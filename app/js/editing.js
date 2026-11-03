import {
  S,
  pageMeta,
  overlaysFor,
  addOverlay,
  removeOverlay,
  findOverlay,
  selectedOverlay,
  markDirty,
  clone,
  uid,
} from './state.js';
import * as History from './history.js';
import { $, $$, icon, toast, clamp, menu, formatDate } from './ui.js';
import { openSignatureDialog, openInitialsDialog } from './signature.js';
import { textBlockHeight, canvasFont, fontStack, handlePoints } from './paint.js';
import { repaintPage, repaintAll, updateStatusbar, flashPage, setFormValue } from './workspace.js';

const measureCanvas = document.createElement('canvas');
const measureCtx = measureCanvas.getContext('2d');
const MIN_SIZE = 12;

let initialized = false;
let gesture = null;
let lastSelection = null;

/* ============================== helpers ============================== */

export function ensureEditable() {
  if (!S.pdfjs) return false;
  if (!S.editable) {
    toast('This document is protected, so it can be read but not edited.', 'warning');
    return false;
  }
  return true;
}

function pageFromEvent(event) {
  const shell = event.target.closest?.('.page-shell');
  if (!shell) return null;
  const index = Number(shell.dataset.page);
  const pageEl = shell.querySelector('.page');
  const canvas = shell.querySelector('.annotation-canvas');
  if (!pageEl || !canvas || !Number.isFinite(index)) return null;
  return { shell, pageEl, canvas, index };
}

function pointInPage(event, pageEl) {
  const rect = pageEl.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / S.zoom,
    y: (event.clientY - rect.top) / S.zoom,
  };
}

export function overlayBounds(obj) {
  if (obj.type === 'ink' && obj.points?.length) {
    const xs = obj.points.map((p) => p.x);
    const ys = obj.points.map((p) => p.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
  }
  return { x: obj.x, y: obj.y, w: obj.w, h: obj.h };
}

function hitTest(pageIndex, point, { handles = false } = {}) {
  const list = overlaysFor(pageIndex);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const obj = list[i];
    if (obj.hidden) continue;
    const b = overlayBounds(obj);
    const pad = obj.type === 'ink' ? Math.max(6, (obj.strokeWidth || 2) / 2 + 3) : 4;
    if (
      point.x >= b.x - pad &&
      point.x <= b.x + b.w + pad &&
      point.y >= b.y - pad &&
      point.y <= b.y + b.h + pad
    ) {
      return obj;
    }
  }
  if (handles) {
    const selected = selectedOverlay();
    if (selected && S.selected?.page === pageIndex) {
      const tolerance = 9 / S.zoom;
      for (const handle of handlePoints(selected)) {
        if (Math.abs(point.x - handle.x) <= tolerance && Math.abs(point.y - handle.y) <= tolerance) {
          return { handle: handle.name, target: selected };
        }
      }
    }
  }
  return null;
}

export function selectOverlay(pageIndex, id) {
  if (pageIndex === null || id === null) {
    if (S.selected) {
      const old = S.selected.page;
      S.selected = null;
      repaintPage(old);
    }
    S.selected = null;
    document.dispatchEvent(new CustomEvent('pdfstudio:selection'));
    return;
  }
  S.selected = { page: pageIndex, id };
  repaintPage(pageIndex);
  document.dispatchEvent(new CustomEvent('pdfstudio:selection'));
  document.dispatchEvent(new CustomEvent('pdfstudio:refresh'));
}

export function selectionPage() {
  return S.selected?.page ?? S.currentPage;
}

function baseOverlay(type, x, y, w, h, extra = {}) {
  return {
    id: uid(),
    type,
    x,
    y,
    w,
    h,
    opacity: S.opts.opacity ?? 1,
    ...extra,
  };
}

function addWithHistory(pageIndex, overlay, { select = true } = {}) {
  History.push('annotations');
  addOverlay(pageIndex, overlay);
  markDirty();
  if (select) selectOverlay(pageIndex, overlay.id);
  repaintPage(pageIndex);
  updateStatusbar();
  return overlay;
}

/* ============================== boot ============================== */

export function initEditing() {
  if (initialized) return;
  initialized = true;
  const pages = $('#pages');
  pages.addEventListener('pointerdown', onPointerDown);
  pages.addEventListener('dblclick', onDoubleClick);
  pages.addEventListener('contextmenu', onContextMenu);
  pages.addEventListener('keydown', () => {});
  document.addEventListener('pdfstudio:toolchange', () => {
    cancelGesture();
    document.body.classList.toggle('text-pick', ['text-pick', 'highlight', 'underline', 'strike'].includes(S.tool));
  });
  document.addEventListener('pdfstudio:delete-selection', deleteSelection);
  document.addEventListener('pdfstudio:duplicate-selection', duplicateSelection);
  document.addEventListener('pdfstudio:select-all-text', selectPageText);
}

export function setTool(toolId) {
  if (!S.pdfjs) return;
  if (!S.editable) {
    toast('Editing is unavailable for this document.', 'warning');
    return;
  }
  if (S.mode !== 'edit') return;
  S.tool = toolId;
  cancelGesture();
  document.body.classList.toggle('text-pick', ['text-pick', 'highlight', 'underline', 'strike'].includes(toolId));
  document.body.dataset.tool = toolId;
  $$('#toolrail .tool-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.tool === toolId);
  });
  if (toolId !== 'select') selectOverlay(null, null);
  repaintAll();
  document.dispatchEvent(new CustomEvent('pdfstudio:toolchange', { detail: { tool: toolId } }));
  document.dispatchEvent(new CustomEvent('pdfstudio:refresh'));
  updateStatusbar();
}

export function getTool() {
  return S.tool;
}

/* ============================== pointer ============================== */

function onPointerDown(event) {
  if (event.button !== 0) return;
  if (S.mode !== 'edit') return;
  if (!ensureEditable()) return;
  const target = pageFromEvent(event);
  if (!target) return;
  const { pageEl, canvas, index } = target;
  const point = pointInPage(event, pageEl);
  const tool = S.tool;

  if (tool === 'select') {
    event.preventDefault();
    const hit = hitTest(index, point, { handles: true });
    if (hit?.target) {
      startResize(event, canvas, pageEl, index, hit.target, hit.handle);
      return;
    }
    if (hit) {
      if (event.shiftKey) {
        selectOverlay(index, hit.id);
      } else {
        selectOverlay(index, hit.id);
      }
      startDrag(event, canvas, pageEl, index, hit);
      return;
    }
    selectOverlay(null, null);
    return;
  }

  if (['text-pick', 'highlight', 'underline', 'strike'].includes(tool)) {
    event.preventDefault();
    startTextSelection(event, pageEl, index, tool);
    return;
  }

  if (tool === 'forms') {
    const field = formAt(index, point);
    if (field) {
      event.preventDefault();
      openFormEditor(field, pageEl, index);
      return;
    }
  }

  if (tool === 'eraser') {
    event.preventDefault();
    startErase(event, canvas, pageEl, index, point);
    return;
  }

  event.preventDefault();
  if (tool === 'ink') {
    startInk(event, canvas, pageEl, index, point);
    return;
  }
  if (tool === 'shape' || tool === 'redact' || tool === 'whiteout') {
    startDraw(event, canvas, pageEl, index, point);
    return;
  }
  if (tool === 'highlight' || tool === 'underline' || tool === 'strike') return;

  createAt(tool, index, point).catch((error) => {
    if (error) toast(error.message || 'Could not add that element.', 'error');
  });
}

function createAt(tool, pageIndex, point) {
  const meta = pageMeta(pageIndex);
  const px = clamp(point.x, 0, meta.viewW);
  const py = clamp(point.y, 0, meta.viewH);

  switch (tool) {
    case 'text':
      return createText(pageIndex, px, py, false);
    case 'note':
      return createText(pageIndex, px, py, true);
    case 'date':
      return createDate(pageIndex, px, py);
    case 'sigbox':
      return createSigBox(pageIndex, px, py);
    case 'stamp':
      return createStamp(pageIndex, px, py);
    case 'signature':
      return createSignature(pageIndex, px, py, false);
    case 'initials':
      return createSignature(pageIndex, px, py, true);
    case 'image':
      return createImage(pageIndex, px, py);
    default:
      return Promise.resolve(null);
  }
}

/* ============================== creation ============================== */

function createText(pageIndex, x, y, note) {
  const meta = pageMeta(pageIndex);
  const w = note ? Math.min(170, meta.viewW - 20) : Math.min(230, meta.viewW - 20);
  const fontSize = note ? Math.max(10, S.opts.textSize) : S.opts.textSize;
  measureCtx.font = `400 ${fontSize}px ${fontStack(S.opts.textFont)}`;
  const h = note ? 84 : textBlockHeight(measureCtx, { type: 'text', fontSize, text: 'Text' }, w);
  const overlay = baseOverlay(note ? 'note' : 'text', clamp(x, 6, meta.viewW - w - 6), clamp(y, 6, meta.viewH - h - 6), w, Math.max(h, note ? 84 : 24), {
    text: note ? 'Note' : 'Text',
    fontSize,
    fontFamily: S.opts.textFont,
    bold: S.opts.textBold,
    align: S.opts.textAlign,
    color: note ? '#3b3217' : S.opts.textColor,
    background: S.opts.noteColor,
    border: '#e2c35b',
    lineHeight: 1.3,
  });
  const before = History.snapshot('annotations');
  addOverlay(pageIndex, overlay);
  markDirty();
  selectOverlay(pageIndex, overlay.id);
  repaintPage(pageIndex);
  updateStatusbar();
  openTextEditor(overlay, pageIndex, { before, isNew: true });
  return Promise.resolve(overlay);
}

function createDate(pageIndex, x, y) {
  const meta = pageMeta(pageIndex);
  const text = formatDate(new Date(), S.opts.dateFormat || 'MMM D, YYYY');
  measureCtx.font = `400 ${S.opts.textSize}px ${fontStack(S.opts.textFont)}`;
  const w = Math.min(meta.viewW - 20, Math.max(96, measureCtx.measureText(text).width + 12));
  const h = Math.max(20, S.opts.textSize * 1.7);
  const overlay = baseOverlay('date', clamp(x, 6, meta.viewW - w - 6), clamp(y, 6, meta.viewH - h - 6), w, h, {
    text,
    fontSize: S.opts.textSize,
    fontFamily: S.opts.textFont,
    bold: false,
    align: 'left',
    color: S.opts.textColor,
    lineHeight: 1.25,
  });
  addWithHistory(pageIndex, overlay);
  return Promise.resolve(overlay);
}

function createSigBox(pageIndex, x, y) {
  const meta = pageMeta(pageIndex);
  const w = Math.min(200, meta.viewW - 16);
  const h = 62;
  const overlay = baseOverlay('sigbox', clamp(x - w / 2, 6, meta.viewW - w - 6), clamp(y - h / 2, 6, meta.viewH - h - 6), w, h, {
    label: S.opts.signHereLabel || 'Sign here',
  });
  addWithHistory(pageIndex, overlay);
  return Promise.resolve(overlay);
}

function createStamp(pageIndex, x, y) {
  const meta = pageMeta(pageIndex);
  const w = 148;
  const h = 56;
  const overlay = baseOverlay('stamp', clamp(x - w / 2, 6, meta.viewW - w - 6), clamp(y - h / 2, 6, meta.viewH - h - 6), w, h, {
    text: S.opts.stampPreset,
    color: S.opts.stampColor,
    strokeWidth: 2,
    opacity: 0.92,
  });
  addWithHistory(pageIndex, overlay);
  return Promise.resolve(overlay);
}

async function createSignature(pageIndex, x, y, initials) {
  let signature = S.activeSignature;
  if (initials) {
    const result = await openInitialsDialog();
    if (!result) return null;
    signature = { dataUrl: result.dataUrl, aspect: result.aspect, kind: 'typed', id: uid() };
  } else if (!signature) {
    signature = await openSignatureDialog();
    if (!signature) return null;
  }
  const meta = pageMeta(pageIndex);
  const aspect = signature.aspect || 3.1;
  const w = Math.min(S.opts.sigWidth || 180, meta.viewW - 16);
  const h = Math.max(24, w / aspect);
  const overlay = baseOverlay(initials ? 'initials' : 'signature', clamp(x - w / 2, 6, meta.viewW - w - 6), clamp(y - h / 2, 6, meta.viewH - h - 6), w, h, {
    src: signature.dataUrl,
    aspect,
    opacity: 1,
  });
  addWithHistory(pageIndex, overlay);
  if (!initials) S.activeSignature = signature;
  return overlay;
}

function createImage(pageIndex, x, y) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const meta = pageMeta(pageIndex);
          const maxW = Math.min(280, meta.viewW - 20);
          const ratio = img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
          let w = maxW;
          let h = w / ratio;
          if (h > meta.viewH * 0.5) {
            h = meta.viewH * 0.5;
            w = h * ratio;
          }
          const overlay = baseOverlay('image', clamp(x - w / 2, 6, meta.viewW - w - 6), clamp(y - h / 2, 6, meta.viewH - h - 6), w, h, {
            src: reader.result,
            aspect: ratio,
          });
          addWithHistory(pageIndex, overlay);
          resolve(overlay);
        };
        img.onerror = () => reject(new Error('That image could not be read.'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('That image could not be read.'));
      reader.readAsDataURL(file);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/* ============================== gestures ============================== */

function startDrag(event, canvas, pageEl, pageIndex, overlay) {
  const start = pointInPage(event, pageEl);
  const before = History.snapshot('annotations');
  gesture = {
    kind: 'move',
    canvas,
    pageEl,
    pageIndex,
    overlay,
    start,
    before,
    origin: clone(overlay),
    moved: false,
    pointerId: event.pointerId,
  };
  canvas.setPointerCapture(event.pointerId);
  canvas.addEventListener('pointermove', onGestureMove);
  canvas.addEventListener('pointerup', onGestureEnd);
  canvas.addEventListener('pointercancel', onGestureEnd);
}

function startResize(event, canvas, pageEl, pageIndex, overlay, handle) {
  const start = pointInPage(event, pageEl);
  gesture = {
    kind: 'resize',
    canvas,
    pageEl,
    pageIndex,
    overlay,
    handle,
    start,
    before: History.snapshot('annotations'),
    origin: clone(overlay),
    moved: false,
    pointerId: event.pointerId,
  };
  canvas.setPointerCapture(event.pointerId);
  canvas.addEventListener('pointermove', onGestureMove);
  canvas.addEventListener('pointerup', onGestureEnd);
  canvas.addEventListener('pointercancel', onGestureEnd);
}

function startInk(event, canvas, pageEl, pageIndex, point) {
  const before = History.snapshot('annotations');
  const overlay = baseOverlay('ink', point.x, point.y, 0, 0, {
    points: [{ x: point.x, y: point.y }],
    color: S.opts.inkColor,
    strokeWidth: S.opts.inkWidth,
    opacity: 1,
    mode: S.opts.inkMode,
  });
  addOverlay(pageIndex, overlay);
  gesture = {
    kind: 'ink',
    canvas,
    pageEl,
    pageIndex,
    overlay,
    before,
    last: point,
    pointerId: event.pointerId,
    shiftStart: point,
  };
  canvas.setPointerCapture(event.pointerId);
  canvas.addEventListener('pointermove', onGestureMove);
  canvas.addEventListener('pointerup', onGestureEnd);
  canvas.addEventListener('pointercancel', onGestureEnd);
  repaintPage(pageIndex);
}

function startDraw(event, canvas, pageEl, pageIndex, point) {
  const tool = S.tool;
  const before = History.snapshot('annotations');
  let overlay;
  if (tool === 'redact') {
    overlay = baseOverlay('redact', point.x, point.y, 0, 0, { fill: S.opts.redactFill || '#000000', opacity: 1 });
  } else if (tool === 'whiteout') {
    overlay = baseOverlay('whiteout', point.x, point.y, 0, 0, { fill: '#ffffff', opacity: 1 });
  } else {
    const type = S.opts.shapeType;
    overlay = baseOverlay(type, point.x, point.y, 0, 0, {
      stroke: S.opts.shapeStroke,
      fill: S.opts.shapeFill === 'transparent' ? 'transparent' : S.opts.shapeFill,
      strokeWidth: S.opts.shapeWidth,
      opacity: 1,
      p1: { x: point.x, y: point.y },
      p2: { x: point.x, y: point.y },
    });
  }
  addOverlay(pageIndex, overlay);
  gesture = {
    kind: 'draw',
    canvas,
    pageEl,
    pageIndex,
    overlay,
    before,
    start: point,
    pointerId: event.pointerId,
    shift: event.shiftKey,
  };
  canvas.setPointerCapture(event.pointerId);
  canvas.addEventListener('pointermove', onGestureMove);
  canvas.addEventListener('pointerup', onGestureEnd);
  canvas.addEventListener('pointercancel', onGestureEnd);
}

function startErase(event, canvas, pageEl, pageIndex, point) {
  const hit = hitTest(pageIndex, point);
  gesture = {
    kind: 'erase',
    canvas,
    pageEl,
    pageIndex,
    before: History.snapshot('annotations'),
    erased: 0,
    pointerId: event.pointerId,
  };
  canvas.setPointerCapture(event.pointerId);
  canvas.addEventListener('pointermove', onGestureMove);
  canvas.addEventListener('pointerup', onGestureEnd);
  canvas.addEventListener('pointercancel', onGestureEnd);
  if (hit) eraseOverlay(pageIndex, hit);
}

function eraseOverlay(pageIndex, overlay) {
  if (!overlay) return;
  removeOverlay(pageIndex, overlay.id);
  if (gesture?.kind === 'erase') gesture.erased += 1;
  markDirty();
  repaintPage(pageIndex);
  document.dispatchEvent(new CustomEvent('pdfstudio:selection'));
  document.dispatchEvent(new CustomEvent('pdfstudio:refresh'));
}

function onGestureMove(event) {
  if (!gesture) return;
  const point = pointInPage(event, gesture.pageEl);
  const { overlay, pageIndex } = gesture;
  const meta = pageMeta(pageIndex);

  if (gesture.kind === 'move') {
    const dx = point.x - gesture.start.x;
    const dy = point.y - gesture.start.y;
    if (Math.abs(dx) > 0.4 || Math.abs(dy) > 0.4) gesture.moved = true;
    applyGeometry(overlay, gesture.origin, {
      x: gesture.origin.x + dx,
      y: gesture.origin.y + dy,
      w: gesture.origin.w,
      h: gesture.origin.h,
    });
  } else if (gesture.kind === 'resize') {
    gesture.moved = true;
    const origin = gesture.origin;
    let x = origin.x;
    let y = origin.y;
    let w = origin.w;
    let h = origin.h;
    const dx = point.x - gesture.start.x;
    const dy = point.y - gesture.start.y;
    const handle = gesture.handle;
    if (handle.includes('w')) {
      x = Math.min(origin.x + dx, origin.x + origin.w - MIN_SIZE);
      w = origin.x + origin.w - x;
    }
    if (handle.includes('e')) w = Math.max(MIN_SIZE, origin.w + dx);
    if (handle.includes('n')) {
      y = Math.min(origin.y + dy, origin.y + origin.h - MIN_SIZE);
      h = origin.y + origin.h - y;
    }
    if (handle.includes('s')) h = Math.max(MIN_SIZE, origin.h + dy);
    if (event.shiftKey) {
      const ratio = origin.h ? origin.w / origin.h : 1;
      h = Math.max(MIN_SIZE, w / ratio);
    }
    applyGeometry(overlay, origin, { x, y, w, h });
  } else if (gesture.kind === 'ink') {
    if (S.opts.inkMode === 'line' || event.shiftKey) {
      overlay.points = [gesture.shiftStart, { x: point.x, y: point.y }];
    } else {
      const last = gesture.last;
      if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 1.1) {
        overlay.points.push({ x: point.x, y: point.y });
        gesture.last = point;
      }
    }
    fitInkBounds(overlay);
    requestRepaint(pageIndex);
  } else if (gesture.kind === 'draw') {
    let ex = point.x;
    let ey = point.y;
    if (event.shiftKey) {
      const dx = ex - gesture.start.x;
      const dy = ey - gesture.start.y;
      if (Math.abs(dx) > Math.abs(dy)) ey = gesture.start.y;
      else ex = gesture.start.x;
    }
    if (overlay.type === 'line' || overlay.type === 'arrow') {
      overlay.p1 = { x: gesture.start.x, y: gesture.start.y };
      overlay.p2 = { x: ex, y: ey };
      overlay.x = Math.min(overlay.p1.x, overlay.p2.x);
      overlay.y = Math.min(overlay.p1.y, overlay.p2.y);
      overlay.w = Math.abs(overlay.p2.x - overlay.p1.x);
      overlay.h = Math.abs(overlay.p2.y - overlay.p1.y);
    } else {
      overlay.x = Math.min(gesture.start.x, ex);
      overlay.y = Math.min(gesture.start.y, ey);
      overlay.w = Math.abs(ex - gesture.start.x);
      overlay.h = Math.abs(ey - gesture.start.y);
    }
    requestRepaint(pageIndex);
  } else if (gesture.kind === 'erase') {
    if (event.buttons !== 1) return;
    const hit = hitTest(pageIndex, point);
    if (hit && !gesture.erasedIds?.has(hit.id)) {
      gesture.erasedIds = gesture.erasedIds || new Set();
      gesture.erasedIds.add(hit.id);
      eraseOverlay(pageIndex, hit);
    }
  }
  if (gesture && overlay) {
    overlay.x = clamp(overlay.x, -overlay.w * 0.5, meta.viewW);
    overlay.y = clamp(overlay.y, -overlay.h * 0.5, meta.viewH);
    repaintPage(pageIndex);
  }
}

function onGestureEnd() {
  if (!gesture) return;
  const state = gesture;
  gesture = null;
  const { canvas } = state;
  canvas.removeEventListener('pointermove', onGestureMove);
  canvas.removeEventListener('pointerup', onGestureEnd);
  canvas.removeEventListener('pointercancel', onGestureEnd);
  try {
    canvas.releasePointerCapture(state.pointerId);
  } catch {
    /* ignore */
  }

  if (state.kind === 'draw') {
    if (state.overlay.w < 3 && state.overlay.h < 3) {
      removeOverlay(state.pageIndex, state.overlay.id);
      repaintPage(state.pageIndex);
      return;
    }
    History.commit(state.before);
    markDirty();
    selectOverlay(state.pageIndex, state.overlay.id);
  } else if (state.kind === 'ink') {
    if ((state.overlay.points?.length || 0) < 2 && state.overlay.w < 2) {
      removeOverlay(state.pageIndex, state.overlay.id);
      repaintPage(state.pageIndex);
      return;
    }
    fitInkBounds(state.overlay);
    History.commit(state.before);
    markDirty();
    selectOverlay(state.pageIndex, state.overlay.id);
  } else if (state.kind === 'erase') {
    if (state.erased) History.commit(state.before);
  } else if (state.moved) {
    History.commit(state.before);
    markDirty();
    selectOverlay(state.pageIndex, state.overlay.id);
  }
  repaintPage(state.pageIndex);
  updateStatusbar();
  document.dispatchEvent(new CustomEvent('pdfstudio:refresh'));
}

function cancelGesture() {
  if (!gesture) return;
  const state = gesture;
  gesture = null;
  state.canvas?.removeEventListener('pointermove', onGestureMove);
  state.canvas?.removeEventListener('pointerup', onGestureEnd);
  state.canvas?.removeEventListener('pointercancel', onGestureEnd);
}

let repaintHandle = 0;
function requestRepaint(pageIndex) {
  if (repaintHandle) return;
  repaintHandle = requestAnimationFrame(() => {
    repaintHandle = 0;
    repaintPage(pageIndex);
  });
}

export function fitInkBounds(overlay) {
  if (!overlay?.points?.length) return;
  const xs = overlay.points.map((p) => p.x);
  const ys = overlay.points.map((p) => p.y);
  overlay.x = Math.min(...xs);
  overlay.y = Math.min(...ys);
  overlay.w = Math.max(1, Math.max(...xs) - overlay.x);
  overlay.h = Math.max(1, Math.max(...ys) - overlay.y);
}

export function applyGeometry(target, origin, bounds) {
  const w = Math.max(1, bounds.w);
  const h = Math.max(1, bounds.h);
  const sx = origin.w ? w / origin.w : 1;
  const sy = origin.h ? h / origin.h : 1;
  target.x = bounds.x;
  target.y = bounds.y;
  target.w = w;
  target.h = h;
  if (origin.points) {
    target.points = origin.points.map((p) => ({
      x: bounds.x + (p.x - origin.x) * sx,
      y: bounds.y + (p.y - origin.y) * sy,
    }));
  }
  if (origin.rects) {
    target.rects = origin.rects.map((r) => ({
      x: bounds.x + (r.x - origin.x) * sx,
      y: bounds.y + (r.y - origin.y) * sy,
      w: r.w * sx,
      h: r.h * sy,
    }));
  }
  if (origin.p1) {
    target.p1 = { x: bounds.x + (origin.p1.x - origin.x) * sx, y: bounds.y + (origin.p1.y - origin.y) * sy };
    target.p2 = { x: bounds.x + (origin.p2.x - origin.x) * sx, y: bounds.y + (origin.p2.y - origin.y) * sy };
  }
  if (target.type === 'text' || target.type === 'note' || target.type === 'date') {
    const factor = Math.min(2.4, Math.max(0.45, sy));
    target.wrappedAt = target.fontSize;
    if (Math.abs(factor - 1) > 0.14) target.fontSize = Math.max(5, (origin.fontSize || 12) * factor);
  }
}

/* ============================== text selection ============================== */

function caretRange(x, y) {
  try {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    const pos = document.caretPositionFromPoint?.(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  } catch {
    return null;
  }
}

function startTextSelection(event, pageEl, pageIndex, tool) {
  const canvas = pageEl.querySelector('.annotation-canvas');
  const textLayer = pageEl.querySelector('.text-layer');
  canvas.style.pointerEvents = 'none';
  textLayer.style.pointerEvents = 'auto';
  const startRange = caretRange(event.clientX, event.clientY);
  if (!startRange || !pageEl.contains(startRange.startContainer)) {
    canvas.style.pointerEvents = '';
    return;
  }
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(startRange);
  const anchorNode = startRange.startContainer;
  const anchorOffset = startRange.startOffset;
  let rects = [];
  let text = '';

  const move = (moveEvent) => {
    const range = caretRange(moveEvent.clientX, moveEvent.clientY);
    if (!range || !pageEl.contains(range.startContainer)) return;
    if (selection.setBaseAndExtent) {
      selection.setBaseAndExtent(anchorNode, anchorOffset, range.startContainer, range.startOffset);
    } else {
      const next = document.createRange();
      next.setStart(anchorNode, anchorOffset);
      next.setEnd(range.startContainer, range.startOffset);
      selection.removeAllRanges();
      selection.addRange(next);
    }
    if (!selection.rangeCount) return;
    const active = selection.getRangeAt(0);
    const collected = collectRects(active, pageEl);
    if (collected.length) {
      rects = collected;
      text = active.toString();
    }
  };

  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    canvas.style.pointerEvents = '';
    textLayer.style.pointerEvents = '';
    if (!rects.length) {
      selection.removeAllRanges();
      return;
    }
    lastSelection = { pageIndex, rects, text };
    if (tool === 'text-pick') {
      showSelectionToolbar(event.clientX, event.clientY);
      return;
    }
    const overlay = makeMark(tool, pageIndex, rects);
    selection.removeAllRanges();
    if (overlay) {
      History.push('annotations');
      addOverlay(pageIndex, overlay);
      markDirty();
      repaintPage(pageIndex);
      selectOverlay(pageIndex, overlay.id);
      updateStatusbar();
    }
  };

  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function collectRects(range, pageEl) {
  const pageRect = pageEl.getBoundingClientRect();
  const out = [];
  for (const r of range.getClientRects()) {
    const x = (Math.max(r.left, pageRect.left) - pageRect.left) / S.zoom;
    const y = (Math.max(r.top, pageRect.top) - pageRect.top) / S.zoom;
    const w = (Math.min(r.right, pageRect.right) - Math.max(r.left, pageRect.left)) / S.zoom;
    const h = (Math.min(r.bottom, pageRect.bottom) - Math.max(r.top, pageRect.top)) / S.zoom;
    if (w > 1.5 && h > 1) out.push({ x, y, w, h });
  }
  return mergeRects(out);
}

function mergeRects(rects) {
  const sorted = [...rects].sort((a, b) => (Math.abs(a.y - b.y) < 2 ? a.x - b.x : a.y - b.y));
  const merged = [];
  for (const rect of sorted) {
    const last = merged[merged.length - 1];
    if (
      last &&
      Math.abs(last.y - rect.y) < 2 &&
      Math.abs(last.h - rect.h) < 2 &&
      rect.x <= last.x + last.w + 3
    ) {
      const right = Math.max(last.x + last.w, rect.x + rect.w);
      last.w = right - last.x;
    } else {
      merged.push({ ...rect });
    }
  }
  return merged;
}

function makeMark(type, pageIndex, rects) {
  if (!rects.length) return null;
  const first = rects[0];
  const last = rects[rects.length - 1];
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  if (type === 'highlight') {
    return {
      id: uid(),
      type: 'highlight',
      x,
      y,
      w: right - x,
      h: bottom - y,
      rects,
      color: S.opts.highlightColor,
      opacity: S.opts.highlightOpacity ?? 0.38,
    };
  }
  return {
    id: uid(),
    type,
    x,
    y,
    w: right - x,
    h: bottom - y,
    rects,
    color: S.opts.markColor || S.opts.inkColor,
    strokeWidth: 1.4,
    opacity: 1,
  };
}

export function applyMarkToSelection(type, color) {
  if (!lastSelection) {
    toast('Select some text first — drag across it with the text tool.', 'info');
    return;
  }
  const { pageIndex, rects } = lastSelection;
  const before = History.snapshot('annotations');
  let overlay;
  if (type === 'highlight') {
    overlay = {
      id: uid(),
      type: 'highlight',
      x: Math.min(...rects.map((r) => r.x)),
      y: Math.min(...rects.map((r) => r.y)),
      w: 0,
      h: 0,
      rects: rects.map((r) => ({ ...r })),
      color: color || S.opts.highlightColor,
      opacity: S.opts.highlightOpacity ?? 0.38,
    };
    overlay.w = Math.max(...rects.map((r) => r.x + r.w)) - overlay.x;
    overlay.h = Math.max(...rects.map((r) => r.y + r.h)) - overlay.y;
  } else {
    overlay = makeMark(type, pageIndex, rects);
    if (color) overlay.color = color;
  }
  addOverlay(pageIndex, overlay);
  History.commit(before);
  markDirty();
  repaintPage(pageIndex);
  selectOverlay(pageIndex, overlay.id);
  updateStatusbar();
  hideSelectionToolbar();
  return overlay;
}

let selectionToolbar = null;

function showSelectionToolbar(x, y) {
  hideSelectionToolbar();
  const root = document.getElementById('menu-root');
  const bar = document.createElement('div');
  bar.className = 'mini-toolbar';
  bar.style.left = `${clamp(x - 90, 10, window.innerWidth - 260)}px`;
  bar.style.top = `${clamp(y + 14, 10, window.innerHeight - 50)}px`;
  bar.innerHTML = `
    <button type="button" data-mark="highlight">${icon('highlight', 14)} Highlight</button>
    <button type="button" data-mark="underline">${icon('underline', 14)}</button>
    <button type="button" data-mark="strike">${icon('strike', 14)}</button>
    <span class="mini-sep"></span>
    <button type="button" data-copy="1">${icon('copy', 14)}</button>
    <button type="button" data-clear="1">${icon('x', 14)}</button>`;
  root.append(bar);
  selectionToolbar = bar;
  bar.addEventListener('pointerdown', (event) => event.stopPropagation());
  bar.addEventListener('click', async (event) => {
    const markButton = event.target.closest('[data-mark]');
    if (markButton) {
      applyMarkToSelection(markButton.dataset.mark);
      return;
    }
    if (event.target.closest('[data-copy]')) {
      try {
        await navigator.clipboard.writeText(lastSelection?.text || '');
        toast('Copied selection.', 'success', 1600);
      } catch {
        toast('Could not copy the selection.', 'error');
      }
      hideSelectionToolbar();
    }
    if (event.target.closest('[data-clear]')) hideSelectionToolbar();
  });
  setTimeout(() => {
    document.addEventListener('pointerdown', onToolbarDismiss, true);
  }, 0);
}

function onToolbarDismiss(event) {
  if (selectionToolbar && !selectionToolbar.contains(event.target)) hideSelectionToolbar();
}

function hideSelectionToolbar() {
  if (selectionToolbar) {
    selectionToolbar.remove();
    selectionToolbar = null;
  }
  document.removeEventListener('pointerdown', onToolbarDismiss, true);
}

export function selectPageText() {
  const el = S.pageEls[S.currentPage];
  if (!el) return;
  const layer = el.textLayer;
  const range = document.createRange();
  range.selectNodeContents(layer);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const rects = collectRects(range, el.page);
  if (rects.length) lastSelection = { pageIndex: S.currentPage, rects, text: range.toString() };
}

/* ============================== text editing ============================== */

export function openTextEditor(overlay, pageIndex, { before: beforeOverride = null, isNew = false } = {}) {
  const el = S.pageEls[pageIndex];
  if (!el) return;
  closeTextEditor(true);
  S.editingId = overlay.id;
  const before = beforeOverride || History.snapshot('annotations');
  repaintPage(pageIndex);

  const area = document.createElement('textarea');
  area.className = `text-editor${overlay.type === 'note' ? ' note' : ''}`;
  area.value = overlay.text === 'Text' || overlay.text === 'Note' ? '' : overlay.text || '';
  area.spellcheck = false;
  area.style.left = `${overlay.x * S.zoom}px`;
  area.style.top = `${overlay.y * S.zoom}px`;
  area.style.width = `${Math.max(40, overlay.w * S.zoom)}px`;
  area.style.height = `${Math.max(24, overlay.h * S.zoom)}px`;
  area.style.font = canvasFont({
    ...overlay,
    fontSize: (overlay.fontSize || 12) * S.zoom,
  });
  area.style.textAlign = overlay.align || 'left';
  area.style.color = overlay.color || '#211d17';
  area.style.background = overlay.type === 'note' ? overlay.background || '#fff3bf' : 'rgba(255,253,248,.96)';
  el.page.append(area);
  let changed = false;

  const sync = () => {
    overlay.text = area.value;
    const lines = Math.max(1, area.value.split('\n').length);
    overlay.h = Math.max(20, (lines * (overlay.fontSize || 12) * (overlay.lineHeight || 1.3)) + 10);
    area.style.height = `${Math.max(24, overlay.h * S.zoom)}px`;
    repaintPage(pageIndex);
    changed = true;
  };

  area.addEventListener('input', sync);
  area.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      closeTextEditor();
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      closeTextEditor();
    }
  });
  area.addEventListener('pointerdown', (event) => event.stopPropagation());
  area.addEventListener('blur', () => closeTextEditor());
  setTimeout(() => {
    area.focus();
    if (!area.value) area.setSelectionRange(0, 0);
    else area.select();
  }, 30);

  textEditorState = { area, overlay, pageIndex, before, changed: () => changed, close: closeTextEditor };

  function closeTextEditor(immediate) {
    if (!textEditorState || textEditorState.area !== area) return;
    const state = textEditorState;
    textEditorState = null;
    S.editingId = null;
    const value = area.value.trim();
    area.remove();
    if (!value || value === 'Text' || value === 'Note') {
      removeOverlay(state.pageIndex, state.overlay.id);
      if (!isNew) History.commit(state.before);
      markDirty();
    } else {
      state.overlay.text = value;
      if (isNew || state.changed()) History.commit(state.before);
      markDirty();
    }
    selectOverlay(state.pageIndex, state.overlay.id);
    repaintPage(state.pageIndex);
    updateStatusbar();
    document.dispatchEvent(new CustomEvent('pdfstudio:refresh'));
  }
}

let textEditorState = null;

export function closeTextEditor(immediate) {
  if (textEditorState) textEditorState.close(immediate);
}

/* ============================== forms ============================== */

function formAt(pageIndex, point) {
  if (!S.formFields?.length) return null;
  const fields = S.formFields.filter((f) => f.page === pageIndex);
  for (let i = fields.length - 1; i >= 0; i -= 1) {
    const r = fields[i].rect;
    if (point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h) return fields[i];
  }
  return null;
}

function formValue(field) {
  return Object.prototype.hasOwnProperty.call(S.formValues, field.name) ? S.formValues[field.name] : field.value;
}

export function openFormEditor(field, pageEl, pageIndex) {
  const value = formValue(field);
  if (field.type === 'Btn') {
    if (field.radio) setFormValue(field, field.buttonValue || true);
    else setFormValue(field, !(value === true || value === 'true' || value === field.buttonValue));
    return;
  }
  if (field.type === 'Ch' || (field.options && field.options.length)) {
    const list = field.options?.length ? field.options : ['Yes', 'No', 'N/A'];
    const root = document.getElementById('menu-root');
    const rect = pageEl.getBoundingClientRect();
    const entries = list.map((option) => ({
      label: String(option),
      action: () => setFormValue(field, String(option)),
    }));
    menu({
      x: rect.left + field.rect.x * S.zoom,
      y: rect.top + (field.rect.y + field.rect.h) * S.zoom,
      items: [{ heading: field.name }, ...entries],
    });
    return;
  }

  document.querySelector('.form-editor')?.remove();
  const input = document.createElement(field.multiline ? 'textarea' : 'input');
  if (!field.multiline) input.type = 'text';
  input.className = 'text-editor form-editor';
  input.value = value == null ? '' : String(value);
  input.style.left = `${field.rect.x * S.zoom}px`;
  input.style.top = `${field.rect.y * S.zoom}px`;
  input.style.width = `${Math.max(40, field.rect.w * S.zoom)}px`;
  input.style.height = `${Math.max(20, field.rect.h * S.zoom)}px`;
  input.style.padding = '1px 3px';
  input.style.fontSize = `${Math.max(7, Math.min(14, field.rect.h * S.zoom * 0.6))}px`;
  input.style.background = 'rgba(255,255,255,.98)';
  pageEl.append(input);
  let committed = false;
  const before = History.snapshot('annotations');
  const commit = () => {
    if (committed) return;
    committed = true;
    const next = input.value;
    input.remove();
    if (String(value ?? '') !== String(next)) {
      History.commit(before);
      setFormValue(field, next);
    }
    repaintPage(pageIndex);
  };
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !field.multiline) {
      event.preventDefault();
      commit();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      committed = true;
      input.remove();
      repaintPage(pageIndex);
    }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('pointerdown', (event) => event.stopPropagation());
  setTimeout(() => {
    input.focus();
    input.select?.();
  }, 30);
}

/* ============================== selection actions ============================== */

export function deleteSelection() {
  const selected = selectedOverlay();
  if (!selected || !S.selected) return false;
  const before = History.snapshot('annotations');
  const pageIndex = S.selected.page;
  removeOverlay(pageIndex, selected.id);
  History.commit(before);
  markDirty();
  repaintPage(pageIndex);
  selectOverlay(null, null);
  updateStatusbar();
  return true;
}

export function duplicateSelection() {
  const selected = selectedOverlay();
  if (!selected || !S.selected) return false;
  const pageIndex = S.selected.page;
  const meta = pageMeta(pageIndex);
  const copy = { ...clone(selected), id: uid() };
  copy.x = clamp(copy.x + 14, 0, meta.viewW - copy.w);
  copy.y = clamp(copy.y + 14, 0, meta.viewH - copy.h);
  if (copy.rects) copy.rects = copy.rects.map((r) => ({ ...r, x: r.x + 14, y: r.y + 14 }));
  if (copy.points) copy.points = copy.points.map((p) => ({ x: p.x + 14, y: p.y + 14 }));
  if (copy.p1) {
    copy.p1 = { x: copy.p1.x + 14, y: copy.p1.y + 14 };
    copy.p2 = { x: copy.p2.x + 14, y: copy.p2.y + 14 };
  }
  const before = History.snapshot('annotations');
  addOverlay(pageIndex, copy);
  History.commit(before);
  markDirty();
  selectOverlay(pageIndex, copy.id);
  repaintPage(pageIndex);
  updateStatusbar();
  return true;
}

export function reorderSelection(direction) {
  const selected = selectedOverlay();
  if (!selected || !S.selected) return false;
  const list = overlaysFor(S.selected.page);
  const at = list.findIndex((o) => o.id === selected.id);
  if (at < 0) return false;
  const target = direction === 'front' ? list.length - 1 : direction === 'back' ? 0 : at + (direction === 'forward' ? 1 : -1);
  if (target === at || target < 0 || target >= list.length) return false;
  const before = History.snapshot('annotations');
  list.splice(at, 1);
  list.splice(target, 0, selected);
  History.commit(before);
  markDirty();
  repaintPage(S.selected.page);
  return true;
}

export function nudgeSelection(dx, dy) {
  const selected = selectedOverlay();
  if (!selected || !S.selected) return false;
  const before = History.snapshot('annotations');
  const pageIndex = S.selected.page;
  applyGeometry(selected, clone(selected), {
    x: selected.x + dx,
    y: selected.y + dy,
    w: selected.w,
    h: selected.h,
  });
  History.commit(before);
  markDirty();
  repaintPage(pageIndex);
  return true;
}

export function updateSelected(patch) {
  const selected = selectedOverlay();
  if (!selected || !S.selected) return;
  const before = History.snapshot('annotations');
  Object.assign(selected, patch);
  History.commit(before);
  markDirty();
  repaintPage(S.selected.page);
  updateStatusbar();
  document.dispatchEvent(new CustomEvent('pdfstudio:selection'));
}

export function openSelectedText() {
  const selected = selectedOverlay();
  if (!selected || !S.selected) return;
  if (!['text', 'note', 'date'].includes(selected.type)) return;
  openTextEditor(selected, S.selected.page);
}

/* ============================== double click / context ============================== */

function onDoubleClick(event) {
  if (S.mode !== 'edit') return;
  const target = pageFromEvent(event);
  if (!target) return;
  const point = pointInPage(event, target.pageEl);
  const hit = hitTest(target.index, point);
  if (!hit) return;
  if (['text', 'note', 'date'].includes(hit.type)) {
    event.preventDefault();
    selectOverlay(target.index, hit.id);
    openTextEditor(hit, target.index);
  }
}

function onContextMenu(event) {
  if (S.mode !== 'edit' || !S.pdfjs) return;
  const target = pageFromEvent(event);
  if (!target) return;
  const point = pointInPage(event, target.pageEl);
  const hit = hitTest(target.index, point);
  if (!hit) return;
  event.preventDefault();
  selectOverlay(target.index, hit.id);
  const items = [
    { heading: 'Element' },
    {
      label: 'Edit text',
      icon: 'text',
      disabled: !['text', 'note', 'date'].includes(hit.type),
      action: () => openTextEditor(hit, target.index),
    },
    { label: 'Duplicate', icon: 'duplicate', shortcut: 'Ctrl+D', action: duplicateSelection },
    { label: 'Bring to front', icon: 'arrow-up', action: () => reorderSelection('front') },
    { label: 'Send to back', icon: 'arrow-down', action: () => reorderSelection('back') },
    { type: 'sep' },
    { label: 'Remove', icon: 'trash', danger: true, shortcut: 'Del', action: deleteSelection },
  ];
  if (hit.type === 'sigbox') {
    items.splice(1, 0, {
      label: 'Fill this sign-here box…',
      icon: 'signature',
      action: async () => {
        const signature = await openSignatureDialog({ title: 'Sign here' });
        if (!signature) return;
        const meta = pageMeta(target.index);
        const aspect = signature.aspect || 3.1;
        const w = hit.w * 0.86;
        const h = w / aspect;
        const overlay = baseOverlay('signature', hit.x + (hit.w - w) / 2, hit.y + hit.h * 0.34, w, Math.min(h, hit.h * 0.6), {
          src: signature.dataUrl,
          aspect,
          opacity: 1,
        });
        const before = History.snapshot('annotations');
        addOverlay(target.index, overlay);
        removeOverlay(target.index, hit.id);
        History.commit(before);
        markDirty();
        selectOverlay(target.index, overlay.id);
        repaintPage(target.index);
        flashPage(target.index);
      },
    });
  }
  menu({ x: event.clientX, y: event.clientY, items });
}

/* ============================== keyboard support ============================== */

export function handleEditorKey(event) {
  if (S.mode !== 'edit' || !S.pdfjs) return false;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return false;
  if (!S.selected) return false;
  const step = event.shiftKey ? 10 : 1;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    return deleteSelection();
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    return nudgeSelection(-step, 0);
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    return nudgeSelection(step, 0);
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    return nudgeSelection(0, -step);
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    return nudgeSelection(0, step);
  }
  return false;
}
