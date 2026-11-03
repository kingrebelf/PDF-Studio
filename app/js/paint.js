import { S, pageMeta, selectedOverlay } from './state.js';

const ACCENT = '#b0522b';
const FONT_STACKS = {
  Helvetica: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  Times: '"Times New Roman", Times, Georgia, serif',
  Courier: '"Courier New", Courier, monospace',
};

const imageCache = new Map();

function imageFor(src, page) {
  if (!src) return null;
  const cached = imageCache.get(src);
  if (cached) return cached.complete ? cached : null;
  const img = new Image();
  img.onload = () => {
    document.dispatchEvent(new CustomEvent('pdfstudio:repaint', { detail: { page } }));
  };
  img.onerror = () => imageCache.delete(src);
  img.src = src;
  imageCache.set(src, img);
  return img.complete && img.naturalWidth ? img : null;
}

export function clearImageCache() {
  imageCache.clear();
}

export function fontStack(family) {
  return FONT_STACKS[family] || FONT_STACKS.Helvetica;
}

export function canvasFont(obj) {
  const weight = obj.bold ? '700' : '400';
  return `${weight} ${obj.fontSize || 12}px ${fontStack(obj.fontFamily || 'Helvetica')}`;
}

export function wrapText(ctx, text, maxWidth) {
  const paragraphs = String(text ?? '').split(/\r?\n/);
  const lines = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    const words = paragraph.split(/\s+/);
    let line = '';
    for (const word of words) {
      const attempt = line ? `${line} ${word}` : word;
      if (ctx.measureText(attempt).width <= maxWidth || !line) {
        if (!line && ctx.measureText(word).width > maxWidth) {
          let chunk = '';
          for (const char of word) {
            if (ctx.measureText(chunk + char).width > maxWidth && chunk) {
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

export function textBlockHeight(ctx, obj, width) {
  ctx.save();
  ctx.font = canvasFont(obj);
  const pad = obj.type === 'note' ? 16 : 2;
  const label = obj.type === 'note' ? 17 : 0;
  const lines = wrapText(ctx, obj.text || '', Math.max(8, width - pad));
  const lineHeight = (obj.lineHeight || 1.28) * (obj.fontSize || 12);
  ctx.restore();
  return Math.max((obj.fontSize || 12) * 1.6, lines.length * lineHeight + label + 6);
}

export function drawTextBlock(ctx, obj, width, height) {
  if (!obj.text) return;
  const pad = obj.type === 'note' ? 8 : 2;
  const labelHeight = obj.type === 'note' ? 15 : 0;
  ctx.save();
  ctx.font = canvasFont(obj);
  ctx.fillStyle = obj.color || '#211d17';
  ctx.textBaseline = 'alphabetic';
  const align = obj.align || 'left';
  ctx.textAlign = align;
  const lineHeight = (obj.lineHeight || 1.28) * (obj.fontSize || 12);
  const maxWidth = Math.max(8, width - pad * 2);
  const lines = wrapText(ctx, obj.text, maxWidth);
  if (obj.type === 'note') {
    ctx.save();
    ctx.font = `700 ${Math.max(6, (obj.fontSize || 12) * 0.58)}px ${fontStack('Helvetica')}`;
    ctx.fillStyle = 'rgba(78, 61, 24, .55)';
    ctx.textAlign = 'left';
    ctx.fillText('NOTE', pad, 11);
    ctx.restore();
    ctx.font = canvasFont(obj);
    ctx.fillStyle = obj.color || '#3b3217';
  }
  const x = align === 'center' ? width / 2 : align === 'right' ? width - pad : pad;
  let y = pad + labelHeight + (obj.fontSize || 12) * 0.86;
  ctx.beginPath();
  ctx.rect(1, 1, width - 2, height - 2);
  ctx.clip();
  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += lineHeight;
    if (y > height + lineHeight) break;
  }
  ctx.restore();
}

function drawInk(ctx, obj) {
  const points = obj.points || [];
  if (points.length < 1) return;
  ctx.save();
  ctx.strokeStyle = obj.color || '#b0522b';
  ctx.lineWidth = obj.strokeWidth || 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = obj.opacity ?? 1;
  if (points.length === 1) {
    ctx.fillStyle = obj.color;
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, (obj.strokeWidth || 2) / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length - 1; i += 1) {
      const midX = (points[i].x + points[i + 1].x) / 2;
      const midY = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawArrowHead(ctx, from, to, size) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(angle - spread), to.y - size * Math.sin(angle - spread));
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(angle + spread), to.y - size * Math.sin(angle + spread));
  ctx.stroke();
}

function drawStamp(ctx, obj) {
  const color = obj.color || '#3e7a53';
  const text = obj.text || 'APPROVED';
  ctx.save();
  ctx.globalAlpha = obj.opacity ?? 0.9;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.5, (obj.strokeWidth || 2));
  const inset = ctx.lineWidth / 2 + 1;
  ctx.strokeRect(obj.x + inset, obj.y + inset, obj.w - inset * 2, obj.h - inset * 2);
  ctx.strokeRect(obj.x + inset + 3, obj.y + inset + 3, obj.w - (inset + 3) * 2, obj.h - (inset + 3) * 2);
  let size = obj.fontSize || Math.min(17, obj.h * 0.34);
  ctx.font = `700 ${size}px ${fontStack('Helvetica')}`;
  while (ctx.measureText(text).width > obj.w - 20 && size > 6) {
    size -= 1;
    ctx.font = `700 ${size}px ${fontStack('Helvetica')}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, obj.x + obj.w / 2, obj.y + obj.h / 2 + 0.5);
  ctx.restore();
}

function drawSigBox(ctx, obj) {
  const color = '#b0522b';
  ctx.save();
  ctx.globalAlpha = obj.opacity ?? 1;
  ctx.fillStyle = 'rgba(176, 82, 43, .045)';
  ctx.fillRect(obj.x, obj.y, obj.w, obj.h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(obj.x + 1, obj.y + 1, obj.w - 2, obj.h - 2);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(125, 53, 23, .78)';
  ctx.font = `600 ${Math.min(11, obj.h * 0.22)}px ${fontStack('Helvetica')}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(obj.label || 'Sign here', obj.x + obj.w / 2, obj.y + obj.h * 0.36);
  const cy = obj.y + obj.h * 0.68;
  ctx.strokeStyle = 'rgba(176, 82, 43, .65)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(obj.x + obj.w * 0.2, cy + 3);
  ctx.bezierCurveTo(
    obj.x + obj.w * 0.3, cy - 8,
    obj.x + obj.w * 0.38, cy + 8,
    obj.x + obj.w * 0.47, cy - 2
  );
  ctx.bezierCurveTo(
    obj.x + obj.w * 0.55, cy - 9,
    obj.x + obj.w * 0.6, cy + 5,
    obj.x + obj.w * 0.7, cy
  );
  ctx.stroke();
  ctx.restore();
}

export function paintOverlay(ctx, obj, pageIndex) {
  if (!obj || obj.id === S.editingId) return;
  const opacity = obj.opacity ?? 1;
  ctx.save();
  ctx.globalAlpha = opacity;

  switch (obj.type) {
    case 'text':
    case 'date':
    case 'note': {
      if (obj.type === 'note') {
        ctx.fillStyle = obj.background || '#fff3bf';
        ctx.strokeStyle = obj.border || '#e2c35b';
        ctx.lineWidth = 1;
        roundRect(ctx, obj.x, obj.y, obj.w, obj.h, 4);
        ctx.fill();
        ctx.stroke();
        ctx.save();
        ctx.fillStyle = 'rgba(139, 111, 30, .10)';
        ctx.beginPath();
        ctx.moveTo(obj.x + obj.w - 13, obj.y);
        ctx.lineTo(obj.x + obj.w, obj.y + 13);
        ctx.lineTo(obj.x + obj.w, obj.y);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.translate(obj.x, obj.y);
      drawTextBlock(ctx, obj, obj.w, obj.h);
      break;
    }
    case 'highlight': {
      ctx.fillStyle = obj.color || '#f1c860';
      for (const rect of obj.rects || [obj]) {
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      }
      break;
    }
    case 'underline':
    case 'strike': {
      ctx.strokeStyle = obj.color || '#b0522b';
      ctx.lineWidth = obj.strokeWidth || 1.4;
      for (const rect of obj.rects || [obj]) {
        const y = obj.type === 'underline' ? rect.y + rect.h - 1.2 : rect.y + rect.h * 0.56;
        ctx.beginPath();
        ctx.moveTo(rect.x, y);
        ctx.lineTo(rect.x + rect.w, y);
        ctx.stroke();
      }
      break;
    }
    case 'ink':
      drawInk(ctx, obj);
      break;
    case 'rect':
    case 'ellipse': {
      ctx.strokeStyle = obj.stroke || '#b0522b';
      ctx.fillStyle = obj.fill && obj.fill !== 'transparent' ? obj.fill : 'transparent';
      ctx.lineWidth = obj.strokeWidth || 2;
      if (obj.type === 'rect') {
        if (ctx.fillStyle !== 'transparent') ctx.fillRect(obj.x, obj.y, obj.w, obj.h);
        ctx.strokeRect(obj.x, obj.y, obj.w, obj.h);
      } else {
        ctx.beginPath();
        ctx.ellipse(obj.x + obj.w / 2, obj.y + obj.h / 2, obj.w / 2, obj.h / 2, 0, 0, Math.PI * 2);
        if (ctx.fillStyle !== 'transparent') ctx.fill();
        ctx.stroke();
      }
      break;
    }
    case 'line':
    case 'arrow': {
      const p1 = obj.p1 || { x: obj.x, y: obj.y };
      const p2 = obj.p2 || { x: obj.x + obj.w, y: obj.y + obj.h };
      ctx.strokeStyle = obj.stroke || '#b0522b';
      ctx.lineWidth = obj.strokeWidth || 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      if (obj.type === 'arrow') drawArrowHead(ctx, p1, p2, Math.max(7, (obj.strokeWidth || 2) * 4));
      break;
    }
    case 'redact': {
      ctx.fillStyle = obj.fill || '#000000';
      ctx.fillRect(obj.x, obj.y, obj.w, obj.h);
      break;
    }
    case 'whiteout': {
      ctx.fillStyle = obj.fill || '#ffffff';
      ctx.fillRect(obj.x, obj.y, obj.w, obj.h);
      break;
    }
    case 'stamp':
      drawStamp(ctx, obj);
      break;
    case 'sigbox':
      drawSigBox(ctx, obj);
      break;
    case 'signature':
    case 'initials':
    case 'image': {
      const img = imageFor(obj.src, pageIndex);
      if (img) {
        ctx.drawImage(img, obj.x, obj.y, obj.w, obj.h);
      } else {
        ctx.fillStyle = 'rgba(0, 0, 0, .04)';
        ctx.fillRect(obj.x, obj.y, obj.w, obj.h);
        ctx.strokeStyle = 'rgba(120, 105, 85, .35)';
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(obj.x, obj.y, obj.w, obj.h);
      }
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function paintForms(ctx, pageIndex) {
  if (!S.formFields?.length) return;
  const fields = S.formFields.filter((field) => field.page === pageIndex);
  if (!fields.length) return;
  for (const field of fields) {
    if (!field.rect || field.rect.w < 1 || field.rect.h < 1) continue;
    const { x, y, w, h } = field.rect;
    const value = Object.prototype.hasOwnProperty.call(S.formValues, field.name)
      ? S.formValues[field.name]
      : field.value;
    ctx.save();
    if (field.type === 'Btn') {
      if (field.radio) {
        ctx.beginPath();
        ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2 - 1, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,.9)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(90, 104, 120, .65)';
        ctx.lineWidth = 1;
        ctx.stroke();
        if (value === field.buttonValue || value === true) {
          ctx.beginPath();
          ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2 - 5, 0, Math.PI * 2);
          ctx.fillStyle = '#3f6d94';
          ctx.fill();
        }
      } else {
        ctx.fillStyle = 'rgba(255,255,255,.92)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(90, 104, 120, .65)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        if (value === true || value === field.buttonValue || value === 'true') {
          ctx.strokeStyle = '#3f6d94';
          ctx.lineWidth = Math.max(1.3, Math.min(w, h) * 0.16);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x + w * 0.22, y + h * 0.52);
          ctx.lineTo(x + w * 0.43, y + h * 0.73);
          ctx.lineTo(x + w * 0.79, y + h * 0.27);
          ctx.stroke();
        }
      }
    } else if (field.type === 'Sig') {
      ctx.fillStyle = 'rgba(255, 252, 246, .86)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(160, 120, 80, .55)';
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(120, 85, 50, .55)';
      ctx.font = `10px ${fontStack('Helvetica')}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(value ? String(value) : 'Signature', x + w / 2, y + h / 2);
    } else {
      ctx.fillStyle = 'rgba(255, 253, 248, .92)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(90, 104, 120, .55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      if (value !== undefined && value !== null && value !== '') {
        const text = String(value);
        let size = Math.min(12, Math.max(6, h * 0.58));
        ctx.font = `${size}px ${fontStack('Helvetica')}`;
        while (ctx.measureText(text).width > w - 8 && size > 5) {
          size -= 0.5;
          ctx.font = `${size}px ${fontStack('Helvetica')}`;
        }
        ctx.fillStyle = '#25303b';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(text, x + 4, y + h / 2 + 0.5, w - 8);
      }
      if (field.type === 'Ch') {
        ctx.strokeStyle = 'rgba(70, 90, 110, .7)';
        ctx.beginPath();
        ctx.moveTo(x + w - 12, y + h / 2 - 2);
        ctx.lineTo(x + w - 8, y + h / 2 + 2);
        ctx.lineTo(x + w - 4, y + h / 2 - 2);
        ctx.stroke();
      }
    }
    if (S.tool === 'forms') {
      ctx.strokeStyle = 'rgba(176, 82, 43, .62)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(x - 1.5, y - 1.5, w + 3, h + 3);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }
}

export function paintPage(ctx, pageIndex, scale, { selection = true, search = true, zoom = scale, clear = true } = {}) {
  const meta = pageMeta(pageIndex);
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  if (clear) ctx.clearRect(0, 0, meta.viewW, meta.viewH);
  paintForms(ctx, pageIndex);

  const list = S.overlays.get(pageIndex) || [];
  for (const obj of list) paintOverlay(ctx, obj, pageIndex);

  if (search && S.search.highlights?.has(pageIndex)) {
    const rects = S.search.highlights.get(pageIndex);
    for (const rect of rects) {
      ctx.save();
      ctx.globalAlpha = 0.24;
      ctx.fillStyle = '#e7b23e';
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = 'rgba(173, 114, 20, .8)';
      ctx.lineWidth = 1 / zoom;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.restore();
    }
  }

  if (selection) {
    const selected = selectedOverlay();
    if (selected && S.selected?.page === pageIndex) {
      drawSelection(ctx, selected, zoom);
    }
  }
  ctx.restore();
}

function drawSelection(ctx, obj, zoom) {
  const hs = 7 / zoom;
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.2 / zoom;
  ctx.setLineDash([]);
  ctx.strokeRect(obj.x, obj.y, obj.w, obj.h);
  if (obj.type === 'highlight' || obj.type === 'underline' || obj.type === 'strike') {
    ctx.restore();
    return;
  }
  const handles = handlePoints(obj);
  ctx.fillStyle = '#fffdf8';
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.3 / zoom;
  for (const handle of handles) {
    ctx.beginPath();
    ctx.rect(handle.x - hs / 2, handle.y - hs / 2, hs, hs);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

export function handlePoints(obj) {
  const { x, y, w, h } = obj;
  return [
    { name: 'nw', x, y },
    { name: 'n', x: x + w / 2, y },
    { name: 'ne', x: x + w, y },
    { name: 'e', x: x + w, y: y + h / 2 },
    { name: 'se', x: x + w, y: y + h },
    { name: 's', x: x + w / 2, y: y + h },
    { name: 'sw', x, y: y + h },
    { name: 'w', x, y: y + h / 2 },
  ];
}
