import { icon } from './icons.js';
export { icon };

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function debounce(fn, ms = 180) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function formatRelativeTime(timestamp) {
  const delta = Date.now() - Number(timestamp || 0);
  if (!delta || delta < 0) return '';
  const min = Math.round(delta / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatDate(date = new Date(), style = 'MMM D, YYYY') {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const longMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const yyyy = String(date.getFullYear());
  const yy = yyyy.slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return style
    .replaceAll('YYYY', yyyy)
    .replaceAll('YY', yy)
    .replaceAll('MMMM', longMonths[date.getMonth()])
    .replaceAll('MMM', months[date.getMonth()])
    .replaceAll('MM', mm)
    .replaceAll('M', String(date.getMonth() + 1))
    .replaceAll('DD', dd)
    .replaceAll('D', String(date.getDate()));
}

export function parsePageRange(input, maxPages) {
  const text = String(input ?? '').trim();
  if (!text || /^all$/i.test(text)) {
    return Array.from({ length: maxPages }, (_, i) => i);
  }
  const result = new Set();
  for (const rawPart of text.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    let match = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (match) {
      let start = Number(match[1]);
      let end = Number(match[2]);
      if (start > end) [start, end] = [end, start];
      for (let n = start; n <= end; n += 1) {
        if (n >= 1 && n <= maxPages) result.add(n - 1);
      }
      continue;
    }
    match = /^(\d+)\s*-$/.exec(part);
    if (match) {
      for (let n = Number(match[1]); n <= maxPages; n += 1) {
        if (n >= 1) result.add(n - 1);
      }
      continue;
    }
    match = /^-\s*(\d+)$/.exec(part);
    if (match) {
      for (let n = 1; n <= Number(match[1]); n += 1) {
        if (n <= maxPages) result.add(n - 1);
      }
      continue;
    }
    if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n >= 1 && n <= maxPages) result.add(n - 1);
      continue;
    }
    throw new Error(`“${part}” is not a valid page range.`);
  }
  return [...result].sort((a, b) => a - b);
}

export function hexToRgba(hex, alpha = 1) {
  let h = String(hex || '#000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = Number.parseInt(h, 16);
  if (Number.isNaN(n)) return `rgba(0,0,0,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export function toast(message, type = 'info', duration = 3400) {
  const root = $('#toast-root');
  if (!root) return;
  const map = { info: 'info', error: 'help', success: 'check', warning: 'help' };
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.innerHTML = `${icon(map[type] || 'info', 14)}<span></span>`;
  node.querySelector('span').textContent = message;
  root.append(node);
  while (root.children.length > 3) root.firstElementChild.remove();
  setTimeout(() => {
    node.classList.add('fade');
    setTimeout(() => node.remove(), 280);
  }, duration);
}

export function showBusy(title = 'Working…', subtitle = 'This will only take a moment.') {
  const busy = $('#busy');
  if (!busy) return;
  $('#busy-title').textContent = title;
  $('#busy-sub').textContent = subtitle;
  $('#busy-progress').hidden = true;
  $('#busy-progress span').style.width = '0%';
  busy.hidden = false;
}

export function setBusyProgress(ratio, subtitle) {
  const bar = $('#busy-progress');
  if (!bar) return;
  bar.hidden = false;
  bar.querySelector('span').style.width = `${clamp(ratio, 0, 1) * 100}%`;
  if (subtitle) $('#busy-sub').textContent = subtitle;
}

export function hideBusy() {
  const busy = $('#busy');
  if (busy) busy.hidden = true;
}

let activeModal = null;

export function openModal(options = {}) {
  const {
    title = '',
    subtitle = '',
    body = '',
    footer = null,
    size = '',
    onMount = null,
    onClose = null,
    closeOnBackdrop = true,
    closeOnEsc = true,
    iconName = '',
  } = options;

  if (activeModal) activeModal.close(true);

  const root = $('#modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="modal-head">
        <div class="modal-head-text">
          <h2 class="modal-title">${escapeHtml(title)}</h2>
          ${subtitle ? `<p class="modal-sub">${escapeHtml(subtitle)}</p>` : ''}
        </div>
        <button type="button" class="icon-btn modal-close" data-close title="Close" aria-label="Close">${icon('x', 17)}</button>
      </div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div>
    </div>`;

  const modal = backdrop.querySelector('.modal');
  const bodyEl = backdrop.querySelector('.modal-body');
  const footerEl = backdrop.querySelector('.modal-foot');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body instanceof Node) bodyEl.append(body);

  if (footer === false) {
    footerEl.remove();
  } else if (footer instanceof Node) {
    footerEl.append(footer);
  } else if (typeof footer === 'string') {
    footerEl.innerHTML = footer;
  } else {
    footerEl.innerHTML = `<button type="button" class="btn" data-close>Close</button>`;
  }

  root.innerHTML = '';
  root.append(backdrop);

  let closed = false;
  const close = (immediate = false) => {
    if (closed) return;
    closed = true;
    if (activeModal && activeModal.backdrop === backdrop) activeModal = null;
    if (immediate) backdrop.remove();
    else {
      backdrop.style.animation = 'fade-in .12s reverse';
      setTimeout(() => backdrop.remove(), 100);
    }
    document.removeEventListener('keydown', onKey, true);
    if (typeof onClose === 'function') onClose();
  };

  const onKey = (event) => {
    if (event.key === 'Escape' && closeOnEsc) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop && closeOnBackdrop) close();
  });
  backdrop.addEventListener('click', (event) => {
    const target = event.target.closest('[data-close]');
    if (target) {
      event.preventDefault();
      close();
    }
  });
  document.addEventListener('keydown', onKey, true);

  activeModal = { backdrop, close, bodyEl, footerEl, modal };
  if (iconName) {
    const holder = modal.querySelector('.modal-head-text');
    holder.insertAdjacentHTML(
      'afterbegin',
      `<span class="modal-head-icon">${icon(iconName, 22)}</span>`
    );
  }

  requestAnimationFrame(() => {
    const focusable = bodyEl.querySelector('input:not([type="hidden"]), textarea, select, button');
    if (focusable) {
      focusable.focus();
      if (focusable.select && focusable.type === 'text') focusable.select();
    } else {
      footerEl?.querySelector('.btn.primary, .btn')?.focus();
    }
  });

  if (typeof onMount === 'function') onMount({ backdrop, modal, bodyEl, footerEl, close });
  return { backdrop, modal, bodyEl, footerEl, close };
}

export function closeModal() {
  if (activeModal) activeModal.close();
}

export function confirmModal({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  danger = false,
  iconName = 'help',
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const modal = openModal({
      title,
      body: `<div class="confirm-copy">${message}</div>`,
      iconName,
      size: 'narrow',
      footer: `
        <button type="button" class="btn" data-cancel>${escapeHtml(cancelLabel)}</button>
        <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-confirm>${escapeHtml(confirmLabel)}</button>`,
      onClose: () => finish(false),
    });
    modal.footerEl.querySelector('[data-cancel]').addEventListener('click', () => {
      finish(false);
      modal.close();
    });
    modal.footerEl.querySelector('[data-confirm]').addEventListener('click', () => {
      finish(true);
      modal.close(true);
    });
  });
}

export function promptModal({
  title = 'Enter a value',
  label = '',
  value = '',
  placeholder = '',
  confirmLabel = 'OK',
  multiline = false,
  type = 'text',
  iconName = '',
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const field = multiline
      ? `<textarea id="prompt-value" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`
      : `<input id="prompt-value" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">`;
    const modal = openModal({
      title,
      body: `<label class="field-label" for="prompt-value">${escapeHtml(label)}</label>${field}`,
      iconName,
      size: 'narrow',
      footer: `
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="button" class="btn primary" data-confirm>${escapeHtml(confirmLabel)}</button>`,
      onClose: () => finish(null),
    });
    const input = modal.bodyEl.querySelector('#prompt-value');
    const submit = () => {
      const result = input.value;
      finish(result);
      modal.close(true);
    };
    modal.footerEl.querySelector('[data-cancel]').addEventListener('click', () => {
      finish(null);
      modal.close();
    });
    modal.footerEl.querySelector('[data-confirm]').addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !multiline) {
        event.preventDefault();
        submit();
      }
    });
    setTimeout(() => {
      input.focus();
      if (input.select) input.select();
    }, 30);
  });
}

export function menu({ x = 0, y = 0, items = [], align = 'left' } = {}) {
  const root = $('#menu-root');
  root.innerHTML = '';
  root.classList.add('open');

  const backdrop = document.createElement('div');
  backdrop.className = 'menu-backdrop';
  root.append(backdrop);

  const panel = document.createElement('div');
  panel.className = 'menu';
  panel.setAttribute('role', 'menu');

  for (const item of items) {
    if (!item) continue;
    if (item.type === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      panel.append(sep);
      continue;
    }
    if (item.heading) {
      const heading = document.createElement('div');
      heading.className = 'menu-heading';
      heading.textContent = item.heading;
      panel.append(heading);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu-item${item.danger ? ' danger' : ''}`;
    button.disabled = Boolean(item.disabled);
    button.setAttribute('role', 'menuitem');
    button.innerHTML = `${item.icon ? icon(item.icon, 15) : '<span style="width:15px"></span>'}<span class="menu-label"></span>${item.shortcut ? `<span class="shortcut">${escapeHtml(item.shortcut)}</span>` : ''}`;
    button.querySelector('.menu-label').textContent = item.label;
    button.addEventListener('click', () => {
      close();
      item.action?.();
    });
    panel.append(button);
  }

  root.append(panel);
  const rect = panel.getBoundingClientRect();
  let left = align === 'right' ? x - rect.width : x;
  let top = y;
  left = clamp(left, 8, window.innerWidth - rect.width - 8);
  if (top + rect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - rect.height - 8);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;

  const close = () => {
    root.classList.remove('open');
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
  };

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  backdrop.addEventListener('pointerdown', close);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
  setTimeout(() => {
    panel.querySelector('.menu-item:not(:disabled)')?.focus();
  }, 0);

  return close;
}

export function swatchRow(colors, current, dataAttr = 'data-color') {
  return colors
    .map(
      (color) =>
        `<button type="button" class="color-swatch${color.value === current ? ' active' : ''}" style="background:${color.value}" title="${escapeHtml(color.name)}" ${dataAttr}="${color.value}"></button>`
    )
    .join('');
}

export function bindSwatches(container, selector, callback) {
  container.querySelectorAll(selector).forEach((button) => {
    button.addEventListener('click', () => {
      container.querySelectorAll(selector).forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      callback(button.getAttribute('data-color') || button.dataset.color);
    });
  });
}

export function readFile(file, as = 'arraybuffer') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    if (as === 'dataurl') reader.readAsDataURL(file);
    else reader.readAsArrayBuffer(file);
  });
}

export function dataUrlToBytes(dataUrl) {
  const base64 = String(dataUrl).split(',')[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function downloadBlob(bytes, filename, mime = 'application/pdf') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function basename(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || '';
}

export function stripExtension(name) {
  return String(name || '').replace(/\.[^.]+$/, '');
}

export function sanitizeFilename(name, fallback = 'document') {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
