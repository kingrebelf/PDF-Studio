import { S, clone, markDirty } from './state.js';

let restoreHandler = null;
let busy = false;

export function setRestoreHandler(fn) {
  restoreHandler = fn;
}

export function snapshot(kind) {
  return {
    kind,
    overlays: clone(Array.from(S.overlays.entries())),
    formValues: clone(S.formValues),
    currentPage: S.currentPage,
    selected: S.selected ? { ...S.selected } : null,
    bytes: kind === 'doc' && S.bytes ? new Uint8Array(S.bytes) : null,
    path: S.path,
    name: S.name,
    meta: clone(S.meta),
    metaDirty: S.metaDirty,
    stamp: Date.now(),
  };
}

export function push(kind = 'annotations') {
  if (!S.bytes) return;
  S.history.push(snapshot(kind));
  if (S.history.length > 30) S.history.shift();
  S.future = [];
  announce();
}

function announce() {
  document.dispatchEvent(new CustomEvent('pdfstudio:history'));
}

export function commit(entry) {
  if (!entry) return;
  S.history.push(entry);
  if (S.history.length > 30) S.history.shift();
  S.future = [];
  announce();
}

export function canUndo() {
  return S.history.length > 0;
}

export function canRedo() {
  return S.future.length > 0;
}

export async function undo() {
  if (busy || !S.history.length) return;
  busy = true;
  const entry = S.history.pop();
  S.future.push(snapshot(entry.kind === 'doc' ? 'doc' : 'annotations'));
  try {
    if (restoreHandler) await restoreHandler(entry);
    markDirty();
  } finally {
    busy = false;
    announce();
  }
}

export async function redo() {
  if (busy || !S.future.length) return;
  busy = true;
  const entry = S.future.pop();
  S.history.push(snapshot(entry.kind === 'doc' ? 'doc' : 'annotations'));
  try {
    if (restoreHandler) await restoreHandler(entry);
    markDirty();
  } finally {
    busy = false;
    announce();
  }
}

export function clearHistory() {
  S.history = [];
  S.future = [];
  announce();
}
