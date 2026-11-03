import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { PDFDocument, StandardFonts, PDFName, PDFDict } from 'pdf-lib';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-studio-test-'));
let app;
try {
  const fixture = await PDFDocument.create();
  const p = fixture.addPage([400, 400]);
  p.drawText('SECRET-REDACTION-CHECK', { x: 50, y: 300, size: 16, font: await fixture.embedFont(StandardFonts.Helvetica) });
  const field = fixture.getForm().createTextField('test_name');
  field.addToPage(p, {x:30,y:20,width:150,height:24});
  const encrypted = (await fs.readFile(new URL('./fixtures/encrypted.pdf', import.meta.url))).toString('base64');
  const encoded = Buffer.from(await fixture.save()).toString('base64');
  const fixturePath = path.join(temp, 'opened.pdf');
  await fs.writeFile(fixturePath, Buffer.from(encoded, 'base64'));
  const executablePath = process.env.PDF_STUDIO_EXECUTABLE;
  const args = [...(executablePath ? [] : ['.']), `--user-data-dir=${temp}`, '--use-fake-device-for-media-stream'];
  if (process.platform === 'linux' && process.env.CI) args.push('--no-sandbox');
  app = await electron.launch({ executablePath, args, timeout: 45000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.__pdfstudio?.booted);
  await page.locator('#launcher-continue').click();
  assert.equal(await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return window.__pdfstudio.openFileData(bytes, 'test.pdf', null);
  }, encoded), true, 'fixture opens');
  await page.waitForFunction(() => document.querySelector('.page-canvas')?.width > 0);

  await page.waitForFunction(() => window.__pdfstudio.S.formFields.some(field => field.name === 'test_name'));
  const formBytes = await page.evaluate(async () => {
    window.__pdfstudio.S.formValues.test_name = 'Form value';
    const { buildPdfBytes } = await import('./js/docops.js');
    return Array.from(await buildPdfBytes({flattenForms:false}));
  });
  assert.equal((await PDFDocument.load(Uint8Array.from(formBytes))).getForm().getTextField('test_name').getText(), 'Form value', 'form values save');

  // Exercise the real typed-signature dialog and ensure the result can be embedded.
  await page.evaluate(() => { window.signatureTest = import('./js/signature.js').then(m => m.openSignatureDialog()); });
  await page.locator('[data-sig-tab="type"]').click();
  await page.locator('#sig-type-text').fill('Alex Example');
  await page.locator('#sig-use').click();
  assert.equal(await page.evaluate(async () => Boolean((await window.signatureTest)?.dataUrl)), true, 'typed signature is created');
  await page.locator('[data-mode="edit"]').first().click();
  await page.locator('[data-tool="signature"]').click();
  await page.locator('.annotation-canvas').first().click({position:{x:150,y:220}});
  assert.equal(await page.evaluate(() => (window.__pdfstudio.S.overlays.get(0) || []).some(x => x.type === 'signature' && x.src?.startsWith('data:image/png'))), true, 'signature is placed on the page');
  const signed = await page.evaluate(async () => {
    const { buildPdfBytes } = await import('./js/docops.js');
    return Array.from(await buildPdfBytes({ flattenForms:false }));
  });
  const signedDoc = await PDFDocument.load(Uint8Array.from(signed));
  assert.equal(signedDoc.getPageCount(), 1, 'signed PDF can be reopened');
  const xobjects = signedDoc.getPage(0).node.Resources().lookup(PDFName.of('XObject'), PDFDict);
  assert.ok(xobjects && xobjects.keys().length > 0, 'signature image is embedded');

  const missingImageRejected = await page.evaluate(async () => {
    const { S } = window.__pdfstudio;
    const previous = S.overlays;
    S.overlays = new Map([[0, [{id:'broken',type:'signature',x:0,y:0,w:20,h:10}]]]);
    try { await (await import('./js/docops.js')).buildPdfBytes({flattenForms:false}); return false; }
    catch { return true; }
    finally { S.overlays = previous; }
  });
  assert.ok(missingImageRejected, 'save fails instead of dropping a missing signature');

  // A redaction must remain opaque even if an old overlay has a lower opacity,
  // and must cover marks later in the overlay list.
  const result = await page.evaluate(async () => {
    const { S } = window.__pdfstudio;
    S.overlays.set(0, [
      {id:'redact-test',type:'redact',x:40,y:70,w:250,h:60,fill:'#000000',opacity:0.1},
      {id:'mark',type:'rect',x:50,y:80,w:200,h:30,fill:'#ffffff',stroke:'#ffffff',opacity:1},
    ]);
    const { buildPdfBytes } = await import('./js/docops.js');
    const bytes = await buildPdfBytes({ flattenForms:true });
    const pdfjs = await import('./vendor/pdfjs/pdf.mjs');
    const pdf = await pdfjs.getDocument({data:bytes.slice(),isEvalSupported:false}).promise;
    const first = await pdf.getPage(1);
    const text = (await first.getTextContent()).items.map(x => x.str).join(' ');
    const viewport = first.getViewport({scale:1});
    const canvas = document.createElement('canvas'); canvas.width=viewport.width; canvas.height=viewport.height;
    const ctx=canvas.getContext('2d'); await first.render({canvasContext:ctx,viewport}).promise;
    return {text, pixel:Array.from(ctx.getImageData(60,90,1,1).data)};
  });
  assert.ok(!result.text.includes('SECRET-REDACTION-CHECK'), 'redacted page does not retain searchable original text');
  assert.ok(result.pixel[0] < 30 && result.pixel[1] < 30 && result.pixel[2] < 30, `redaction stays opaque: ${result.pixel}`);

  const markedDirty = await page.evaluate(async () => {
    const { commitAnnotationsForOps } = await import('./js/docops.js');
    await commitAnnotationsForOps();
    return window.__pdfstudio.S.dirty;
  });
  assert.ok(markedDirty, 'preparing page operations preserves the unsaved state');

  const saved = await page.evaluate(async (filePath) => {
    const file = await window.api.openPath(filePath);
    return window.api.savePDF({data:file.data,path:filePath});
  }, fixturePath);
  assert.equal(saved.canceled, false, 'opened PDF can be saved');
  assert.equal((await PDFDocument.load(await fs.readFile(fixturePath))).getPageCount(), 1, 'saved PDF remains readable');

  const media = await page.evaluate(async () => {
    let camera = false, microphone = false;
    try { const stream = await navigator.mediaDevices.getUserMedia({video:true}); camera = true; stream.getTracks().forEach(track => track.stop()); } catch {}
    try { const stream = await navigator.mediaDevices.getUserMedia({audio:true}); microphone = true; stream.getTracks().forEach(track => track.stop()); } catch {}
    return {camera, microphone};
  });
  assert.deepEqual(media, {camera:true, microphone:false}, 'camera works while microphone access is denied');

  const denied = await page.evaluate(async () => {
    try { await window.api.savePDF({data:new Uint8Array([1]),path:'C:\\not-opened.pdf'}); return false; }
    catch { return true; }
  });
  assert.ok(denied, 'save rejects paths not opened or selected by the user');
  await page.evaluate((b64) => {
    window.__pdfstudio.S.dirty = false;
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    window.encryptedOpen = window.__pdfstudio.openFileData(bytes, 'encrypted.pdf', null);
  }, encrypted);
  await page.locator('#prompt-value').fill('test-password');
  await page.locator('.modal-foot [data-confirm]').click();
  assert.equal(await page.evaluate(() => window.encryptedOpen), true, 'password-protected PDF opens with the correct password');
  assert.equal(await page.evaluate(() => window.__pdfstudio.S.editable), false, 'encrypted document opens read-only');

  console.log('Regression checks passed: forms, signature, save/reopen, redaction, camera permissions, and save-path authorization.');
} finally {
  if (app) {
    const exited = app.process().exitCode === null ? new Promise(resolve => app.process().once('exit', resolve)) : Promise.resolve();
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await exited;
  }
  await fs.rm(temp, { recursive:true, force:true, maxRetries:10, retryDelay:200 });
}

