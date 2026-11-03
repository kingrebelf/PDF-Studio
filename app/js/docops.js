import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  LineCapStyle,
} from '../vendor/pdflib/pdf-lib.esm.min.js';
import { S, pageMeta, hexToRgb, markClean, markDirty, overlayCount } from './state.js';
import * as History from './history.js';
import {
  $,
  toast,
  showBusy,
  hideBusy,
  setBusyProgress,
  downloadBlob,
  sanitizeFilename,
  stripExtension,
  confirmModal,
  parsePageRange,
} from './ui.js';
import { renderPageToCanvas } from './workspace.js';
import { fontStack } from './paint.js';

const RASTER_SCALE = 2.6;

/* ============================== bytes & colours ============================== */

export function dataUrlBytes(dataUrl) {
  const [head, body] = String(dataUrl).split(',');
  const binary = atob(body || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { bytes, mime: /data:([^;]+)/.exec(head)?.[1] || 'image/png' };
}

function colorOf(hex, fallback = '#000000') {
  const { r, g, b } = hexToRgb(hex || fallback);
  return rgb(r, g, b);
}

async function embedImage(doc, dataUrl) {
  const { bytes, mime } = dataUrlBytes(dataUrl);
  if (/jpe?g/i.test(mime)) return doc.embedJpg(bytes);
  if (/png/i.test(mime)) return doc.embedPng(bytes);
  const converted = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('That image could not be embedded.'));
    img.src = dataUrl;
  });
  return doc.embedPng(dataUrlBytes(converted).bytes);
}

async function fontsFor(doc) {
  const [helv, helvBold, times, timesBold, courier, courierBold] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
    doc.embedFont(StandardFonts.TimesRoman),
    doc.embedFont(StandardFonts.TimesRomanBold),
    doc.embedFont(StandardFonts.Courier),
    doc.embedFont(StandardFonts.CourierBold),
  ]);
  return {
    Helvetica: { regular: helv, bold: helvBold },
    Times: { regular: times, bold: timesBold },
    Courier: { regular: courier, bold: courierBold },
  };
}

function pickFont(fonts, obj) {
  const family = fonts[obj.fontFamily] || fonts.Helvetica;
  return obj.bold ? family.bold : family.regular;
}

/* ============================== text layout ============================== */

function wrapWithFont(text, font, size, maxWidth) {
  const lines = [];
  for (const paragraph of String(text ?? '').split(/\r?\n/)) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    const words = paragraph.split(/\s+/);
    let line = '';
    for (const word of words) {
      const attempt = line ? `${line} ${word}` : word;
      let width = 0;
      try {
        width = font.widthOfTextAtSize(attempt, size);
      } catch {
        width = attempt.length * size * 0.5;
      }
      if (width <= maxWidth || !line) {
        if (!line && width > maxWidth) {
          let chunk = '';
          for (const char of word) {
            let cw = 0;
            try {
              cw = font.widthOfTextAtSize(chunk + char, size);
            } catch {
              cw = (chunk.length + 1) * size * 0.5;
            }
            if (cw > maxWidth && chunk) {
              lines.push(chunk);
              chunk = char;
            } else {
              chunk += char;
            }
          }
          line = chunk;
        } else {
          line = attempt;
        }
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/* ============================== geometry ============================== */

function mapperFor(page) {
  const box = page.getCropBox ? page.getCropBox() : page.getMediaBox();
  const top = box.y + box.height;
  return {
    box,
    x: (value) => box.x + value,
    y: (value) => top - value,
  };
}

function drawWrappedText(page, obj, fonts, map) {
  const size = Math.max(4, obj.fontSize || 12);
  const font = pickFont(fonts, obj);
  const color = colorOf(obj.color, '#211d17');
  const opacity = obj.opacity ?? 1;
  const pad = obj.type === 'note' ? 8 : 2;
  const labelHeight = obj.type === 'note' ? 15 : 0;
  const maxWidth = Math.max(8, obj.w - pad * 2);
  const lineHeight = (obj.lineHeight || 1.3) * size;
  const lines = wrapWithFont(obj.text || '', font, size, maxWidth);
  let baseline = obj.y + pad + labelHeight + size * 0.86;
  const limit = obj.y + obj.h + lineHeight;
  for (const line of lines) {
    if (baseline > limit) break;
    let width = 0;
    try {
      width = font.widthOfTextAtSize(line, size);
    } catch {
      width = line.length * size * 0.5;
    }
    let x = obj.x + pad;
    if (obj.align === 'center') x = obj.x + (obj.w - width) / 2;
    else if (obj.align === 'right') x = obj.x + obj.w - pad - width;
    page.drawText(line, {
      x: map.x(x),
      y: map.y(baseline),
      size,
      font,
      color,
      opacity,
    });
    baseline += lineHeight;
  }
}

/* ============================== overlays ============================== */

async function drawOverlay(doc, page, obj, fonts, imageCache) {
  const map = mapperFor(page);
  const opacity = obj.opacity ?? 1;

  switch (obj.type) {
    case 'text':
    case 'date': {
      drawWrappedText(page, obj, fonts, map);
      break;
    }
    case 'note': {
      page.drawRectangle({
        x: map.x(obj.x),
        y: map.y(obj.y + obj.h),
        width: obj.w,
        height: obj.h,
        color: colorOf(obj.background || '#fff3bf'),
        borderColor: colorOf(obj.border || '#e2c35b'),
        borderWidth: 1,
        opacity,
      });
      drawWrappedText(page, obj, fonts, map);
      break;
    }
    case 'highlight': {
      for (const rect of obj.rects || [obj]) {
        page.drawRectangle({
          x: map.x(rect.x),
          y: map.y(rect.y + rect.h),
          width: rect.w,
          height: rect.h,
          color: colorOf(obj.color || '#f1c860'),
          opacity: obj.opacity ?? 0.38,
        });
      }
      break;
    }
    case 'underline':
    case 'strike': {
      for (const rect of obj.rects || [obj]) {
        const y = obj.type === 'underline' ? rect.y + rect.h - 1.2 : rect.y + rect.h * 0.56;
        page.drawLine({
          start: { x: map.x(rect.x), y: map.y(y) },
          end: { x: map.x(rect.x + rect.w), y: map.y(y) },
          thickness: obj.strokeWidth || 1.4,
          color: colorOf(obj.color || '#b0522b'),
          opacity,
        });
      }
      break;
    }
    case 'ink': {
      const points = obj.points || [];
      if (points.length === 1) {
        page.drawCircle({
          x: map.x(points[0].x),
          y: map.y(points[0].y),
          size: (obj.strokeWidth || 2) / 2,
          color: colorOf(obj.color || '#b0522b'),
          opacity,
        });
      }
      for (let i = 1; i < points.length; i += 1) {
        page.drawLine({
          start: { x: map.x(points[i - 1].x), y: map.y(points[i - 1].y) },
          end: { x: map.x(points[i].x), y: map.y(points[i].y) },
          thickness: obj.strokeWidth || 2,
          color: colorOf(obj.color || '#b0522b'),
          opacity,
          lineCap: LineCapStyle.Round,
        });
      }
      break;
    }
    case 'rect': {
      page.drawRectangle({
        x: map.x(obj.x),
        y: map.y(obj.y + obj.h),
        width: obj.w,
        height: obj.h,
        color: obj.fill && obj.fill !== 'transparent' ? colorOf(obj.fill) : undefined,
        borderColor: colorOf(obj.stroke || '#b0522b'),
        borderWidth: obj.strokeWidth || 2,
        opacity,
        borderOpacity: opacity,
      });
      break;
    }
    case 'ellipse': {
      page.drawEllipse({
        x: map.x(obj.x + obj.w / 2),
        y: map.y(obj.y + obj.h / 2),
        xScale: obj.w / 2,
        yScale: obj.h / 2,
        color: obj.fill && obj.fill !== 'transparent' ? colorOf(obj.fill) : undefined,
        borderColor: colorOf(obj.stroke || '#b0522b'),
        borderWidth: obj.strokeWidth || 2,
        opacity,
        borderOpacity: opacity,
      });
      break;
    }
    case 'line':
    case 'arrow': {
      const p1 = obj.p1 || { x: obj.x, y: obj.y };
      const p2 = obj.p2 || { x: obj.x + obj.w, y: obj.y + obj.h };
      page.drawLine({
        start: { x: map.x(p1.x), y: map.y(p1.y) },
        end: { x: map.x(p2.x), y: map.y(p2.y) },
        thickness: obj.strokeWidth || 2,
        color: colorOf(obj.stroke || '#b0522b'),
        opacity,
        lineCap: LineCapStyle.Round,
      });
      if (obj.type === 'arrow') {
        const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        const spread = Math.PI / 7;
        const size = Math.max(7, (obj.strokeWidth || 2) * 4);
        for (const direction of [angle - spread, angle + spread]) {
          page.drawLine({
            start: { x: map.x(p2.x), y: map.y(p2.y) },
            end: {
              x: map.x(p2.x - size * Math.cos(direction)),
              y: map.y(p2.y - size * Math.sin(direction)),
            },
            thickness: obj.strokeWidth || 2,
            color: colorOf(obj.stroke || '#b0522b'),
            opacity,
            lineCap: LineCapStyle.Round,
          });
        }
      }
      break;
    }
    case 'redact': {
      page.drawRectangle({
        x: map.x(obj.x),
        y: map.y(obj.y + obj.h),
        width: obj.w,
        height: obj.h,
        color: colorOf(obj.fill || '#000000'),
        opacity: 1,
      });
      break;
    }
    case 'whiteout': {
      page.drawRectangle({
        x: map.x(obj.x),
        y: map.y(obj.y + obj.h),
        width: obj.w,
        height: obj.h,
        color: colorOf(obj.fill || '#ffffff'),
        opacity: 1,
      });
      break;
    }
    case 'stamp': {
      const text = obj.text || 'APPROVED';
      const color = colorOf(obj.color || '#3e7a53');
      page.drawRectangle({
        x: map.x(obj.x + 1.5),
        y: map.y(obj.y + obj.h - 1.5),
        width: obj.w - 3,
        height: obj.h - 3,
        borderColor: color,
        borderWidth: 1.6,
        opacity,
        borderOpacity: opacity,
      });
      page.drawRectangle({
        x: map.x(obj.x + 5),
        y: map.y(obj.y + obj.h - 5),
        width: obj.w - 10,
        height: obj.h - 10,
        borderColor: color,
        borderWidth: 1.1,
        opacity,
        borderOpacity: opacity,
      });
      const font = fonts.Helvetica.bold;
      let size = obj.fontSize || Math.min(17, obj.h * 0.34);
      let width = 0;
      try {
        width = font.widthOfTextAtSize(text, size);
      } catch {
        width = text.length * size * 0.6;
      }
      while (width > obj.w - 20 && size > 5) {
        size -= 1;
        try {
          width = font.widthOfTextAtSize(text, size);
        } catch {
          width = text.length * size * 0.6;
        }
      }
      page.drawText(text, {
        x: map.x(obj.x + (obj.w - width) / 2),
        y: map.y(obj.y + obj.h / 2 + size * 0.35),
        size,
        font,
        color,
        opacity,
      });
      break;
    }
    case 'sigbox': {
      const color = colorOf('#b0522b');
      page.drawRectangle({
        x: map.x(obj.x),
        y: map.y(obj.y + obj.h),
        width: obj.w,
        height: obj.h,
        color: colorOf('#fbf1ea'),
        borderColor: color,
        borderWidth: 1.1,
        borderDashArray: [5, 4],
        opacity: 0.96,
      });
      const font = fonts.Helvetica.bold;
      const label = obj.label || 'Sign here';
      const size = Math.min(10, Math.max(5, obj.h * 0.2));
      let width = 0;
      try {
        width = font.widthOfTextAtSize(label, size);
      } catch {
        width = label.length * size * 0.6;
      }
      page.drawText(label, {
        x: map.x(obj.x + (obj.w - width) / 2),
        y: map.y(obj.y + obj.h * 0.34),
        size,
        font,
        color,
        opacity: 0.82,
      });
      const y = obj.y + obj.h * 0.68;
      const points = [
        { x: obj.x + obj.w * 0.22, y: y + 3 },
        { x: obj.x + obj.w * 0.3, y: y - 4 },
        { x: obj.x + obj.w * 0.37, y: y + 5 },
        { x: obj.x + obj.w * 0.45, y: y - 2 },
        { x: obj.x + obj.w * 0.53, y: y - 6 },
        { x: obj.x + obj.w * 0.6, y: y + 3 },
        { x: obj.x + obj.w * 0.69, y: y },
      ];
      for (let i = 1; i < points.length; i += 1) {
        page.drawLine({
          start: { x: map.x(points[i - 1].x), y: map.y(points[i - 1].y) },
          end: { x: map.x(points[i].x), y: map.y(points[i].y) },
          thickness: 1.3,
          color,
          opacity: 0.65,
          lineCap: LineCapStyle.Round,
        });
      }
      break;
    }
    case 'signature':
    case 'initials':
    case 'image': {
      if (!obj.src) throw new Error('The image data is missing.');
      let embedded = imageCache.get(obj.src);
      if (!embedded) {
        embedded = await embedImage(doc, obj.src);
        imageCache.set(obj.src, embedded);
      }
      page.drawImage(embedded, {
        x: map.x(obj.x),
        y: map.y(obj.y + obj.h),
        width: obj.w,
        height: obj.h,
        opacity,
      });
      break;
    }
    default:
      break;
  }
}

async function drawOverlaysOnPage(doc, page, list, fonts, imageCache) {
  for (const obj of list) {
    try {
      await drawOverlay(doc, page, obj, fonts, imageCache);
    } catch (error) {
      throw new Error(`Could not save ${obj.type || 'annotation'}: ${error?.message || error}`);
    }
  }
}

/* ============================== forms & metadata ============================== */

function applyFormValues(doc) {
  if (!S.formFields?.length) return;
  let form;
  try {
    form = doc.getForm();
  } catch {
    return;
  }
  for (const field of S.formFields) {
    if (!Object.prototype.hasOwnProperty.call(S.formValues, field.name)) continue;
    const value = S.formValues[field.name];
    try {
      const target = form.getFieldMaybe ? form.getFieldMaybe(field.name) : form.getFields().find((f) => f.getName() === field.name);
      if (!target) throw new Error('Field was not found in the PDF.');
      const type = target.constructor?.name || '';
      if (type.includes('TextField') || target.setText) target.setText(String(value ?? ''));
      else if (type.includes('CheckBox') || target.check) {
        if (value === true || value === 'true' || value === field.buttonValue) target.check();
        else target.uncheck?.();
      } else if (type.includes('RadioGroup') || target.select) target.select(String(value ?? ''));
      else if (type.includes('Dropdown')) target.select(String(value ?? ''));
      else if (type.includes('OptionList')) target.select(String(value ?? ''));
    } catch (error) {
      throw new Error(`Could not save form field ${field.name}: ${error?.message || error}`);
    }
  }
}

export function applyMetadata(doc) {
  const meta = S.meta || {};
  const safe = (fn, value) => {
    try {
      if (value !== undefined && value !== null) fn(String(value));
    } catch {
      /* ignore invalid metadata */
    }
  };
  safe((v) => doc.setTitle(v), meta.title);
  safe((v) => doc.setAuthor(v), meta.author);
  safe((v) => doc.setSubject(v), meta.subject);
  safe((v) => doc.setKeywords(Array.isArray(meta.keywords) ? meta.keywords : String(meta.keywords || '').split(/[,;]\s*/).filter(Boolean)), meta.keywords);
  safe((v) => doc.setCreator(v), meta.creator || 'PDF Studio');
  safe((v) => doc.setProducer(v), 'PDF Studio');
  try {
    doc.setModificationDate(new Date());
  } catch {
    /* ignore */
  }
}

/* ============================== the save pipeline ============================== */

export async function buildPdfBytes({ flattenForms = S.opts.flattenForms, forOps = false } = {}) {
  if (!S.bytes) throw new Error('There is no document to save.');
  if (!S.editable && !forOps) {
    return new Uint8Array(S.bytes);
  }

  const rasterPages = [];
  for (let i = 0; i < S.numPages; i += 1) {
    const list = S.overlays.get(i) || [];
    if (!list.length) continue;
    if (pageMeta(i).rot !== 0 || list.some((o) => o.type === 'redact')) rasterPages.push(i);
  }

  const src = await PDFDocument.load(new Uint8Array(S.bytes), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  applyFormValues(src);

  const fonts = await fontsFor(src);
  const imageCache = new Map();

  /* Fast path: every annotated page is unrotated, so vector output is exact. */
  if (!rasterPages.length) {
    for (let i = 0; i < S.numPages; i += 1) {
      const list = S.overlays.get(i) || [];
      if (!list.length) continue;
      await drawOverlaysOnPage(src, src.getPage(i), list, fonts, imageCache);
    }
    applyMetadata(src);
    if (flattenForms) {
      try {
        src.getForm().flatten();
      } catch (error) {
        throw new Error(`Could not flatten form fields: ${error?.message || error}`);
      }
    }
    return src.save({ useObjectStreams: true });
  }

  /* Rasterize affected pages. Other document structures still require
     independent inspection before sharing sensitive information. */
  try {
    src.getForm().flatten();
  } catch (error) {
    throw new Error(`Could not flatten form fields: ${error?.message || error}`);
  }

  const out = await PDFDocument.create();
  const outFonts = await fontsFor(out);
  const outImages = new Map();
  const total = S.numPages;

  for (let i = 0; i < total; i += 1) {
    if (rasterPages.includes(i)) {
      const meta = pageMeta(i);
      if (typeof setBusyProgress === 'function') setBusyProgress(0.15 + (i / total) * 0.7);
      const canvas = await renderPageToCanvas(i, RASTER_SCALE, {
        overlays: true,
        background: '#ffffff',
      });
      const jpg = canvas.toDataURL('image/jpeg', 0.93);
      const embedded = await out.embedJpg(dataUrlBytes(jpg).bytes);
      const page = out.addPage([meta.viewW, meta.viewH]);
      page.drawImage(embedded, { x: 0, y: 0, width: meta.viewW, height: meta.viewH });
    } else {
      const [copied] = await out.copyPages(src, [i]);
      out.addPage(copied);
      const list = S.overlays.get(i) || [];
      if (list.length) await drawOverlaysOnPage(out, copied, list, outFonts, outImages);
    }
  }

  applyMetadata(out);
  return out.save({ useObjectStreams: true });
}

/* ============================== save & export ============================== */

export function isBakedIn() {
  return overlayCount() > 0 || Object.keys(S.formValues).length > 0 || S.metaDirty;
}

export async function saveDocument({ saveAs = false, silent = false } = {}) {
  if (!S.pdfjs) return false;
  if (!S.editable) {
    toast('This protected PDF can only be saved as a copy.', 'warning');
    return saveCopy({ forceDialog: true });
  }
  showBusy(saveAs ? 'Saving a copy…' : 'Saving…', 'Embedding your annotations into the PDF.');
  try {
    const bytes = await buildPdfBytes({ flattenForms: S.opts.flattenForms });
    const suggested = S.name || 'Document.pdf';
    let result;
    if (window.api?.savePDF) {
      result = await window.api.savePDF({
        data: bytes,
        path: S.path,
        suggestedName: suggested,
        saveAs,
      });
    } else {
      downloadBlob(bytes, suggested);
      result = { canceled: false, path: S.path, name: suggested };
    }
    if (result?.canceled) return false;
    S.path = result?.path || S.path;
    S.name = result?.name || S.name;
    const { reloadFromBytes } = await import('./workspace.js');
    await reloadFromBytes(bytes, {
      name: S.name,
      path: S.path,
      clearOverlays: true,
    });
    markClean();
    History.clearHistory();
    if (!silent) toast(`Saved ${S.name}`, 'success');
    return true;
  } catch (error) {
    console.error(error);
    toast(error?.message || 'The PDF could not be saved.', 'error', 5200);
    return false;
  } finally {
    hideBusy();
  }
}

export async function saveCopy({ forceDialog = false } = {}) {
  if (!S.pdfjs) return false;
  showBusy('Saving a copy…', 'Building a separate file — your original stays untouched.');
  try {
    const bytes = S.editable
      ? await buildPdfBytes({ flattenForms: S.opts.flattenForms })
      : new Uint8Array(S.bytes);
    const suggested = stripExtension(S.name || 'document') + ' (copy).pdf';
    if (window.api?.savePDF) {
      const result = await window.api.savePDF({
        data: bytes,
        suggestedName: suggested,
        saveAs: true,
      });
      if (result?.canceled) return false;
      toast(`Copy saved as ${result.name}`, 'success');
      return true;
    }
    downloadBlob(bytes, suggested);
    return true;
  } catch (error) {
    toast(error?.message || 'The copy could not be saved.', 'error');
    return false;
  } finally {
    hideBusy();
  }
}

export async function exportText() {
  if (!S.pdfjs) return;
  showBusy('Extracting text…', 'Reading every page.');
  try {
    const lines = [];
    for (let i = 0; i < S.numPages; i += 1) {
      const page = await S.pdfjs.getPage(i + 1);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => item.str + (item.hasEOL ? '\n' : ' '))
        .join('')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      lines.push(`--- Page ${i + 1} ---`, text, '');
      setBusyProgress((i + 1) / S.numPages);
    }
    const out = `${stripExtension(S.name || 'document')}\n\n${lines.join('\n')}`;
    if (window.api?.saveText) {
      const result = await window.api.saveText({
        text: out,
        suggestedName: `${stripExtension(S.name || 'document')}.txt`,
        extension: 'txt',
      });
      if (!result?.canceled) toast('Text exported.', 'success');
    } else {
      downloadBlob(new Blob([out], { type: 'text/plain' }), `${stripExtension(S.name || 'document')}.txt`, 'text/plain');
    }
  } catch (error) {
    toast(error?.message || 'The text could not be exported.', 'error');
  } finally {
    hideBusy();
  }
}

export async function exportImages({ format = 'png', scale = 2 } = {}) {
  if (!S.pdfjs) return;
  showBusy('Exporting pages…', 'Rendering high-quality images.');
  try {
    const files = [];
    for (let i = 0; i < S.numPages; i += 1) {
      const canvas = await renderPageToCanvas(i, scale, { overlays: true });
      files.push({
        name: `page-${String(i + 1).padStart(3, '0')}`,
        dataUrl: canvas.toDataURL(format === 'jpg' ? 'image/jpeg' : 'image/png', 0.92),
      });
      setBusyProgress((i + 1) / S.numPages);
    }
    const base = sanitizeFilename(stripExtension(S.name || 'document'), 'document');
    if (window.api?.saveImages) {
      const result = await window.api.saveImages({ files, suggestedName: base });
      if (!result?.canceled) toast(`Exported ${result.count} image${result.count === 1 ? '' : 's'}.`, 'success');
    } else {
      for (const file of files) {
        const anchor = document.createElement('a');
        anchor.href = file.dataUrl;
        anchor.download = `${base}-${file.name}.${format === 'jpg' ? 'jpg' : 'png'}`;
        anchor.click();
      }
    }
  } catch (error) {
    toast(error?.message || 'The images could not be exported.', 'error');
  } finally {
    hideBusy();
  }
}

/* ============================== printing ============================== */

let printing = false;

export async function printDocument() {
  if (!S.pdfjs || printing) return;
  printing = true;
  showBusy('Preparing to print…', 'Rendering pages at print quality.');
  try {
    const root = $('#print-root');
    root.innerHTML = '';
    const images = [];
    for (let i = 0; i < S.numPages; i += 1) {
      const canvas = await renderPageToCanvas(i, 2.2, { overlays: true });
      images.push(canvas.toDataURL('image/jpeg', 0.94));
      setBusyProgress((i + 1) / S.numPages);
    }
    root.innerHTML = images
      .map((src) => `<div class="print-page"><img src="${src}" alt=""></div>`)
      .join('');
    hideBusy();
    await new Promise((resolve) => setTimeout(resolve, 160));
    window.print();
  } catch (error) {
    toast(error?.message || 'Printing could not start.', 'error');
  } finally {
    setTimeout(() => {
      $('#print-root').innerHTML = '';
    }, 1500);
    hideBusy();
    printing = false;
  }
}

/* ============================== committing for page ops ============================== */

export async function commitAnnotationsForOps() {
  if (!S.overlays.size && !Object.keys(S.formValues).length && !S.metaDirty) return false;
  const bytes = await buildPdfBytes({ flattenForms: true, forOps: true });
  const { reloadFromBytes } = await import('./workspace.js');
  await reloadFromBytes(bytes, { clearOverlays: true });
  // These changes are only in memory until the user saves the document.
  markDirty();
  return true;
}


/* ============================== page operations ============================== */

async function mutate(fn, { busy = 'Updating the document…', detail = 'Rebuilding pages.' } = {}) {
  if (!S.pdfjs) return false;
  History.push('doc');
  showBusy(busy, detail);
  try {
    await commitAnnotationsForOps();
    const doc = await PDFDocument.load(new Uint8Array(S.bytes), {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    await fn(doc);
    applyMetadata(doc);
    const bytes = await doc.save({ useObjectStreams: true });
    const { reloadFromBytes, scrollToPage, flashPage } = await import('./workspace.js');
    await reloadFromBytes(bytes, { clearOverlays: true });
    markDirty();
    scrollToPage(S.currentPage, { smooth: false });
    flashPage(S.currentPage);
    return true;
  } catch (error) {
    console.error(error);
    toast(error?.message || 'That page operation failed.', 'error', 5000);
    return false;
  } finally {
    hideBusy();
  }
}

export async function rotatePage(page = S.currentPage, delta = 90) {
  if (page < 0 || page >= S.numPages) return false;
  return mutate(
    (doc) => {
      const target = doc.getPage(page);
      target.setRotation(degrees(((target.getRotation().angle + delta) % 360 + 360) % 360));
    },
    { busy: 'Rotating the page…' }
  );
}

export async function rotateDocument(delta = 90) {
  return mutate(
    (doc) => {
      doc.getPages().forEach((page) => {
        page.setRotation(degrees(((page.getRotation().angle + delta) % 360 + 360) % 360));
      });
    },
    { busy: 'Rotating every page…' }
  );
}

export async function removePageAt(page = S.currentPage) {
  if (!S.pdfjs || S.numPages <= 1) return false;
  if (page < 0 || page >= S.numPages) return false;
  return mutate(
    (doc) => {
      doc.removePage(page);
    },
    { busy: 'Deleting the page…' }
  );
}

export async function deletePage(page = S.currentPage) {
  if (!S.pdfjs || S.numPages <= 1) {
    toast('A PDF needs at least one page.', 'warning');
    return false;
  }
  const ok = await confirmModal({
    title: 'Delete this page?',
    message: `Page ${page + 1} will be removed from the document. You can undo this with Ctrl+Z.`,
    confirmLabel: 'Delete page',
    danger: true,
    iconName: 'trash',
  });
  if (!ok) return false;
  return removePageAt(page);
}

export async function duplicatePage(page = S.currentPage) {
  if (!S.pdfjs) return false;
  return mutate(
    async (doc) => {
      const [copy] = await doc.copyPages(doc, [page]);
      doc.insertPage(page + 1, copy);
    },
    { busy: 'Duplicating the page…' }
  );
}

export async function insertBlankPage(at = S.currentPage + 1) {
  if (!S.pdfjs) return false;
  const meta = pageMeta(clampPage(at - 1));
  return mutate(
    (doc) => {
      const index = Math.max(0, Math.min(doc.getPageCount(), at));
      doc.insertPage(index, [meta.viewW, meta.viewH]);
    },
    { busy: 'Inserting a blank page…' }
  );
}

function clampPage(index) {
  return Math.max(0, Math.min((S.numPages || 1) - 1, index));
}

export async function movePage(from, to) {
  if (!S.pdfjs || from === to) return false;
  return mutate(
    (doc) => {
      const page = doc.getPage(from);
      doc.removePage(from);
      const index = Math.max(0, Math.min(doc.getPageCount(), from < to ? to - 1 : to));
      doc.insertPage(index, page);
    },
    { busy: 'Reordering pages…' }
  );
}

export async function mergeDocuments(paths = null) {
  if (!S.pdfjs) return false;
  let files = paths;
  if (!files) {
    if (!window.api?.openPDFs) {
      toast('Merging needs the desktop app.', 'warning');
      return false;
    }
    files = await window.api.openPDFs();
  }
  if (!files?.length) return false;
  History.push('doc');
  showBusy('Merging PDFs…', `${files.length} document${files.length === 1 ? '' : 's'} to add.`);
  try {
    await commitAnnotationsForOps();
    const doc = await PDFDocument.load(new Uint8Array(S.bytes), { ignoreEncryption: true });
    for (let i = 0; i < files.length; i += 1) {
      setBusyProgress((i + 1) / files.length);
      const file = typeof files[i] === 'string' ? await window.api.openPath(files[i]) : files[i];
      if (!file?.data) continue;
      const extra = await PDFDocument.load(new Uint8Array(file.data), { ignoreEncryption: true });
      const pages = await doc.copyPages(extra, extra.getPageIndices());
      pages.forEach((page) => doc.addPage(page));
    }
    applyMetadata(doc);
    const bytes = await doc.save({ useObjectStreams: true });
    const { reloadFromBytes, scrollToPage } = await import('./workspace.js');
    await reloadFromBytes(bytes, { clearOverlays: true });
    markDirty();
    scrollToPage(S.currentPage, { smooth: false });
    toast(`Merged ${files.length} document${files.length === 1 ? '' : 's'}.`, 'success');
    return true;
  } catch (error) {
    toast(error?.message || 'The documents could not be merged.', 'error', 5000);
    return false;
  } finally {
    hideBusy();
  }
}

export async function extractPages(pages, { openAfter = false } = {}) {
  if (!S.pdfjs || !pages?.length) return false;
  showBusy('Extracting pages…', `${pages.length} page${pages.length === 1 ? '' : 's'} selected.`);
  try {
    await commitAnnotationsForOps();
    const doc = await PDFDocument.load(new Uint8Array(S.bytes), { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const copied = await out.copyPages(doc, pages);
    copied.forEach((page) => out.addPage(page));
    applyMetadata(out);
    const bytes = await out.save({ useObjectStreams: true });
    const base = sanitizeFilename(stripExtension(S.name || 'document'), 'document');
    if (window.api?.savePDF) {
      const result = await window.api.savePDF({
        data: bytes,
        suggestedName: `${base} (pages ${pages.map((p) => p + 1).join(', ')}).pdf`,
        saveAs: true,
      });
      if (result?.canceled) return false;
      toast(`Extracted ${pages.length} page${pages.length === 1 ? '' : 's'}.`, 'success');
      if (openAfter) {
        const file = await window.api.openPath(result.path);
        if (file) document.dispatchEvent(new CustomEvent('pdfstudio:open-bytes', { detail: file }));
      }
      return true;
    }
    downloadBlob(bytes, `${base}-extract.pdf`);
    return true;
  } catch (error) {
    toast(error?.message || 'Those pages could not be extracted.', 'error');
    return false;
  } finally {
    hideBusy();
  }
}

export async function setDocumentMetadata(meta) {
  if (!S.pdfjs) return false;
  S.meta = { ...S.meta, ...meta };
  S.metaDirty = true;
  markDirty();
  document.dispatchEvent(new CustomEvent('pdfstudio:refresh'));
  if (!window.api?.savePDF) {
    toast('Metadata will be embedded the next time you save.', 'success');
    return true;
  }
  const ok = await confirmModal({
    title: 'Write metadata now?',
    message: 'The new title and author can be embedded immediately, or saved with your next save. Writing now will re-save the document and keep your annotations.',
    confirmLabel: 'Write now',
    cancelLabel: 'Save later',
    iconName: 'info',
  });
  if (!ok) {
    toast('Metadata will be embedded on your next save.', 'info');
    return true;
  }
  return saveDocument({ silent: false });
}

export async function flattenNow() {
  if (!S.pdfjs) return false;
  if (!S.editable) {
    toast('This document cannot be flattened because it is protected.', 'warning');
    return false;
  }
  const ok = await confirmModal({
    title: 'Flatten annotations?',
    message: 'Annotations and form values will be burned into the page. This is what happens on save anyway; flattening now also clears the editing layers so the document is ready to share.',
    confirmLabel: 'Flatten',
    iconName: 'layers',
  });
  if (!ok) return false;
  History.push('doc');
  showBusy('Flattening…', 'Burning annotations and form values into the pages.');
  try {
    const bytes = await buildPdfBytes({ flattenForms: true, forOps: true });
    const { reloadFromBytes } = await import('./workspace.js');
    await reloadFromBytes(bytes, { clearOverlays: true });
    markDirty();
    toast('Annotations flattened.', 'success');
    return true;
  } catch (error) {
    toast(error?.message || 'The document could not be flattened.', 'error');
    return false;
  } finally {
    hideBusy();
  }
}

export async function chooseAndExtract() {
  const range = await new Promise((resolve) => {
    import('./ui.js').then(({ promptModal }) => {
      promptModal({
        title: 'Extract pages',
        label: 'Pages to extract (for example 1-3, 7, 10-12)',
        value: '',
        placeholder: '1-3, 7',
        confirmLabel: 'Extract',
        iconName: 'split',
      }).then(resolve);
    });
  });
  if (range === null) return false;
  try {
    const pages = parsePageRange(range, S.numPages);
    if (!pages.length) {
      toast('No pages matched that range.', 'warning');
      return false;
    }
    return extractPages(pages);
  } catch (error) {
    toast(error.message, 'error');
    return false;
  }
}

