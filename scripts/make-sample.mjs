import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import fs from 'node:fs';

const PAPER = rgb(0.999, 0.992, 0.972);
const INK = rgb(0.13, 0.115, 0.09);
const MUTED = rgb(0.42, 0.39, 0.34);
const RULE = rgb(0.86, 0.83, 0.77);
const TERRA = rgb(0.69, 0.32, 0.17);
const GOLD = rgb(0.82, 0.6, 0.21);

const doc = await PDFDocument.create();
doc.setTitle('Mutual Work Agreement — PDF Studio Sample');
doc.setAuthor('PDF Studio');
doc.setSubject('A sample agreement for trying out PDF Studio');
doc.setKeywords(['sample', 'agreement', 'pdf studio']);
doc.setCreator('PDF Studio sample generator');
doc.setProducer('PDF Studio');

const helv = await doc.embedFont(StandardFonts.Helvetica);
const helvB = await doc.embedFont(StandardFonts.HelveticaBold);
const times = await doc.embedFont(StandardFonts.TimesRoman);
const timesB = await doc.embedFont(StandardFonts.TimesRomanBold);
const timesI = await doc.embedFont(StandardFonts.TimesRomanItalic);
const mono = await doc.embedFont(StandardFonts.Courier);

const W = 612;
const H = 792;

function pageBg(page) {
  page.drawRectangle({ x: 0, y: 0, width: page.getWidth(), height: page.getHeight(), color: PAPER });
}

function wrap(text, font, size, maxWidth) {
  const out = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) <= maxWidth || !line) line = test;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out;
}

function paragraph(page, text, x, y, { font = times, size = 11.5, width = W - 144, leading = 17, color = INK } = {}) {
  const lines = wrap(text, font, size, width);
  let cursor = y;
  for (const line of lines) {
    page.drawText(line, { x, y: cursor, size, font, color, lineHeight: leading });
    cursor -= leading;
  }
  return cursor;
}

function smallCaps(page, text, x, y, color = TERRA, size = 8.5) {
  page.drawText(text.toUpperCase(), { x, y, size, font: helvB, color, characterSpacing: 1.6 });
}

function footnote(page, n) {
  page.drawLine({ start: { x: 72, y: 64 }, end: { x: W - 72, y: 64 }, thickness: 0.7, color: RULE });
  page.drawText('PDF Studio sample document', { x: 72, y: 47, size: 8, font: helv, color: MUTED });
  page.drawText(String(n), { x: W - 80, y: 47, size: 8, font: helv, color: MUTED });
}

/* ---------------- page 1: cover ---------------- */
{
  const page = doc.addPage([W, H]);
  pageBg(page);
  page.drawRectangle({ x: 0, y: H - 268, width: W, height: 268, color: rgb(0.16, 0.14, 0.115) });
  page.drawRectangle({ x: 0, y: H - 274, width: W, height: 6, color: TERRA });

  page.drawText('PDF STUDIO', { x: 72, y: H - 78, size: 10, font: helvB, color: rgb(0.95, 0.91, 0.84), characterSpacing: 3.2 });
  page.drawText('A calmer way', { x: 72, y: H - 160, size: 44, font: timesB, color: rgb(1, 0.98, 0.94) });
  page.drawText('to work with paper.', { x: 72, y: H - 210, size: 44, font: timesI, color: rgb(0.96, 0.79, 0.62) });

  smallCaps(page, 'Sample document', 72, H - 318, TERRA, 9);
  page.drawText('Mutual Work', { x: 72, y: H - 380, size: 38, font: timesB, color: INK });
  page.drawText('Agreement', { x: 72, y: H - 422, size: 38, font: timesB, color: INK });

  page.drawLine({ start: { x: 72, y: H - 460 }, end: { x: 300, y: H - 460 }, thickness: 1.2, color: RULE });

  paragraph(page,
    'A short, human-readable agreement between two people who would rather be making things than reading contracts. It contains real form fields, generous margins for notes, and one page turned on its side — useful for trying every corner of the editor.',
    72, H - 495, { font: times, size: 12.5, width: 330, leading: 19 });

  const facts = [
    ['Prepared for', 'Alex Morgan'],
    ['Studio', 'Northline Design Co.'],
    ['Reference', 'NW-2026-014'],
    ['Date', '28 October 2026'],
  ];
  let y = H - 350;
  for (const [k, v] of facts) {
    page.drawText(k.toUpperCase(), { x: 430, y, size: 7, font: helvB, color: MUTED, characterSpacing: 1.2 });
    page.drawText(v, { x: 430, y: y - 16, size: 11, font: helv, color: INK });
    y -= 52;
  }

  page.drawRectangle({ x: 72, y: 120, width: 468, height: 112, color: rgb(0.985, 0.965, 0.93), borderColor: RULE, borderWidth: 0.8 });
  smallCaps(page, 'Inside this sample', 92, 202, TERRA, 8);
  page.drawText('01  The agreement         02  Payment & signatures', { x: 92, y: 178, size: 10, font: helv, color: INK });
  page.drawText('03  Working notes           04  A page turned sideways', { x: 92, y: 158, size: 10, font: helv, color: INK });
  page.drawText('Try the sample in View mode first. Switch to Edit when you want to sign, highlight or change something.', { x: 92, y: 134, size: 8.5, font: helv, color: MUTED });

  footnote(page, 1);
}

/* ---------------- page 2: agreement ---------------- */
{
  const page = doc.addPage([W, H]);
  pageBg(page);

  smallCaps(page, 'Section one', 72, H - 82);
  page.drawText('The agreement', { x: 72, y: H - 124, size: 30, font: timesB, color: INK });
  page.drawLine({ start: { x: 72, y: H - 142 }, end: { x: W - 72, y: H - 142 }, thickness: 0.8, color: RULE });

  let y = H - 178;
  const clause = (num, title, body) => {
    page.drawText(num, { x: 72, y, size: 10, font: helvB, color: TERRA });
    page.drawText(title, { x: 100, y, size: 12.5, font: helvB, color: INK });
    y -= 19;
    y = paragraph(page, body, 100, y, { size: 11, width: W - 190, leading: 16 });
    y -= 14;
  };

  clause('1.1', 'Scope of work',
    'Northline Design Co. will design and build a small identity system: a wordmark, a colour and type palette, and a one-page set of usage notes. Two rounds of revisions are included. Additional rounds are billed at the studio’s usual day rate.');
  clause('1.2', 'Timeline',
    'Work begins on 4 November 2026 and is expected to finish by 16 December 2026. Either party may pause the schedule in writing if feedback takes longer than ten working days.');
  clause('1.3', 'What each side provides',
    'The client provides existing brand materials, a decision-maker for feedback, and timely access to any third-party accounts needed. The studio provides weekly progress notes and keeps source files tidy and portable.');

  page.drawRectangle({ x: 72, y: 226, width: W - 144, height: 166, color: rgb(0.985, 0.968, 0.94), borderColor: RULE, borderWidth: 0.8 });
  smallCaps(page, 'A few details', 92, 368, TERRA, 8);
  page.drawText('These are real interactive fields — fill them in with the Form fields tool.', { x: 92, y: 348, size: 8.5, font: helv, color: MUTED });

  const form = doc.getForm();
  const nameField = form.createTextField('fullName');
  nameField.setText('Alex Morgan');
  nameField.addToPage(page, { x: 92, y: 308, width: 196, height: 24, borderWidth: 0.7, borderColor: RULE, backgroundColor: rgb(1, 1, 1) });
  page.drawText('FULL NAME', { x: 92, y: 338, size: 6.5, font: helvB, color: MUTED, characterSpacing: 1 });

  const companyField = form.createTextField('company');
  companyField.setText('Northline Design Co.');
  companyField.addToPage(page, { x: 300, y: 308, width: 236, height: 24, borderWidth: 0.7, borderColor: RULE, backgroundColor: rgb(1, 1, 1) });
  page.drawText('STUDIO / COMPANY', { x: 300, y: 338, size: 6.5, font: helvB, color: MUTED, characterSpacing: 1 });

  const emailField = form.createTextField('email');
  emailField.setText('alex@northline.example');
  emailField.addToPage(page, { x: 92, y: 266, width: 260, height: 24, borderWidth: 0.7, borderColor: RULE, backgroundColor: rgb(1, 1, 1) });
  page.drawText('EMAIL', { x: 92, y: 296, size: 6.5, font: helvB, color: MUTED, characterSpacing: 1 });

  const plan = form.createDropdown('plan');
  plan.setOptions(['Standard identity', 'Extended identity', 'Identity + website']);
  plan.select('Standard identity');
  plan.addToPage(page, { x: 364, y: 266, width: 172, height: 24, borderWidth: 0.7, borderColor: RULE, backgroundColor: rgb(1, 1, 1) });
  page.drawText('PACKAGE', { x: 364, y: 296, size: 6.5, font: helvB, color: MUTED, characterSpacing: 1 });

  const agree = form.createCheckBox('agreeToTerms');
  agree.addToPage(page, { x: 92, y: 238, width: 13, height: 13, borderWidth: 0.8, borderColor: MUTED, backgroundColor: rgb(1, 1, 1) });
  page.drawText('I have read and agree to the terms.', { x: 113, y: 241, size: 9.5, font: helv, color: INK });

  const rush = form.createRadioGroup('turnaround');
  rush.addOptionToPage('Standard', page, { x: 356, y: 241, width: 11, height: 11, borderWidth: 0.8, borderColor: MUTED });
  page.drawText('Standard', { x: 372, y: 241, size: 9, font: helv, color: INK });
  rush.addOptionToPage('Rush', page, { x: 432, y: 241, width: 11, height: 11, borderWidth: 0.8, borderColor: MUTED });
  page.drawText('Rush', { x: 448, y: 241, size: 9, font: helv, color: INK });
  rush.select('Standard');

  footnote(page, 2);
}

/* ---------------- page 3: payment & signatures ---------------- */
{
  const page = doc.addPage([W, H]);
  pageBg(page);

  smallCaps(page, 'Section two', 72, H - 82);
  page.drawText('Payment and signatures', { x: 72, y: H - 124, size: 28, font: timesB, color: INK });
  page.drawLine({ start: { x: 72, y: H - 142 }, end: { x: W - 72, y: H - 142 }, thickness: 0.8, color: RULE });

  let y = H - 178;
  y = paragraph(page,
    'The total fee for the work described is 8,400 USD, split into two payments: half to begin, half on delivery. Invoices are payable within fourteen days. The studio retains the right to show the finished work in its portfolio unless the client asks otherwise in writing.',
    72, y, { size: 11.5, width: W - 144, leading: 18 });
  y -= 18;

  const rows = [
    ['Design fee', '6,800.00'],
    ['Type licensing', '900.00'],
    ['Handover & files', '700.00'],
  ];
  page.drawRectangle({ x: 72, y: y - 92, width: W - 144, height: 26, color: rgb(0.96, 0.94, 0.9) });
  page.drawText('ITEM', { x: 86, y: y - 82, size: 7, font: helvB, color: MUTED, characterSpacing: 1.2 });
  page.drawText('AMOUNT (USD)', { x: W - 190, y: y - 82, size: 7, font: helvB, color: MUTED, characterSpacing: 1.2 });
  let ry = y - 112;
  for (const [label, amount] of rows) {
    page.drawText(label, { x: 86, y: ry, size: 10.5, font: helv, color: INK });
    const w = helv.widthOfTextAtSize(amount, 10.5);
    page.drawText(amount, { x: W - 86 - w, y: ry, size: 10.5, font: helv, color: INK });
    page.drawLine({ start: { x: 86, y: ry - 10 }, end: { x: W - 86, y: ry - 10 }, thickness: 0.5, color: RULE });
    ry -= 26;
  }
  page.drawText('TOTAL', { x: 86, y: ry - 2, size: 8, font: helvB, color: INK, characterSpacing: 1 });
  const total = '8,400.00';
  const tw = helvB.widthOfTextAtSize(total, 12);
  page.drawText(total, { x: W - 86 - tw, y: ry - 4, size: 12, font: helvB, color: TERRA });

  page.drawLine({ start: { x: 72, y: 300 }, end: { x: W - 72, y: 300 }, thickness: 0.8, color: RULE });
  smallCaps(page, 'Sign below', 72, 278, TERRA, 8);
  page.drawText('Sign on paper, or use the Signature tool to add your own.', { x: 72, y: 258, size: 9, font: helv, color: MUTED });

  const lineY = 168;
  page.drawLine({ start: { x: 72, y: lineY }, end: { x: 300, y: lineY }, thickness: 0.9, color: MUTED });
  page.drawLine({ start: { x: 340, y: lineY }, end: { x: W - 72, y: lineY }, thickness: 0.9, color: MUTED });
  page.drawText('Signature — Northline Design Co.', { x: 72, y: lineY - 16, size: 8, font: helv, color: MUTED });
  page.drawText('Signature — Client', { x: 340, y: lineY - 16, size: 8, font: helv, color: MUTED });
  page.drawText('Date', { x: 72, y: lineY - 54, size: 8, font: helvB, color: MUTED, characterSpacing: 0.8 });
  page.drawLine({ start: { x: 104, y: lineY - 56 }, end: { x: 220, y: lineY - 56 }, thickness: 0.7, color: RULE });
  page.drawText('Date', { x: 340, y: lineY - 54, size: 8, font: helvB, color: MUTED, characterSpacing: 0.8 });
  page.drawLine({ start: { x: 372, y: lineY - 56 }, end: { x: 488, y: lineY - 56 }, thickness: 0.7, color: RULE });

  footnote(page, 3);
}

/* ---------------- page 4: notes ---------------- */
{
  const page = doc.addPage([W, H]);
  pageBg(page);

  smallCaps(page, 'Working notes', 72, H - 82);
  page.drawText('A page for marking up', { x: 72, y: H - 124, size: 30, font: timesB, color: INK });
  paragraph(page, 'Use this page to try highlights, underlines, ink, sticky notes and shapes. Nothing here is precious.', 72, H - 156, { size: 11, width: W - 144, color: MUTED });

  const items = [
    ['01', 'Open in View mode', 'Scroll, search for “Northline”, and try dark paper from the moon button in the title bar.'],
    ['02', 'Switch to Edit', 'The tool rail appears on the left. Choose Highlight and drag across any sentence below.'],
    ['03', 'Sign the agreement', 'Pick the Signature tool, draw or type a signature, then click page three. Reuse it later without redrawing.'],
    ['04', 'Leave a sign-here box', 'Use the Sign here box tool when someone else needs to sign. It is written into the saved PDF.'],
    ['05', 'Redact something', 'Drag over a line with the Redact tool. On save, the covered content is removed rather than hidden.'],
  ];

  let y = H - 214;
  for (const [num, title, body] of items) {
    page.drawText(num, { x: 72, y, size: 10, font: mono, color: TERRA });
    page.drawText(title, { x: 108, y, size: 13, font: helvB, color: INK });
    y -= 18;
    y = paragraph(page, body, 108, y, { size: 10.5, width: W - 200, leading: 15.5, color: rgb(0.28, 0.26, 0.22) });
    y -= 16;
  }

  page.drawRectangle({ x: 72, y: 150, width: W - 144, height: 96, color: rgb(1, 0.953, 0.749), borderColor: rgb(0.886, 0.765, 0.357), borderWidth: 0.8 });
  page.drawText('NOTE', { x: 88, y: 224, size: 7, font: helvB, color: rgb(0.35, 0.29, 0.13), characterSpacing: 1.4 });
  paragraph(page, 'Everything in this sample is fictional. The names, numbers and studio are here only to make the pages feel real while you explore.', 88, 204, { size: 9.5, width: W - 180, leading: 14, color: rgb(0.24, 0.2, 0.09) });

  footnote(page, 4);
}

/* ---------------- page 5: rotated ---------------- */
{
  const page = doc.addPage([W, H]);
  pageBg(page);
  page.setRotation(degrees(90));

  // Content drawn in unrotated coordinates; rotating the page makes it landscape.
  smallCaps(page, 'Appendix', 72, H - 82);
  page.drawText('A page turned sideways', { x: 72, y: H - 124, size: 28, font: timesB, color: INK });
  page.drawText('Rotated 90° — the editor keeps annotations aligned with the page.', { x: 72, y: H - 150, size: 10, font: timesI, color: MUTED });

  const cols = [72, 210, 348, 486];
  const headerY = H - 200;
  page.drawRectangle({ x: 72, y: headerY - 6, width: W - 144, height: 24, color: rgb(0.16, 0.14, 0.115) });
  ['WEEK', 'FOCUS', 'OUTPUT', 'OWNER'].forEach((label, i) => {
    page.drawText(label, { x: cols[i] + 8, y: headerY + 2, size: 7.5, font: helvB, color: rgb(0.98, 0.95, 0.9), characterSpacing: 1.2 });
  });

  const rows = [
    ['01', 'Discovery', 'Interview notes, audit', 'Alex'],
    ['02', 'Directions', 'Two visual routes', 'Studio'],
    ['03', 'Refinement', 'Chosen route, palette', 'Both'],
    ['04', 'System', 'Type scale, components', 'Studio'],
    ['05', 'Handover', 'Files, usage notes', 'Studio'],
    ['06', 'Review', 'Final sign-off', 'Alex'],
  ];
  let ry = headerY - 34;
  rows.forEach((row, idx) => {
    if (idx % 2 === 0) page.drawRectangle({ x: 72, y: ry - 8, width: W - 144, height: 24, color: rgb(0.985, 0.972, 0.95) });
    row.forEach((cell, i) => {
      page.drawText(cell, { x: cols[i] + 8, y: ry, size: 9.5, font: i === 0 ? mono : helv, color: INK });
    });
    ry -= 24;
  });

  page.drawRectangle({ x: 72, y: 180, width: W - 144, height: 92, color: rgb(0.975, 0.955, 0.92), borderColor: RULE, borderWidth: 0.8 });
  page.drawText('WHY THIS PAGE EXISTS', { x: 88, y: 250, size: 7, font: helvB, color: TERRA, characterSpacing: 1.2 });
  paragraph(page, 'PDF pages can carry their own rotation. A reader has to honour it, and an editor has to keep every highlight, signature and note sitting on the right spot. This page is here so you can check both.', 88, 232, { size: 9.5, width: W - 180, leading: 14 });

  footnote(page, 5);
}

const bytes = await doc.save({ useObjectStreams: true });
fs.writeFileSync(new URL('../app/assets/sample.pdf', import.meta.url), bytes);
console.log('wrote app/assets/sample.pdf', bytes.length, 'bytes');
