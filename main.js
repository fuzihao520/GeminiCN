'use strict';

/**
 * Gemini 中文版 —— 便携式桌面客户端
 * ---------------------------------------------------------------
 * 设计要点：
 * 1) 便携数据：所有用户数据（Cookie、缓存、设置、工作文件夹）都放在
 *    程序所在目录的 data\ 下，不写系统盘 C: 的用户目录。
 * 2) 默认中文：启动地址强制 hl=zh-CN，并设置 Accept-Language，
 *    保证 Gemini 网页界面用简体中文（可切换为英文/跟随账号）。
 * 3) Cookie 长期保留：使用独立的持久化会话，不调用任何清理接口，
 *    退出前主动 flush，登录状态可长期保持。
 * 4) 本地文件：支持系统文件选择框上传、拖拽上传，
 *    并提供固定的工作文件夹与下载目录。
 */

const {
  app,
  BrowserWindow,
  Menu,
  shell,
  session,
  dialog,
  ipcMain,
  Notification,
  powerMonitor,
  globalShortcut,
  Tray,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const netcheck = require('./netcheck');
const { createAccountStore } = require('./accounts');

// ---------------------------------------------------------------
// 便携化：必须在 app ready 之前设置路径
// ---------------------------------------------------------------
const APP_ROOT = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
const DATA_ROOT = path.join(APP_ROOT, 'data');
const PROFILE_DIR = path.join(DATA_ROOT, 'profile');
const WORK_DIR = path.join(DATA_ROOT, '工作文件夹');
const DOWNLOAD_DIR = path.join(WORK_DIR, '下载');

for (const dir of [DATA_ROOT, PROFILE_DIR, WORK_DIR, DOWNLOAD_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    // 目录不可写时不要直接崩，交给后续提示
  }
}

app.setPath('userData', PROFILE_DIR);
try {
  app.setPath('crashDumps', path.join(DATA_ROOT, '崩溃日志'));
} catch {}

// 语言与站点常量
const GEMINI_ORIGIN = 'https://gemini.google.com/app';
const GEMINI_HOST = 'gemini.google.com';

// 允许在客户端内部打开的 Google 域名（登录、账号、静态资源）
const INTERNAL_HOSTS = new Set([
  'gemini.google.com',
  'accounts.google.com',
  'accounts.youtube.com',
  'myaccount.google.com',
  'ogs.google.com',
  'apis.google.com',
  'gstatic.com',
  'ssl.gstatic.com',
  'www.gstatic.com',
  'content-autofill.googleapis.com',
  'clients6.google.com',
]);

const LANG_MODES = {
  zh: { label: '简体中文（推荐）', hl: 'zh-CN', accept: 'zh-CN,zh;q=0.9,en;q=0.8' },
  en: { label: 'English', hl: 'en', accept: 'en-US,en;q=0.9' },
  auto: { label: '跟随 Google 账号设置', hl: null, accept: null },
};

const SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json');
const ACCOUNTS_FILE = path.join(DATA_ROOT, 'accounts.json');
const accounts = createAccountStore(ACCOUNTS_FILE);

/** 读取本地设置 */
function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lang: LANG_MODES[parsed.lang] ? parsed.lang : 'zh',
      bounds: parsed.bounds || null,
      maximized: Boolean(parsed.maximized),
      closeToTray: parsed.closeToTray !== false,
      globalShortcutEnabled: parsed.globalShortcutEnabled !== false,
      globalShortcut: typeof parsed.globalShortcut === 'string' ? parsed.globalShortcut : 'Alt+Space',
      safeMode: parsed.safeMode !== false,
    };
  } catch {
    return {
      lang: 'zh',
      bounds: null,
      maximized: false,
      closeToTray: true,
      globalShortcutEnabled: true,
      globalShortcut: 'Alt+Space',
      safeMode: true,
    };
  }
}

/** 保存本地设置（原子写入，避免断电写坏） */
function saveSettings() {
  try {
    const payload = {
      lang: settings.lang,
      bounds: settings.bounds,
      maximized: settings.maximized,
      closeToTray: settings.closeToTray,
      globalShortcutEnabled: settings.globalShortcutEnabled,
      globalShortcut: settings.globalShortcut,
      safeMode: settings.safeMode,
      updatedAt: new Date().toISOString(),
    };
    const tmp = `${SETTINGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch {}
}

const settings = loadSettings();
let currentLang = settings.lang;
let mainWindow = null;
let hlGuardAt = 0;

// 网络状态
let netState = null; // 最近一次检测结果
let netTimer = null;
let netRunning = false;
let netNotifiedRed = false;

// 托盘 / 窗口 / 断网兜底
let tray = null;
let isQuitting = false;
let showingOffline = false;
let failedURL = '';

/** 生成 Chrome 风格 UA，避免 Google 把嵌入式浏览器判定为不安全环境 */
function chromeUserAgent() {
  const chromeVersion = process.versions.chrome || '142.0.0.0';
  return (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    `(KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  );
}

/** 当前语言模式对应的启动地址 */
function startUrl(lang = currentLang) {
  const mode = LANG_MODES[lang] || LANG_MODES.zh;
  return mode.hl ? `${GEMINI_ORIGIN}?hl=${mode.hl}` : GEMINI_ORIGIN;
}

/** 安全解析主机名 */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 是否允许在客户端内部打开 */
function isInternal(url) {
  const host = hostOf(url);
  if (!host) return false;
  return [...INTERNAL_HOSTS].some((h) => host === h || host.endsWith(`.${h}`));
}

// ---------------------------------------------------------------
// 会话与 Cookie：持久化 + 语言请求头
// ---------------------------------------------------------------
function configureSession(ses) {
  ses.setUserAgent(chromeUserAgent());

  // 下载默认落到工作文件夹，避免又写回 C 盘下载目录
  try {
    ses.setDownloadPath(DOWNLOAD_DIR);
  } catch {}

  // 强制语言请求头（hl 参数之外的第二道保险）
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const mode = LANG_MODES[currentLang] || LANG_MODES.zh;
    const headers = details.requestHeaders;

    // 头部字段大小写不固定，按现有键名替换
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === 'user-agent' && /electron/i.test(headers[key])) {
        headers[key] = chromeUserAgent();
      }
      if (lower === 'accept-language' && mode.accept) {
        headers[key] = mode.accept;
      }
    }
    if (mode.accept && !Object.keys(headers).some((k) => k.toLowerCase() === 'accept-language')) {
      headers['Accept-Language'] = mode.accept;
    }
    callback({ requestHeaders: headers });
  });
}

// ---------------------------------------------------------------
// 本地文件与工作文件夹
// ---------------------------------------------------------------
function ensureWorkDir() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  return WORK_DIR;
}

function openWorkDir() {
  shell.openPath(ensureWorkDir()).catch(() => {});
}

function openDownloadDir() {
  openWorkDir();
  shell.openPath(DOWNLOAD_DIR).catch(() => {});
}

/** 选择文件后复制进工作文件夹，重名自动加序号 */
async function importFilesToWorkDir() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择要放入工作文件夹的本地文件',
    buttonLabel: '复制到工作文件夹',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '所有文件', extensions: ['*'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return;

  ensureWorkDir();
  const report = [];
  for (const src of result.filePaths) {
    try {
      const base = path.basename(src);
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      let target = path.join(WORK_DIR, base);
      let index = 1;
      while (fs.existsSync(target)) {
        target = path.join(WORK_DIR, `${stem}(${index})${ext}`);
        index += 1;
      }
      fs.copyFileSync(src, target);
      report.push(`${path.basename(target)}  ✅`);
    } catch (err) {
      report.push(`${path.basename(src)}  ❌ ${err.message}`);
    }
  }

  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '已放入工作文件夹',
    message: `已处理 ${report.length} 个文件`,
    detail: `${report.join('\n')}\n\n位置：${WORK_DIR}`,
    buttons: ['打开工作文件夹', '知道了'],
    defaultId: 0,
    cancelId: 1,
  }).then((res) => {
    if (res.response === 0) openWorkDir();
  });
}

/** 用系统默认程序打开本地文件 */
async function openLocalFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '用系统默认程序打开本地文件',
    properties: ['openFile'],
    defaultPath: WORK_DIR,
    filters: [{ name: '所有文件', extensions: ['*'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  await shell.openPath(result.filePaths[0]);
}
