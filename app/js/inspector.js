import { S, PALETTE, HIGHLIGHT_PALETTE, STAMPS, pageMeta, selectedOverlay } from './state.js';
import { $, icon, escapeHtml, clamp, toast } from './ui.js';
import { updateSelected, deleteSelection, duplicateSelection, reorderSelection, openTextEditor, openSelectedText } from './editing.js';
import { prettyType } from './toolbar.js';
import { formValueFor, setFormValue, dispatchAction, scrollToPage, flashPage } from './workspace.js';
import { openSignatureDialog } from './signature.js';
import { formatBytes } from './ui.js';

let bound = false;
let activeFormName = '';

export function initInspector() {
  if (bound) return;
  bound = true;
  document.addEventListener('pdfstudio:selection', renderInspector);
  document.addEventListener('pdfstudio:refresh', renderInspector);
  document.addEventListener('pdfstudio:forms', renderInspector);
  document.addEventListener('pdfstudio:toolchange', renderInspector);
  document.addEventListener('pdfstudio:docloaded', renderInspector);
  document.addEventListener('pdfstudio:history', renderInspector);
  document.addEventListener('pdfstudio:pagechange', renderInspector);
  document.addEventListener('pdfstudio:forms-value', renderInspector);
  $('#btn-hide-inspector')?.addEventListener('click', () => {
    S.inspectorCollapsed = true;
    $('#inspector').hidden = true;
  });
}

export function showInspector() {
  S.inspectorCollapsed = false;
  if (S.mode === 'edit' && S.pdfjs) {
    $('#inspector').hidden = false;
    renderInspector();
  }
}

export function renderInspector() {
  const body = $('#inspector-body');
  if (!body) return;
  if (S.mode !== 'edit' || !S.pdfjs) return;
  const selected = selectedOverlay();
  $('#inspector-title').textContent = selected ? prettyType(selected.type) : 'Document';
  const focused = document.activeElement;
  const editingField = focused && body.contains(focused) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(focused.tagName);
  if (editingField && !selected) return;

  body.innerHTML = selected ? selectedPanel(selected) : documentPanel();
  bind(selected);
}

/* ============================== selected object ============================== */

function selectedPanel(obj) {
  const meta = pageMeta(S.selected.page);
  const pos = {
    x: Math.round(obj.x),
    y: Math.round(obj.y),
    w: Math.round(obj.w),
    h: Math.round(obj.h),
  };
  const kind = obj.type;
  return `
    <div class="insp-section">
      <div class="insp-label">Position &amp; size <span class="selected-badge">${escapeHtml(prettyType(kind))}</span></div>
      <div class="insp-grid">
        <div class="insp-row"><span class="insp-key">X</span><input type="number" data-geo="x" value="${pos.x}" step="1"></div>
        <div class="insp-row"><span class="insp-key">Y</span><input type="number" data-geo="y" value="${pos.y}" step="1"></div>
        <div class="insp-row"><span class="insp-key">W</span><input type="number" data-geo="w" value="${pos.w}" min="4" step="1"></div>
        <div class="insp-row"><span class="insp-key">H</span><input type="number" data-geo="h" value="${pos.h}" min="4" step="1"></div>
      </div>
      <div class="hint">Page ${S.selected.page + 1} · ${Math.round(meta.viewW)} × ${Math.round(meta.viewH)} pt</div>
    </div>
    ${colorSection(obj)}
    ${typeSection(obj)}
    <div class="insp-section">
      <div class="insp-label">Appearance</div>
      <div class="insp-row"><span class="insp-key">Opacity</span><input type="range" min="10" max="100" step="5" value="${Math.round((obj.opacity ?? 1) * 100)}" data-opacity></div>
    </div>
    <div class="insp-section">
      <div class="insp-label">Arrange</div>
      <div class="insp-grid">
        <button type="button" class="insp-action" data-arrange="front">${icon('arrow-up', 14)} Front</button>
        <button type="button" class="insp-action" data-arrange="back">${icon('arrow-down', 14)} Back</button>
        <button type="button" class="insp-action" data-dup>${icon('duplicate', 14)} Duplicate</button>
        <button type="button" class="insp-action danger" data-del>${icon('trash', 14)} Delete</button>
      </div>
    </div>`;
}

function colorSection(obj) {
  if (obj.type === 'highlight') {
    return `
      <div class="insp-section">
        <div class="insp-label">Highlight colour</div>
        <div class="swatch-grid">${HIGHLIGHT_PALETTE.map((c) => `<button type="button" class="color-swatch${obj.color === c.value ? ' active' : ''}" data-color="${c.value}" style="background:${c.value}" title="${c.name}"></button>`).join('')}</div>
      </div>`;
  }
  if (obj.type === 'redact' || obj.type === 'whiteout') {
    const colors = obj.type === 'redact' ? ['#000000', '#1b1b1b', '#ffffff'] : ['#ffffff', '#fffdf8', '#f4f0e8'];
    return `
      <div class="insp-section">
        <div class="insp-label">Fill</div>
        <div class="swatch-grid">${colors.map((c) => `<button type="button" class="color-swatch${obj.fill === c ? ' active' : ''}" data-fill="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div>
      </div>`;
  }
  if (['signature', 'initials', 'image', 'sigbox'].includes(obj.type)) return '';
  if (['rect', 'ellipse', 'line', 'arrow'].includes(obj.type)) {
    return `
      <div class="insp-section">
        <div class="insp-label">Stroke colour</div>
        <div class="swatch-grid">${PALETTE.map((c) => `<button type="button" class="color-swatch${obj.stroke === c.value ? ' active' : ''}" data-stroke="${c.value}" style="background:${c.value}" title="${c.name}"></button>`).join('')}</div>
      </div>
      <div class="insp-section">
        <div class="insp-label">Fill</div>
        <div class="swatch-grid">
          <button type="button" class="color-swatch${obj.fill === 'transparent' ? ' active' : ''}" data-fill="transparent" style="background:repeating-linear-gradient(45deg,#ddd,#ddd 3px,#fff 3px,#fff 6px)" title="No fill"></button>
          ${HIGHLIGHT_PALETTE.map((c) => `<button type="button" class="color-swatch${obj.fill === c.value ? ' active' : ''}" data-fill="${c.value}" style="background:${c.value}" title="${c.name}"></button>`).join('')}
        </div>
      </div>
      <div class="insp-section">
        <div class="insp-row"><span class="insp-key">Stroke</span><input type="range" min="1" max="16" step="0.5" value="${obj.strokeWidth || 2}" data-strokewidth></div>
      </div>`;
  }
  if (obj.type === 'stamp') {
    return `
      <div class="insp-section">
        <div class="insp-label">Stamp</div>
        <div class="form-field">
          <label class="field-label" for="insp-stamp-text">Text</label>
          <input id="insp-stamp-text" type="text" value="${escapeHtml(obj.text || 'APPROVED')}" data-stamp-text>
        </div>
        <div class="swatch-grid">${PALETTE.map((c) => `<button type="button" class="color-swatch${obj.color === c.value ? ' active' : ''}" data-color="${c.value}" style="background:${c.value}" title="${c.name}"></button>`).join('')}</div>
      </div>`;
  }
  return `
    <div class="insp-section">
      <div class="insp-label">Ink colour</div>
      <div class="swatch-grid">${PALETTE.map((c) => `<button type="button" class="color-swatch${obj.color === c.value ? ' active' : ''}" data-color="${c.value}" style="background:${c.value}" title="${c.name}"></button>`).join('')}</div>
    </div>`;
}

function typeSection(obj) {
  if (['text', 'note', 'date'].includes(obj.type)) {
    return `
      <div class="insp-section">
        <div class="insp-label">Text</div>
        <div class="form-field">
          <label class="field-label" for="insp-text">Content</label>
          <textarea id="insp-text" data-text style="min-height:64px">${escapeHtml(obj.text || '')}</textarea>
        </div>
        <div class="insp-row">
          <span class="insp-key">Font</span>
          <select data-font>
            ${[
              ['Helvetica', 'Sans'],
              ['Times', 'Serif'],
              ['Courier', 'Mono'],
            ]
              .map(([v, l]) => `<option value="${v}"${obj.fontFamily === v ? ' selected' : ''}>${l}</option>`)
              .join('')}
          </select>
        </div>
        <div class="insp-grid">
          <div class="insp-row"><span class="insp-key">Size</span><input type="number" min="5" max="144" value="${Math.round(obj.fontSize || 12)}" data-fontsize></div>
          <div class="insp-row"><span class="insp-key">Line</span><input type="number" min="0.8" max="3" step="0.1" value="${obj.lineHeight || 1.3}" data-lineheight></div>
        </div>
        <div class="icon-pair">
          <button type="button" class="icon-btn tiny${obj.bold ? ' active' : ''}" data-bold title="Bold">${icon('bold', 15)}</button>
          <button type="button" class="icon-btn tiny${obj.align === 'left' ? ' active' : ''}" data-align="left" title="Left">${icon('align-left', 15)}</button>
          <button type="button" class="icon-btn tiny${obj.align === 'center' ? ' active' : ''}" data-align="center" title="Center">${icon('align-center', 15)}</button>
          <button type="button" class="icon-btn tiny${obj.align === 'right' ? ' active' : ''}" data-align="right" title="Right">${icon('align-right', 15)}</button>
          <button type="button" class="icon-btn tiny" data-edit-text title="Edit on page">${icon('pen', 15)}</button>
        </div>
      </div>
      ${
        obj.type === 'note'
          ? `<div class="insp-section">
              <div class="insp-label">Note paper</div>
              <div class="swatch-grid">${[
                ['#fff3bf', 'Butter'],
                ['#ffdbe2', 'Blush'],
                ['#d9ecff', 'Sky'],
                ['#ddf2d8', 'Mint'],
                ['#eeddff', 'Lilac'],
                ['#ffe6c9', 'Peach'],
              ]
                .map(([v, l]) => `<button type="button" class="color-swatch${obj.background === v ? ' active' : ''}" data-background="${v}" style="background:${v}" title="${l}"></button>`)
                .join('')}</div>
            </div>`
          : ''
      }`;
  }
  if (obj.type === 'ink') {
    return `
      <div class="insp-section">
        <div class="insp-label">Stroke</div>
        <div class="insp-row"><span class="insp-key">Width</span><input type="range" min="1" max="24" step="0.5" value="${obj.strokeWidth || 2}" data-strokewidth></div>
      </div>`;
  }
  if (obj.type === 'sigbox') {
    return `
      <div class="insp-section">
        <div class="insp-label">Sign-here box</div>
        <div class="form-field">
          <label class="field-label" for="insp-sigbox-label">Label</label>
          <input id="insp-sigbox-label" type="text" value="${escapeHtml(obj.label || 'Sign here')}" data-label>
        </div>
        <button type="button" class="btn small wide primary" data-fill-sign>${icon('signature', 14)} Sign this box</button>
        <div class="insp-note" style="margin-top:8px">Saving the PDF keeps this box visible so someone else can sign it. Use “Sign this box” to sign it yourself.</div>
      </div>`;
  }
  if (obj.type === 'signature' || obj.type === 'initials') {
    return `
      <div class="insp-section">
        <div class="insp-label">Signature</div>
        <button type="button" class="btn small wide subtle" data-replace-signature>${icon('refresh', 14)} Replace with a different signature</button>
        <div class="insp-note" style="margin-top:8px">Signatures are stored on this device only.</div>
      </div>`;
  }
  if (obj.type === 'image') {
    return `
      <div class="insp-section">
        <div class="insp-label">Image</div>
        <label class="check-row"><input type="checkbox" ${obj.keepRatio !== false ? 'checked' : ''} data-keep-ratio> Keep aspect ratio</label>
      </div>`;
  }
  return '';
}

/* ============================== document panel ============================== */

function documentPanel() {
  const meta = S.meta || {};
  const edited = S.overlays.size;
  return `
    <div class="doc-mini">
      <div class="doc-mini-title">${escapeHtml(S.name || 'No document')}</div>
      <div class="doc-mini-meta">
        ${S.numPages} page${S.numPages === 1 ? '' : 's'} · ${formatBytes(S.size || S.bytes?.length || 0)}<br>
        ${S.editable ? (S.dirty ? 'Unsaved changes' : 'Saved') : 'View only'}${edited ? ` · ${edited} annotated page${edited === 1 ? '' : 's'}` : ''}
      </div>
    </div>

    <div class="insp-section">
      <div class="insp-label">Current page</div>
      <div class="insp-grid">
        <button type="button" class="insp-action" data-page-rotate="90">${icon('rotate-cw', 14)} Rotate right</button>
        <button type="button" class="insp-action" data-page-rotate="-90">${icon('rotate-ccw', 14)} Rotate left</button>
        <button type="button" class="insp-action" data-page-duplicate>${icon('duplicate', 14)} Duplicate</button>
        <button type="button" class="insp-action danger" data-page-delete>${icon('trash', 14)} Delete page</button>
      </div>
      <div class="insp-note" style="margin-top:7px">Page ${S.currentPage + 1} of ${S.numPages}. Use the Pages tool for reordering, inserting and extracting.</div>
    </div>

    <div class="insp-section">
      <div class="insp-label">Document tools</div>
      <div class="insp-grid">
        <button type="button" class="insp-action" data-action="pages">${icon('pages', 14)} Pages</button>
        <button type="button" class="insp-action" data-action="merge">${icon('merge', 14)} Merge</button>
        <button type="button" class="insp-action" data-action="extract-pages">${icon('split', 14)} Extract</button>
        <button type="button" class="insp-action" data-action="compress">${icon('compress', 14)} Compress</button>
        <button type="button" class="insp-action" data-action="watermark">${icon('watermark', 14)} Watermark</button>
        <button type="button" class="insp-action" data-action="header-footer">${icon('header', 14)} Header</button>
        <button type="button" class="insp-action" data-action="bates">${icon('hash', 14)} Bates</button>
        <button type="button" class="insp-action" data-action="metadata">${icon('info', 14)} Properties</button>
        <button type="button" class="insp-action" data-action="export-text">${icon('file-text', 14)} Text</button>
        <button type="button" class="insp-action" data-action="export-images">${icon('image', 14)} Images</button>
        <button type="button" class="insp-action span-2" data-action="flatten">${icon('layers', 14)} Flatten annotations &amp; forms</button>
      </div>
    </div>

    <div class="insp-section">
      <div class="insp-label">Metadata</div>
      <div class="form-field">
        <label class="field-label" for="meta-title">Title</label>
        <input id="meta-title" type="text" value="${escapeHtml(meta.title || '')}" data-meta="title" placeholder="Untitled">
      </div>
      <div class="form-field">
        <label class="field-label" for="meta-author">Author</label>
        <input id="meta-author" type="text" value="${escapeHtml(meta.author || '')}" data-meta="author" placeholder="Author">
      </div>
      <button type="button" class="btn small wide subtle" data-apply-meta>${icon('check', 14)} Apply metadata</button>
    </div>

    ${formsSection()}

    <div class="insp-section">
      <div class="insp-label">Storage</div>
      <div class="insp-note">Everything happens on this device. No account, no uploads, no telemetry.</div>
    </div>`;
}

function formsSection() {
  if (!S.formFields?.length) return '';
  const fields = S.formFields;
  return `
    <div class="insp-section">
      <div class="insp-label">Form fields <span class="count-badge">${fields.length}</span></div>
      ${fields
        .slice(0, 60)
        .map((field) => {
          const value = formValueFor(field);
          const id = `ff-${field.page}-${field.name.replace(/\W+/g, '-')}`;
          if (field.type === 'Btn') {
            if (field.radio) {
              return `<label class="check-row"><input type="radio" name="${escapeHtml(field.name)}" ${value === field.buttonValue || value === true ? 'checked' : ''} data-form-radio="${escapeHtml(field.name)}" data-form-value="${escapeHtml(field.buttonValue || '')}"> ${escapeHtml(field.name)}${field.buttonValue ? ` · ${escapeHtml(field.buttonValue)}` : ''}</label>`;
            }
            return `<label class="check-row"><input type="checkbox" ${value === true || value === 'true' || value === field.buttonValue ? 'checked' : ''} data-form-check="${escapeHtml(field.name)}"> ${escapeHtml(field.name)}</label>`;
          }
          if (field.type === 'Ch' || field.options?.length) {
            return `<div class="form-field"><label class="field-label" for="${id}">${escapeHtml(field.name)}</label>
              <select id="${id}" data-form-select="${escapeHtml(field.name)}">
                <option value=""></option>
                ${field.options.map((opt) => `<option value="${escapeHtml(opt)}"${String(value) === String(opt) ? ' selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
              </select></div>`;
          }
          return `<div class="form-field"><label class="field-label" for="${id}">${escapeHtml(field.name)}</label>
            <input id="${id}" type="text" value="${escapeHtml(value ?? '')}" data-form-text="${escapeHtml(field.name)}" placeholder="Type here"></div>`;
        })
        .join('')}
      ${fields.length > 60 ? '<div class="hint">Only the first 60 fields are listed. Use the Form fields tool to fill the rest on the page.</div>' : ''}
      <button type="button" class="btn small wide subtle" data-action="flatten" style="margin-top:6px">${icon('layers', 14)} Flatten form data</button>
    </div>`;
}

/* ============================== binding ============================== */

function bind(selected) {
  const body = $('#inspector-body');
  const field = (f) => S.formFields.find((x) => x.name === f);

  body.querySelectorAll('[data-geo]').forEach((input) => {
    input.addEventListener('change', () => {
      const obj = selectedOverlay();
      if (!obj) return;
      const key = input.dataset.geo;
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      const patch = { [key]: key === 'w' || key === 'h' ? Math.max(4, value) : value };
      updateSelected(patch);
    });
  });

  body.querySelectorAll('[data-color]').forEach((button) => {
    button.addEventListener('click', () => {
      body.querySelectorAll('[data-color]').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      updateSelected({ color: button.dataset.color });
    });
  });
  body.querySelectorAll('[data-fill]').forEach((button) => {
    button.addEventListener('click', () => {
      body.querySelectorAll('[data-fill]').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      updateSelected({ fill: button.dataset.fill });
    });
  });
  body.querySelectorAll('[data-stroke]').forEach((button) => {
    button.addEventListener('click', () => {
      body.querySelectorAll('[data-stroke]').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      updateSelected({ stroke: button.dataset.stroke });
    });
  });
  body.querySelectorAll('[data-background]').forEach((button) => {
    button.addEventListener('click', () => {
      body.querySelectorAll('[data-background]').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      updateSelected({ background: button.dataset.background });
    });
  });

  body.querySelector('[data-strokewidth]')?.addEventListener('change', (event) => {
    updateSelected({ strokeWidth: Number(event.target.value) });
  });
  body.querySelector('[data-opacity]')?.addEventListener('change', (event) => {
    updateSelected({ opacity: Number(event.target.value) / 100 });
  });
  body.querySelector('[data-fontsize]')?.addEventListener('change', (event) => {
    updateSelected({ fontSize: clamp(Number(event.target.value) || 12, 5, 144) });
  });
  body.querySelector('[data-lineheight]')?.addEventListener('change', (event) => {
    updateSelected({ lineHeight: clamp(Number(event.target.value) || 1.3, 0.8, 3) });
  });
  body.querySelector('[data-font]')?.addEventListener('change', (event) => {
    updateSelected({ fontFamily: event.target.value });
  });
  body.querySelector('[data-bold]')?.addEventListener('click', () => {
    const obj = selectedOverlay();
    if (!obj) return;
    updateSelected({ bold: !obj.bold });
  });
  body.querySelectorAll('[data-align]').forEach((button) => {
    button.addEventListener('click', () => updateSelected({ align: button.dataset.align }));
  });
  body.querySelector('[data-text]')?.addEventListener('change', (event) => {
    updateSelected({ text: event.target.value });
  });
  body.querySelector('[data-edit-text]')?.addEventListener('click', openSelectedText);
  body.querySelector('[data-label]')?.addEventListener('change', (event) => {
    updateSelected({ label: event.target.value });
  });
  body.querySelector('[data-stamp-text]')?.addEventListener('change', (event) => {
    updateSelected({ text: event.target.value.toUpperCase() });
  });
  body.querySelector('[data-keep-ratio]')?.addEventListener('change', (event) => {
    updateSelected({ keepRatio: event.target.checked });
  });

  body.querySelector('[data-fill-sign]')?.addEventListener('click', async () => {
    const box = selectedOverlay();
    if (!box || box.type !== 'sigbox') return;
    const signature = await openSignatureDialog({ title: 'Sign this box' });
    if (!signature) return;
    const aspect = signature.aspect || 3.1;
    const w = box.w * 0.86;
    const h = Math.min(box.h * 0.62, w / aspect);
    const overlay = {
      id: `o${Date.now().toString(36)}`,
      type: 'signature',
      x: box.x + (box.w - w) / 2,
      y: box.y + box.h * 0.3,
      w,
      h,
      src: signature.dataUrl,
      aspect,
      opacity: 1,
    };
    S.activeSignature = signature;
    const { addOverlay, removeOverlay, markDirty } = await import('./state.js');
    const History = await import('./history.js');
    const before = History.snapshot('annotations');
    addOverlay(S.selected.page, overlay);
    removeOverlay(S.selected.page, box.id);
    History.commit(before);
    markDirty();
    document.dispatchEvent(new CustomEvent('pdfstudio:selection'));
    document.dispatchEvent(new CustomEvent('pdfstudio:refresh'));
  });

  body.querySelector('[data-replace-signature]')?.addEventListener('click', async () => {
    const obj = selectedOverlay();
    if (!obj) return;
    const signature = await openSignatureDialog({ title: 'Replace signature' });
    if (!signature) return;
    updateSelected({
      src: signature.dataUrl,
      aspect: signature.aspect || 3.1,
      h: obj.w / (signature.aspect || 3.1),
    });
    S.activeSignature = signature;
  });

  body.querySelectorAll('[data-arrange]').forEach((button) => {
    button.addEventListener('click', () => reorderSelection(button.dataset.arrange));
  });
  body.querySelector('[data-dup]')?.addEventListener('click', duplicateSelection);
  body.querySelector('[data-del]')?.addEventListener('click', deleteSelection);

  body.querySelector('[data-page-rotate="90"]')?.addEventListener('click', () =>
    dispatchAction('rotate-page', { page: S.currentPage, delta: 90 })
  );
  body.querySelector('[data-page-rotate="-90"]')?.addEventListener('click', () =>
    dispatchAction('rotate-page', { page: S.currentPage, delta: -90 })
  );
  body.querySelector('[data-page-duplicate]')?.addEventListener('click', () =>
    dispatchAction('duplicate-page', { page: S.currentPage })
  );
  body.querySelector('[data-page-delete]')?.addEventListener('click', () =>
    dispatchAction('delete-page', { page: S.currentPage })
  );

  const metaValues = {};
  body.querySelectorAll('[data-meta]').forEach((input) => {
    metaValues[input.dataset.meta] = input.value;
    input.addEventListener('input', () => {
      metaValues[input.dataset.meta] = input.value;
    });
  });
  body.querySelector('[data-apply-meta]')?.addEventListener('click', () => {
    dispatchAction('set-metadata', { meta: { ...metaValues } });
  });

  body.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => dispatchAction(button.dataset.action));
  });

  body.querySelectorAll('[data-form-text]').forEach((input) => {
    input.addEventListener('change', () => {
      const target = field(input.dataset.formText);
      if (target) setFormValue(target, input.value);
    });
  });
  body.querySelectorAll('[data-form-select]').forEach((select) => {
    select.addEventListener('change', () => {
      const target = field(select.dataset.formSelect);
      if (target) setFormValue(target, select.value);
    });
  });
  body.querySelectorAll('[data-form-check]').forEach((input) => {
    input.addEventListener('change', () => {
      const target = field(input.dataset.formCheck);
      if (target) setFormValue(target, input.checked);
    });
  });
  body.querySelectorAll('[data-form-radio]').forEach((input) => {
    input.addEventListener('change', () => {
      const target = field(input.dataset.formRadio);
      if (target && input.checked) setFormValue(target, input.dataset.formValue);
    });
  });
}

export function focusFormField(name) {
  activeFormName = name;
  const body = $('#inspector-body');
  const input = body?.querySelector(`[data-form-text="${CSS.escape(name)}"], [data-form-check="${CSS.escape(name)}"], [data-form-select="${CSS.escape(name)}"]`);
  if (input) {
    input.focus();
    input.scrollIntoView({ block: 'center' });
  }
}

export function selectPageFromInspector(index) {
  scrollToPage(index);
  flashPage(index);
}
