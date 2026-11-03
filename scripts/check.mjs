#!/usr/bin/env node
/**
 * Static health check for PDF Studio.
 *
 * Runs without launching Electron so it can gate CI and pre-package builds:
 *   1. every app/js module parses as an ES module
 *   2. every named import resolves to a real export
 *   3. vendored PDF.js / pdf-lib files and local assets exist
 *   4. index.html references existing local files
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const JS_DIR = path.join(APP, 'js');

const problems = [];
const notes = [];

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function parseCheck(file) {
  try {
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
      input: read(file),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error.stderr || error.message)
      .split('\n')
      .filter(Boolean)
      .slice(0, 3)
      .join(' ');
    problems.push(`${path.relative(ROOT, file)} does not parse — ${detail}`);
  }
}

function exportsOf(source) {
  const names = new Set();
  const decl = /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(decl)) names.add(match[1]);
  const lists = /^export\s*\{([^}]*)\}/gm;
  for (const match of source.matchAll(lists)) {
    for (const part of match[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const alias = piece.split(/\s+as\s+/);
      names.add((alias[1] || alias[0]).trim());
    }
  }
  if (/^export\s+default\b/m.test(source)) names.add('default');
  return names;
}

const modules = fs
  .readdirSync(JS_DIR)
  .filter((name) => name.endsWith('.js'))
  .sort();

const exportMap = new Map();
for (const name of modules) {
  const file = path.join(JS_DIR, name);
  const source = read(file);
  parseCheck(file);
  exportMap.set(name, exportsOf(source));
}

for (const name of modules) {
  const source = read(path.join(JS_DIR, name));
  const imports = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/([\w.-]+\.js)['"]/gs;
  for (const match of source.matchAll(imports)) {
    const target = match[2];
    const available = exportMap.get(target);
    if (!available) {
      problems.push(`${name} imports from missing module ${target}`);
      continue;
    }
    for (const part of match[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const imported = piece.split(/\s+as\s+/)[0].trim();
      if (!available.has(imported)) {
        problems.push(`${name} imports ${imported} from ${target}, which does not export it`);
      }
    }
  }
}

const required = [
  'app/index.html',
  'app/css/app.css',
  'app/assets/sample.pdf',
  'app/assets/GreatVibes-Regular.ttf',
  'app/assets/GreatVibes-OFL.txt',
  'app/assets/app-icon.png',
  'app/vendor/pdfjs/pdf.mjs',
  'app/vendor/pdfjs/pdf.worker.mjs',
  'app/vendor/pdfjs/cmaps/Adobe-CNS1-UCS2.bcmap',
  'app/vendor/pdfjs/standard_fonts/FoxitSerif.pfb',
  'app/vendor/pdflib/pdf-lib.esm.min.js',
  'main.js',
  'preload.js',
  'build/icon.png',
  'build/icon.ico',
  'build/icon.icns',
];
for (const rel of required) {
  if (!fs.existsSync(path.join(ROOT, rel))) problems.push(`missing required file: ${rel}`);
}

const html = read(path.join(APP, 'index.html'));
for (const match of html.matchAll(/(?:src|href)="(?!https?:|data:|#)([^"]+)"/g)) {
  const target = path.join(APP, match[1]);
  if (!fs.existsSync(target)) problems.push(`index.html references missing file: ${match[1]}`);
}

if (!problems.length) {
  const total = modules.reduce((sum, name) => sum + read(path.join(JS_DIR, name)).split('\n').length, 0);
  notes.push(`${modules.length} ES modules parsed (${total.toLocaleString()} lines)`);
  notes.push(`${required.length} required assets present`);
  notes.push('all named imports resolve');
  console.log('PDF Studio check: OK');
  for (const note of notes) console.log(`  • ${note}`);
  process.exit(0);
}

console.error(`PDF Studio check: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
for (const problem of problems) console.error(`  ✗ ${problem}`);
process.exit(1);
