import { S, PALETTE } from './state.js';
import { $, $$, icon, escapeHtml, openModal, confirmModal, toast, parsePageRange } from './ui.js';
import {
  rotatePage,
  removePageAt,
  duplicatePage,
  insertBlankPage,
  movePage,
  extractPages,
} from './docops.js';
import {
  applyWatermark,
  applyHeaderFooter,
  applyBates,
  compressDocument,
} from './docops-extra.js';
import { scrollToPage, flashPage, renderPageToCanvas } from './workspace.js';

/* ============================== shared fields ============================== */

function pageRangeInput(id, value = 'all', label = 'Pages') {
  return `<div class="form-field">
    <label class="field-label" for="${id}">${escapeHtml(label)}</label>
    <input id="${id}" type="text" value="${escapeHtml(value)}" placeholder="all, or 1-3, 7">
    <div class="hint">Use “all”, single pages, ranges, or a list — e.g. <code>1-3, 7, 10-</code>.</div>
  </div>`;
}

function parseRange(input, fallbackAll = true) {
  try {
    const pages = parsePageRange(input.value, S.numPages);
    if (!pages.length && fallbackAll) return Array.from({ length: S.numPages }, (_, i) => i);
    return pages;
  } catch (error) {
    throw error;
  }
}

function colorRow(id, value) {
  return `<div class="swatch-grid" id="${id}">
    ${PALETTE.map((color) => `<button type="button" class="color-swatch${color.value === value ? ' active' : ''}" data-color="${color.value}" style="background:${color.value}" title="${color.name}"></button>`).join('')}
    <button type="button" class="color-swatch" data-color="#5d564c" style="background:#5d564c" title="Slate"></button>
    <button type="button" class="color-swatch" data-color="#8a7f70" style="background:#8a7f70" title="Warm grey"></button>
  </div>`;
}

function bindColors(root, id, onChange) {
  const node = root.querySelector(`#${id}`);
  if (!node) return;
  let current = node.querySelector('.color-swatch.active')?.dataset.color || node.querySelector('.color-swatch')?.dataset.color;
  node.querySelectorAll('.color-swatch').forEach((button) => {
    button.addEventListener('click', () => {
      node.querySelectorAll('.color-swatch').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      current = button.dataset.color;
      onChange(current);
    });
  });
  return () => current;
}

/* ============================== page manager ============================== */

export function openPageManager() {
  if (!S.pdfjs) return;
  let selected = new Set();
  let closed = false;
  let lastAnchor = null;

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="pm-toolbar">
      <button type="button" class="btn small subtle" data-pm="rotate-cw">${icon('rotate-cw', 14)} Rotate right</button>
      <button type="button" class="btn small subtle" data-pm="rotate-ccw">${icon('rotate-ccw', 14)} Rotate left</button>
      <button type="button" class="btn small subtle" data-pm="duplicate">${icon('duplicate', 14)} Duplicate</button>
      <button type="button" class="btn small subtle" data-pm="insert">${icon('plus', 14)} Insert blank</button>
      <button type="button" class="btn small subtle" data-pm="extract">${icon('export', 14)} Extract</button>
      <button type="button" class="btn small subtle" data-pm="left">${icon('chevron-left', 14)} Move left</button>
      <button type="button" class="btn small subtle" data-pm="right">${icon('chevron-right', 14)} Move right</button>
      <span class="context-spacer"></span>
      <button type="button" class="btn small danger" data-pm="delete">${icon('trash', 14)} Delete</button>
    </div>
    <div class="pm-selection-note" id="pm-note">Select pages to reorder or change them. Click, shift-click for a range.</div>
    <div class="page-manager-grid" id="pm-grid"></div>`;

  const modal = openModal({
    title: 'Pages',
    subtitle: 'Rotate, reorder, duplicate, insert, extract or remove pages. Changes apply immediately.',
    body,
    size: 'wide',
    iconName: 'pages',
    footer: `<span class="left" id="pm-count">${S.numPages} pages</span><button type="button" class="btn" data-close>Done</button>`,
    onClose: () => {
      closed = true;
    },
  });

  const grid = body.querySelector('#pm-grid');
  const note = body.querySelector('#pm-note');
  const renderToken = { value: 0 };

  async function renderGrid() {
    const token = ++renderToken.value;
    grid.innerHTML = '';
    const limit = Math.min(S.numPages, 160);
    for (let i = 0; i < limit; i += 1) {
      const item = document.createElement('div');
      item.className = `pm-item${selected.has(i) ? ' selected' : ''}`;
      item.dataset.page = String(i);
      item.innerHTML = `
        <div class="pm-thumb" style="aspect-ratio:${S.pages[i]?.viewW || 612} / ${S.pages[i]?.viewH || 792};background:#fff;border-radius:3px;display:grid;place-items:center;overflow:hidden">
          <div class="thumb-skeleton" style="position:relative;width:100%;height:100%"></div>
        </div>
        <span class="pm-num">${i + 1}</span>
        <span class="pm-check">${icon('check', 10)}</span>
        ${S.pages[i]?.rot ? `<span class="pm-rot">${S.pages[i].rot}°</span>` : ''}`;
      item.addEventListener('click', (event) => {
        if (event.shiftKey && lastAnchor !== null) {
          const [a, b] = [Math.min(lastAnchor, i), Math.max(lastAnchor, i)];
          for (let n = a; n <= b; n += 1) selected.add(n);
        } else if (event.metaKey || event.ctrlKey) {
          if (selected.has(i)) selected.delete(i);
          else selected.add(i);
          lastAnchor = i;
        } else {
          selected = new Set([i]);
          lastAnchor = i;
        }
        updateSelectionUi();
      });
      item.addEventListener('dblclick', () => {
        scrollToPage(i);
        flashPage(i);
        modal.close();
      });
      grid.append(item);
    }
    if (limit < S.numPages) {
      const noteEl = document.createElement('div');
      noteEl.className = 'hint';
      noteEl.style.gridColumn = '1 / -1';
      noteEl.textContent = `Showing the first ${limit} of ${S.numPages} pages.`;
      grid.append(noteEl);
    }
    updateSelectionUi();

    const concurrency = 2;
    let cursor = 0;
    const worker = async () => {
      while (cursor < limit && token === renderToken.value && !closed) {
        const index = cursor;
        cursor += 1;
        try {
          const canvas = await renderPageToCanvas(index, 0.26, { overlays: true });
          if (token !== renderToken.value) return;
          const holder = grid.querySelector(`[data-page="${index}"] .pm-thumb`);
          if (holder) {
            holder.innerHTML = '';
            holder.append(canvas);
          }
        } catch {
          /* ignore one page */
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  function updateSelectionUi() {
    grid.querySelectorAll('.pm-item').forEach((item) => {
      item.classList.toggle('selected', selected.has(Number(item.dataset.page)));
    });
    const count = selected.size;
    note.textContent = count
      ? `${count} page${count === 1 ? '' : 's'} selected`
      : 'Select pages to reorder or change them. Click, shift-click for a range.';
    if (modal.footerEl) modal.footerEl.querySelector('#pm-count').textContent = `${S.numPages} pages`;
  }

  async function runOp(op) {
    const pages = [...selected].sort((a, b) => a - b);
    const page = pages.length ? pages[0] : S.currentPage;
    try {
      if (op === 'rotate-cw' || op === 'rotate-ccw') {
        for (const target of pages.length ? pages : [page]) {
          const ok = await rotatePage(target, op === 'rotate-cw' ? 90 : -90);
          if (!ok) break;
          if (pages.length === 1) break;
        }
        selected = new Set();
      } else if (op === 'delete') {
        if (!pages.length) {
          toast('Select at least one page to delete.', 'warning');
          return;
        }
        if (S.numPages - pages.length < 1) {
          toast('A PDF needs at least one page.', 'warning');
          return;
        }
        const ok = await confirmModal({
          title: `Delete ${pages.length} page${pages.length === 1 ? '' : 's'}?`,
          message: `Page${pages.length === 1 ? '' : 's'} ${pages.map((p) => p + 1).join(', ')} will be removed. Undo is available with Ctrl+Z.`,
          confirmLabel: 'Delete',
          danger: true,
          iconName: 'trash',
        });
        if (!ok) return;
        for (const target of [...pages].sort((a, b) => b - a)) {
          const ok2 = await removePageAt(target);
          if (!ok2) break;
        }
        selected = new Set();
      } else if (op === 'duplicate') {
        if (!pages.length) {
          toast('Select a page to duplicate.', 'warning');
          return;
        }
        for (const target of [...pages].sort((a, b) => b - a)) {
          const ok = await duplicatePage(target);
          if (!ok) break;
          selected = new Set([target + 1]);
        }
      } else if (op === 'insert') {
        const at = pages.length ? Math.min(...pages) : S.currentPage + 1;
        const ok = await insertBlankPage(at);
        if (ok) selected = new Set([Math.min(at, S.numPages - 1)]);
      } else if (op === 'extract') {
        if (!pages.length) {
          toast('Select the pages you want to extract.', 'warning');
          return;
        }
        await extractPages(pages);
        selected = new Set();
      } else if (op === 'left' || op === 'right') {
        if (!pages.length) {
          toast('Select a page to move.', 'warning');
          return;
        }
        const target = pages[0];
        const to = op === 'left' ? target - 1 : target + 2;
        if (to < 0 || target >= S.numPages - 1 && op === 'right') return;
        const ok = await movePage(target, to);
        if (ok) selected = new Set([op === 'left' ? target - 1 : target + 1].map((n) => Math.max(0, Math.min(S.numPages - 1, n))));
      }
    } catch (error) {
      toast(error?.message || 'That page operation failed.', 'error');
    }
    if (!closed) {
      await renderGrid();
      modal.footerEl.querySelector('#pm-count').textContent = `${S.numPages} pages`;
    }
  }

  body.querySelectorAll('[data-pm]').forEach((button) => {
    button.addEventListener('click', () => runOp(button.dataset.pm));
  });

  renderGrid();
}

/* ============================== watermark ============================== */

export function openWatermarkDialog() {
  if (!S.pdfjs) return;
  const body = `
    <div class="form-field">
      <label class="field-label" for="wm-text">Watermark text</label>
      <input id="wm-text" type="text" value="DRAFT" placeholder="CONFIDENTIAL">
    </div>
    <div class="grid-2">
      <div class="form-field">
        <label class="field-label" for="wm-size">Size</label>
        <input id="wm-size" type="number" min="6" max="200" value="64">
      </div>
      <div class="form-field">
        <label class="field-label" for="wm-opacity">Opacity (%)</label>
        <input id="wm-opacity" type="number" min="2" max="100" value="14">
      </div>
    </div>
    <div class="grid-2">
      <div class="form-field">
        <label class="field-label" for="wm-rotation">Rotation</label>
        <select id="wm-rotation">
          <option value="45" selected>Diagonal (45°)</option>
          <option value="0">Horizontal</option>
          <option value="90">Vertical</option>
          <option value="-45">Diagonal up</option>
        </select>
      </div>
      <div class="form-field">
        <label class="field-label" for="wm-position">Position</label>
        <select id="wm-position">
          <option value="center" selected>Center</option>
          <option value="top-left">Top left</option>
          <option value="top-right">Top right</option>
          <option value="bottom-left">Bottom left</option>
          <option value="bottom-right">Bottom right</option>
        </select>
      </div>
    </div>
    <div class="form-field">
      <label class="check-row"><input id="wm-tile" type="checkbox"> Tile across the page</label>
    </div>
    ${colorRow('wm-colors', '#8a7f70')}
    ${pageRangeInput('wm-pages', 'all')}
    <div class="callout neutral">${icon('info', 15)}<div>Watermarks are written into the PDF when you apply them, so they travel with the file.</div></div>`;

  let color = '#8a7f70';
  const modal = openModal({
    title: 'Watermark',
    subtitle: 'Add a subtle mark to every page, or only the pages you choose.',
    body,
    iconName: 'watermark',
    footer: `<button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="wm-apply">${icon('check', 15)} Apply watermark</button>`,
  });
  bindColors(modal.bodyEl, 'wm-colors', (value) => {
    color = value;
  });
  modal.footerEl.querySelector('#wm-apply').addEventListener('click', async () => {
    const text = modal.bodyEl.querySelector('#wm-text').value.trim();
    if (!text) {
      toast('Enter the watermark text.', 'warning');
      return;
    }
    let pages;
    try {
      pages = parseRange(modal.bodyEl.querySelector('#wm-pages'));
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
    modal.close();
    await applyWatermark({
      text,
      fontSize: Number(modal.bodyEl.querySelector('#wm-size').value) || 64,
      opacity: (Number(modal.bodyEl.querySelector('#wm-opacity').value) || 14) / 100,
      rotation: Number(modal.bodyEl.querySelector('#wm-rotation').value) || 0,
      position: modal.bodyEl.querySelector('#wm-position').value,
      tile: modal.bodyEl.querySelector('#wm-tile').checked,
      color,
      pages,
    });
  });
}

/* ============================== header / footer ============================== */

export function openHeaderFooterDialog() {
  if (!S.pdfjs) return;
  const body = `
    <p class="hint" style="margin-top:0">Use <code>{page}</code>, <code>{pages}</code>, <code>{date}</code>, <code>{title}</code> and <code>{author}</code> as tokens.</p>
    <div class="insp-label">Header</div>
    <div class="grid-3">
      <div class="form-field"><label class="field-label" for="hf-hl">Left</label><input id="hf-hl" type="text" placeholder=""></div>
      <div class="form-field"><label class="field-label" for="hf-hc">Center</label><input id="hf-hc" type="text" value="{title}"></div>
      <div class="form-field"><label class="field-label" for="hf-hr">Right</label><input id="hf-hr" type="text" placeholder="{date}"></div>
    </div>
    <div class="insp-label" style="margin-top:8px">Footer</div>
    <div class="grid-3">
      <div class="form-field"><label class="field-label" for="hf-fl">Left</label><input id="hf-fl" type="text" placeholder=""></div>
      <div class="form-field"><label class="field-label" for="hf-fc">Center</label><input id="hf-fc" type="text" placeholder="Page {page} of {pages}"></div>
      <div class="form-field"><label class="field-label" for="hf-fr">Right</label><input id="hf-fr" type="text" placeholder=""></div>
    </div>
    <div class="grid-3" style="margin-top:10px">
      <div class="form-field"><label class="field-label" for="hf-margin">Margin</label><input id="hf-margin" type="number" min="10" max="120" value="36"></div>
      <div class="form-field"><label class="field-label" for="hf-size">Size</label><input id="hf-size" type="number" min="5" max="24" value="9"></div>
      <div class="form-field"><label class="field-label" for="hf-range">Pages</label><input id="hf-range" type="text" value="all"></div>
    </div>
    <label class="check-row"><input id="hf-skip" type="checkbox"> Skip the first page</label>
    ${colorRow('hf-colors', '#6f675c')}`;

  let color = '#6f675c';
  const modal = openModal({
    title: 'Header & footer',
    subtitle: 'Add consistent running text to the pages you choose.',
    body,
    iconName: 'header',
    footer: `<button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="hf-apply">${icon('check', 15)} Apply</button>`,
  });
  bindColors(modal.bodyEl, 'hf-colors', (value) => {
    color = value;
  });
  modal.footerEl.querySelector('#hf-apply').addEventListener('click', async () => {
    let pages;
    try {
      pages = parseRange(modal.bodyEl.querySelector('#hf-range'));
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
    const val = (id) => modal.bodyEl.querySelector(id).value;
    modal.close();
    await applyHeaderFooter({
      headerLeft: val('#hf-hl'),
      headerCenter: val('#hf-hc'),
      headerRight: val('#hf-hr'),
      footerLeft: val('#hf-fl'),
      footerCenter: val('#hf-fc'),
      footerRight: val('#hf-fr'),
      margin: Number(val('#hf-margin')) || 36,
      fontSize: Number(val('#hf-size')) || 9,
      skipFirst: modal.bodyEl.querySelector('#hf-skip').checked,
      pages,
      color,
    });
  });
}

/* ============================== Bates ============================== */

export function openBatesDialog() {
  if (!S.pdfjs) return;
  const body = `
    <div class="grid-2">
      <div class="form-field"><label class="field-label" for="bt-prefix">Prefix</label><input id="bt-prefix" type="text" placeholder="ABC"></div>
      <div class="form-field"><label class="field-label" for="bt-suffix">Suffix</label><input id="bt-suffix" type="text" placeholder=""></div>
    </div>
    <div class="grid-3">
      <div class="form-field"><label class="field-label" for="bt-start">Start at</label><input id="bt-start" type="number" min="1" value="1"></div>
      <div class="form-field"><label class="field-label" for="bt-digits">Digits</label><input id="bt-digits" type="number" min="1" max="12" value="6"></div>
      <div class="form-field"><label class="field-label" for="bt-size">Size</label><input id="bt-size" type="number" min="5" max="24" value="9"></div>
    </div>
    <div class="grid-2">
      <div class="form-field">
        <label class="field-label" for="bt-position">Position</label>
        <select id="bt-position">
          <option value="bottom-right" selected>Bottom right</option>
          <option value="bottom-left">Bottom left</option>
          <option value="bottom-center">Bottom center</option>
          <option value="top-right">Top right</option>
          <option value="top-left">Top left</option>
        </select>
      </div>
      <div class="form-field"><label class="field-label" for="bt-range">Pages</label><input id="bt-range" type="text" value="all"></div>
    </div>
    ${colorRow('bt-colors', '#5d564c')}
    <div class="callout neutral">${icon('info', 15)}<div>Bates numbers are sequential and are written into the PDF immediately. Prefixes are separated with a dash, e.g. <code>ABC-000001</code>.</div></div>`;

  let color = '#5d564c';
  const modal = openModal({
    title: 'Bates numbering',
    subtitle: 'Stamp sequential identifiers on legal and archival documents.',
    body,
    iconName: 'hash',
    footer: `<button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="bt-apply">${icon('check', 15)} Apply numbering</button>`,
  });
  bindColors(modal.bodyEl, 'bt-colors', (value) => {
    color = value;
  });
  modal.footerEl.querySelector('#bt-apply').addEventListener('click', async () => {
    let pages;
    try {
      pages = parseRange(modal.bodyEl.querySelector('#bt-range'));
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
    const val = (id) => modal.bodyEl.querySelector(id).value;
    modal.close();
    await applyBates({
      prefix: val('#bt-prefix').trim(),
      suffix: val('#bt-suffix').trim(),
      start: Number(val('#bt-start')) || 1,
      digits: Number(val('#bt-digits')) || 6,
      fontSize: Number(val('#bt-size')) || 9,
      position: val('#bt-position'),
      pages,
      color,
    });
  });
}

/* ============================== compress ============================== */

export function openCompressDialog() {
  if (!S.pdfjs) return;
  const sizeMb = ((S.bytes?.length || 0) / 1024 / 1024).toFixed(1);
  const body = `
    <div class="callout neutral" style="margin-bottom:14px">${icon('info', 15)}<div>Compression turns pages into high-quality images. Text will no longer be selectable in the compressed copy — save a copy first if you need the original.</div></div>
    <div class="form-field">
      <label class="field-label" for="cp-quality">Quality</label>
      <select id="cp-quality">
        <option value="light">Light — keeps text crisp, modest saving</option>
        <option value="balanced" selected>Balanced — recommended for email</option>
        <option value="strong">Strong — smallest file, softest text</option>
      </select>
    </div>
    <div class="insp-note">Current size: ${sizeMb} MB · ${S.numPages} pages</div>`;
  const modal = openModal({
    title: 'Compress PDF',
    subtitle: 'Make the file easier to email while keeping it readable.',
    body,
    iconName: 'compress',
    footer: `<button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="cp-apply">${icon('compress', 15)} Compress</button>`,
  });
  modal.footerEl.querySelector('#cp-apply').addEventListener('click', async () => {
    const quality = modal.bodyEl.querySelector('#cp-quality').value;
    modal.close();
    await compressDocument({ quality });
  });
}
