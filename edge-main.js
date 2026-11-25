'use strict';

/**
 * Gemini 中文版 · Edge 内核版
 * ---------------------------------------------------------------
 * 为什么不用 Electron 内核直接开 Google 登录页：
 * Google 对嵌入式浏览器（Electron / WebView）一律返回
 * “此浏览器或应用可能不安全”，UA、客户端提示、JS 指纹全对齐也过不去，
 * 因为真正被校验的是浏览器构建本身。实测：真实 Edge 提交账号直接放行。
 *
 * 所以这个版本的做法是：
 *   1) 用本机真实的 Edge 以「应用窗口」模式打开 Gemini（没有地址栏、没有标签页，像客户端）；
 *   2) 独立配置文件放在程序目录内，Cookie/登录态随程序走，不碰你日常用的 Edge；
 *   3) 本进程只做启动器：托盘、中文、网络绿/红提示、账号记忆、路径随程序。
 *
 * 不安装 Chrome、不导入 Cookie、不做任何浏览器指纹伪装。
 */

const { app, BrowserWindow, Tray, Menu, Notification, dialog, shell, ipcMain, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const netcheck = require('./netcheck');
const regions = require('./regions');
const { createAccountStore } = require('./accounts');
const autoLogin = require('./auto-login');
const netMod = require('node:net');

// ---------------------------------------------------------------
// 路径：一律跟着程序走（exe 在哪个盘、哪个目录，数据就在它旁边）
// ---------------------------------------------------------------
const APP_ROOT = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
const DATA_ROOT = path.join(APP_ROOT, 'data');
const EDGE_PROFILE = path.join(DATA_ROOT, 'edge-profile');
const WORK_DIR = path.join(DATA_ROOT, '工作文件夹');
const DOWNLOAD_DIR = path.join(WORK_DIR, '下载');
const SETTINGS_FILE = path.join(DATA_ROOT, 'settings.json');
const LOG_FILE = path.join(DATA_ROOT, 'debug.log');

app.setPath('userData', path.join(DATA_ROOT, 'appdata'));

// 只允许单实例
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------------------------------------------------------------
// 设置
// ---------------------------------------------------------------
const DEFAULT_SETTINGS = {
  lang: 'zh',
  windowSize: { width: 1280, height: 880 },
  checkIntervalMin: 10,
  firstRunDone: false,
  showStatusWidget: true,
  regionTipSeconds: 10,
};

let settings = { ...DEFAULT_SETTINGS };

function ensureDirs() {
  for (const dir of [DATA_ROOT, EDGE_PROFILE, WORK_DIR, DOWNLOAD_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
}

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch {}
}

function logDebug(message) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {}
}

// ---------------------------------------------------------------
// 找 Edge：优先系统安装目录，其次注册表 App Paths
// ---------------------------------------------------------------
function findEdge() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];

  for (const file of candidates) {
    try {
      if (file && fs.existsSync(file)) return file;
    } catch {}
  }

  // 注册表兜底
  const regPaths = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
  ];
  for (const key of regPaths) {
    try {
      const out = require('node:child_process')
        .execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', timeout: 5000 });
      const match = out.match(/REG_SZ\s+(.+?)\s*$/m);
      if (match && fs.existsSync(match[1])) return match[1].trim();
    } catch {}
  }
  return null;
}

/** 读 Edge 版本（取安装目录里最新的版本号文件夹） */
function edgeVersion(edgeExe) {
  try {
    const root = path.dirname(edgeExe);
    let best = null;
    for (const name of fs.readdirSync(root)) {
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(name)) continue;
      if (!best || Number(name.split('.')[0]) > Number(best.split('.')[0])) best = name;
    }
    return best || '未知';
  } catch {
    return '未知';
  }
}

// ---------------------------------------------------------------
// Edge 配置：中文界面、下载目录指向程序目录内
// ---------------------------------------------------------------
function prepareProfile() {
  const prefDir = path.join(EDGE_PROFILE, 'Default');
  fs.mkdirSync(prefDir, { recursive: true });
  const prefFile = path.join(prefDir, 'Preferences');

  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(prefFile, 'utf8')) || {};
  } catch {
    data = {};
  }

  // 界面语言：中文
  data.intl = { ...(data.intl || {}), accept_languages: 'zh-CN,zh,en', selected_languages: 'zh-CN' };

  // 下载目录：跟着程序走
  data.download = { ...(data.download || {}), default_directory: DOWNLOAD_DIR, prompt_for_download: false };
  data.savefile = { ...(data.savefile || {}), default_directory: DOWNLOAD_DIR };

  // 关闭“首次运行”类干扰
  data.edge = { ...(data.edge || {}) };

  // 上次是被任务管理器/托盘“退出”直接结束的，标记为正常退出，避免下次启动弹“恢复上次会话”
  data.profile = { ...(data.profile || {}), exit_type: 'Normal', exited_cleanly: true };

  try {
    fs.writeFileSync(prefFile, JSON.stringify(data), 'utf8');
  } catch (err) {
    logDebug(`prepareProfile failed: ${err?.message || err}`);
  }
}

// ---------------------------------------------------------------
// 启动 / 聚焦 Edge 应用窗口
// ---------------------------------------------------------------
let edgeProc = null;
let edgeExePath = null;
let launching = false;
let debugPort = null;

/** 在 127.0.0.1 上找一个空闲端口（只给本机自动填写用，不对外） */
function pickPort() {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const server = netMod.createServer();
      server.once('error', () => {
        server.close();
        if (port >= 27200) resolve(null);
        else tryPort(port + 1);
      });
      server.once('listening', () => {
        server.close(() => resolve(port));
      });
      server.listen(port, '127.0.0.1');
    };
    tryPort(27101);
  });
}

function geminiUrl() {
  return 'https://gemini.google.com/app?hl=zh-CN';
}

function signinUrl() {
  return (
    'https://accounts.google.com/ServiceLogin?hl=zh-CN&continue=' +
    encodeURIComponent('https://gemini.google.com/app')
  );
}

function edgeRunning() {
  return Boolean(edgeProc && edgeProc.exitCode === null);
}

async function launchEdge(url = geminiUrl()) {
  if (!edgeExePath) edgeExePath = findEdge();
  if (!edgeExePath) {
    dialog.showMessageBox({
      type: 'error',
      title: '没有找到 Microsoft Edge',
      message: '这台电脑上没找到 Microsoft Edge',
      detail: [
        '本方案的浏览器内核用的是系统自带的 Microsoft Edge（不是 Chrome）。',
        '',
        '请先安装或修复 Edge 后再打开：',
        '1) 开始菜单搜索「Microsoft Edge」看能否启动；',
        '2) 不能启动就到 https://www.microsoft.com/edge 重新安装；',
        '3) 装好后再运行本程序。',
      ].join('\n'),
      buttons: ['打开 Edge 下载页', '知道了'],
      defaultId: 0,
      cancelId: 1,
    }).then((res) => {
      if (res.response === 0) shell.openExternal('https://www.microsoft.com/edge').catch(() => {});
    });
    return false;
  }

  if (edgeRunning()) {
    activateEdge();
    return true;
  }

  launching = true;
  prepareProfile();

  // 本机调试端口：只用于“账号自动填写”，绑在 127.0.0.1，改变不了对外指纹
  debugPort = await pickPort();

  const size = settings.windowSize || DEFAULT_SETTINGS.windowSize;
  const args = [
    `--app=${url}`,
    `--user-data-dir=${EDGE_PROFILE}`,
    '--lang=zh-CN',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSplashScreen',
    '--disable-session-crashed-bubble',
    `--window-size=${size.width},${size.height}`,
  ];
  if (debugPort) args.push(`--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*');

  logDebug(`launch edge url=${url} debugPort=${debugPort || 'none'}`);

  try {
    edgeProc = spawn(edgeExePath, args, {
      cwd: APP_ROOT,
      detached: false,
      stdio: 'ignore',
    });
  } catch (err) {
    launching = false;
    logDebug(`launch edge failed: ${err?.message || err}`);
    dialog.showErrorBox('启动 Edge 失败', String(err?.message || err));
    return false;
  }

  logDebug(`edge launched pid=${edgeProc.pid} url=${url}`);

  edgeProc.on('exit', (code) => {
    logDebug(`edge exited code=${code}`);
    launching = false;
    edgeProc = null;
  });
  edgeProc.on('error', (err) => {
    launching = false;
    logDebug(`edge process error: ${err?.message || err}`);
  });

  setTimeout(() => {
    launching = false;
  }, 3000);

  return true;
}

/** 把已经运行的 Edge 窗口切到前台（用 WScript 按标题激活，不依赖额外依赖） */
function activateEdge() {
  const script =
    "$shell = New-Object -ComObject WScript.Shell; " +
    "if ($shell.AppActivate('Google Gemini') -or $shell.AppActivate('Google 账号') -or $shell.AppActivate('登录')) { exit 0 } else { exit 1 }";

  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { timeout: 8000, windowsHide: true },
    (err) => {
      if (err) {
        logDebug('activate edge failed, reopen');
        relaunchEdge();
      }
    }
  );
}

/** 完全重启 Edge（关掉用自己的 profile 起的进程树，再重新打开） */
async function relaunchEdge(url = geminiUrl()) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (edgeRunning() && edgeProc?.pid) {
    try {
      spawn('taskkill', ['/PID', String(edgeProc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {}
    edgeProc = null;
    await sleep(1600);
  }
  return launchEdge(url);
}

/**
 * 用已保存的账号打开登录页并自动填写邮箱/密码
 * 只填表单并点“下一步”，验证码、二次验证、设备确认一律留给本人手动完成。
 */
async function loginWithSavedAccount(id) {
  const account = accountStore.getAccount(id);
  if (!account) return { ok: false, message: '账号不存在' };

  accountStore.touch(id);

  try {
    require('electron').clipboard.writeText(account.email);
  } catch {}

  const password = accountStore.getPassword(id);
  await relaunchEdge(signinUrl());

  if (!debugPort) {
    showToast({ ok: false, text: '自动填写通道未就绪，已复制邮箱，请在登录页手动粘贴', duration: 10000 });
    return { ok: false, message: '自动填写通道未就绪，账号已复制到剪贴板' };
  }

  const result = await autoLogin.fillSignin({
    port: debugPort,
    email: account.email,
    password,
    log: (text) => logDebug(`auto-login: ${text}`),
  });

  logDebug(`auto-login result: ${JSON.stringify(result)}`);
  showToast({
    ok: Boolean(result.ok),
    text: result.ok ? `${account.email}：${result.message}` : `自动填写失败（${result.stage}）：${result.message}`,
    duration: result.ok ? 9000 : 14000,
  });

  return result;
}

// ---------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------
let tray = null;

function trayImage() {
  const ico = path.join(__dirname, 'assets', 'icon.ico');
  try {
    if (fs.existsSync(ico)) return nativeImage.createFromPath(ico);
  } catch {}
  return nativeImage.createEmpty();
}

function buildTrayMenu() {
  const accounts = accountStore.list();

  const accountItems = accounts.accounts.length
    ? accounts.accounts.map((acc) => ({
        label: acc.email,
        click: () => {
          loginWithSavedAccount(acc.id);
        },
      }))
    : [{ label: '（还没有保存的账号）', enabled: false }];

  return Menu.buildFromTemplate([
    { label: '打开 Gemini', click: () => launchEdge(geminiUrl()) },
    { label: '重新加载窗口', click: () => relaunchEdge(geminiUrl()) },
    { type: 'separator' },
    { label: '登录 Google 账号', click: () => launchEdge(signinUrl()) },
    {
      label: '账号记忆',
      submenu: [
        ...accountItems,
        { type: 'separator' },
        { label: '管理账号…', click: () => openAccountManager() },
      ],
    },
    { type: 'separator' },
    {
      label: netState ? `网络状态：${netState.ok ? '正常' : '受限'}` : '网络状态：检测中…',
      enabled: false,
    },
    { label: '检查网络状态（看详情）', click: () => checkNetworkNow(true) },
    {
      label: settings.showStatusWidget ? '隐藏右下角状态条' : '显示右下角状态条',
      click: () => {
        settings.showStatusWidget = !settings.showStatusWidget;
        saveSettings();
        if (!settings.showStatusWidget) hideStatusWidget();
        else refreshStatusWidget();
        refreshTray();
      },
    },
    {
      label: '打开工作文件夹',
      click: () => shell.openPath(WORK_DIR).catch(() => {}),
    },
    {
      label: '打开下载文件夹',
      click: () => shell.openPath(DOWNLOAD_DIR).catch(() => {}),
    },
    { type: 'separator' },
    { label: '关于 / 路径', click: () => showAbout() },
    { label: '退出', click: () => quitApp() },
  ]);
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function setupTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Gemini 中文版（Edge 内核）');
  refreshTray();
  tray.on('click', () => {
    if (edgeRunning()) activateEdge();
    else launchEdge();
  });
}

// ---------------------------------------------------------------
// 关于
// ---------------------------------------------------------------
function showAbout() {
  const edgeVer = edgeExePath ? edgeVersion(edgeExePath) : '未找到';
  dialog.showMessageBox({
    type: 'info',
    title: '关于 Gemini 中文版',
    message: 'Gemini 中文版（Edge 内核）',
    detail: [
      `版本：${app.getVersion()}`,
      `浏览器内核：Microsoft Edge ${edgeVer}（真实浏览器，Google 登录不会被判不安全）`,
      '',
      `程序目录：${APP_ROOT}`,
      `数据目录：${DATA_ROOT}`,
      `配置文件：${EDGE_PROFILE}`,
      `下载目录：${DOWNLOAD_DIR}`,
      '',
      '数据全部在程序目录内，不会写 C 盘，卸载时删掉整个文件夹即可。',
      '',
      '作者：付自晧  微信：Fuzihao2050  QQ：20514365',
      '广告人之家：ggrzj.cn',
    ].join('\n'),
    buttons: ['知道了'],
  });
}

// ---------------------------------------------------------------
// 账号记忆
// ---------------------------------------------------------------
const accountStore = createAccountStore(path.join(DATA_ROOT, 'accounts.json'));

let managerWindow = null;

function openAccountManager() {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.show();
    managerWindow.focus();
    return;
  }

  managerWindow = new BrowserWindow({
    width: 820,
    height: 640,
    minWidth: 720,
    minHeight: 520,
    title: '账号记忆 · Gemini 中文版',
    backgroundColor: '#f6f7fb',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-manager.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  managerWindow.loadFile(path.join(__dirname, 'account-manager.html'));
  managerWindow.on('closed', () => {
    managerWindow = null;
  });
}

function registerAccountIpc() {
  ipcMain.handle('accounts:list', () => accountStore.list());

  ipcMain.handle('accounts:upsert', (_event, payload = {}) => {
    try {
      const result = accountStore.upsert({
        email: payload.email,
        password: payload.password || '',
        rememberPassword: payload.rememberPassword !== false,
      });
      refreshTray();
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, message: String(err?.message || err) };
    }
  });

  ipcMain.handle('accounts:remove', (_event, id) => {
    const result = accountStore.remove(id);
    refreshTray();
    return { ok: true, data: result };
  });

  ipcMain.handle('accounts:remember', (_event, value) => {
    const result = accountStore.setRememberPassword(Boolean(value));
    refreshTray();
    return { ok: true, data: result };
  });

  ipcMain.handle('accounts:login', async (_event, id) => {
    const result = await loginWithSavedAccount(id);
    return { ok: true, message: result.message || '' };
  });

  ipcMain.handle('manager:close', () => {
    if (managerWindow && !managerWindow.isDestroyed()) managerWindow.close();
  });

  ipcMain.handle('manager:open-workdir', () => {
    shell.openPath(WORK_DIR).catch(() => {});
  });

  ipcMain.handle('manager:status', () => ({
    ok: Boolean(netState?.ok),
    text: netState?.summary?.text || '网络状态检测中…',
    safeMode: true,
  }));

  ipcMain.on('status:detail', () => checkNetworkNow(true));
}

// ---------------------------------------------------------------
// 原生提示条（绿色=正常，红色=受限），显示在屏幕右下角
// ---------------------------------------------------------------
let toastWindow = null;
let toastTimer = null;
let lastToastKey = '';
let lastToastAt = 0;

function closeToast() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  if (toastWindow && !toastWindow.isDestroyed()) toastWindow.close();
  toastWindow = null;
}

function showToast({ ok, text, duration, aboveLatency = false }) {
  closeToast();

  const width = 430;
  const height = 50;
  const pos = anchorBottomRight(width, height, 12, aboveLatency ? 52 : 10);

  toastWindow = new BrowserWindow({
    width,
    height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  toastWindow.loadFile(path.join(__dirname, 'toast.html'), {
    search: new URLSearchParams({
      ok: ok ? '1' : '0',
      text,
      duration: String(duration),
    }).toString(),
  });
  toastWindow.once('ready-to-show', () => {
    try {
      toastWindow?.showInactive();
    } catch {}
  });

  toastTimer = setTimeout(() => closeToast(), duration + 600);
}

function showStatusToast(force = false) {
  if (!netState) return;
  const key = `${netState.ok ? 'ok' : 'bad'}|${netState.summary?.text || ''}`;
  const now = Date.now();
  if (!force && key === lastToastKey && now - lastToastAt < 60000) return;
  lastToastKey = key;
  lastToastAt = now;

  showToast({
    ok: Boolean(netState.ok),
    text: netState.summary?.text || '',
    duration: netState.ok ? 8000 : 14000,
  });
  logDebug(`toast: ${netState.summary?.text || ''}`);
}

// ---------------------------------------------------------------
// 右下角常驻状态条：左＝出口地区是否支持（几秒），右＝延迟 + 信号（常驻）
// ---------------------------------------------------------------
let statusWindow = null;
let statusReady = false;
let statusFollowTimer = null;
let latencySamples = null;

function statusBarSize() {
  return { width: 150, height: 42 };
}

/** 以 Edge 窗口右下角为锚点算窗口位置（取不到窗口就退回屏幕右下角） */
function anchorBottomRight(width, height, gapX = 12, gapY = 10) {
  const area = require('electron').screen.getPrimaryDisplay().workArea;
  const rect = cachedEdgeRect;
  if (rect && rect.width > 700 && rect.height > 400) {
    return {
      x: Math.round(rect.right - width - gapX),
      y: Math.round(rect.bottom - height - gapY),
    };
  }
  return {
    x: Math.round(area.x + area.width - width - gapX),
    y: Math.round(area.y + area.height - height - gapY),
  };
}

/** 算出状态条该贴的位置：优先贴 Edge 窗口右下角，取不到就贴屏幕右下角 */
function placeStatusWindow(win) {
  const size = statusBarSize();
  const pos = anchorBottomRight(size.width, size.height, 12, 10);
  win.setBounds({ ...pos, ...size });
}

/** 用 Win32 取 Edge 应用窗口的屏幕矩形（异步，结果写进缓存，避免阻塞主进程） */
let cachedEdgeRect = null;
let rectBusy = false;

function refreshEdgeRect(callback) {
  if (rectBusy) return;
  rectBusy = true;

  const script = [
    '$sig = @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    'public class WinRect {',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
    '}',
    '"@',
    'Add-Type -TypeDefinition $sig',
    '$p = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and -not [WinRect]::IsIconic($_.MainWindowHandle) } | Select-Object -First 1',
    'if ($p) { $r = New-Object RECT; [WinRect]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null; "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)" }',
  ].join('\r\n');

  require('node:child_process').execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 6000, windowsHide: true, encoding: 'utf8' },
    (err, stdout) => {
      rectBusy = false;
      if (!err && stdout) {
        const parts = String(stdout).trim().split(',').map((n) => Number(n));
        if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
          const [left, top, right, bottom] = parts;
          if (right > left && bottom > top) {
            cachedEdgeRect = { left, top, right, bottom, width: right - left, height: bottom - top };
          }
        }
      }
      if (typeof callback === 'function') callback(cachedEdgeRect);
    }
  );
}

function createStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) return statusWindow;

  const size = statusBarSize();
  const pos = anchorBottomRight(size.width, size.height, 12, 10);

  statusWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 不拦截鼠标：贴在页面右下角也不影响点页面上的按钮
  try {
    statusWindow.setIgnoreMouseEvents(true);
  } catch {}

  statusReady = false;
  statusWindow.setAlwaysOnTop(true, 'floating');
  statusWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  statusWindow.loadFile(path.join(__dirname, 'status.html'));
  statusWindow.webContents.once('did-finish-load', () => {
    statusReady = true;
    applyStatusContent();
    try {
      statusWindow?.showInactive();
    } catch {}
  });
  statusWindow.on('closed', () => {
    statusWindow = null;
    statusReady = false;
  });

  // 跟着 Edge 窗口走：Edge 移动/最大化后状态条仍贴在窗口右下角
  if (statusFollowTimer) clearInterval(statusFollowTimer);
  const follow = () => {
    refreshEdgeRect(() => {
      if (statusWindow && !statusWindow.isDestroyed()) placeStatusWindow(statusWindow);
    });
  };
  statusFollowTimer = setInterval(follow, 5000);
  follow();

  return statusWindow;
}

function statusScript(expr) {
  if (!statusReady || !statusWindow || statusWindow.isDestroyed()) return;
  statusWindow.webContents.executeJavaScript(expr).catch(() => {});
}

/** 只推延迟数据给右下角的小条（地区提示改走独立提示窗） */
function applyStatusContent() {
  const lat = latencySamples;
  const level = lat?.level || 'bad';
  const text = lat?.ok ? `${lat.avg} ms` : '超时';
  statusScript(`window.setLatency(${JSON.stringify(level)}, ${JSON.stringify(text)})`);
}

/** 出口地区提示：独立小窗显示约 10 秒后自动消失，贴在窗口右下角上方 */
function showRegionTip() {
  const region = netState?.region;
  if (!region || !region.text) return;

  const ok = region.level === 'ok';
  const duration = Math.max(3, Number(settings.regionTipSeconds) || 10) * 1000;

  const draw = (tries = 2) => {
    // 先确保拿到 Edge 窗口位置，避免提示跑到屏幕角落
    refreshEdgeRect(() => {
      if (!cachedEdgeRect && tries > 0) {
        setTimeout(() => draw(tries - 1), 1200);
        return;
      }
      showToast({ ok, text: region.text, duration, aboveLatency: true });
    });
  };

  setTimeout(() => draw(2), 800);
}

function refreshStatusWidget() {
  // 老配置文件里没有这一项，按“显示”处理
  if (settings.showStatusWidget === false) {
    hideStatusWidget();
    return;
  }
  const win = createStatusWindow();
  if (!win) return;
  placeStatusWindow(win);
  if (statusReady) applyStatusContent();
  else if (!win.isVisible()) {
    setTimeout(() => {
      try {
        win?.showInactive();
      } catch {}
    }, 500);
  }
  if (!win.isVisible()) {
    try {
      win.showInactive();
    } catch {}
  }
}

function hideStatusWidget() {
  if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide();
}

/** 延迟轮询：20 秒一次，更新数值与信号颜色 */
let latencyTimer = null;

async function pollLatency() {
  try {
    latencySamples = await netcheck.measureLatency(3);
    applyStatusContent();
  } catch (err) {
    logDebug(`latency failed: ${err?.message || err}`);
  }
}

function scheduleLatency() {
  if (latencyTimer) clearInterval(latencyTimer);
  pollLatency();
  latencyTimer = setInterval(pollLatency, 20000);
}

// ---------------------------------------------------------------
// 网络状态检测
// ---------------------------------------------------------------
let netState = null;
let netTimer = null;
let lastOk = null;

async function runNetworkCheck() {
  try {
    const result = await netcheck.check();
    const region = regions.judge(result.location);
    netState = { ...result, region, summary: netcheck.summarize(result) };
    fs.writeFileSync(
      path.join(DATA_ROOT, 'net-status.json'),
      JSON.stringify({ ...result, summary: netState.summary }, null, 2),
      'utf8'
    );

    // 出口地区提示：每次检测都弹一次（约 10 秒自动消失）；状态异常时另外补系统通知
    if (lastOk !== null && lastOk !== netState.ok && !netState.ok) {
      try {
        new Notification({
          title: 'Gemini 中文版 · 网络提醒',
          body: netState.summary.text,
        }).show();
      } catch {}
    }
    lastOk = netState.ok;
    refreshStatusWidget();
    showRegionTip();
    try {
      tray?.setToolTip(`Gemini 中文版 · ${netState.summary?.text || ''}`);
    } catch {}
    refreshTray();
  } catch (err) {
    logDebug(`netcheck failed: ${err?.message || err}`);
  }
}

function scheduleNetworkCheck() {
  if (netTimer) clearInterval(netTimer);
  netTimer = setInterval(runNetworkCheck, Math.max(3, settings.checkIntervalMin || 10) * 60 * 1000);
}

async function checkNetworkNow(showDialog = false) {
  await runNetworkCheck();
  if (showDialog) {
    dialog.showMessageBox({
      type: netState?.ok ? 'info' : 'warning',
      title: '网络状态',
      message: netState?.summary?.text || '检测失败',
      detail: netState?.summary?.detail || '',
      buttons: ['知道了'],
    });
  }
}

// ---------------------------------------------------------------
// 退出
// ---------------------------------------------------------------
let quitting = false;

function quitApp() {
  quitting = true;
  if (netTimer) clearInterval(netTimer);
  if (latencyTimer) clearInterval(latencyTimer);
  if (statusFollowTimer) clearInterval(statusFollowTimer);
  if (edgeRunning() && edgeProc?.pid) {
    try {
      spawn('taskkill', ['/PID', String(edgeProc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {}
  }
  closeToast();
  if (statusWindow && !statusWindow.isDestroyed()) statusWindow.destroy();
  if (managerWindow && !managerWindow.isDestroyed()) managerWindow.destroy();
  app.quit();
}

// ---------------------------------------------------------------
// 启动流程
// ---------------------------------------------------------------
app.on('second-instance', () => {
  if (edgeRunning()) activateEdge();
  else launchEdge();
});

app.whenReady().then(async () => {
  ensureDirs();
  loadSettings();
  accountStore.ensureFile();
  edgeExePath = findEdge();
  logDebug(`app root=${APP_ROOT} edge=${edgeExePath || '未找到'} ver=${edgeExePath ? edgeVersion(edgeExePath) : '-'}`);

  setupTray();
  registerAccountIpc();

  if (app.isPackaged) app.setAppUserModelId('cn.ggrzj.gemini');

  // 首次运行给一个说明，避免用户以为没有窗口就是没启动
  if (!settings.firstRunDone) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Gemini 中文版 使用说明',
      message: '这个版本用系统自带的 Microsoft Edge 内核打开 Gemini',
      detail: [
        '为什么这样做：Google 会把 Electron/嵌入式浏览器判成“此浏览器或应用可能不安全”，',
        '只有真实浏览器能通过。实测真实 Edge 可以直接登录，所以这里不再伪装浏览器身份。',
        '',
        '你要知道的几件事：',
        '1) 登录就在打开的那个窗口里做，不安装 Chrome、不导入 Cookie；',
        '2) 它的配置和 Cookie 都在程序目录的 data\\edge-profile 里，和你日常用的 Edge 互不影响；',
        '3) 关掉窗口后程序仍在托盘运行，右键托盘图标可以重新打开、管理账号、检查网络；',
        '4) 数据全部随程序目录走，不写 C 盘。',
      ].join('\n'),
      buttons: ['知道了'],
    }).then(() => {
      settings.firstRunDone = true;
      saveSettings();
    });
  }

  launchEdge(geminiUrl());
  refreshStatusWidget();
  runNetworkCheck();
  scheduleNetworkCheck();
  scheduleLatency();
});

app.on('window-all-closed', () => {
  // 托盘常驻：窗口全关不退出，只有托盘「退出」才真正结束
  logDebug('all windows closed, keep tray');
});

app.on('before-quit', () => {
  quitting = true;
  try {
    if (edgeRunning() && edgeProc?.pid) {
      spawn('taskkill', ['/PID', String(edgeProc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
  } catch {}
});
