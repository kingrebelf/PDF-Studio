export const S = {
  bytes: null,
  name: '',
  path: null,
  size: 0,
  dirty: false,
  loading: false,
  editable: true,
  encrypted: false,
  pdfjs: null,
  numPages: 0,
  pages: [],
  pageEls: [],
  overlays: new Map(),
  selected: null,
  formFields: [],
  formValues: {},
  currentPage: 0,
  zoom: 1,
  fitMode: 'page',
  mode: 'view',
  tool: 'select',
  activeSignature: null,
  initials: '',
  meta: {},
  metaDirty: false,
  pdfDark: false,
  theme: 'light',
  search: { query: '', matches: [], index: -1, highlights: new Map(), open: false },
  history: [],
  future: [],
  sidebarTab: 'pages',
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  opts: {
    highlightColor: '#f1c860',
    highlightOpacity: 0.45,
    markColor: '#b0522b',
    inkColor: '#b0522b',
    inkWidth: 2,
    inkMode: 'pen',
    shapeType: 'rect',
    shapeStroke: '#b0522b',
    shapeFill: 'transparent',
    shapeWidth: 2,
    textColor: '#211d17',
    textSize: 12,
    textFont: 'Helvetica',
    textAlign: 'left',
    textBold: false,
    stampPreset: 'APPROVED',
    stampColor: '#3e7a53',
    sigWidth: 180,
    noteColor: '#fff3bf',
    opacity: 1,
    eraserSize: 14,
    dateFormat: 'MMM D, YYYY',
    flattenForms: true,
    signHereLabel: 'Sign here',
    redactFill: '#000000',
    whiteoutFill: '#ffffff',
  },
};

export const PALETTE = [
  { name: 'Ink', value: '#211d17' },
  { name: 'Terracotta', value: '#b0522b' },
  { name: 'Gold', value: '#d19a35' },
  { name: 'Olive', value: '#5e7a45' },
  { name: 'Forest', value: '#2f6b52' },
  { name: 'Ocean', value: '#3f6d94' },
  { name: 'Plum', value: '#75507f' },
  { name: 'Crimson', value: '#b13a2e' },
  { name: 'Slate', value: '#5f6670' },
];

export const HIGHLIGHT_PALETTE = [
  { name: 'Sun', value: '#f1c860' },
  { name: 'Mint', value: '#a8d8a4' },
  { name: 'Sky', value: '#a9cdea' },
  { name: 'Blush', value: '#f2b8c6' },
  { name: 'Lilac', value: '#c9b6e4' },
  { name: 'Sand', value: '#e4d3a8' },
];

export const STAMPS = [
  { label: 'APPROVED', color: '#3e7a53' },
  { label: 'REVIEWED', color: '#3f6d94' },
  { label: 'DRAFT', color: '#7a7468' },
  { label: 'CONFIDENTIAL', color: '#b13a2e' },
  { label: 'PAID', color: '#3e7a53' },
  { label: 'VOID', color: '#b13a2e' },
  { label: 'COMPLETED', color: '#3f6d94' },
  { label: 'RECEIVED', color: '#75507f' },
];

export function uid() {
  return `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

export function overlaysFor(page, create = false) {
  let list = S.overlays.get(page);
  if (!list && create) {
    list = [];
    S.overlays.set(page, list);
  }
  return list || [];
}

export function findOverlay(page, id) {
  return overlaysFor(page).find((o) => o.id === id) || null;
}

export function selectedOverlay() {
  if (!S.selected) return null;
  return findOverlay(S.selected.page, S.selected.id);
}

export function addOverlay(page, obj) {
  overlaysFor(page, true).push(obj);
  return obj;
}

export function removeOverlay(page, id) {
  const list = overlaysFor(page);
  const at = list.findIndex((o) => o.id === id);
  if (at >= 0) list.splice(at, 1);
  if (S.selected && S.selected.page === page && S.selected.id === id) S.selected = null;
}

export function overlayCount() {
  let n = 0;
  for (const list of S.overlays.values()) n += list.length;
  return n;
}

export function hasUnsavedChanges() {
  return S.dirty || overlayCount() > 0 || Object.keys(S.formValues).length > 0 || S.metaDirty;
}

export function markDirty() {
  if (!S.dirty) {
    S.dirty = true;
    updateDirtyChrome();
  }
}

export function markClean() {
  S.dirty = false;
  updateDirtyChrome();
}

export function setDirty(value) {
  S.dirty = Boolean(value);
  updateDirtyChrome();
}

export function updateDirtyChrome() {
  const dot = document.getElementById('dirty-dot');
  if (dot) dot.hidden = !S.dirty;
  if (window.api?.setDirty) window.api.setDirty(S.dirty);
  const title = S.name ? `${S.dirty ? '• ' : ''}${S.name} — PDF Studio` : 'PDF Studio';
  document.title = title;
  if (window.api?.setTitle) window.api.setTitle(title);
}

export function setPageMetaFromViewport(index, viewport, rawView) {
  const rot = ((viewport.rotation % 360) + 360) % 360;
  const [x0, y0, x1, y1] = rawView || [0, 0, viewport.width, viewport.height];
  S.pages[index] = {
    index,
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
    viewW: viewport.width,
    viewH: viewport.height,
    rot,
    originX: x0,
    originY: y0,
  };
}

export function pageMeta(index) {
  return S.pages[index] || { w: 612, h: 792, viewW: 612, viewH: 792, rot: 0, originX: 0, originY: 0 };
}

export function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const num = Number.parseInt(h, 16);
  if (Number.isNaN(num)) return { r: 0, g: 0, b: 0 };
  return {
    r: ((num >> 16) & 255) / 255,
    g: ((num >> 8) & 255) / 255,
    b: (num & 255) / 255,
  };
}

export function isLightColor(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 > 0.68;
}

export function loadPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem('pdfstudio.prefs') || '{}');
    if (prefs.theme === 'dark' || prefs.theme === 'light') S.theme = prefs.theme;
    S.pdfDark = Boolean(prefs.pdfDark);
    if (prefs.opts && typeof prefs.opts === 'object') S.opts = { ...S.opts, ...prefs.opts };
    if (typeof prefs.initials === 'string') S.initials = prefs.initials;
    if (prefs.sidebarCollapsed) S.sidebarCollapsed = true;
  } catch {
    /* ignore */
  }
}

export function savePrefs() {
  try {
    localStorage.setItem(
      'pdfstudio.prefs',
      JSON.stringify({
        theme: S.theme,
        pdfDark: S.pdfDark,
        opts: S.opts,
        initials: S.initials,
        sidebarCollapsed: S.sidebarCollapsed,
      })
    );
  } catch {
    /* ignore */
  }
}

export function loadSignatures() {
  try {
    const list = JSON.parse(localStorage.getItem('pdfstudio.signatures') || '[]');
    return Array.isArray(list) ? list.slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function storeSignatures(list) {
  try {
    localStorage.setItem('pdfstudio.signatures', JSON.stringify(list.slice(0, 8)));
    return true;
  } catch {
    return false;
  }
}

export function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem('pdfstudio.recent') || '[]');
    return Array.isArray(list) ? list.slice(0, 7) : [];
  } catch {
    return [];
  }
}

export function pushRecent(entry) {
  const list = loadRecent().filter((r) => r.path !== entry.path);
  if (entry.path) list.unshift({ ...entry, time: Date.now() });
  try {
    localStorage.setItem('pdfstudio.recent', JSON.stringify(list.slice(0, 7)));
  } catch {
    /* ignore */
  }
}

export function resetDocumentState() {
  S.bytes = null;
  S.name = '';
  S.path = null;
  S.size = 0;
  S.pdfjs = null;
  S.numPages = 0;
  S.pages = [];
  S.pageEls = [];
  S.overlays = new Map();
  S.selected = null;
  S.formFields = [];
  S.formValues = {};
  S.currentPage = 0;
  S.search = { query: '', matches: [], index: -1, highlights: new Map(), open: false };
  S.history = [];
  S.future = [];
  S.meta = {};
  S.metaDirty = false;
  S.editable = true;
  S.encrypted = false;
  S.dirty = false;
}
