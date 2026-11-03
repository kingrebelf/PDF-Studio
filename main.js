'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ROOT = __dirname;
const APP_DIR = path.join(ROOT, 'app');
const isMac = process.platform === 'darwin';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow = null;
let isDirty = false;
let forceClose = false;
let closePending = false;
let quitAfterClose = false;
let pendingOpenPath = null;
const openedPdfPaths = new Set();

function pathKey(filePath) {
  const absolute = path.resolve(filePath);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function trustedHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('Untrusted application request');
    }
    return handler(event, ...args);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
};

function pdfArgFromArgv(argv) {
  const args = argv.slice(1);
  for (const arg of args) {
    if (!arg || arg.startsWith('-')) continue;
    const candidate = path.resolve(arg);
    if (/\.pdf$/i.test(candidate) && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    title: 'PDF Studio',
    backgroundColor: '#f4f0e8',
    icon: isMac ? undefined : path.join(ROOT, 'app', 'assets', 'app-icon.png'),
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 17, y: 16 } : undefined,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL('app://pdfstudio/index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    const openPath = pendingOpenPath || pdfArgFromArgv(process.argv);
    pendingOpenPath = null;
    if (openPath) {
      mainWindow.webContents.send('app:open-file', openPath);
    }
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:state', { maximized: true });
  });
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:state', { maximized: false });
  });

  mainWindow.on('close', (event) => {
    if (isDirty && !forceClose) {
      event.preventDefault();
      if (!closePending) {
        closePending = true;
        mainWindow.webContents.send('app:close-request');
      }
      return;
    }
    if (!forceClose) forceClose = true;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://pdfstudio/')) {
      event.preventDefault();
      if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.isEditable) {
      items.push(
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      );
    } else if (params.selectionText) {
      items.push({ role: 'copy' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });

  mainWindow.on('page-title-updated', (event) => event.preventDefault());
}

function buildMacMenu() {
  if (!isMac) return null;
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
  ]);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const file = pdfArgFromArgv(argv);
    if (file) mainWindow.webContents.send('app:open-file', file);
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.webContents.send('app:open-file', filePath);
    } else {
      pendingOpenPath = filePath;
    }
  });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      const types = details.mediaTypes || [];
      const allowed = wc === mainWindow?.webContents && permission === 'media' &&
        details.isMainFrame && details.requestingUrl?.startsWith('app://pdfstudio/') &&
        types.length > 0 && types.every((type) => type === 'video');
      callback(Boolean(allowed));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) =>
      wc === mainWindow?.webContents && permission === 'media' && origin === 'app://pdfstudio' &&
      details.isMainFrame && details.mediaType === 'video'
    );

    protocol.handle('app', async (request) => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== 'pdfstudio') return new Response('Forbidden', { status: 403 });
        const relative = decodeURIComponent(url.pathname);
        const filePath = path.resolve(APP_DIR, `.${relative}`);
        if (!filePath.startsWith(APP_DIR + path.sep) && filePath !== APP_DIR) {
          return new Response('Forbidden', { status: 403 });
        }
        const stat = await fsp.stat(filePath).catch(() => null);
        if (!stat || !stat.isFile()) {
          return new Response('Not found', { status: 404 });
        }
        const ext = path.extname(filePath).toLowerCase();
        const res = await net.fetch(pathToFileURL(filePath).toString());
        const headers = new Headers(res.headers);
        if (MIME[ext]) headers.set('Content-Type', MIME[ext]);
        headers.set('Cache-Control', 'no-store');
        return new Response(res.body, { status: res.status, headers });
      } catch (error) {
        return new Response(`Error: ${error.message}`, { status: 500 });
      }
    });

    Menu.setApplicationMenu(buildMacMenu());
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', (event) => {
    if (mainWindow && isDirty && !forceClose) {
      event.preventDefault();
      quitAfterClose = true;
      mainWindow.close();
    }
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}

/* ---------------------------------- IPC ---------------------------------- */

function ensurePdfExtension(filePath) {
  if (!/\.pdf$/i.test(filePath)) return `${filePath}.pdf`;
  return filePath;
}

trustedHandle('dialog:open-pdf', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDF',
    properties: ['openFile'],
    filters: [
      { name: 'PDF documents', extensions: ['pdf'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return readPdfFile(result.filePaths[0]);
});

trustedHandle('dialog:open-pdfs', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose PDFs',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePaths.length) return [];
  return result.filePaths;
});

async function readPdfFile(filePath) {
  if (typeof filePath !== 'string' || !/\.pdf$/i.test(filePath)) throw new Error('Please choose a PDF file.');
  const data = await fsp.readFile(filePath);
  openedPdfPaths.add(pathKey(filePath));
  return {
    path: filePath,
    name: path.basename(filePath),
    data: new Uint8Array(data),
    size: data.length,
  };
}

trustedHandle('file:read', async (_event, filePath) => {
  if (typeof filePath !== 'string') throw new Error('Invalid path');
  return readPdfFile(filePath);
});

trustedHandle('file:save', async (_event, payload) => {
  const { data, path: existingPath, suggestedName, saveAs, extension } = payload;
  if (!data) throw new Error('No data to save');
  let target = saveAs ? null : existingPath;
  if (target && (typeof target !== 'string' || !openedPdfPaths.has(pathKey(target)))) {
    throw new Error('Choose where to save this document first.');
  }
  if (!target) {
    const isPdf = !extension || extension === 'pdf';
    const result = await dialog.showSaveDialog(mainWindow, {
      title: saveAs ? 'Save a copy' : 'Save PDF',
      defaultPath: suggestedName || 'Document.pdf',
      filters: isPdf
        ? [{ name: 'PDF document', extensions: ['pdf'] }]
        : [{ name: 'Files', extensions: [extension] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    target = isPdf ? ensurePdfExtension(result.filePath) : result.filePath;
  }
  // Write beside the target and replace it only after the complete write succeeds.
  const tempPath = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(tempPath, Buffer.from(data), { flag: 'wx' });
    await fsp.rename(tempPath, target);
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => {});
    throw error;
  }
  if (/\.pdf$/i.test(target)) openedPdfPaths.add(pathKey(target));
  return { canceled: false, path: target, name: path.basename(target) };
});

trustedHandle('file:save-text', async (_event, payload) => {
  const { text, suggestedName, extension = 'txt' } = payload;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export text',
    defaultPath: suggestedName || 'document.txt',
    filters: [{ name: 'Text file', extensions: [extension] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const target = /\.\w+$/.test(result.filePath)
    ? result.filePath
    : `${result.filePath}.${extension}`;
  await fsp.writeFile(target, text, 'utf8');
  return { canceled: false, path: target };
});

trustedHandle('images:save', async (_event, payload) => {
  const { files, suggestedName } = payload;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder for the images',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Save here',
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const dir = result.filePaths[0];
  const base = (suggestedName || 'page')
    .replace(/\.pdf$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
  let count = 0;
  for (const file of files) {
    const match = /^data:(image\/\w+);base64,(.*)$/.exec(file.dataUrl);
    if (!match) continue;
    const ext = match[1].includes('png') ? 'png' : 'jpg';
    const fileName = `${base}-${String(file.name).replace(/\.[^.]+$/, '')}.${ext}`;
    await fsp.writeFile(path.join(dir, fileName), Buffer.from(match[2], 'base64'));
    count += 1;
  }
  return { canceled: false, dir, count };
});

trustedHandle('shell:external', async (_event, url) => {
  if (typeof url !== 'string' || !/^(https?:|mailto:)/i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});

trustedHandle('shell:show-item', async (_event, filePath) => {
  if (typeof filePath !== 'string') return;
  shell.showItemInFolder(filePath);
});

trustedHandle('window:minimize', () => mainWindow?.minimize());
trustedHandle('window:maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
trustedHandle('window:close', () => mainWindow?.close());
trustedHandle('window:state', () => ({ maximized: mainWindow?.isMaximized() ?? false }));
trustedHandle('window:theme', (_event, theme) => {
  mainWindow?.setBackgroundColor(theme === 'dark' ? '#14120f' : '#f4f0e8');
});

trustedHandle('app:get-info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  platform: process.platform,
  arch: process.arch,
}));

trustedHandle('app:set-dirty', (_event, dirty) => {
  isDirty = Boolean(dirty);
});

trustedHandle('app:set-title', (_event, title) => {
  mainWindow?.setTitle(title || 'PDF Studio');
});

trustedHandle('app:close-response', (_event, shouldClose) => {
  closePending = false;
  if (shouldClose) {
    forceClose = true;
    isDirty = false;
    if (mainWindow) {
      mainWindow.close();
      if (quitAfterClose && isMac) app.quit();
    }
  }
  quitAfterClose = false;
});
