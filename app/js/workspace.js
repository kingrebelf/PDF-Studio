import * as pdfjsLib from '../vendor/pdfjs/pdf.mjs';
import { PDFDocument } from '../vendor/pdflib/pdf-lib.esm.min.js';
import {
  S,
  pageMeta,
  overlaysFor,
  markDirty,
  markClean,
  updateDirtyChrome,
  clone,
  loadPrefs,
  savePrefs,
  loadSignatures,
} from './state.js';
import {
  $,
  $$,
  icon,
  toast,
  showBusy,
  hideBusy,
  setBusyProgress,
  promptModal,
  formatBytes,
  clamp,
  debounce,
  menu,
  escapeHtml,
  nextFrame,
} from './ui.js';
import { paintPage } from './paint.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
const CMAP_URL = new URL('../vendor/pdfjs/cmaps/', import.meta.url).href;
const STANDARD_FONT_URL = new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href;

const DPR = Math.min(window.devicePixelRatio || 1, 2);
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const PAGE_PAD = 34;

let initialized = false;
let loadingTask = null;
let renderGeneration = 0;
let renderQueue = [];
let queued = new Set();
let activeRenders = 0;
let pageObserver = null;
let thumbObserver = null;
let scrollRaf = 0;
let searchToken = 0;
let thumbToken = 0;
let formToken = 0;
let resizeTimer = null;
const thumbCache = new Map();
const textCache = new Map();
let lastScrollCheck = 0;

export const MAX_CONCURRENT_RENDERS = 2;

export function initViewer() {
  if (initialized) return;
  initialized = true;
  loadPrefs();
  applyTheme();
  bindSidebarControls();
  bindSearchControls();
  document.addEventListener('pdfstudio:repaint', (event) => {
    const page = event.detail?.page;
    if (typeof page === 'number') repaintPage(page);
    else repaintAll();
  });
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!S.pdfjs) return;
      if (S.fitMode) applyFit(S.fitMode, { keepPage: true });
      else {
        updateStatusbar();
        renderVisiblePages();
      }
    }, 160);
  });
}

export function applyTheme() {
  document.body.dataset.theme = S.theme;
  document.body.classList.toggle('pdf-dark', S.pdfDark);
  document.getElementById('btn-theme').innerHTML = icon(S.theme === 'dark' ? 'sun' : 'moon', 17);
  document.getElementById('btn-appearance').innerHTML = icon(S.pdfDark ? 'sun' : 'moon', 17);
  if (window.api?.setTheme) window.api.setTheme(S.theme);
  savePrefs();
}

export function toggleTheme() {
  S.theme = S.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
}

export function togglePdfDark() {
  S.pdfDark = !S.pdfDark;
  applyTheme();
  if (window.api?.setTheme) window.api.setTheme(S.theme);
  savePrefs();
}

/* ============================== Loading ============================== */

function passwordPrompt(reason) {
  const label =
    reason === 2
      ? 'That password did not work. Try again.'
      : 'This document is protected. Enter its password to open it.';
  return promptModal({
    title: 'Password required',
    label,
    placeholder: 'PDF password',
    type: 'password',
    confirmLabel: 'Unlock',
    iconName: 'lock',
  });
}

export async function loadDocument(bytes, options = {}) {
  const {
    name = S.name,
    path = S.path,
    size = bytes?.length || 0,
    reload = false,
    preserveView = false,
    keepOverlays = false,
    fit = 'page',
  } = options;

  if (!bytes || !bytes.length) throw new Error('This PDF is empty.');

  const previousPage = S.currentPage;
  const previousZoom = S.zoom;
  const previousScrollTop = $('#scroll')?.scrollTop || 0;

  cleanupDocumentView();
  S.loading = true;
  S.bytes = new Uint8Array(bytes);
  S.name = name || 'Document.pdf';
  S.path = path || null;
  S.size = size;
  S.encrypted = false;
  S.editable = true;
  S.selected = null;
  S.search = { query: '', matches: [], index: -1, highlights: new Map(), open: S.search.open };
  if (!keepOverlays) {
    S.overlays = new Map();
    S.formValues = {};
  }
  if (!reload) {
    S.history = [];
    S.future = [];
    S.meta = {};
    S.metaDirty = false;
    S.zoom = 1;
    S.fitMode = 'page';
    S.currentPage = 0;
  }
  textCache.clear();
  geometryCache.clear();
  if (!reload) {
    S.search.open = false;
    const pop = $('#search-popover');
    if (pop) pop.hidden = true;
    $('#search-count') && ($('#search-count').textContent = '0 results');
  }
  document.dispatchEvent(new CustomEvent('pdfstudio:history'));

  let attempts = 0;
  const task = pdfjsLib.getDocument({
    data: S.bytes.slice(0),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_URL,
    isEvalSupported: false,
    useWorkerFetch: true,
    onPassword: (updatePassword, reason) => {
      attempts += 1;
      if (attempts > 4) {
        updatePassword(null);
        return;
      }
      passwordPrompt(reason).then((password) => updatePassword(password || null));
    },
  });
  loadingTask = task;

  try {
    const pdf = await task.promise;
    S.pdfjs = pdf;
    S.numPages = pdf.numPages;
    if (!S.numPages) throw new Error('This PDF has no pages.');

    const metaTasks = [];
    for (let i = 0; i < pdf.numPages; i += 1) {
      metaTasks.push(
        pdf.getPage(i + 1).then((page) => {
          const viewport = page.getViewport({ scale: 1 });
          S.pages[i] = {
            index: i,
            w: Math.abs(page.view[2] - page.view[0]),
            h: Math.abs(page.view[3] - page.view[1]),
            viewW: viewport.width,
            viewH: viewport.height,
            rot: ((viewport.rotation % 360) + 360) % 360,
            originX: page.view[0],
            originY: page.view[1],
          };
          return page;
        })
      );
    }
    await mapLimit(metaTasks, 8);

    try {
      const libDoc = await PDFDocument.load(S.bytes.slice(0), { updateMetadata: false });
      if (!reload) S.meta = readMetadata(libDoc);
      S.editable = true;
    } catch (error) {
      S.editable = false;
      S.encrypted = /encrypt|password/i.test(String(error?.message || ''));
      if (!reload) S.meta = {};
      if (S.pdfjs) {
        setTimeout(() => {
          toast(
            S.encrypted
              ? 'This PDF is encrypted. You can read, print and save a copy, but editing is unavailable.'
              : 'Editing is unavailable for this PDF. You can still read, print and save a copy.',
            'warning',
            6000
          );
        }, 400);
      }
    }

    document.body.dataset.doc = 'true';
    $('#welcome').hidden = true;
    $('#scroll').hidden = false;
    $('#statusbar').hidden = false;
    $('#page-count-badge').textContent = String(S.numPages);
    $('#page-total').textContent = `/ ${S.numPages}`;
    $('#doc-name').textContent = S.name;
    $('#doc-name').title = S.path || S.name;
    updateDirtyChrome();

    buildPageShells();
    buildThumbnails();
    buildOutline();
    updateStatusbar();
    document.dispatchEvent(new CustomEvent('pdfstudio:docloaded'));
    document.dispatchEvent(new CustomEvent('pdfstudio:mode'));

    if (preserveView) {
      S.zoom = previousZoom;
      S.currentPage = clamp(previousPage, 0, S.numPages - 1);
      layoutPages();
      requestAnimationFrame(() => {
        if (!S.fitMode) scrollToPage(S.currentPage, { smooth: false });
        else scrollToPage(S.currentPage, { smooth: false });
        renderVisiblePages();
        updateRightPanel();
      });
    } else {
      S.fitMode = fit;
      applyFit(fit, { keepPage: false });
    }
    S.loading = false;
    discoverForms(formToken + 1);
    return true;
  } catch (error) {
    S.loading = false;
    cleanupDocumentView();
    throw error;
  }
}

function readMetadata(doc) {
  const safe = (fn) => {
    try {
      return fn() || '';
    } catch {
      return '';
    }
  };
  return {
    title: safe(() => doc.getTitle()),
    author: safe(() => doc.getAuthor()),
    subject: safe(() => doc.getSubject()),
    keywords: safe(() => doc.getKeywords()),
    creator: safe(() => doc.getCreator()),
    producer: safe(() => doc.getProducer()),
    creationDate: safe(() => doc.getCreationDate()?.toISOString()),
    modificationDate: safe(() => doc.getModificationDate()?.toISOString()),
  };
}

export async function reloadFromBytes(bytes, options = {}) {
  const page = S.currentPage;
  const zoom = S.zoom;
  const fit = S.fitMode;
  const overlays = options.clearOverlays ? new Map() : S.overlays;
  const formValues = options.clearOverlays ? {} : S.formValues;
  await loadDocument(bytes, {
    name: options.name ?? S.name,
    path: options.path ?? S.path,
    size: bytes.length,
    reload: true,
    preserveView: true,
    keepOverlays: true,
    fit,
  });
  if (!options.clearOverlays) {
    S.overlays = overlays;
    S.formValues = formValues;
  } else {
    S.overlays = new Map();
    S.formValues = {};
  }
  S.currentPage = clamp(page, 0, S.numPages - 1);
  if (fit) S.fitMode = fit;
  S.zoom = fit ? calcFit(fit) : zoom;
  layoutPages();
  scrollToPage(S.currentPage, { smooth: false });
  renderVisiblePages();
  repaintAll();
  updateStatusbar();
  document.dispatchEvent(new CustomEvent('pdfstudio:docloaded'));
  return true;
}

export function cleanupDocumentView() {
  renderGeneration += 1;
  renderQueue = [];
  queued.clear();
  pageObserver?.disconnect();
  pageObserver = null;
  thumbObserver?.disconnect();
  thumbObserver = null;
  for (const el of S.pageEls) {
    try {
      el.renderTask?.cancel();
    } catch {
      /* ignore */
    }
  }
  S.pageEls = [];
  const pagesEl = $('#pages');
  if (pagesEl) pagesEl.innerHTML = '';
  const thumbs = $('#thumb-list');
  if (thumbs) thumbs.innerHTML = '';
  if (loadingTask) {
    try {
      loadingTask.destroy();
    } catch {
      /* ignore */
    }
    loadingTask = null;
  }
  S.pdfjs = null;
  S.pages = [];
  setSearchHighlights(new Map());
  thumbCache.clear();
  textCache.clear();
  geometryCache.clear();
}

export function destroyView() {
  cleanupDocumentView();
  document.body.dataset.doc = 'false';
  $('#welcome').hidden = false;
  $('#scroll').hidden = true;
  $('#statusbar').hidden = true;
}

/* ============================== Page shells ============================== */

function buildPageShells() {
  const pagesEl = $('#pages');
  pagesEl.innerHTML = '';
  S.pageEls = new Array(S.numPages);
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < S.numPages; i += 1) {
    const meta = pageMeta(i);
    const shell = document.createElement('div');
    shell.className = 'page-shell';
    shell.dataset.page = String(i);
    shell.style.width = `${Math.round(meta.viewW * S.zoom)}px`;
    shell.innerHTML = `
      <div class="page" style="width:${Math.round(meta.viewW * S.zoom)}px;height:${Math.round(meta.viewH * S.zoom)}px;aspect-ratio:${meta.viewW} / ${meta.viewH}">
        <canvas class="page-canvas"></canvas>
        <div class="text-layer"></div>
        <div class="link-layer"></div>
        <canvas class="annotation-canvas"></canvas>
      </div>
      <div class="page-label">${i + 1}</div>`;
    fragment.append(shell);
    const entry = {
      shell,
      page: shell.querySelector('.page'),
      canvas: shell.querySelector('.page-canvas'),
      textLayer: shell.querySelector('.text-layer'),
      linkLayer: shell.querySelector('.link-layer'),
      annotation: shell.querySelector('.annotation-canvas'),
      label: shell.querySelector('.page-label'),
      renderKey: null,
      renderTask: null,
      rendering: false,
      textTask: null,
      painted: false,
    };
    S.pageEls[i] = entry;
  }
  pagesEl.append(fragment);

  pageObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const index = Number(entry.target.dataset.page);
        if (entry.isIntersecting) scheduleRender(index);
      }
    },
    { root: $('#scroll'), rootMargin: '850px 0px' }
  );

  for (const entry of S.pageEls) pageObserver.observe(entry.shell);
  layoutPages();
}

export function layoutPages() {
  if (!S.pageEls.length) return;
  const current = S.currentPage;
  for (let i = 0; i < S.pageEls.length; i += 1) {
    const el = S.pageEls[i];
    if (!el) continue;
    const meta = pageMeta(i);
    const width = Math.max(1, Math.round(meta.viewW * S.zoom));
    const height = Math.max(1, Math.round(meta.viewH * S.zoom));
    el.shell.style.width = `${width}px`;
    el.page.style.width = `${width}px`;
    el.page.style.height = `${height}px`;
    el.page.style.aspectRatio = `${meta.viewW} / ${meta.viewH}`;
    el.annotation.width = Math.max(1, Math.round(width * DPR));
    el.annotation.height = Math.max(1, Math.round(height * DPR));
    el.annotation.style.width = '100%';
    el.annotation.style.height = '100%';
    el.painted = false;
    if (el.renderKey !== `${S.zoom}`) {
      try {
        el.renderTask?.cancel();
      } catch {
        /* ignore */
      }
      el.renderTask = null;
      el.canvas.width = 0;
      el.canvas.height = 0;
      el.textLayer.innerHTML = '';
      el.linkLayer.innerHTML = '';
      el.renderKey = null;
    }
  }
  updateZoomLabel();
  S.currentPage = clamp(current, 0, Math.max(0, S.numPages - 1));
  repaintVisiblePages();
}

export function updateZoomLabel() {
  const label = $('#zoom-label');
  if (label) label.textContent = `${Math.round(S.zoom * 100)}%`;
}

/* ============================== Rendering ============================== */

function nearViewport(index, margin = 900) {
  const el = S.pageEls[index];
  const scroll = $('#scroll');
  if (!el || !scroll) return false;
  const pageRect = el.shell.getBoundingClientRect();
  const scrollRect = scroll.getBoundingClientRect();
  return pageRect.bottom > scrollRect.top - margin && pageRect.top < scrollRect.bottom + margin;
}

function scheduleRender(index, force = false) {
  if (!S.pdfjs) return;
  const el = S.pageEls[index];
  if (!el) return;
  if (!force && el.renderKey === `${S.zoom}`) return;
  if (el.rendering || queued.has(index)) return;
  queued.add(index);
  renderQueue.push(index);
  pumpRenders();
}

async function pumpRenders() {
  if (activeRenders >= MAX_CONCURRENT_RENDERS) return;
  while (activeRenders < MAX_CONCURRENT_RENDERS && renderQueue.length) {
    const index = renderQueue.shift();
    queued.delete(index);
    if (!nearViewport(index)) continue;
    if (S.pageEls[index]?.renderKey === `${S.zoom}`) continue;
    const entry = S.pageEls[index];
    if (!entry || entry.rendering) continue;
    const renderZoom = S.zoom;
    entry.rendering = true;
    activeRenders += 1;
    renderPage(index)
      .catch((error) => {
        if (!/cancel/i.test(String(error?.message || ''))) console.warn('Page render failed', index, error);
      })
      .finally(() => {
        activeRenders -= 1;
        entry.rendering = false;
        if (S.pageEls[index] === entry && entry.renderKey !== `${S.zoom}` && S.zoom !== renderZoom && nearViewport(index)) scheduleRender(index);
        pumpRenders();
      });
  }
}

export function renderVisiblePages() {
  if (!S.pdfjs) return;
  const scroll = $('#scroll');
  if (!scroll) return;
  const rect = scroll.getBoundingClientRect();
  for (let i = 0; i < S.pageEls.length; i += 1) {
    const el = S.pageEls[i];
    if (!el) continue;
    const r = el.shell.getBoundingClientRect();
    if (r.bottom > rect.top - 900 && r.top < rect.bottom + 900) scheduleRender(i);
  }
}

async function renderPage(index) {
  const el = S.pageEls[index];
  if (!el || !S.pdfjs) return;
  const generation = renderGeneration;
  const pdfPage = await S.pdfjs.getPage(index + 1);
  if (generation !== renderGeneration || !S.pageEls[index]) return;

  const zoom = S.zoom;
  const viewport = pdfPage.getViewport({ scale: zoom * DPR });
  // Render into a private canvas so cancellation or layout changes cannot
  // reset a canvas while PDF.js is still using its transformed context.
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  const ctx = canvas.getContext('2d', { alpha: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const task = pdfPage.render({
    canvasContext: ctx,
    viewport,
    intent: 'display',
    annotationMode: pdfjsLib.AnnotationMode.DISABLE,
  });
  el.renderTask = task;
  await task.promise;
  el.renderTask = null;
  if (generation !== renderGeneration || S.pageEls[index] !== el || zoom !== S.zoom) return;
  el.canvas.width = canvas.width;
  el.canvas.height = canvas.height;
  el.canvas.getContext('2d').drawImage(canvas, 0, 0);
  el.renderKey = `${zoom}`;

  await buildTextLayer(el, pdfPage, index, generation);
  buildLinks(el, pdfPage, index);

  repaintPage(index);
  if (index === S.currentPage) {
    el.shell.classList.add('active');
  }
  unloadDistantPages(index);
}

async function buildTextLayer(el, pdfPage, index, generation) {
  const layer = el.textLayer;
  layer.style.setProperty('--scale-factor', String(S.zoom));
  layer.innerHTML = '';
  try {
    const viewport = pdfPage.getViewport({ scale: S.zoom });
    const content = await pdfPage.getTextContent();
    if (generation !== renderGeneration) return;
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: content,
      container: layer,
      viewport,
    });
    await textLayer.render();
    el.textTask = textLayer;
    textCache.set(index, content);
  } catch (error) {
    if (!/cancel/i.test(String(error?.message || ''))) console.warn('Text layer failed', error);
  }
}

async function buildLinks(el, pdfPage, index) {
  const layer = el.linkLayer;
  layer.innerHTML = '';
  try {
    const annotations = await pdfPage.getAnnotations({ intent: 'display' });
    if (!annotations?.length) return;
    const viewport = pdfPage.getViewport({ scale: S.zoom });
    for (const ann of annotations) {
      if (ann.subtype !== 'Link' || !ann.rect) continue;
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(ann.rect);
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);
      if (w < 1 || h < 1) continue;
      const box = document.createElement('a');
      box.className = 'link-box';
      box.href = '#';
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      box.title = ann.url || 'Go to page';
      box.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (ann.url) {
          if (window.api?.openExternal) window.api.openExternal(ann.url);
          else window.open(ann.url, '_blank', 'noopener');
          return;
        }
        if (ann.dest) {
          const target = await resolveDestination(ann.dest);
          if (target !== null) scrollToPage(target);
        }
      });
      layer.append(box);
    }
  } catch {
    /* ignore */
  }
}

function unloadDistantPages(keepIndex) {
  const scroll = $('#scroll');
  if (!scroll) return;
  const rendered = S.pageEls.filter((el) => el?.renderKey);
  if (rendered.length <= 14) return;
  const scrollRect = scroll.getBoundingClientRect();
  const center = scrollRect.top + scrollRect.height / 2;
  const sorted = rendered
    .map((el) => {
      const r = el.shell.getBoundingClientRect();
      return { el, distance: Math.abs(r.top + r.height / 2 - center) };
    })
    .sort((a, b) => b.distance - a.distance);
  const keepSet = new Set([keepIndex]);
  const elKeep = S.pageEls[keepIndex];
  if (elKeep) keepSet.add(keepIndex);
  let unloaded = 0;
  for (const item of sorted) {
    if (rendered.length - unloaded <= 12) break;
    if (item.el === elKeep) continue;
    item.el.canvas.width = 0;
    item.el.canvas.height = 0;
    item.el.textLayer.innerHTML = '';
    item.el.linkLayer.innerHTML = '';
    item.el.renderKey = null;
    unloaded += 1;
  }
}

export async function renderPageToCanvas(index, scale, { overlays = false, background = '#ffffff' } = {}) {
  if (!S.pdfjs) throw new Error('No document open.');
  const pdfPage = await S.pdfjs.getPage(index + 1);
  const viewport = pdfPage.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  await pdfPage.render({
    canvasContext: ctx,
    viewport,
    intent: 'print',
    annotationMode: pdfjsLib.AnnotationMode.DISABLE,
  }).promise;
  if (overlays) {
    paintPage(ctx, index, scale, { selection: false, search: false, zoom: scale, clear: false });
  }
  if (background) {
    // paintPage clears the canvas so the on-screen page can show through.
    // Rasterised pages are encoded as JPEG, where transparency turns black,
    // so put the paper colour back underneath everything that was drawn.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
  return canvas;
}

export function pageViewportAt(index, scale) {
  return S.pdfjs?.getPage(index + 1).then((page) => page.getViewport({ scale }));
}

/* ============================== Navigation ============================== */

export function scrollToPage(index, { smooth = true } = {}) {
  const el = S.pageEls[clamp(index, 0, S.numPages - 1)];
  const scroll = $('#scroll');
  if (!el || !scroll) return;
  const top =
    scroll.scrollTop +
    el.shell.getBoundingClientRect().top -
    scroll.getBoundingClientRect().top -
    18;
  scroll.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  const changed = S.currentPage !== clamp(index, 0, S.numPages - 1);
  S.currentPage = clamp(index, 0, S.numPages - 1);
  updateActiveThumb();
  updatePageInput();
  if (changed) document.dispatchEvent(new CustomEvent('pdfstudio:pagechange', { detail: { page: S.currentPage } }));
}

export function updatePageInput() {
  const input = $('#page-input');
  if (input && document.activeElement !== input) input.value = String(S.currentPage + 1);
}

export function updateActiveThumb() {
  $$('.thumb-item', $('#thumb-list')).forEach((item) => {
    item.classList.toggle('active', Number(item.dataset.page) === S.currentPage);
  });
  const active = $(`.thumb-item[data-page="${S.currentPage}"]`, $('#thumb-list'));
  if (active) {
    const list = $('#thumb-list');
    const listRect = list.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    if (itemRect.top < listRect.top + 4 || itemRect.bottom > listRect.bottom - 4) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }
  S.pageEls.forEach((el, i) => el?.shell.classList.toggle('active', i === S.currentPage));
}

export function handleScroll() {
  if (!S.pdfjs) return;
  renderVisiblePages();
  const now = performance.now();
  if (now - lastScrollCheck < 40) return;
  lastScrollCheck = now;
  const scroll = $('#scroll');
  if (!scroll) return;
  const scrollRect = scroll.getBoundingClientRect();
  const probe = scrollRect.top + Math.min(160, scrollRect.height * 0.25);
  let best = S.currentPage;
  let bestDistance = Infinity;
  for (let i = 0; i < S.pageEls.length; i += 1) {
    const el = S.pageEls[i];
    if (!el) continue;
    const rect = el.shell.getBoundingClientRect();
    if (rect.bottom < scrollRect.top || rect.top > scrollRect.bottom) continue;
    const distance = Math.abs(rect.top - probe);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  if (best !== S.currentPage) {
    S.currentPage = best;
    updatePageInput();
    updateActiveThumb();
    updateStatusbar();
    document.dispatchEvent(new CustomEvent('pdfstudio:pagechange', { detail: { page: best } }));
  }
  updatePageInput();
}

export function setCurrentPage(index) {
  scrollToPage(index);
}

/* ============================== Zoom ============================== */

export function calcFit(mode) {
  const scroll = $('#scroll');
  if (!scroll || !S.numPages) return 1;
  const meta = pageMeta(S.currentPage);
  const availableWidth = Math.max(120, scroll.clientWidth - PAGE_PAD * 2);
  const availableHeight = Math.max(120, scroll.clientHeight - 64);
  const widthRatio = availableWidth / meta.viewW;
  const heightRatio = availableHeight / meta.viewH;
  const ratio = mode === 'width' ? widthRatio : Math.min(widthRatio, heightRatio);
  return clamp(ratio, 0.15, 5);
}

export function applyFit(mode = 'page', { keepPage = true } = {}) {
  if (!S.numPages) return;
  const page = S.currentPage;
  S.fitMode = mode;
  S.zoom = Math.round(calcFit(mode) * 1000) / 1000;
  layoutPages();
  if (keepPage) scrollToPage(page, { smooth: false });
  renderVisiblePages();
  updateStatusbar();
  updateFitButtons();
}

export function setZoom(value, { fit = null, keepPage = true } = {}) {
  if (!S.numPages) return;
  const page = S.currentPage;
  S.zoom = clamp(Math.round(value * 1000) / 1000, 0.15, 5);
  S.fitMode = fit;
  layoutPages();
  if (keepPage) scrollToPage(page, { smooth: false });
  renderVisiblePages();
  updateStatusbar();
  updateFitButtons();
  document.dispatchEvent(new CustomEvent('pdfstudio:room'));
}

export function zoomBy(direction) {
  const current = S.zoom;
  let next = current;
  if (direction > 0) {
    next = ZOOM_STEPS.find((step) => step > current + 0.001) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
  } else {
    const lower = ZOOM_STEPS.filter((step) => step < current - 0.001);
    next = lower[lower.length - 1] || ZOOM_STEPS[0];
  }
  setZoom(next);
}

export function updateFitButtons() {
  $('#btn-fit-width')?.classList.toggle('active', S.fitMode === 'width');
  $('#btn-fit-page')?.classList.toggle('active', S.fitMode === 'page');
}

export function zoomToActual() {
  const page = S.currentPage;
  S.zoom = 1;
  S.fitMode = null;
  layoutPages();
  scrollToPage(page, { smooth: false });
  renderVisiblePages();
  updateStatusbar();
  updateFitButtons();
}

/* ============================== Annotations repaint ============================== */

export function repaintPage(index) {
  const el = S.pageEls[index];
  if (!el) return;
  if (!nearViewport(index, 1200)) {
    el.painted = false;
    return;
  }
  const meta = pageMeta(index);
  const width = Math.max(1, Math.round(meta.viewW * S.zoom));
  const height = Math.max(1, Math.round(meta.viewH * S.zoom));
  if (el.annotation.width !== Math.round(width * DPR)) el.annotation.width = Math.round(width * DPR);
  if (el.annotation.height !== Math.round(height * DPR)) el.annotation.height = Math.round(height * DPR);
  const ctx = el.annotation.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, el.annotation.width, el.annotation.height);
  paintPage(ctx, index, S.zoom * DPR, {
    selection: S.mode === 'edit',
    search: true,
    zoom: S.zoom,
  });
  el.painted = true;
}

export function repaintAll() {
  for (let i = 0; i < S.pageEls.length; i += 1) repaintPage(i);
}

export function repaintVisiblePages() {
  for (let i = 0; i < S.pageEls.length; i += 1) {
    if (nearViewport(i, 1500)) repaintPage(i);
    else if (S.pageEls[i]) S.pageEls[i].painted = false;
  }
}

/* ============================== Status ============================== */

export function updateStatusbar() {
  const total = S.numPages || 0;
  $('#page-total').textContent = `/ ${total}`;
  updatePageInput();
  const meta = $('#doc-meta');
  if (meta) {
    const bits = [`${total} page${total === 1 ? '' : 's'}`];
    if (S.size) bits.push(formatBytes(S.size));
    if (!S.editable) bits.push(S.encrypted ? 'Protected' : 'View only');
    else if (S.dirty || S.overlays.size) bits.push('Edited');
    meta.textContent = bits.join(' · ');
  }
  const hint = $('#status-hint');
  if (hint) {
    if (S.mode === 'view') hint.textContent = 'Read-only view';
    else if (S.tool === 'select') hint.textContent = 'Select an object to edit';
    else if (S.tool === 'text-pick' || S.tool === 'highlight' || S.tool === 'underline' || S.tool === 'strike') {
      hint.textContent = 'Drag across text, then choose a mark';
    } else if (S.tool === 'forms') hint.textContent = 'Click a form field to fill it';
    else hint.textContent = 'Editing · Ctrl+Z to undo';
  }
  updateZoomLabel();
  updateDirtyChrome();
}

export function refreshDocumentChrome() {
  const hasDoc = Boolean(S.pdfjs);
  document.body.dataset.doc = hasDoc ? 'true' : 'false';
  ['btn-save', 'btn-print', 'btn-search', 'btn-appearance'].forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.disabled = !hasDoc;
  });
  const addPages = document.getElementById('btn-sidebar-add');
  if (addPages) addPages.disabled = !hasDoc || !S.editable;
  if (!hasDoc) {
    $('#welcome').hidden = false;
    $('#scroll').hidden = true;
    $('#statusbar').hidden = true;
    $('#doc-name').textContent = 'No document';
    $('#page-count-badge').textContent = '0';
    updateDirtyChrome();
    return;
  }
  $('#welcome').hidden = true;
  $('#scroll').hidden = false;
  $('#statusbar').hidden = false;
  $('#doc-name').textContent = S.name || 'Document.pdf';
  $('#page-count-badge').textContent = String(S.numPages);
  updateStatusbar();
}

/* ============================== Thumbnails ============================== */

export function buildThumbnails() {
  const list = $('#thumb-list');
  if (!list) return;
  list.innerHTML = '';
  thumbToken += 1;
  const token = thumbToken;
  thumbCache.clear();
  const frag = document.createDocumentFragment();

  for (let i = 0; i < S.numPages; i += 1) {
    const meta = pageMeta(i);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `thumb-item${i === S.currentPage ? ' active' : ''}`;
    item.dataset.page = String(i);
    item.draggable = true;
    item.title = `Page ${i + 1}`;
    item.innerHTML = `
      <div class="thumb-canvas-wrap" style="aspect-ratio:${meta.viewW} / ${meta.viewH}">
        <div class="thumb-skeleton"></div>
      </div>
      <span class="thumb-num">${i + 1}</span>`;
    item.addEventListener('click', () => scrollToPage(i));
    item.addEventListener('dblclick', () => scrollToPage(i));
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      thumbnailMenu(event, i);
    });
    bindThumbDrag(item, i);
    frag.append(item);
    thumbObserver?.observe?.(item);
  }
  list.append(frag);

  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          renderThumb(Number(entry.target.dataset.page), entry.target, token);
          thumbObserver.unobserve(entry.target);
        }
      }
    },
    { root: list, rootMargin: '400px 0px' }
  );
  for (const item of list.children) thumbObserver.observe(item);
}

async function renderThumb(index, item, token) {
  if (!S.pdfjs || token !== thumbToken) return;
  try {
    const page = await S.pdfjs.getPage(index + 1);
    const meta = pageMeta(index);
    const width = 168;
    const scale = width / meta.viewW;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, intent: 'display' }).promise;
    if (token !== thumbToken) return;
    const wrap = item.querySelector('.thumb-canvas-wrap');
    wrap.innerHTML = '';
    wrap.append(canvas);
    if (meta.rot) {
      const flag = document.createElement('span');
      flag.className = 'thumb-flag';
      flag.textContent = String(meta.rot);
      item.append(flag);
    }
  } catch {
    /* ignore individual thumbnail failures */
  }
}

function bindThumbDrag(item, index) {
  item.addEventListener('dragstart', (event) => {
    item.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    $$('.thumb-item', $('#thumb-list')).forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  });
  item.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = item.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    item.classList.toggle('drop-before', before);
    item.classList.toggle('drop-after', !before);
  });
  item.addEventListener('dragleave', () => {
    item.classList.remove('drop-before', 'drop-after');
  });
  item.addEventListener('drop', (event) => {
    event.preventDefault();
    const from = Number(event.dataTransfer.getData('text/plain'));
    if (!Number.isFinite(from)) return;
    const rect = item.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    let to = index + (before ? 0 : 1);
    if (from < to) to -= 1;
    if (from === to) return;
    document.dispatchEvent(
      new CustomEvent('pdfstudio:action', { detail: { action: 'move-page', from, to } })
    );
  });
}

function thumbnailMenu(event, index) {
  menu({
    x: event.clientX,
    y: event.clientY,
    items: [
      { heading: `Page ${index + 1}` },
      { label: 'Rotate clockwise', icon: 'rotate-cw', action: () => dispatchAction('rotate-page', { page: index, delta: 90 }) },
      { label: 'Rotate counter-clockwise', icon: 'rotate-ccw', action: () => dispatchAction('rotate-page', { page: index, delta: -90 }) },
      { type: 'sep' },
      { label: 'Duplicate page', icon: 'duplicate', action: () => dispatchAction('duplicate-page', { page: index }) },
      { label: 'Insert blank before', icon: 'plus', action: () => dispatchAction('insert-blank', { at: index }) },
      { label: 'Insert blank after', icon: 'plus', action: () => dispatchAction('insert-blank', { at: index + 1 }) },
      { type: 'sep' },
      { label: 'Extract this page…', icon: 'export', action: () => dispatchAction('extract-pages', { pages: [index] }) },
      { label: 'Delete page', icon: 'trash', danger: true, action: () => dispatchAction('delete-page', { page: index }) },
    ],
  });
}

export function dispatchAction(action, detail = {}) {
  document.dispatchEvent(new CustomEvent('pdfstudio:action', { detail: { action, ...detail } }));
}

/* ============================== Outline ============================== */

export async function buildOutline() {
  const list = $('#outline-list');
  if (!list || !S.pdfjs) return;
  list.innerHTML = '';
  try {
    const outline = await S.pdfjs.getOutline();
    if (!outline?.length) {
      list.innerHTML = '<div class="empty-note">This document has no bookmarks.<br>Use the page thumbnails to move around.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const item of outline) {
      frag.append(await outlineNode(item, 0));
    }
    list.append(frag);
  } catch {
    list.innerHTML = '<div class="empty-note">The table of contents could not be read.</div>';
  }
}

async function outlineNode(item, depth) {
  const wrap = document.createElement('div');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'outline-item';
  button.style.paddingLeft = `${7 + depth * 12}px`;
  button.innerHTML = `<span></span><span class="outline-page"></span>`;
  button.querySelector('span').textContent = item.title || 'Untitled section';
  button.addEventListener('click', async () => {
    const target = await resolveDestination(item.dest);
    if (target !== null) scrollToPage(target);
  });
  wrap.append(button);
  resolveDestination(item.dest).then((page) => {
    if (page !== null) button.querySelector('.outline-page').textContent = String(page + 1);
  });
  if (item.items?.length) {
    const children = document.createElement('div');
    children.className = 'outline-children';
    for (const child of item.items) children.append(await outlineNode(child, depth + 1));
    wrap.append(children);
  }
  return wrap;
}

async function resolveDestination(dest) {
  if (!S.pdfjs) return null;
  try {
    let destination = dest;
    if (typeof dest === 'string') destination = await S.pdfjs.getDestination(dest);
    if (!Array.isArray(destination)) return null;
    const ref = destination[0];
    if (typeof ref === 'number') return ref;
    return await S.pdfjs.getPageIndex(ref);
  } catch {
    return null;
  }
}

/* ============================== Sidebar ============================== */

function bindSidebarControls() {
  $$('.side-tab').forEach((button) => {
    button.addEventListener('click', () => setSidebarTab(button.dataset.tab));
  });
  $('#btn-hide-sidebar').addEventListener('click', () => toggleSidebar(true));
  $('#btn-show-sidebar').addEventListener('click', () => toggleSidebar(false));
  $('#btn-sidebar-add').addEventListener('click', () => dispatchAction('pages'));
  if (S.sidebarCollapsed) applySidebarState();
}

export function setSidebarTab(tab) {
  S.sidebarTab = tab;
  $$('.side-tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  $('#thumb-list').hidden = tab !== 'pages';
  $('#outline-list').hidden = tab !== 'outline';
}

export function toggleSidebar(collapsed = !S.sidebarCollapsed) {
  S.sidebarCollapsed = collapsed;
  applySidebarState();
  savePrefs();
  requestAnimationFrame(() => {
    if (S.fitMode) applyFit(S.fitMode, { keepPage: true });
    else renderVisiblePages();
  });
}

function applySidebarState() {
  const sidebar = $('#sidebar');
  sidebar.classList.toggle('collapsed', S.sidebarCollapsed);
  $('#btn-show-sidebar').hidden = !S.sidebarCollapsed;
}

/* ============================== Links ============================== */

export function refreshLinks() {
  for (const el of S.pageEls) {
    if (!el) continue;
    el.linkLayer.style.display = S.mode === 'view' ? '' : 'none';
  }
}

/* ============================== Mode ============================== */

export function setMode(mode) {
  if (mode !== 'view' && mode !== 'edit') return;
  S.mode = mode;
  document.body.dataset.mode = mode;
  document.body.classList.remove('text-pick');
  if (mode === 'view') S.tool = 'select';
  $('#toolrail').hidden = mode !== 'edit';
  $('#contextbar').hidden = mode !== 'edit' || !S.pdfjs;
  $('#inspector').hidden = mode !== 'edit' || !S.pdfjs || S.inspectorCollapsed;
  $('#btn-show-sidebar').style.top = mode === 'edit' ? '10px' : '10px';
  refreshLinks();
  repaintAll();
  updateStatusbar();
  document.dispatchEvent(new CustomEvent('pdfstudio:mode'));
}

/* ============================== Search ============================== */

function bindSearchControls() {
  $('#search-close').addEventListener('click', closeSearch);
  $('#search-prev').addEventListener('click', () => searchNext(-1));
  $('#search-next').addEventListener('click', () => searchNext(1));
  const input = $('#search-input');
  const debounced = debounce(() => runSearch(input.value), 260);
  input.addEventListener('input', () => {
    debounced();
    if (!input.value) {
      clearSearch();
      $('#search-count').textContent = '0 results';
    }
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) searchNext(-1);
      else searchNext(1);
    }
    if (event.key === 'Escape') closeSearch();
  });
  $('#scroll').addEventListener('scroll', handleScroll, { passive: true });
  $('#scroll').addEventListener('wheel', onWheel, { passive: false });
  $('#scroll').addEventListener('pointerdown', onScrollPointerDown);
  $('#scroll').addEventListener('pointermove', onScrollPointerMove);
  $('#scroll').addEventListener('pointerup', onScrollPointerUp);
  $('#scroll').addEventListener('pointercancel', onScrollPointerUp);

  $('#btn-zoom-in').addEventListener('click', () => zoomBy(1));
  $('#btn-zoom-out').addEventListener('click', () => zoomBy(-1));
  $('#zoom-label').addEventListener('click', zoomToActual);
  $('#btn-fit-width').addEventListener('click', () => applyFit('width'));
  $('#btn-fit-page').addEventListener('click', () => applyFit('page'));
  $('#btn-prev-page').addEventListener('click', () => scrollToPage(S.currentPage - 1));
  $('#btn-next-page').addEventListener('click', () => scrollToPage(S.currentPage + 1));
  $('#page-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const n = Number(event.target.value);
      if (Number.isFinite(n)) scrollToPage(n - 1);
      event.target.blur();
    }
  });
  $('#page-input').addEventListener('blur', () => updatePageInput());
}

export function openSearch() {
  S.search.open = true;
  const pop = $('#search-popover');
  pop.hidden = false;
  const input = $('#search-input');
  input.focus();
  input.select();
  if (input.value) runSearch(input.value);
}

export function closeSearch() {
  S.search.open = false;
  $('#search-popover').hidden = true;
  clearSearch();
}

export function clearSearch() {
  S.search.matches = [];
  S.search.index = -1;
  setSearchHighlights(new Map());
  $('#search-count').textContent = '0 results';
  repaintAll();
}

function setSearchHighlights(map) {
  S.search.highlights = map;
}

export async function runSearch(query) {
  const q = String(query || '').trim();
  if (!S.pdfjs) return;
  if (q.length < 2) {
    S.search.matches = [];
    S.search.index = -1;
    setSearchHighlights(new Map());
    $('#search-count').textContent = q ? 'Keep typing…' : '0 results';
    repaintAll();
    return;
  }
  const token = ++searchToken;
  $('#search-count').textContent = 'Searching…';
  const matches = [];
  const needle = q.toLocaleLowerCase();
  const pages = Array.from({ length: S.numPages }, (_, i) => i);
  const concurrency = 4;
  let cursor = 0;

  const worker = async () => {
    while (cursor < pages.length) {
      if (token !== searchToken) return;
      const pageIndex = pages[cursor];
      cursor += 1;
      try {
        const cache = await getPageText(pageIndex);
        if (!cache) continue;
        const haystack = cache.text.toLocaleLowerCase();
        let at = haystack.indexOf(needle);
        while (at !== -1 && matches.length < 2500) {
          const rects = cache.items
            .filter((item) => item.end > at && item.start < at + needle.length)
            .map((item) => item.rect);
          if (rects.length) {
            matches.push({
              page: pageIndex,
              start: at,
              end: at + needle.length,
              snippet: makeSnippet(cache.text, at, needle.length),
              rects,
            });
          }
          at = haystack.indexOf(needle, at + Math.max(1, needle.length));
        }
      } catch {
        /* skip unreadable page */
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (token !== searchToken) return;
  S.search.query = q;
  S.search.matches = matches;
  S.search.index = matches.length ? 0 : -1;
  $('#search-count').textContent = `${matches.length} result${matches.length === 1 ? '' : 's'}`;
  if (matches.length) {
    focusMatch(0, false);
  } else {
    setSearchHighlights(new Map());
    repaintAll();
  }
}

function makeSnippet(text, start, length) {
  const from = Math.max(0, start - 34);
  const to = Math.min(text.length, start + length + 42);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
}

async function getPageText(index) {
  if (textCache.has(index)) {
    const content = textCache.get(index);
    return await geometryForContent(index, content);
  }
  if (!S.pdfjs) return null;
  const page = await S.pdfjs.getPage(index + 1);
  const content = await page.getTextContent();
  textCache.set(index, content);
  return await geometryForContent(index, content);
}

const geometryCache = new Map();

async function geometryForContent(index, content) {
  if (geometryCache.has(index)) return geometryCache.get(index);
  const page = await S.pdfjs.getPage(index + 1);
  const viewport = page.getViewport({ scale: 1 });
  let text = '';
  const items = [];
  for (const item of content.items) {
    if (typeof item.str !== 'string' || !item.str) {
      if (item.str === '') continue;
      continue;
    }
    const start = text.length;
    text += item.str;
    const end = text.length;
    text += ' ';
    let rect = { x: 0, y: 0, w: 0, h: 0 };
    try {
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontH = Math.max(1, Math.hypot(tx[2], tx[3]));
      const width = Math.max(1, item.width * viewport.scale);
      rect = { x: tx[4], y: tx[5] - fontH, w: width, h: fontH };
    } catch {
      /* ignore */
    }
    items.push({ start, end, rect });
  }
  const result = { text, items };
  geometryCache.set(index, result);
  return result;
}

export function focusMatch(index, doScroll = true) {
  const matches = S.search.matches;
  if (!matches.length) return;
  S.search.index = ((index % matches.length) + matches.length) % matches.length;
  const match = matches[S.search.index];
  const map = new Map();
  const pageMatches = matches.filter((m) => m.page === match.page);
  map.set(match.page, pageMatches.flatMap((m) => m.rects));
  setSearchHighlights(map);
  if (doScroll) scrollToPage(match.page);
  repaintPage(match.page);
  $('#search-count').textContent = `${S.search.index + 1} of ${matches.length}`;
}

export function searchNext(direction = 1) {
  if (!S.search.matches.length) return;
  const next =
    S.search.index < 0
      ? direction > 0
        ? 0
        : S.search.matches.length - 1
      : S.search.index + direction;
  focusMatch(next, true);
}

/* ============================== Forms ============================== */

export async function discoverForms(tokenOverride) {
  const token = tokenOverride || formToken + 1;
  formToken = token;
  if (!S.pdfjs) return;
  S.formFields = [];
  document.dispatchEvent(new CustomEvent('pdfstudio:forms'));
  const found = [];
  for (let i = 0; i < S.numPages; i += 1) {
    if (token !== formToken || !S.pdfjs) return;
    try {
      const page = await S.pdfjs.getPage(i + 1);
      const annotations = await page.getAnnotations({ intent: 'display' });
      const viewport = page.getViewport({ scale: 1 });
      for (const ann of annotations) {
        if (ann.subtype !== 'Widget') continue;
        if (ann.hidden || ann.noView) continue;
        if (!ann.rect) continue;
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(ann.rect);
        const rect = {
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          w: Math.abs(x2 - x1),
          h: Math.abs(y2 - y1),
        };
        if (rect.w < 2 || rect.h < 2) continue;
        const name = ann.fieldName || ann.id || `field-${i}-${found.length}`;
        let value = ann.fieldValue;
        if (Array.isArray(value)) value = value[0];
        found.push({
          page: i,
          name,
          id: `${name}@${i}@${ann.buttonValue || ''}`,
          type: ann.fieldType || 'Tx',
          rect,
          value: value ?? '',
          buttonValue: ann.buttonValue || '',
          radio: Boolean(ann.radioButton),
          checkBox: Boolean(ann.checkBox),
          readOnly: Boolean(Number(ann.fieldFlags || 0) & 1),
          multiline: Boolean(Number(ann.fieldFlags || 0) & 4096),
          options: Array.isArray(ann.options)
            ? ann.options.map((o) => (typeof o === 'string' ? o : o.displayValue || o.exportValue || ''))
            : [],
          fieldFlags: Number(ann.fieldFlags || 0),
        });
      }
    } catch {
      /* skip page */
    }
  }
  if (token !== formToken) return;
  S.formFields = found;
  document.dispatchEvent(new CustomEvent('pdfstudio:forms'));
  repaintVisiblePages();
}

export function setFormValue(field, value) {
  S.formValues[field.name] = value;
  markDirty();
  repaintPage(field.page);
  updateStatusbar();
  document.dispatchEvent(new CustomEvent('pdfstudio:forms-value', { detail: { field, value } }));
}

export function formValueFor(field) {
  return Object.prototype.hasOwnProperty.call(S.formValues, field.name)
    ? S.formValues[field.name]
    : field.value;
}

/* ============================== Scroll pan / wheel ============================== */

let spaceDown = false;
let panState = null;

function onWheel(event) {
  if (!S.pdfjs) return;
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1 : -1);
    return;
  }
  if (spaceDown && Math.abs(event.deltaY) > 0) {
    event.preventDefault();
    $('#scroll').scrollBy({ top: event.deltaY, left: event.deltaX });
  }
}

function onScrollPointerDown(event) {
  if (event.button !== 1) return;
  event.preventDefault();
  panState = { x: event.clientX, y: event.clientY, left: $('#scroll').scrollLeft, top: $('#scroll').scrollTop };
  $('#scroll').setPointerCapture(event.pointerId);
  $('#scroll').style.cursor = 'grabbing';
}

function onScrollPointerMove(event) {
  if (!panState) return;
  $('#scroll').scrollLeft = panState.left - (event.clientX - panState.x);
  $('#scroll').scrollTop = panState.top - (event.clientY - panState.y);
}

function onScrollPointerUp() {
  panState = null;
  $('#scroll').style.cursor = '';
}

export function setSpaceDown(value) {
  spaceDown = value;
  $('#scroll').style.cursor = value ? 'grab' : '';
}

/* ============================== History support ============================== */

export async function restoreHistoryEntry(entry) {
  if (entry.kind === 'doc' && entry.bytes) {
    await loadDocument(entry.bytes, {
      name: entry.name,
      path: entry.path,
      size: entry.bytes.length,
      reload: true,
      preserveView: true,
      keepOverlays: true,
    });
  }
  S.overlays = new Map(entry.overlays || []);
  S.formValues = entry.formValues || {};
  S.meta = entry.meta || S.meta;
  S.metaDirty = Boolean(entry.metaDirty);
  S.selected = entry.selected || null;
  S.currentPage = clamp(entry.currentPage || 0, 0, Math.max(0, S.numPages - 1));
  S.dirty = true;
  updateDirtyChrome();
  layoutPages();
  scrollToPage(S.currentPage, { smooth: false });
  repaintAll();
  updateStatusbar();
  document.dispatchEvent(new CustomEvent('pdfstudio:docloaded'));
}

/* ============================== Misc ============================== */

export async function mapLimit(items, limit) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await item;
    }
  });
  await Promise.all(workers);
}

function updateRightPanel() {
  document.dispatchEvent(new CustomEvent('pdfstudio:refresh'));
}

export function getPdfjs() {
  return S.pdfjs;
}

export function setSearchOpen(open) {
  if (open) openSearch();
  else closeSearch();
}

export function flashPage(index) {
  const el = S.pageEls[index];
  if (!el) return;
  el.shell.animate(
    [
      { boxShadow: '0 0 0 0 rgba(176,82,43,0)' },
      { boxShadow: '0 0 0 4px rgba(176,82,43,.22)' },
      { boxShadow: '0 0 0 0 rgba(176,82,43,0)' },
    ],
    { duration: 1100, easing: 'ease-out' }
  );
}
