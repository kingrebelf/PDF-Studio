'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  isElectron: true,
  openPDF: () => ipcRenderer.invoke('dialog:open-pdf'),
  openPDFs: () => ipcRenderer.invoke('dialog:open-pdfs'),
  openPath: (filePath) => ipcRenderer.invoke('file:read', filePath),
  savePDF: (payload) => ipcRenderer.invoke('file:save', payload),
  saveText: (payload) => ipcRenderer.invoke('file:save-text', payload),
  saveImages: (payload) => ipcRenderer.invoke('images:save', payload),
  openExternal: (url) => ipcRenderer.invoke('shell:external', url),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:show-item', filePath),
  getInfo: () => ipcRenderer.invoke('app:get-info'),
  setDirty: (dirty) => ipcRenderer.invoke('app:set-dirty', dirty),
  setTitle: (title) => ipcRenderer.invoke('app:set-title', title),
  setTheme: (theme) => ipcRenderer.invoke('window:theme', theme),
  closeResponse: (shouldClose) => ipcRenderer.invoke('app:close-response', shouldClose),
  windowControl: (action) => ipcRenderer.invoke(`window:${action}`),
  getWindowState: () => ipcRenderer.invoke('window:state'),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  onCommand: (callback) => subscribe('menu:command', callback),
  onOpenFile: (callback) => subscribe('app:open-file', callback),
  onCloseRequest: (callback) => subscribe('app:close-request', callback),
  onWindowState: (callback) => subscribe('window:state', callback),
});
