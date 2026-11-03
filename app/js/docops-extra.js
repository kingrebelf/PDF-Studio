import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
} from '../vendor/pdflib/pdf-lib.esm.min.js';
import { S, pageMeta, hexToRgb, markClean } from './state.js';
import * as History from './history.js';
import {
  toast,
  showBusy,
  hideBusy,
  setBusyProgress,
  sanitizeFilename,
  stripExtension,
} from './ui.js';
import { renderPageToCanvas } from './workspace.js';
import { buildPdfBytes, commitAnnotationsForOps, applyMetadata } from './docops.js';
import { formatDate } from './ui.js';

function colorOf(hex) {
  const { r, g, b } = hexToRgb(hex || '#000000');
  return rgb(r, g, b);
}

async function applyDocChange(mutator, { busy = 'Updating…', detail = '' } = {}) {
  if (!S.pdfjs) return false;
  History.push('doc');
  showBusy(busy, detail);
  try {
    await commitAnnotationsForOps();
    const doc = await PDFDocument.load(new Uint8Array(S.bytes), {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    await mutator(doc);
    applyMetadata(doc);
    const bytes = await doc.save({ useObjectStreams: true });
    const { reloadFromBytes, scrollToPage } = await import('./workspace.js');
    await reloadFromBytes(bytes, { clearOverlays: true });
    markClean();
    scrollToPage(S.currentPage, { smooth: false });
    return true;
  } catch (error) {
    console.error(error);
    toast(error?.message || 'That change could not be applied.', 'error', 5000);
    return false;
  } finally {
    hideBusy();
  }
}

function resolveToken(token, context) {
  return String(token ?? '').replace(/\{(\w+)\}/g, (match, key) => {
    switch (key) {
      case 'page':
        return String(context.page);
      case 'pages':
        return String(context.total);
      case 'date':
        return formatDate(new Date(), 'YYYY-MM-DD');
      case 'longdate':
        return formatDate(new Date(), 'MMMM D, YYYY');
      case 'title':
        return context.title || '';
      case 'author':
        return context.author || '';
      case 'file':
        return context.file || '';
      default:
        return match;
    }
  });
}

/* ============================== watermark ============================== */

export async function applyWatermark({
  text = 'DRAFT',
  fontSize = 64,
  opacity = 0.14,
  color = '#8a7f70',
  rotation = 45,
  position = 'center',
  tile = false,
  pages = null,
} = {}) {
  if (!text.trim()) {
    toast('Enter the watermark text first.', 'warning');
    return false;
  }
  const selected = pages || Array.from({ length: S.numPages }, (_, i) => i);
  const ok = await applyDocChange(
    async (doc) => {
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      for (const index of selected) {
        if (index < 0 || index >= doc.getPageCount()) continue;
        const page = doc.getPage(index);
        const { width, height } = page.getSize();
        if (tile) {
          const size = Math.max(10, fontSize * 0.52);
          const textWidth = font.widthOfTextAtSize(text, size);
          const gapX = textWidth + size * 2.2;
          const gapY = size * 3.6;
          for (let y = size; y < height + gapY; y += gapY) {
            for (let x = -gapX; x < width + gapX; x += gapX) {
              page.drawText(text, {
                x,
                y,
                size,
                font,
                color: colorOf(color),
                opacity,
                rotate: degrees(rotation),
              });
            }
          }
          continue;
        }
        const size = Math.max(8, fontSize);
        const textWidth = font.widthOfTextAtSize(text, size);
        const textHeight = font.heightAtSize(size);
        let x = (width - textWidth) / 2;
        let y = (height - textHeight) / 2 + textHeight * 0.24;
        const margin = 42;
        if (position.includes('left')) x = margin;
        if (position.includes('right')) x = width - textWidth - margin;
        if (position.includes('top')) y = height - size - margin;
        if (position.includes('bottom')) y = margin;
        page.drawText(text, {
          x: Math.max(4, x),
          y: Math.max(4, y),
          size,
          font,
          color: colorOf(color),
          opacity,
          rotate: degrees(rotation),
        });
      }
    },
    { busy: 'Adding the watermark…', detail: `Applying to ${selected.length} page${selected.length === 1 ? '' : 's'}.` }
  );
  if (ok) toast('Watermark applied.', 'success');
  return ok;
}

/* ============================== header & footer ============================== */

export async function applyHeaderFooter({
  headerLeft = '',
  headerCenter = '',
  headerRight = '',
  footerLeft = '',
  footerCenter = '{page}',
  footerRight = '',
  margin = 36,
  fontSize = 9,
  color = '#6f675c',
  skipFirst = false,
  pages = null,
} = {}) {
  if (![headerLeft, headerCenter, headerRight, footerLeft, footerCenter, footerRight].some((t) => t && t.trim())) {
    toast('Add some header or footer text first.', 'warning');
    return false;
  }
  const selected = pages || Array.from({ length: S.numPages }, (_, i) => i);
  const ok = await applyDocChange(
    async (doc) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const contextBase = {
        total: S.numPages,
        title: S.meta?.title || stripExtension(S.name || ''),
        author: S.meta?.author || '',
        file: S.name || '',
      };
      for (const index of selected) {
        if (skipFirst && index === 0) continue;
        if (index < 0 || index >= doc.getPageCount()) continue;
        const page = doc.getPage(index);
        const { width, height } = page.getSize();
        const context = { ...contextBase, page: index + 1 };
        const draw = (template, y, align) => {
          const value = resolveToken(template, context).trim();
          if (!value) return;
          const textWidth = font.widthOfTextAtSize(value, fontSize);
          let x = margin;
          if (align === 'center') x = (width - textWidth) / 2;
          if (align === 'right') x = width - margin - textWidth;
          page.drawText(value, {
            x: Math.max(3, Math.min(width - textWidth - 3, x)),
            y: Math.max(3, y),
            size: fontSize,
            font,
            color: colorOf(color),
            opacity: 0.9,
          });
        };
        const headerY = height - margin + 8;
        const footerY = Math.max(10, margin - 18);
        draw(headerLeft, headerY, 'left');
        draw(headerCenter, headerY, 'center');
        draw(headerRight, headerY, 'right');
        draw(footerLeft, footerY, 'left');
        draw(footerCenter, footerY, 'center');
        draw(footerRight, footerY, 'right');
      }
    },
    { busy: 'Adding headers and footers…' }
  );
  if (ok) toast('Header and footer added.', 'success');
  return ok;
}

/* ============================== Bates numbering ============================== */

export async function applyBates({
  prefix = '',
  suffix = '',
  start = 1,
  digits = 6,
  position = 'bottom-right',
  margin = 36,
  fontSize = 9,
  color = '#5d564c',
  pages = null,
  separator = '-',
} = {}) {
  const selected = pages || Array.from({ length: S.numPages }, (_, i) => i);
  const ok = await applyDocChange(
    async (doc) => {
      const font = await doc.embedFont(StandardFonts.Courier);
      let counter = Number(start) || 1;
      for (const index of selected) {
        if (index < 0 || index >= doc.getPageCount()) continue;
        const page = doc.getPage(index);
        const { width, height } = page.getSize();
        const number = String(counter).padStart(Math.max(1, Number(digits) || 1), '0');
        const text = `${prefix}${prefix ? separator : ''}${number}${suffix ? `${separator}${suffix}` : ''}`;
        counter += 1;
        const textWidth = font.widthOfTextAtSize(text, fontSize);
        let x = width - margin - textWidth;
        let y = margin - 18;
        if (position.includes('left')) x = margin;
        if (position.includes('center')) x = (width - textWidth) / 2;
        if (position.includes('top')) y = height - margin + 6;
        page.drawText(text, {
          x: Math.max(3, x),
          y: Math.max(3, y),
          size: fontSize,
          font,
          color: colorOf(color),
          opacity: 0.95,
        });
      }
    },
    { busy: 'Adding Bates numbers…', detail: `${selected.length} page${selected.length === 1 ? '' : 's'}.` }
  );
  if (ok) toast('Bates numbering applied.', 'success');
  return ok;
}

/* ============================== compression ============================== */

export async function compressDocument({ quality = 'balanced' } = {}) {
  if (!S.pdfjs) return false;
  const presets = {
    light: { scale: 1, jpeg: 0.86, label: 'Light' },
    balanced: { scale: 1.55, jpeg: 0.72, label: 'Balanced' },
    strong: { scale: 1.15, jpeg: 0.55, label: 'Strong' },
  };
  const preset = presets[quality] || presets.balanced;
  History.push('doc');
  showBusy('Compressing…', `Rendering at ${preset.label.toLowerCase()} quality.`);
  try {
    await commitAnnotationsForOps();
    const originalSize = S.bytes?.length || 0;
    const out = await PDFDocument.create();
    for (let i = 0; i < S.numPages; i += 1) {
      const meta = pageMeta(i);
      setBusyProgress((i + 1) / S.numPages);
      const canvas = await renderPageToCanvas(i, preset.scale, { overlays: true, background: '#ffffff' });
      const jpg = canvas.toDataURL('image/jpeg', preset.jpeg);
      const { dataUrlBytes } = await import('./docops.js');
      const image = await out.embedJpg(dataUrlBytes(jpg).bytes);
      const page = out.addPage([meta.viewW, meta.viewH]);
      page.drawImage(image, { x: 0, y: 0, width: meta.viewW, height: meta.viewH });
    }
    applyMetadata(out);
    const bytes = await out.save({ useObjectStreams: true });
    if (originalSize && bytes.length >= originalSize) {
      // Rendering to images loses selectable text, so never trade that away for a
      // file that is not actually smaller.
      S.history.pop();
      toast('This PDF is already compact — no smaller version was produced.', 'info', 4400);
      return false;
    }
    const { reloadFromBytes, scrollToPage } = await import('./workspace.js');
    await reloadFromBytes(bytes, { clearOverlays: true });
    markClean();
    scrollToPage(S.currentPage, { smooth: false });
    const saved = S.bytes.length;
    toast(`Compressed to ${(saved / 1024 / 1024).toFixed(1)} MB.`, 'success');
    return true;
  } catch (error) {
    console.error(error);
    toast(error?.message || 'The document could not be compressed.', 'error');
    return false;
  } finally {
    hideBusy();
  }
}

/* ============================== flatten helper for save ============================== */

export async function flattenExisting() {
  const bytes = await buildPdfBytes({ flattenForms: true });
  const { reloadFromBytes } = await import('./workspace.js');
  await reloadFromBytes(bytes, { clearOverlays: true });
  markClean();
  return true;
}

export { sanitizeFilename };
