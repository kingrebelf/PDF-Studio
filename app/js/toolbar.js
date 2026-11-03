import { S, PALETTE, HIGHLIGHT_PALETTE, STAMPS, savePrefs, selectedOverlay } from './state.js';
import { $, $$, icon, escapeHtml, clamp } from './ui.js';
import {
  setTool,
  updateSelected,
  reorderSelection,
  deleteSelection,
  duplicateSelection,
  openTextEditor,
} from './editing.js';
import { openSignatureDialog } from './signature.js';
import { dispatchAction } from './workspace.js';

export const TOOLS = [
  { id: 'select', label: 'Select', icon: 'select', key: 'V', hint: 'Select, move and resize objects' },
  { id: 'text', label: 'Text', icon: 'text', key: 'T', hint: 'Click to add a text box' },
  { id: 'note', label: 'Note', icon: 'note', key: 'N', hint: 'Click to add a sticky note' },
  { divider: true },
  { id: 'text-pick', label: 'Select text', icon: 'type', key: 'I', hint: 'Drag across text to select it' },
  { id: 'highlight', label: 'Highlight', icon: 'highlight', key: 'H', hint: 'Drag across text to highlight' },
  { id: 'underline', label: 'Underline', icon: 'underline', key: 'U', hint: 'Drag across text to underline' },
  { id: 'strike', label: 'Strikethrough', icon: 'strike', key: 'K', hint: 'Drag across text to strike through' },
  { divider: true },
  { id: 'ink', label: 'Draw', icon: 'pen', key: 'D', hint: 'Draw freehand — hold Shift for a line' },
  { id: 'shape', label: 'Shape', icon: 'shapes', key: 'S', hint: 'Drag to draw a shape' },
  { id: 'eraser', label: 'Eraser', icon: 'eraser', key: 'E', hint: 'Click an object to remove it' },
  { divider: true },
  { id: 'signature', label: 'Signature', icon: 'signature', key: 'G', hint: 'Place your saved signature' },
  { id: 'initials', label: 'Initials', icon: 'signature-badge', hint: 'Place your initials' },
  { id: 'sigbox', label: 'Sign here box', icon: 'signature-badge', hint: 'Leave a place for someone to sign' },
  { id: 'date', label: 'Date', icon: 'calendar', key: 'Y', hint: 'Stamp today’s date' },
  { id: 'stamp', label: 'Stamp', icon: 'stamp', hint: 'Place an approved / draft style stamp' },
  { id: 'image', label: 'Image', icon: 'image', hint: 'Place an image on the page' },
  { divider: true },
  { id: 'redact', label: 'Redact', icon: 'redact', key: 'R', hint: 'Drag to black out content permanently' },
  { id: 'whiteout', label: 'White out', icon: 'whiteout', hint: 'Drag to cover content with white' },
  { id: 'forms', label: 'Form fields', icon: 'forms', key: 'F', hint: 'Click a form field to fill it' },
  { id: 'pages', label: 'Pages', icon: 'pages', key: 'P', hint: 'Rotate, reorder, duplicate and delete pages' },
];

const SHAPE_TYPES = [
  { value: 'rect', label: 'Rectangle' },
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'line', label: 'Line' },
  { value: 'arrow', label: 'Arrow' },
];

const FONT_OPTIONS = [
  { value: 'Helvetica', label: 'Sans' },
  { value: 'Times', label: 'Serif' },
  { value: 'Courier', label: 'Mono' },
];

export function buildToolRail() {
  const rail = $('#toolrail');
  if (!rail) return;
  rail.innerHTML = TOOLS.map((tool) => {
    if (tool.divider) return '<div class="tool-divider"></div>';
    return `<button type="button" class="tool-btn${tool.id === S.tool ? ' active' : ''}" data-tool="${tool.id}" data-tip="${escapeHtml(tool.label)}${tool.key ? ` · ${tool.key}` : ''}" title="${escapeHtml(tool.hint)}">${icon(tool.icon, 20)}</button>`;
  }).join('');
  rail.querySelectorAll('[data-tool]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.tool;
      if (id === 'pages') {
        dispatchAction('pages');
        return;
      }
      setTool(id);
      if (id === 'signature' && !S.activeSignature) {
        openSignatureDialog().then((signature) => {
          if (signature) {
            S.activeSignature = signature;
            document.dispatchEvent(new CustomEvent('pdfstudio:refresh'));
          }
        });
      }
    });
  });
}

/* ============================== options ============================== */

function setOpt(key, value) {
  S.opts[key] = value;
  savePrefs();
}

function swatches(colors, current, attr, extraClass = '') {
  return colors
    .map(
      (color) =>
        `<button type="button" class="color-swatch${extraClass}${color.value === current ? ' active' : ''}" data-${attr}="${color.value}" style="background:${color.value}" title="${escapeHtml(color.name)}"></button>`
    )
    .join('');
}

function colorKey(button) {
  return (
    button.dataset.color ||
    button.dataset.stroke ||
    button.dataset.fill ||
    button.dataset.hcolor ||
    button.dataset.stamp ||
    button.dataset.textColor ||
    button.dataset.note ||
    button.dataset.noteColor ||
    ''
  );
}

export function renderContextbar() {
  const bar = $('#contextbar');
  if (!bar) return;
  bar.innerHTML = '';
  if (S.mode !== 'edit' || !S.pdfjs) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const tool = TOOLS.find((t) => t.id === S.tool);
  bar.innerHTML = contextFor(S.tool);
  bar.querySelector('.context-title')?.insertAdjacentHTML(
    'afterbegin',
    icon(tool?.icon || 'pen', 15)
  );
  bindContext(bar);
  const selected = selectedOverlay();
  if (selected) {
    const badge = document.createElement('span');
    badge.className = 'selected-badge';
    badge.innerHTML = `${icon('move', 12)} ${prettyType(selected.type)} selected`;
    bar.append(badge);
  }
}

export function prettyType(type) {
  return (
    {
      text: 'Text',
      note: 'Note',
      date: 'Date',
      highlight: 'Highlight',
      underline: 'Underline',
      strike: 'Strikethrough',
      ink: 'Drawing',
      rect: 'Rectangle',
      ellipse: 'Ellipse',
      line: 'Line',
      arrow: 'Arrow',
      redact: 'Redaction',
      whiteout: 'White-out',
      stamp: 'Stamp',
      sigbox: 'Sign-here box',
      signature: 'Signature',
      initials: 'Initials',
      image: 'Image',
    }[type] || 'Object'
  );
}

function contextFor(tool) {
  const sel = selectedOverlay();
  switch (tool) {
    case 'select':
      return `
        <span class="context-title">Select</span>
        <span class="context-hint">${sel ? 'Drag to move · handles to resize' : 'Click an object, or switch tools to add one'}</span>
        <span class="context-spacer"></span>
        ${sel ? arrangeButtons() : ''}`;
    case 'text':
    case 'note':
    case 'date':
      return `
        <span class="context-title">${tool === 'note' ? 'Note' : tool === 'date' ? 'Date' : 'Text'}</span>
        <div class="opt-group plain">
          <span class="opt-label">Font</span>
          <select class="mini-select" data-opt="textFont">${FONT_OPTIONS.map((f) => `<option value="${f.value}"${S.opts.textFont === f.value ? ' selected' : ''}>${f.label}</option>`).join('')}</select>
        </div>
        <div class="opt-group plain">
          <span class="opt-label">Size</span>
          <input class="num-input" type="number" min="5" max="96" value="${S.opts.textSize}" data-opt="textSize">
        </div>
        <div class="opt-group plain">
          <button type="button" class="icon-btn tiny${S.opts.textBold ? ' active' : ''}" data-opt-toggle="textBold" title="Bold">${icon('bold', 15)}</button>
          <button type="button" class="icon-btn tiny${S.opts.textAlign === 'left' ? ' active' : ''}" data-opt-align="left" title="Align left">${icon('align-left', 15)}</button>
          <button type="button" class="icon-btn tiny${S.opts.textAlign === 'center' ? ' active' : ''}" data-opt-align="center" title="Align center">${icon('align-center', 15)}</button>
          <button type="button" class="icon-btn tiny${S.opts.textAlign === 'right' ? ' active' : ''}" data-opt-align="right" title="Align right">${icon('align-right', 15)}</button>
        </div>
        <div class="opt-group plain">
          <span class="opt-label">Ink</span>
          <div class="swatch-row">${swatches(PALETTE, S.opts.textColor, 'color')}</div>
        </div>
        ${tool === 'note' ? `<div class="opt-group plain"><span class="opt-label">Paper</span><div class="swatch-row">${swatches(NOTE_COLORS, S.opts.noteColor, 'note')}</div></div>` : ''}
        <span class="context-spacer"></span>
        ${sel ? arrangeButtons() : ''}`;
    case 'text-pick':
      return `
        <span class="context-title">Select text</span>
        <span class="context-hint">Drag across text, then mark it or copy it.</span>
        <span class="context-spacer"></span>
        <button type="button" class="btn small subtle" data-quick-mark="highlight">${icon('highlight', 14)} Highlight</button>
        <button type="button" class="btn small subtle" data-quick-mark="underline">${icon('underline', 14)} Underline</button>
        <button type="button" class="btn small subtle" data-quick-mark="strike">${icon('strike', 14)} Strike</button>`;
    case 'highlight':
      return `
        <span class="context-title">Highlight</span>
        <div class="opt-group plain"><div class="swatch-row">${swatches(HIGHLIGHT_PALETTE, S.opts.highlightColor, 'hcolor')}</div></div>
        <div class="opt-group plain"><span class="opt-label">Opacity</span><input class="num-input" type="number" min="10" max="100" step="5" value="${Math.round((S.opts.highlightOpacity ?? 0.38) * 100)}" data-opt-percent="highlightOpacity"></div>
        <span class="context-spacer"></span>
        <span class="context-hint">Drag across text to apply</span>`;
    case 'underline':
    case 'strike':
      return `
        <span class="context-title">${tool === 'underline' ? 'Underline' : 'Strikethrough'}</span>
        <div class="opt-group plain"><div class="swatch-row">${swatches(PALETTE, S.opts.markColor || S.opts.inkColor, 'color')}</div></div>
        <span class="context-hint">Drag across text to apply</span>
        <span class="context-spacer"></span>
        ${sel ? arrangeButtons() : ''}`;
    case 'ink':
      return `
        <span class="context-title">Draw</span>
        <div class="opt-group plain"><div class="swatch-row">${swatches(PALETTE.slice(0, 8), S.opts.inkColor, 'color')}</div></div>
        <div class="opt-group plain"><span class="opt-label">Width</span><input type="range" class="mini-range" min="1" max="18" step="0.5" value="${S.opts.inkWidth}" data-opt-range="inkWidth"><span class="range-val">${S.opts.inkWidth}px</span></div>
        <div class="opt-group plain">
          <button type="button" class="icon-btn tiny${S.opts.inkMode !== 'line' ? ' active' : ''}" data-ink-mode="pen" title="Freehand">${icon('pen', 15)}</button>
          <button type="button" class="icon-btn tiny${S.opts.inkMode === 'line' ? ' active' : ''}" data-ink-mode="line" title="Straight line">${icon('minus', 15)}</button>
        </div>
        <span class="context-spacer"></span>
        <span class="context-hint">Hold Shift for a straight line</span>`;
    case 'shape':
      return `
        <span class="context-title">Shape</span>
        <div class="opt-group plain">
          <select class="mini-select" data-opt="shapeType">${SHAPE_TYPES.map((s) => `<option value="${s.value}"${S.opts.shapeType === s.value ? ' selected' : ''}>${s.label}</option>`).join('')}</select>
        </div>
        <div class="opt-group plain"><span class="opt-label">Stroke</span><div class="swatch-row">${swatches(PALETTE.slice(0, 8), S.opts.shapeStroke, 'stroke')}</div></div>
        <div class="opt-group plain"><span class="opt-label">Fill</span><div class="swatch-row">
          <button type="button" class="color-swatch${S.opts.shapeFill === 'transparent' ? ' active' : ''}" data-fill="transparent" style="background:repeating-linear-gradient(45deg,#ddd,#ddd 3px,#fff 3px,#fff 6px)" title="No fill"></button>
          ${swatches(HIGHLIGHT_PALETTE, S.opts.shapeFill, 'fill')}
        </div></div>
        <div class="opt-group plain"><span class="opt-label">Width</span><input type="range" class="mini-range" min="1" max="14" step="0.5" value="${S.opts.shapeWidth}" data-opt-range="shapeWidth"><span class="range-val">${S.opts.shapeWidth}px</span></div>
        <span class="context-spacer"></span>
        ${sel ? arrangeButtons() : ''}`;
    case 'eraser':
      return `
        <span class="context-title">Eraser</span>
        <div class="opt-group plain"><span class="opt-label">Size</span><input type="range" class="mini-range" min="6" max="42" step="1" value="${S.opts.eraserSize}" data-opt-range="eraserSize"><span class="range-val">${S.opts.eraserSize}px</span></div>
        <span class="context-spacer"></span>
        <span class="context-hint">Click or drag over an object to remove it</span>`;
    case 'signature':
    case 'initials':
      return `
        <span class="context-title">${tool === 'signature' ? 'Signature' : 'Initials'}</span>
        <div class="opt-group plain"><span class="opt-label">Width</span><input type="range" class="mini-range" min="80" max="320" step="5" value="${S.opts.sigWidth}" data-opt-range="sigWidth"><span class="range-val">${S.opts.sigWidth}px</span></div>
        <button type="button" class="btn small subtle" data-new-signature="1">${icon('signature', 14)} ${S.activeSignature ? 'New signature' : 'Create signature'}</button>
        <span class="context-spacer"></span>
        <span class="context-hint">${tool === 'initials' ? 'Click to place your initials' : S.activeSignature ? 'Click anywhere to place it' : 'Create one, then click to place it'}</span>`;
    case 'sigbox':
      return `
        <span class="context-title">Sign-here box</span>
        <div class="opt-group plain"><span class="opt-label">Label</span><input type="text" class="mini-select" style="width:130px;height:24px" value="${escapeHtml(S.opts.signHereLabel || 'Sign here')}" data-opt="signHereLabel"></div>
        <span class="context-spacer"></span>
        <span class="context-hint">Drag it into place, then save or send the PDF</span>`;
    case 'stamp':
      return `
        <span class="context-title">Stamp</span>
        <div class="opt-group plain"><select class="mini-select" data-opt="stampPreset">${STAMPS.map((s) => `<option value="${s.label}"${S.opts.stampPreset === s.label ? ' selected' : ''}>${s.label}</option>`).join('')}</select></div>
        <div class="opt-group plain"><div class="swatch-row">${swatches(PALETTE.slice(0, 8), S.opts.stampColor, 'color')}</div></div>
        <span class="context-spacer"></span>
        <span class="context-hint">Click the page to place the stamp</span>`;
    case 'image':
      return `<span class="context-title">Image</span><span class="context-hint">Click the page to add an image. It is embedded into the PDF when you save.</span>`;
    case 'redact':
      return `
        <span class="context-title">Redact</span>
        <div class="opt-group plain"><span class="opt-label">Fill</span><div class="swatch-row">${['#000000', '#1b1b1b', '#ffffff'].map((c) => `<button type="button" class="color-swatch${(S.opts.redactFill || '#000000') === c ? ' active' : ''}" data-fill="${c}" style="background:${c}" title="${c === '#ffffff' ? 'White' : 'Black'}"></button>`).join('')}</div></div>
        <span class="context-spacer"></span>
        <span class="context-hint">Redactions are burned in and the covered content is removed on save.</span>`;
    case 'whiteout':
      return `
        <span class="context-title">White out</span>
        <div class="opt-group plain"><span class="opt-label">Fill</span><div class="swatch-row">${['#ffffff', '#fffdf8', '#f4f0e8'].map((c) => `<button type="button" class="color-swatch${(S.opts.whiteoutFill || '#ffffff') === c ? ' active' : ''}" data-fill="${c}" style="background:${c}" title="Cover"></button>`).join('')}</div></div>
        <span class="context-hint">Covers content without deleting it underneath.</span>`;
    case 'forms':
      return `
        <span class="context-title">Form fields</span>
        <span class="context-hint">${S.formFields.length ? `${S.formFields.length} field${S.formFields.length === 1 ? '' : 's'} detected — click one to fill it.` : 'This document has no interactive form fields.'}</span>
        <span class="context-spacer"></span>
        <label class="check-row" style="margin:0"><input type="checkbox" ${S.opts.flattenForms ? 'checked' : ''} data-opt-check="flattenForms"> Flatten on save</label>`;
    default:
      return `<span class="context-title">${escapeHtml(tool?.label || 'Edit')}</span><span class="context-hint">${escapeHtml(tool?.hint || '')}</span>`;
  }
}

const NOTE_COLORS = [
  { name: 'Butter', value: '#fff3bf' },
  { name: 'Blush', value: '#ffdbe2' },
  { name: 'Sky', value: '#d9ecff' },
  { name: 'Mint', value: '#ddf2d8' },
  { name: 'Lilac', value: '#eeddff' },
  { name: 'Peach', value: '#ffe6c9' },
];

function arrangeButtons() {
  return `
    <div class="opt-group plain">
      <button type="button" class="icon-btn tiny" data-arrange="front" title="Bring to front">${icon('arrow-up', 15)}</button>
      <button type="button" class="icon-btn tiny" data-arrange="back" title="Send to back">${icon('arrow-down', 15)}</button>
      <button type="button" class="icon-btn tiny" data-duplicate="1" title="Duplicate (Ctrl+D)">${icon('duplicate', 15)}</button>
      <button type="button" class="icon-btn tiny" data-delete="1" title="Delete (Del)">${icon('trash', 15)}</button>
    </div>`;
}

function bindContext(bar) {
  bar.querySelectorAll('.color-swatch').forEach((button) => {
    button.addEventListener('click', () => {
      const value = colorKey(button);
      if (!value) return;
      bar.querySelectorAll('.color-swatch').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      const hasFill = button.dataset.fill !== undefined;
      const hasStroke = button.dataset.stroke !== undefined;
      const hasNote = button.dataset.note !== undefined;
      if (hasFill) {
        if (S.tool === 'redact') setOpt('redactFill', value);
        else if (S.tool === 'whiteout') setOpt('whiteoutFill', value);
        else setOpt('shapeFill', value);
      } else if (hasStroke) setOpt('shapeStroke', value);
      else if (hasNote) setOpt('noteColor', value);
      else if (button.dataset.hcolor) setOpt('highlightColor', value);
      else if (S.tool === 'text' || S.tool === 'note' || S.tool === 'date') setOpt('textColor', value);
      else if (S.tool === 'underline' || S.tool === 'strike') setOpt('markColor', value);
      else if (S.tool === 'stamp') setOpt('stampColor', value);
      else setOpt('inkColor', value);

      const selected = selectedOverlay();
      if (!selected) return;
      if (hasFill) updateSelected({ fill: value });
      else if (hasStroke) updateSelected({ stroke: value });
      else if (hasNote) updateSelected({ background: value });
      else if (selected.type === 'highlight') updateSelected({ color: value });
      else if (selected.type === 'stamp') updateSelected({ color: value });
      else updateSelected({ color: value });
    });
  });

  bar.querySelectorAll('[data-opt]').forEach((input) => {
    const key = input.dataset.opt;
    const apply = () => {
      let value = input.value;
      if (input.type === 'number') value = clamp(Number(value) || 1, Number(input.min) || 1, Number(input.max) || 999);
      setOpt(key, value);
      const selected = selectedOverlay();
      if (selected) {
        if (key === 'textFont') updateSelected({ fontFamily: value });
        else if (key === 'textSize') updateSelected({ fontSize: Number(value) });
        else if (key === 'stampPreset') updateSelected({ text: value });
        else if (key === 'signHereLabel') updateSelected({ label: value });
      }
    };
    input.addEventListener('input', apply);
    input.addEventListener('change', apply);
  });

  bar.querySelectorAll('[data-opt-range]').forEach((input) => {
    const key = input.dataset.optRange;
    input.addEventListener('input', () => {
      const value = Number(input.value);
      setOpt(key, value);
      const label = input.parentElement.querySelector('.range-val');
      if (label) label.textContent = `${value}px`;
      const selected = selectedOverlay();
      if (!selected) return;
      if (key === 'inkWidth') updateSelected({ strokeWidth: value });
      if (key === 'shapeWidth') updateSelected({ strokeWidth: value });
      if (key === 'sigWidth' && selected.type === 'signature') {
        const aspect = selected.aspect || 3;
        updateSelected({ w: value, h: value / aspect });
      }
    });
  });

  bar.querySelectorAll('[data-opt-percent]').forEach((input) => {
    const key = input.dataset.optPercent;
    input.addEventListener('input', () => {
      const value = clamp(Number(input.value) || 10, 5, 100) / 100;
      setOpt(key, value);
      const selected = selectedOverlay();
      if (selected?.type === 'highlight') updateSelected({ opacity: value });
    });
  });

  bar.querySelectorAll('[data-opt-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.optToggle;
      const next = !S.opts[key];
      setOpt(key, next);
      button.classList.toggle('active', next);
      const selected = selectedOverlay();
      if (selected && key === 'textBold') updateSelected({ bold: next });
    });
  });

  bar.querySelectorAll('[data-opt-align]').forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.optAlign;
      setOpt('textAlign', value);
      bar.querySelectorAll('[data-opt-align]').forEach((b) => b.classList.toggle('active', b === button));
      const selected = selectedOverlay();
      if (selected) updateSelected({ align: value });
    });
  });

  bar.querySelectorAll('[data-opt-check]').forEach((input) => {
    input.addEventListener('change', () => setOpt(input.dataset.optCheck, input.checked));
  });

  bar.querySelectorAll('[data-ink-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      setOpt('inkMode', button.dataset.inkMode);
      bar.querySelectorAll('[data-ink-mode]').forEach((b) => b.classList.toggle('active', b === button));
    });
  });

  bar.querySelectorAll('[data-arrange]').forEach((button) => {
    button.addEventListener('click', () => reorderSelection(button.dataset.arrange));
  });
  bar.querySelector('[data-duplicate]')?.addEventListener('click', duplicateSelection);
  bar.querySelector('[data-delete]')?.addEventListener('click', deleteSelection);

  bar.querySelector('[data-new-signature]')?.addEventListener('click', async () => {
    const signature = await openSignatureDialog();
    if (signature) {
      S.activeSignature = signature;
      document.dispatchEvent(new CustomEvent('pdfstudio:refresh'));
    }
  });

  bar.querySelectorAll('[data-quick-mark]').forEach((button) => {
    button.addEventListener('click', () => {
      document.dispatchEvent(
        new CustomEvent('pdfstudio:quick-mark', { detail: { type: button.dataset.quickMark } })
      );
    });
  });
}

export function toolShortcut(key) {
  const tool = TOOLS.find((t) => t.key && t.key.toLowerCase() === key.toLowerCase());
  if (!tool) return false;
  if (tool.id === 'pages') dispatchAction('pages');
  else setTool(tool.id);
  return true;
}

export function refreshSelectionUi() {
  renderContextbar();
}
