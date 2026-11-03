import { S, loadSignatures, storeSignatures } from './state.js';
import { openModal, toast, readFile, escapeHtml, $ } from './ui.js';
import { icon } from './icons.js';

function trimCanvas(source, padding = 18) {
  const ctx = source.getContext('2d', { willReadFrequently: true });
  const { width, height } = source;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = Math.max(1, w + padding * 2);
  out.height = Math.max(1, h + padding * 2);
  const octx = out.getContext('2d');
  octx.drawImage(source, minX, minY, w, h, padding, padding, w, h);
  return out;
}

function cleanPaper(canvas, threshold = 212, softness = 34) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const lum = r * 0.299 + g * 0.587 + b * 0.114;
    if (lum > threshold) {
      const t = Math.min(1, (lum - threshold) / softness);
      d[i + 3] = Math.round(d[i + 3] * (1 - t));
    }
    if (lum < 248 && lum > 120) {
      // Slightly deepen the ink so pale photos stay legible.
      const factor = 0.85;
      d[i] = Math.round(r * factor);
      d[i + 1] = Math.round(g * factor);
      d[i + 2] = Math.round(b * factor);
    }
  }
  ctx.putImageData(img, 0, 0);
}

async function imageFromFile(file) {
  const dataUrl = await readFile(file, 'dataurl');
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ img, dataUrl });
    img.onerror = () => reject(new Error('That image could not be read.'));
    img.src = dataUrl;
  });
}

export async function signatureFromDataUrl(dataUrl, { cleanup = false, mirror = false } = {}) {
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That image could not be read.'));
    image.src = dataUrl;
  });
  const max = 1400;
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  const scale = Math.min(1, max / Math.max(w, h));
  w = Math.max(1, Math.round(w * scale));
  h = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (mirror) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(img, 0, 0, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (cleanup) cleanPaper(canvas, 205, 44);
  const trimmed = trimCanvas(canvas, Math.round(Math.max(w, h) * 0.02));
  if (!trimmed) throw new Error('The signature appears to be blank.');
  return makeSignature(trimmed.toDataURL('image/png'), 'image');
}

function makeSignature(dataUrl, kind, extra = {}) {
  const aspect = extra.aspect || 3.1;
  return {
    id: `sig${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    dataUrl,
    kind,
    aspect,
    createdAt: Date.now(),
    ...extra,
  };
}

async function renderTypedSignature(text, color = '#1f2f5c') {
  await document.fonts.load('160px "Great Vibes"').catch(() => {});
  const padding = 40;
  const fontSize = 150;
  const probe = document.createElement('canvas');
  const pctx = probe.getContext('2d');
  pctx.font = `${fontSize}px "Great Vibes", cursive`;
  const width = Math.max(360, Math.ceil(pctx.measureText(text).width) + padding * 2);
  const height = fontSize * 1.9;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontSize}px "Great Vibes", cursive`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2 + fontSize * 0.04);
  const trimmed = trimCanvas(canvas, 14);
  if (!trimmed) return null;
  return trimmed;
}

function addSignatureToStore(signature) {
  const list = loadSignatures();
  if (list.some((item) => item.dataUrl === signature.dataUrl)) return true;
  list.unshift({
    id: signature.id,
    dataUrl: signature.dataUrl,
    kind: signature.kind,
    aspect: signature.aspect,
    createdAt: signature.createdAt,
  });
  return storeSignatures(list.slice(0, 8));
}

export function saveSignature(signature) {
  if (!addSignatureToStore(signature)) toast('Signature is available for this session but could not be saved for reuse.', 'warning');
  S.activeSignature = signature;
  return signature;
}

export function openSignatureDialog({ title = 'Add your signature', subtitle = 'Draw, type, upload, or use your camera. Signatures are stored only on this device.' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let activeTab = 'draw';
    let stream = null;
    let cameraRequest = 0;
    let lastCapture = null;
    let drawMode = false;
    let drawn = false;

    const done = (signature) => {
      if (settled) return;
      settled = true;
      if (signature) saveSignature(signature);
      resolve(signature || null);
      modal.close(true);
    };

    const saved = loadSignatures();
    const savedHtml = saved.length
      ? `<div class="sig-saved-block">
          <div class="insp-label" style="margin-bottom:7px">Saved on this device</div>
          <div class="saved-sigs" id="saved-sigs">
            ${saved
              .map(
                (sig) => `<div class="saved-sig" data-sig-id="${sig.id}" role="button" tabindex="0" title="Use this signature">
                  <img src="${sig.dataUrl}" alt="Saved signature">
                  <button type="button" class="sig-del" data-del-sig="${sig.id}" title="Delete signature">${icon('trash', 12)}</button>
                </div>`
              )
              .join('')}
          </div>
        </div>`
      : '';

    const body = `
      <div class="sig-layout">
        ${savedHtml}
        <div class="tab-row" id="sig-tabs">
          <button type="button" data-sig-tab="draw" class="active">${icon('pen', 14)} Draw</button>
          <button type="button" data-sig-tab="type">${icon('type', 14)} Type</button>
          <button type="button" data-sig-tab="upload">${icon('upload', 14)} Upload</button>
          <button type="button" data-sig-tab="camera">${icon('camera', 14)} Camera</button>
        </div>

        <div class="sig-pane" data-pane="draw">
          <div class="sig-pad-wrap">
            <canvas id="sig-pad" class="sig-pad"></canvas>
            <div class="sig-pad-baseline"></div>
            <div class="sig-pad-hint">Draw your signature above the line</div>
          </div>
          <div class="sig-tools" style="margin-top:9px">
            <span class="opt-label">Ink</span>
            <button type="button" class="color-swatch active" data-sig-color="#1d2b56" style="background:#1d2b56" title="Ink blue"></button>
            <button type="button" class="color-swatch" data-sig-color="#171512" style="background:#171512" title="Black"></button>
            <button type="button" class="color-swatch" data-sig-color="#2f5c91" style="background:#2f5c91" title="Blue"></button>
            <span class="context-spacer" style="flex:1"></span>
            <button type="button" class="btn small subtle" id="sig-clear">${icon('trash', 13)} Clear</button>
          </div>
        </div>

        <div class="sig-pane" data-pane="type" hidden>
          <label class="field-label" for="sig-type-text">Type your name or initials</label>
          <input id="sig-type-text" type="text" value="${escapeHtml(S.initials || '')}" placeholder="e.g. Benjamin Carter" autocomplete="off">
          <div class="sig-type-preview" style="margin-top:10px">
            <div class="ghost" id="sig-type-preview">${escapeHtml(S.initials || 'Your signature')}</div>
          </div>
          <div class="hint">Choose among a few ink colors. The script is rendered with Great Vibes.</div>
          <div class="sig-tools" style="margin-top:8px">
            <span class="opt-label">Ink</span>
            <button type="button" class="color-swatch active" data-sig-type-color="#1f2f5c" style="background:#1f2f5c" title="Ink blue"></button>
            <button type="button" class="color-swatch" data-sig-type-color="#171512" style="background:#171512" title="Black"></button>
          </div>
        </div>

        <div class="sig-pane" data-pane="upload" hidden>
          <div class="sig-upload-zone" id="sig-upload-zone" role="button" tabindex="0">
            ${icon('upload', 26)}
            <strong>Upload a signature image</strong>
            <span>PNG, JPG or WebP. White paper is removed automatically.</span>
          </div>
          <input type="file" id="sig-upload-input" accept="image/png,image/jpeg,image/webp" hidden>
          <div id="sig-upload-preview" class="sig-type-preview" style="margin-top:10px;display:none">
            <img id="sig-upload-img" alt="Uploaded signature" style="max-width:92%;max-height:140px;object-fit:contain">
          </div>
          <label class="check-row" style="margin-top:8px"><input type="checkbox" id="sig-clean" checked> Remove paper background</label>
        </div>

        <div class="sig-pane" data-pane="camera" hidden>
          <div class="camera-wrap" id="camera-wrap">
            <video id="camera-video" autoplay playsinline muted></video>
            <div class="camera-empty" id="camera-empty">Start the camera, then hold your signature up to it.</div>
          </div>
          <div class="camera-actions">
            <button type="button" class="btn small" id="camera-start">${icon('camera', 13)} Start camera</button>
            <button type="button" class="btn small" id="camera-capture" disabled>${icon('check', 13)} Capture</button>
            <label class="check-row" style="margin:0"><input type="checkbox" id="camera-clean" checked> Clean paper</label>
            <label class="check-row" style="margin:0"><input type="checkbox" id="camera-mirror"> Mirror</label>
          </div>
          <div id="camera-preview" class="sig-type-preview" style="margin-top:10px;display:none">
            <img id="camera-img" alt="Captured signature" style="max-width:92%;max-height:140px;object-fit:contain">
          </div>
        </div>

        <div class="hint">Signatures are saved locally so you can reuse them. Nothing is uploaded.</div>
      </div>`;

    const modal = openModal({
      title,
      subtitle,
      body,
      size: 'wide',
      iconName: 'signature',
      footer: `
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="button" class="btn primary" id="sig-use" disabled>${icon('check', 15)} Use signature</button>`,
      onClose: () => done(null),
      onMount: ({ bodyEl, footerEl }) => {
        const pad = bodyEl.querySelector('#sig-pad');
        const useButton = footerEl.querySelector('#sig-use');
        const ctx = pad.getContext('2d');
        const W = 1000;
        const H = 300;
        pad.width = W;
        pad.height = H;
        let ink = '#1d2b56';
        let lastPoint = null;

        const clearPad = () => {
          ctx.clearRect(0, 0, W, H);
          drawn = false;
          useButton.disabled = activeTab !== 'type' && activeTab !== 'upload' && activeTab !== 'camera';
        };

        const padPoint = (event) => {
          const rect = pad.getBoundingClientRect();
          return {
            x: ((event.clientX - rect.left) / rect.width) * W,
            y: ((event.clientY - rect.top) / rect.height) * H,
            pressure: event.pressure || 0.5,
          };
        };

        const drawSegment = (from, to) => {
          ctx.strokeStyle = ink;
          ctx.lineWidth = 3.2 + (to.pressure || 0.5) * 1.6;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          ctx.quadraticCurveTo(from.x, from.y, (from.x + to.x) / 2, (from.y + to.y) / 2);
          ctx.lineTo(to.x, to.y);
          ctx.stroke();
        };

        pad.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return;
          pad.setPointerCapture(event.pointerId);
          drawMode = true;
          lastPoint = padPoint(event);
          drawn = true;
          useButton.disabled = false;
        });
        pad.addEventListener('pointermove', (event) => {
          if (!drawMode) return;
          const point = padPoint(event);
          drawSegment(lastPoint, point);
          lastPoint = point;
        });
        const stopDraw = () => {
          drawMode = false;
          lastPoint = null;
        };
        pad.addEventListener('pointerup', stopDraw);
        pad.addEventListener('pointercancel', stopDraw);

        bodyEl.querySelectorAll('[data-sig-color]').forEach((button) => {
          button.addEventListener('click', () => {
            bodyEl.querySelectorAll('[data-sig-color]').forEach((b) => b.classList.remove('active'));
            button.classList.add('active');
            ink = button.dataset.sigColor;
          });
        });

        bodyEl.querySelector('#sig-clear').addEventListener('click', clearPad);

        const switchTab = (tab) => {
          activeTab = tab;
          bodyEl.querySelectorAll('[data-sig-tab]').forEach((b) => b.classList.toggle('active', b.dataset.sigTab === tab));
          bodyEl.querySelectorAll('[data-pane]').forEach((pane) => {
            pane.hidden = pane.dataset.pane !== tab;
          });
          if (tab !== 'camera') stopCamera();
          updateUseState();
        };

        bodyEl.querySelectorAll('[data-sig-tab]').forEach((button) => {
          button.addEventListener('click', () => switchTab(button.dataset.sigTab));
        });

        const typeInput = bodyEl.querySelector('#sig-type-text');
        const typePreview = bodyEl.querySelector('#sig-type-preview');
        typeInput.addEventListener('input', () => {
          typePreview.textContent = typeInput.value || 'Your signature';
          updateUseState();
        });
        let typeInk = '#1f2f5c';
        bodyEl.querySelectorAll('[data-sig-type-color]').forEach((button) => {
          button.addEventListener('click', () => {
            bodyEl.querySelectorAll('[data-sig-type-color]').forEach((b) => b.classList.remove('active'));
            button.classList.add('active');
            typeInk = button.dataset.sigTypeColor;
            typePreview.style.color = typeInk;
          });
        });

        let uploadSignature = null;
        const uploadZone = bodyEl.querySelector('#sig-upload-zone');
        const uploadInput = bodyEl.querySelector('#sig-upload-input');
        const uploadPreview = bodyEl.querySelector('#sig-upload-preview');
        const uploadImg = bodyEl.querySelector('#sig-upload-img');
        uploadZone.addEventListener('click', () => uploadInput.click());
        uploadZone.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') uploadInput.click();
        });
        uploadInput.addEventListener('change', async () => {
          const file = uploadInput.files?.[0];
          uploadInput.value = '';
          if (!file) return;
          try {
            const clean = bodyEl.querySelector('#sig-clean').checked;
            uploadSignature = await signatureFromDataUrl(await readFile(file, 'dataurl'), { cleanup: clean });
            uploadImg.src = uploadSignature.dataUrl;
            uploadPreview.style.display = 'grid';
            updateUseState();
          } catch (error) {
            toast(error.message || 'Could not read that image.', 'error');
          }
        });

        const video = bodyEl.querySelector('#camera-video');
        const cameraEmpty = bodyEl.querySelector('#camera-empty');
        const captureButton = bodyEl.querySelector('#camera-capture');
        const startButton = bodyEl.querySelector('#camera-start');
        const cameraPreview = bodyEl.querySelector('#camera-preview');
        const cameraImg = bodyEl.querySelector('#camera-img');

        async function startCamera() {
          if (stream) return;
          const request = ++cameraRequest;
          try {
            const acquired = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } },
              audio: false,
            });
            if (request !== cameraRequest || settled || activeTab !== 'camera') {
              acquired.getTracks().forEach((track) => track.stop());
              return;
            }
            stream = acquired;
            video.srcObject = stream;
            cameraEmpty.hidden = true;
            captureButton.disabled = false;
            startButton.textContent = 'Camera on';
            startButton.disabled = true;
            await video.play().catch(() => {});
          } catch (error) {
            cameraEmpty.hidden = false;
            cameraEmpty.textContent =
              'Camera unavailable. Check camera permissions, or use Upload instead.';
            startButton.disabled = false;
          }
        }

        function stopCamera() {
          cameraRequest += 1;
          if (stream) {
            stream.getTracks().forEach((track) => track.stop());
            stream = null;
          }
          video.srcObject = null;
          captureButton.disabled = true;
          startButton.disabled = false;
          startButton.textContent = 'Start camera';
        }

        startButton.addEventListener('click', startCamera);
        captureButton.addEventListener('click', async () => {
          if (!stream) return;
          const mirror = bodyEl.querySelector('#camera-mirror').checked;
          const w = video.videoWidth || 1280;
          const h = video.videoHeight || 720;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const c = canvas.getContext('2d');
          if (mirror) {
            c.translate(w, 0);
            c.scale(-1, 1);
          }
          c.drawImage(video, 0, 0, w, h);
          c.setTransform(1, 0, 0, 1, 0, 0);
          if (bodyEl.querySelector('#camera-clean').checked) cleanPaper(canvas, 200, 50);
          const trimmed = trimCanvas(canvas, 16);
          if (!trimmed) {
            toast('No signature detected. Try again with more contrast.', 'error');
            return;
          }
          lastCapture = makeSignature(trimmed.toDataURL('image/png'), 'camera');
          cameraImg.src = lastCapture.dataUrl;
          cameraPreview.style.display = 'grid';
          captureButton.disabled = true;
          useButton.disabled = false;
          toast('Captured. Check the preview, then use the signature.', 'success', 2600);
        });

        const updateUseState = () => {
          let ready = false;
          if (activeTab === 'draw') ready = drawn;
          else if (activeTab === 'type') ready = Boolean(typeInput.value.trim());
          else if (activeTab === 'upload') ready = Boolean(uploadSignature);
          else if (activeTab === 'camera') ready = Boolean(lastCapture);
          useButton.disabled = !ready;
        };

        useButton.addEventListener('click', async () => {
          try {
            if (activeTab === 'draw') {
              if (!drawn) return;
              const trimmed = trimCanvas(pad, 18);
              if (!trimmed) return;
              done(makeSignature(trimmed.toDataURL('image/png'), 'drawn'));
            } else if (activeTab === 'type') {
              const text = typeInput.value.trim();
              if (!text) return;
              const rendered = await renderTypedSignature(text, typeInk);
              if (!rendered) return;
              done(makeSignature(rendered.toDataURL('image/png'), 'typed', { text, aspect: rendered.width / rendered.height }));
            } else if (activeTab === 'upload') {
              if (uploadSignature) done(uploadSignature);
            } else if (activeTab === 'camera') {
              if (lastCapture) done(lastCapture);
            }
          } catch (error) {
            toast(error.message || 'Could not create the signature.', 'error');
          }
        });

        bodyEl.querySelectorAll('.saved-sig').forEach((node) => {
          node.addEventListener('click', (event) => {
            if (event.target.closest('.sig-del')) return;
            const signature = loadSignatures().find((item) => item.id === node.dataset.sigId);
            if (signature) done({ ...signature, kind: signature.kind || 'image' });
          });
          node.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') node.click();
          });
        });

        bodyEl.querySelectorAll('[data-del-sig]').forEach((button) => {
          button.addEventListener('click', (event) => {
            event.stopPropagation();
            const id = button.dataset.delSig;
            const stored = loadSignatures();
            const removed = stored.find((item) => item.id === id);
            const next = stored.filter((item) => item.id !== id);
            if (!storeSignatures(next)) {
              toast('The signature could not be removed from local storage.', 'error');
              return;
            }
            if (S.activeSignature?.id === id || (removed && S.activeSignature?.dataUrl === removed.dataUrl)) S.activeSignature = null;
            nodeFromId(id)?.remove();
            toast('Signature removed.', 'info');
            if (!bodyEl.querySelector('.saved-sig')) bodyEl.querySelector('.sig-saved-block')?.remove();
          });
        });

        const nodeFromId = (id) => bodyEl.querySelector(`[data-sig-id="${id}"]`);

        // Pre-warm the script font so the live preview and export match.
        document.fonts.load('160px "Great Vibes"').catch(() => {});

        updateUseState();
        setTimeout(() => {
          if (document.activeElement === typeInput) typeInput.focus();
        }, 40);
      },
    });

    const originalClose = modal.close;
    modal.close = (immediate) => {
      stopCameraIfAny();
      originalClose(immediate);
    };

    function stopCameraIfAny() {
      cameraRequest += 1;
      const video = $('#camera-video');
      if (video?.srcObject) {
        video.srcObject.getTracks().forEach((track) => track.stop());
        video.srcObject = null;
      }
    }
  });
}

export async function openInitialsDialog() {
  const value = await new Promise((resolve) => {
    const modal = openModal({
      title: 'Your initials',
      subtitle: 'Initials are drawn in the same script and saved for reuse.',
      size: 'narrow',
      iconName: 'signature',
      body: `<label class="field-label" for="initials-input">Initials</label>
             <input id="initials-input" type="text" maxlength="6" value="${escapeHtml(S.initials || '')}" placeholder="e.g. BC">
             <div class="hint">Use two or three letters for the cleanest look.</div>`,
      footer: `<button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn primary" data-ok>Use initials</button>`,
      onClose: () => resolve(null),
    });
    const input = modal.bodyEl.querySelector('#initials-input');
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      S.initials = text;
      resolve(text);
      modal.close(true);
    };
    modal.footerEl.querySelector('[data-cancel]').addEventListener('click', () => {
      resolve(null);
      modal.close();
    });
    modal.footerEl.querySelector('[data-ok]').addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 40);
  });
  if (!value) return null;
  const canvas = await renderTypedSignature(value, '#1f2f5c');
  if (!canvas) return null;
  return {
    text: value,
    dataUrl: canvas.toDataURL('image/png'),
    aspect: canvas.width / canvas.height,
  };
}
