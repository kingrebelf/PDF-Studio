import { S, hasUnsavedChanges, loadRecent, pushRecent, markClean, loadSignatures } from './state.js';
import {
  $,
  $$,
  icon,
  toast,
  openModal,
  promptModal,
  menu,
  escapeHtml,
  formatRelativeTime,
  basename,
  showBusy,
  hideBusy,
} from './ui.js';
import { hydrateIcons } from './icons.js';
import * as History from './history.js';
import {
  initViewer,
  loadDocument,
  destroyView,
  refreshDocumentChrome,
  setMode,
  setSidebarTab,
  toggleSidebar,
  applyTheme,
  toggleTheme,
  togglePdfDark,
  openSearch,
  closeSearch,
  closeSearch as hideSearch,
  repaintAll,
  repaintVisiblePages,
  updateStatusbar,
  scrollToPage,
  restoreHistoryEntry,
  setSpaceDown,
  refreshLinks,
} from './workspace.js';
import {
  initEditing,
  setTool,
  handleEditorKey,
  deleteSelection,
  duplicateSelection,
  applyMarkToSelection,
  selectPageText,
  closeTextEditor,
  selectionPage,
} from './editing.js';
import { buildToolRail, renderContextbar, toolShortcut } from './toolbar.js';
import { initInspector, showInspector, renderInspector } from './inspector.js';
import {
  saveDocument,
  saveCopy,
  exportText,
  exportImages,
  printDocument,
  rotatePage,
  rotateDocument,
  deletePage,
  duplicatePage,
  insertBlankPage,
  movePage,
  mergeDocuments,
  extractPages,
  chooseAndExtract,
  setDocumentMetadata,
  flattenNow,
} from './docops.js';
import {
  openPageManager,
  openWatermarkDialog,
  openHeaderFooterDialog,
  openBatesDialog,
  openCompressDialog,
} from './dialogs-doc.js';
import { openSignatureDialog } from './signature.js';

const SAMPLE_URL = new URL('../assets/sample.pdf', import.meta.url).href;
let busyOpening = false;

/* ============================== boot ============================== */

async function boot() {
  hydrateIcons(document);
  const launcher = document.getElementById('launcher');
  document.getElementById('launcher-continue').addEventListener('click', () => { launcher.hidden = true; });
  document.getElementById('launcher-donate').addEventListener('click', () => {
    window.api?.openExternal('https://buy.stripe.com/4gMaEZbjc0cd23293U9IQ00');
  });
  document.body.classList.add(`platform-${window.api?.platform || 'web'}`);
  if (!window.api) {
    document.getElementById('window-controls')?.setAttribute('hidden', '');
    document.getElementById('btn-theme')?.removeAttribute('disabled');
  }

  initViewer();
  initEditing();
  buildToolRail();
  initInspector();
  History.setRestoreHandler(async (entry) => {
    await restoreHistoryEntry(entry);
    renderContextbar();
    renderInspector();
    repaintAll();
    updateStatusbar();
  });

  wireChrome();
  wireModes();
  wireActions();
  wireKeyboard();
  wireDrop();
  wireIpc();
  wireWelcome();
  refreshRecent();
  updateHistoryButtons();
  updateWindowState();
  setMode('view');
  refreshDocumentChrome();
  refreshAppearanceButtons();

  document.addEventListener('pdfstudio:history', updateHistoryButtons);
  document.addEventListener('pdfstudio:selection', updateHistoryButtons);
  document.addEventListener('pdfstudio:refresh', () => {
    updateHistoryButtons();
    updateStatusbar();
  });
  document.addEventListener('pdfstudio:forms', () => repaintVisiblePages());
  document.addEventListener('pdfstudio:forms-value', () => {
    repaintVisiblePages();
    updateStatusbar();
  });
  document.addEventListener('pdfstudio:toolchange', () => {
    renderContextbar();
    renderInspector();
  });
  document.addEventListener('pdfstudio:mode', () => {
    renderContextbar();
    if (S.mode === 'edit') showInspector();
  });
  document.addEventListener('pdfstudio:open-bytes', (event) => {
    const file = event.detail;
    if (file?.data) openFileData(file.data, file.name, file.path);
  });

  window.__pdfstudio = {
    S,
    openFileData,
    openPath,
    actions: runAction,
    booted: true,
  };
}

/* ============================== chrome ============================== */

function wireChrome() {
  $('#btn-open').addEventListener('click', chooseFile);
  $('#welcome-open').addEventListener('click', chooseFile);
  $('#welcome-sample').addEventListener('click', openSample);
  $('#btn-save').addEventListener('click', () => saveDocument());
  $('#btn-print').addEventListener('click', () => printDocument());
  $('#btn-search').addEventListener('click', toggleSearch);
  $('#btn-appearance').addEventListener('click', () => {
    togglePdfDark();
    refreshAppearanceButtons();
    toast(S.pdfDark ? 'Dark paper on' : 'Dark paper off', 'info', 1500);
  });
  $('#btn-theme').addEventListener('click', () => {
    toggleTheme();
    refreshAppearanceButtons();
    document.dispatchEvent(new CustomEvent('pdfstudio:refresh'));
  });
  $('#btn-more').addEventListener('click', (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    openMoreMenu(rect.left + rect.width, rect.bottom + 6);
  });
  $('#btn-undo').addEventListener('click', () => History.undo());
  $('#btn-redo').addEventListener('click', () => History.redo());

  $$('#mode-switch button').forEach((button) => {
    button.addEventListener('click', () => switchMode(button.dataset.mode));
  });

  $$('#window-controls [data-win]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.api?.windowControl) return;
      await window.api.windowControl(button.dataset.win);
      updateWindowState();
    });
  });

  $('#btn-hide-sidebar')?.addEventListener('click', () => {
    toggleSidebar(true);
    setTimeout(() => renderContextbar(), 210);
  });
  $('#btn-show-sidebar')?.addEventListener('click', () => {
    toggleSidebar(false);
    setTimeout(() => renderContextbar(), 210);
  });

  const pageInput = $('#page-input');
  pageInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const n = Number(pageInput.value);
      if (Number.isFinite(n)) scrollToPage(n - 1);
      pageInput.blur();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (hasUnsavedChanges() && !window.api) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

function refreshAppearanceButtons() {
  const appearance = $('#btn-appearance');
  if (appearance) appearance.innerHTML = icon(S.pdfDark ? 'sun' : 'moon', 17);
  const theme = $('#btn-theme');
  if (theme) theme.innerHTML = icon(S.theme === 'dark' ? 'sun' : 'moon', 17);
  theme?.setAttribute('title', S.theme === 'dark' ? 'Light app theme' : 'Dark app theme');
}

async function updateWindowState() {
  if (!window.api?.getWindowState) return;
  const state = await window.api.getWindowState();
  const button = $('#window-controls [data-win="maximize"]');
  if (button) button.innerHTML = icon(state?.maximized ? 'win-restore' : 'win-max', 15);
}

/* ============================== modes ============================== */

function wireModes() {
  $$('#mode-switch button').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === S.mode);
  });
}

function switchMode(mode) {
  if (mode === S.mode) return;
  if (mode === 'edit' && S.pdfjs && !S.editable) {
    toast('This PDF is protected, so Editor mode is unavailable. You can still read, print and save a copy.', 'warning', 4600);
    return;
  }
  if (mode === 'edit' && !S.pdfjs) {
    toast('Open a PDF to start editing.', 'info', 2000);
    return;
  }
  closeTextEditor();
  setMode(mode);
  $$('#mode-switch button').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.body.dataset.mode = mode;
  if (mode === 'edit') {
    buildToolRail();
    setTool('select');
    showInspector();
    renderContextbar();
    document.body.classList.remove('text-pick');
  } else {
    closeSearch();
    $('#toolrail').hidden = true;
    $('#contextbar').hidden = true;
    $('#inspector').hidden = true;
    document.body.classList.remove('text-pick');
    S.tool = 'select';
    refreshLinks();
  }
  updateStatusbar();
}

/* ============================== files ============================== */

function chooseFile() {
  if (window.api?.openPDF) {
    window.api
      .openPDF()
      .then((file) => {
        if (file) openFileData(file.data, file.name, file.path);
      })
      .catch((error) => toast(error?.message || 'That file could not be opened.', 'error'));
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf,.pdf';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => openFileData(reader.result, file.name, null);
    reader.onerror = () => toast('That file could not be read.', 'error');
    reader.readAsArrayBuffer(file);
  });
  input.click();
}

export async function openPath(path) {
  try {
    if (window.api?.openPath) {
      const file = await window.api.openPath(path);
      if (file) return openFileData(file.data, file.name, file.path);
      return false;
    }
    toast('Opening recent files needs the desktop app.', 'info');
    return false;
  } catch (error) {
    toast(error?.message || 'That file could not be opened.', 'error');
    return false;
  }
}

export async function openFileData(data, name = 'Document.pdf', path = null) {
  if (busyOpening) return false;
  const proceed = await confirmReplaceDocument();
  if (!proceed) return false;
  busyOpening = true;
  showBusy('Opening PDF…', 'Reading the document and rendering the first pages.');
  try {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    await loadDocument(bytes, { name, path, size: bytes.length, fit: 'page' });
    markClean();
    History.clearHistory();
    pushRecent({ path: path || name, name });
    refreshRecent();
    updateHistoryButtons();
    refreshDocumentChrome();
    refreshAppearanceButtons();
    renderContextbar();
    if (S.mode === 'edit' && S.editable) showInspector();
    if (!S.editable) {
      switchMode('view');
      toast('This PDF is protected. Read-only mode is on; you can still save a copy.', 'warning', 5200);
    }
    if (S.mode === 'edit') {
      buildToolRail();
      setTool('select');
    }
    return true;
  } catch (error) {
    console.error(error);
    const message = /password|encrypted/i.test(String(error?.message || ''))
      ? 'This PDF is password protected and could not be unlocked.'
      : error?.message || 'That PDF could not be opened.';
    toast(message, 'error', 5200);
    refreshDocumentChrome();
    return false;
  } finally {
    busyOpening = false;
    hideBusy();
  }
}

async function openSample() {
  const proceed = await confirmReplaceDocument();
  if (!proceed) return false;
  busyOpening = true;
  showBusy('Opening the sample…', 'A short agreement with a form, a signature box and a rotated page.');
  try {
    const response = await fetch(SAMPLE_URL);
    if (!response.ok) throw new Error('The sample document is missing.');
    const buffer = await response.arrayBuffer();
    await loadDocument(new Uint8Array(buffer), {
      name: 'PDF Studio Sample.pdf',
      path: null,
      size: buffer.byteLength,
      fit: 'page',
    });
    markClean();
    History.clearHistory();
    refreshDocumentChrome();
    renderContextbar();
    switchMode('edit');
    return true;
  } catch (error) {
    toast(error?.message || 'The sample could not be opened.', 'error');
    return false;
  } finally {
    busyOpening = false;
    hideBusy();
  }
}

async function confirmReplaceDocument() {
  if (!S.pdfjs || !hasUnsavedChanges()) return true;
  const choice = await promptUnsaved();
  if (choice === 'cancel') return false;
  if (choice === 'save') {
    const saved = await saveDocument();
    if (!saved) return false;
  }
  return true;
}

function promptUnsaved() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const modal = openModal({
      title: 'Save your changes?',
      subtitle: `${S.name || 'This document'} has annotations that have not been written into the PDF yet.`,
      size: 'narrow',
      iconName: 'save',
      body: `<div class="confirm-copy">Saving burns highlights, notes, signatures and form values into the file. If you discard, those edits are lost.</div>`,
      footer: `
        <button type="button" class="btn ghost" data-choice="cancel">Cancel</button>
        <button type="button" class="btn" data-choice="discard">Discard</button>
        <button type="button" class="btn primary" data-choice="save">Save</button>`,
      onClose: () => finish('cancel'),
    });
    modal.footerEl.querySelectorAll('[data-choice]').forEach((button) => {
      button.addEventListener('click', () => {
        finish(button.dataset.choice);
        modal.close(true);
      });
    });
  });
}

function refreshRecent() {
  const wrap = $('#recent-wrap');
  const list = $('#recent-list');
  if (!wrap || !list) return;
  const recent = loadRecent();
  wrap.hidden = !recent.length;
  list.innerHTML = '';
  recent.forEach((entry) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-item';
    button.innerHTML = `${icon('file', 14)}<span>${escapeHtml(entry.name || basename(entry.path))}</span><time>${formatRelativeTime(entry.time)}</time>`;
    button.title = entry.path;
    button.addEventListener('click', () => openPath(entry.path));
    list.append(button);
  });
}

/* ============================== more menu ============================== */

function openMoreMenu(x, y) {
  const hasDoc = Boolean(S.pdfjs);
  menu({
    x,
    y,
    align: 'right',
    items: [
      { label: 'Open PDF…', icon: 'folder-open', shortcut: 'Ctrl+O', action: chooseFile },
      { label: 'Save', icon: 'save', shortcut: 'Ctrl+S', disabled: !hasDoc, action: () => saveDocument() },
      { label: 'Save a copy…', icon: 'copy', shortcut: 'Ctrl+Shift+S', disabled: !hasDoc, action: () => saveCopy() },
      { type: 'sep' },
      { label: 'Print…', icon: 'printer', shortcut: 'Ctrl+P', disabled: !hasDoc, action: () => printDocument() },
      { label: 'Export text…', icon: 'file-text', disabled: !hasDoc, action: () => exportText() },
      { label: 'Export pages as images…', icon: 'image', disabled: !hasDoc, action: () => exportImages() },
      { type: 'sep' },
      { heading: 'Document tools' },
      { label: 'Manage pages…', icon: 'pages', disabled: !hasDoc, action: () => openPageManager() },
      { label: 'Merge PDFs…', icon: 'merge', disabled: !hasDoc, action: () => mergeDocuments() },
      { label: 'Extract pages…', icon: 'split', disabled: !hasDoc, action: () => chooseAndExtract() },
      { label: 'Watermark…', icon: 'watermark', disabled: !hasDoc, action: () => openWatermarkDialog() },
      { label: 'Header & footer…', icon: 'header', disabled: !hasDoc, action: () => openHeaderFooterDialog() },
      { label: 'Bates numbering…', icon: 'hash', disabled: !hasDoc, action: () => openBatesDialog() },
      { label: 'Compress…', icon: 'compress', disabled: !hasDoc, action: () => openCompressDialog() },
      { label: 'Rotate all pages', icon: 'rotate-cw', disabled: !hasDoc, action: () => rotateDocument(90) },
      { label: 'Flatten annotations', icon: 'layers', disabled: !hasDoc, action: () => flattenNow() },
      { label: 'Document properties…', icon: 'info', disabled: !hasDoc, action: () => openPropertiesDialog() },
      { type: 'sep' },
      { label: 'Keyboard shortcuts', icon: 'keyboard', action: openShortcuts },
      { label: 'About PDF Studio', icon: 'help', action: openAbout },
      { type: 'sep' },
      { label: 'Close document', icon: 'x', disabled: !hasDoc, action: closeDocument },
    ],
  });
}

function openPropertiesDialog() {
  if (!S.pdfjs) return;
  const meta = S.meta || {};
  const modal = openModal({
    title: 'Document properties',
    subtitle: 'Embedded in the PDF the next time you save.',
    iconName: 'info',
    body: `
      <div class="grid-2">
        <div class="form-field"><label class="field-label" for="prop-title">Title</label><input id="prop-title" type="text" value="${escapeHtml(meta.title || '')}"></div>
        <div class="form-field"><label class="field-label" for="prop-author">Author</label><input id="prop-author" type="text" value="${escapeHtml(meta.author || '')}"></div>
      </div>
      <div class="form-field"><label class="field-label" for="prop-subject">Subject</label><input id="prop-subject" type="text" value="${escapeHtml(meta.subject || '')}"></div>
      <div class="form-field"><label class="field-label" for="prop-keywords">Keywords</label><input id="prop-keywords" type="text" value="${escapeHtml(Array.isArray(meta.keywords) ? meta.keywords.join(', ') : meta.keywords || '')}" placeholder="contract, signed"></div>
      <div class="insp-note">
        ${S.numPages} pages · ${((S.bytes?.length || 0) / 1024 / 1024).toFixed(2)} MB<br>
        ${meta.producer ? `Producer: ${escapeHtml(meta.producer)}<br>` : ''}
        ${meta.creationDate ? `Created: ${escapeHtml(String(meta.creationDate).slice(0, 10))}` : ''}
      </div>`,
    footer: `<button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="prop-apply">${icon('check', 15)} Save properties</button>`,
  });
  modal.footerEl.querySelector('#prop-apply').addEventListener('click', () => {
    const value = (id) => modal.bodyEl.querySelector(id).value.trim();
    const meta2 = {
      title: value('#prop-title'),
      author: value('#prop-author'),
      subject: value('#prop-subject'),
      keywords: value('#prop-keywords')
        .split(/[,;]\s*/)
        .filter(Boolean),
    };
    modal.close(true);
    setDocumentMetadata(meta2);
  });
}

function openShortcuts() {
  const rows = [
    ['Ctrl+O', 'Open a PDF'],
    ['Ctrl+S', 'Save (burn annotations in)'],
    ['Ctrl+Shift+S', 'Save a copy'],
    ['Ctrl+P', 'Print'],
    ['Ctrl+F', 'Find in document'],
    ['Ctrl+Z', 'Undo'],
    ['Ctrl+Shift+Z / Ctrl+Y', 'Redo'],
    ['Ctrl+A', 'Select all text on the page'],
    ['Delete', 'Remove the selected object'],
    ['Ctrl+D', 'Duplicate the selected object'],
    ['Arrow keys', 'Nudge a selected object'],
    ['Shift + Arrow', 'Nudge by 10 points'],
    ['+ / − / 0', 'Zoom in, out, actual size'],
    ['Esc', 'Close search, menus, or deselect'],
    ['V T N I H U K D S G Y R F P E', 'Switch tools'],
    ['Space + drag', 'Pan the page'],
    ['Ctrl + wheel', 'Zoom at the pointer'],
  ];
  openModal({
    title: 'Keyboard shortcuts',
    subtitle: 'Everything within reach.',
    iconName: 'keyboard',
    body: `<div class="shortcut-list">${rows
      .map(
        ([keys, label]) =>
          `<div class="shortcut-row"><span>${escapeHtml(label)}</span><kbd>${escapeHtml(keys)}</kbd></div>`
      )
      .join('')}</div>`,
    size: 'narrow',
  });
}

function openAbout() {
  const info = window.api?.getInfo?.();
  Promise.resolve(info)
    .then((details) => {
      openModal({
        title: 'PDF Studio',
        subtitle: 'Read it. Sign it. Make it yours.',
        iconName: 'file',
        size: 'narrow',
        body: `
          <div class="about-art">
            <div class="about-mark">${icon('signature', 46)}</div>
            <p>Version ${escapeHtml(details?.version || '1.0.0')}</p>
            <p class="hint">Electron ${escapeHtml(details?.electron || '—')} · Chromium ${escapeHtml(details?.chrome || '—')}</p>
          </div>
          <div class="callout neutral">${icon('shield', 15)}<div>Local-first by design: no account, no cloud, no telemetry. Everything you open and edit stays on this machine.</div></div>
          <p class="hint">Built with PDF.js and pdf-lib. Great Vibes is used under the SIL Open Font License.</p>`,
        footer: `<button type="button" class="btn" data-close>Close</button>`,
      });
    })
    .catch(() => {});
}

async function closeDocument() {
  if (!S.pdfjs) return;
  const proceed = await confirmReplaceDocument();
  if (!proceed) return;
  destroyView();
  markClean();
  History.clearHistory();
  S.name = '';
  S.path = null;
  refreshDocumentChrome();
  refreshRecent();
  switchMode('view');
  $('#doc-name').textContent = 'No document';
}

/* ============================== search ============================== */

function toggleSearch() {
  if (!S.pdfjs) return;
  if (S.search.open) hideSearch();
  else openSearch();
}

/* ============================== actions ============================== */

function wireActions() {
  document.addEventListener('pdfstudio:action', (event) => {
    const detail = event.detail || {};
    runAction(detail.action, detail).catch((error) => {
      console.error(error);
      toast(error?.message || 'That action failed.', 'error');
    });
  });
  document.addEventListener('pdfstudio:quick-mark', (event) => {
    applyMarkToSelection(event.detail?.type);
  });
}

export async function runAction(action, detail = {}) {
  if (!action) return false;
  switch (action) {
    case 'save':
      return saveDocument();
    case 'save-as':
      return saveDocument({ saveAs: true });
    case 'save-copy':
      return saveCopy();
    case 'print':
      return printDocument();
    case 'export-text':
      return exportText();
    case 'export-images':
      return exportImages();
    case 'pages':
      return openPageManager();
    case 'rotate-page':
      return rotatePage(detail.page ?? S.currentPage, detail.delta ?? 90);
    case 'rotate-doc':
      return rotateDocument(detail.delta ?? 90);
    case 'delete-page':
      return deletePage(detail.page ?? S.currentPage);
    case 'duplicate-page':
      return duplicatePage(detail.page ?? S.currentPage);
    case 'insert-blank':
      return insertBlankPage(detail.at ?? S.currentPage + 1);
    case 'move-page':
      return movePage(detail.from, detail.to);
    case 'merge':
      return mergeDocuments();
    case 'extract-pages':
      return detail.pages?.length ? extractPages(detail.pages) : chooseAndExtract();
    case 'watermark':
      return openWatermarkDialog();
    case 'header-footer':
      return openHeaderFooterDialog();
    case 'bates':
      return openBatesDialog();
    case 'compress':
      return openCompressDialog();
    case 'flatten':
      return flattenNow();
    case 'set-metadata':
      return setDocumentMetadata(detail.meta || {});
    case 'properties':
    case 'metadata':
      return openPropertiesDialog();
    case 'theme':
      toggleTheme();
      refreshAppearanceButtons();
      return true;
    case 'pdf-dark':
      togglePdfDark();
      refreshAppearanceButtons();
      return true;
    case 'close-document':
      return closeDocument();
    case 'shortcuts':
      openShortcuts();
      return true;
    case 'about':
      openAbout();
      return true;
    case 'undo':
      return History.undo();
    case 'redo':
      return History.redo();
    case 'search':
      toggleSearch();
      return true;
    default:
      console.warn('Unknown action', action);
      return false;
  }
}

/* ============================== keyboard ============================== */

function wireKeyboard() {
  window.addEventListener('keydown', (event) => {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable;
    const mod = event.ctrlKey || event.metaKey;

    if (event.key === 'Escape') {
      hideSelectionMenu();
      if ($('#menu-root').classList.contains('open')) {
        $('#menu-root').innerHTML = '';
        $('#menu-root').classList.remove('open');
        return;
      }
      if (document.querySelector('.modal-backdrop')) return;
      if (S.search.open) {
        closeSearch();
        return;
      }
      if (document.activeElement?.classList.contains('text-editor')) {
        document.activeElement.blur();
        return;
      }
      if (S.selected) {
        const { selectOverlay } = window.__pdfstudio || {};
        document.dispatchEvent(new CustomEvent('pdfstudio:deselect'));
        S.selected = null;
        repaintAll();
        document.dispatchEvent(new CustomEvent('pdfstudio:selection'));
        return;
      }
      return;
    }

    if (typing) return;

    if (mod && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      chooseFile();
      return;
    }
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (event.shiftKey) saveCopy();
      else saveDocument();
      return;
    }
    if (mod && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      printDocument();
      return;
    }
    if (mod && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      toggleSearch();
      return;
    }
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) History.redo();
      else History.undo();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      History.redo();
      return;
    }
    if (mod && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      if (S.mode === 'edit' && S.selected) duplicateSelection();
      return;
    }
    if (mod && event.key.toLowerCase() === 'a') {
      if (S.mode === 'edit' && ['text-pick', 'highlight', 'underline', 'strike'].includes(S.tool)) {
        event.preventDefault();
        selectPageText();
      }
      return;
    }
    if (mod && (event.key === '=' || event.key === '+')) {
      event.preventDefault();
      import('./workspace.js').then(({ zoomBy }) => zoomBy(1));
      return;
    }
    if (mod && event.key === '-') {
      event.preventDefault();
      import('./workspace.js').then(({ zoomBy }) => zoomBy(-1));
      return;
    }
    if (mod && event.key === '0') {
      event.preventDefault();
      import('./workspace.js').then(({ zoomToActual }) => zoomToActual());
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (handleEditorKey(event)) return;
      return;
    }
    if (event.key.startsWith('Arrow')) {
      if (handleEditorKey(event)) return;
    }
    if (event.key === ' ' && S.pdfjs && !event.repeat) {
      if (document.activeElement?.tagName === 'BUTTON') return;
      setSpaceDown(true);
      event.preventDefault();
      return;
    }
    if (!mod && !event.altKey && S.mode === 'edit' && event.key.length === 1) {
      if (toolShortcut(event.key)) {
        event.preventDefault();
      }
    }
  });

  window.addEventListener('keyup', (event) => {
    if (event.key === ' ') setSpaceDown(false);
  });
  window.addEventListener('blur', () => setSpaceDown(false));
}

function hideSelectionMenu() {
  const root = $('#menu-root');
  if (root?.classList.contains('open')) {
    root.classList.remove('open');
    root.innerHTML = '';
  }
}

function updateHistoryButtons() {
  const undo = $('#btn-undo');
  const redo = $('#btn-redo');
  if (undo) undo.disabled = !History.canUndo();
  if (redo) redo.disabled = !History.canRedo();
}

/* ============================== drag & drop ============================== */

function wireDrop() {
  let depth = 0;
  const overlay = $('#drop-overlay');
  window.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    depth += 1;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const file = event.dataTransfer.files[0];
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      toast('Only PDF files can be opened here.', 'warning');
      return;
    }
    const path = window.api?.getPathForFile?.(file) || '';
    if (path) openPath(path);
    else {
      const reader = new FileReader();
      reader.onload = () => openFileData(reader.result, file.name, null);
      reader.readAsArrayBuffer(file);
    }
  });
}

/* ============================== IPC ============================== */

function wireIpc() {
  window.api?.onOpenFile?.((path) => {
    if (path) openPath(path);
  });
  window.api?.onCloseRequest?.(async () => {
    if (!S.pdfjs || !hasUnsavedChanges()) {
      window.api.closeResponse(true);
      return;
    }
    const choice = await promptUnsaved();
    if (choice === 'cancel') {
      window.api.closeResponse(false);
      return;
    }
    if (choice === 'save') {
      const saved = await saveDocument({ silent: true });
      window.api.closeResponse(Boolean(saved));
      return;
    }
    window.api.closeResponse(true);
  });
  window.api?.onWindowState?.((state) => {
    const button = $('#window-controls [data-win="maximize"]');
    if (button) button.innerHTML = icon(state?.maximized ? 'win-restore' : 'win-max', 15);
  });
  window.api?.onCommand?.((command) => {
    if (command) runAction(command);
  });
}

/* ============================== welcome ============================== */

function wireWelcome() {
  // Recent files and welcome buttons are wired in wireChrome; keep the
  // welcome screen's copy fresh with the saved signature count when useful.
  try {
    const signatures = loadSignatures().length;
    if (signatures) document.dispatchEvent(new CustomEvent('pdfstudio:refresh'));
  } catch {
    /* ignore */
  }
}

/* ============================== start ============================== */

boot().catch((error) => {
  console.error('PDF Studio failed to start', error);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div style="position:fixed;inset:auto 16px 16px 16px;padding:14px 16px;background:#2b241c;color:#fff;border-radius:10px;font:13px system-ui;z-index:9999">PDF Studio could not start: ${escapeHtml(error?.message || String(error))}</div>`
  );
});
