'use strict';

/**
 * 账号管理窗口的预加载脚本
 * 只暴露账号相关的最小接口，禁用 Node 能力。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('accountApi', {
  list: () => ipcRenderer.invoke('accounts:list'),
  upsert: (payload) => ipcRenderer.invoke('accounts:upsert', payload),
  remove: (id) => ipcRenderer.invoke('accounts:remove', id),
  setRemember: (value) => ipcRenderer.invoke('accounts:remember', value),
  loginWith: (id) => ipcRenderer.invoke('accounts:login', id),
  close: () => ipcRenderer.invoke('manager:close'),
  openWorkDir: () => ipcRenderer.invoke('manager:open-workdir'),
  status: () => ipcRenderer.invoke('manager:status'),
});
