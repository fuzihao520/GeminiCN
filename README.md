# Gemini 中文版（GeminiCN）

一个 Windows 桌面客户端：用系统自带的 **Microsoft Edge 内核**以“应用窗口”方式打开 Gemini，
默认简体中文，数据全部放在程序目录里，绿色免安装。

## 为什么做这个

Google 的 Gemini 网页版没有官方中文客户端，浏览器里用又总觉得“不像个软件”；
自己用 Electron 套壳时，Google 的登录页会直接返回
**“无法登录 · 此浏览器或应用可能不安全”**。

排查过程（可复现）：

| 客户端 | 提交账号后 |
| --- | --- |
| Electron 原生身份 | 拦（`/v3/signin/rejected`） |
| Electron 伪装 Chrome（UA + `sec-ch-ua*` + JS 指纹全对齐） | 拦 |
| Electron 伪装 Edge（版本号与内置 Chromium 对齐） | 拦 |
| 真实 Chrome（同 IP、同随机邮箱） | 放行 |
| **真实 Edge（系统自带）** | **放行** |

原因是 Google 校验的是浏览器构建本身：真 Chrome 会带一个 Electron 无法生成的
`x-browser-validation` 签名，所以“伪装浏览器”这条路走不通，只有真实浏览器能过。

结论：客户端不再自造浏览器内核，直接驱动本机真实的 Edge，
用 `--app` 模式开一个无地址栏窗口，配合**程序目录内的独立配置文件**，
既拿到了真实浏览器身份，又保证数据随程序走。

## 功能

- 真实 Edge 内核，Google 登录可用（不需要装 Chrome、不需要导入 Cookie）
- 默认简体中文：`--lang=zh-CN` + `?hl=zh-CN` + Edge 配置 `zh-CN`
- 便携数据：`data\edge-profile` 存 Cookie / 登录态 / 缓存，不写 C 盘、不污染日常浏览器
- 下载目录固定在 `data\工作文件夹\下载`
- 网络状态：启动检测 + 每 10 分钟检测；窗口右下角先弹出口地区提示（绿=支持 / 红=不支持，10 秒自动消失，`settings.regionTipSeconds` 可调），随后只保留延迟小条（延迟数字 + 4 格信号，绿<150ms / 橙 150–400ms / 红>400ms，20 秒刷新；鼠标穿透不挡操作）
- 出口 IP 属地中文显示（ip-api 优先，国内接口兜底）
- 账号记忆：多账号保存，点一下自动打开登录页并填写邮箱/密码（验证码仍由本人完成）；密码用 Windows DPAPI 加密，可删除
- 托盘常驻、单实例、关于对话框显示真实路径
- exe 与托盘使用官方 Gemini 客户端原生图标（多尺寸 ico，取自官方安装包资源，版权归 Google，仅个人自用）
- 运行日志 `data\debug.log`，出问题可直接看

## 运行（源码方式）

```bash
npm install
npm start          # 启动（入口 edge-main.js）
npm run pack       # 打包到 dist/GeminiCN-win32-x64
```

要求：Windows 10/11 x64，已安装 Microsoft Edge（系统自带）。

## 目录结构

```
edge-main.js            启动器主进程：找 Edge、起窗口、托盘、网络检测、账号记忆、右下角小条
auto-login.js           账号自动填写（本机 CDP 驱动真实 Edge 的登录表单，不碰验证码）
netcheck.js             网络与出口 IP 属地检测、延迟采样
geo-zh.js               境外地名中文化
regions.js              出口国家 → Google AI 支持/不支持判断
accounts.js             账号存储（DPAPI 加密）
account-manager.html    账号管理窗口
preload-manager.js      账号管理窗口的预加载脚本
status.html             右下角常驻延迟小条（延迟数字 + 4 格信号 + 蚂蚁线）
toast.html              出口地区提示（绿=支持 / 红=不支持，10 秒自动消失）
assets/                 图标（官方 Gemini 原生图标 + 自制矢量备份）
tools/                  排查用探针脚本（登录拦截、浏览器身份、指纹对比）
使用说明.md             面向使用者的完整说明
```

历史实现（Electron 自造内核、登录必被 Google 拦截）未纳入本仓库，
相关内容保留在本地 `源码` 目录的 `main.js` / `identity.js` / `offline.html`，仅作排查记录。

## 已知边界

- 需要本机装了 Edge；没装会提示去官网安装（不会自动下载）
- 不代填账号密码、不绕过验证码和二次验证
- 登录能否通过最终取决于 Google 对 IP / 设备的风控，机房 IP 被标记时真浏览器也会被拦
- 本机若 Edge 版本较旧（如 92），功能正常但建议用 Windows 更新升级

## 风险与免责

- 本项目是个人自用工具的浏览器外壳，不做指纹伪装、不破解任何校验
- 使用第三方节点访问 Google 需自行遵守所在地法律法规与 Google 服务条款
- 账号安全由使用者自负；建议不要多账号高频切换

## 作者

付自晧　微信：Fuzihao2050　QQ：20514365　广告人之家：ggrzj.cn

## 许可

MIT License，见 [LICENSE](LICENSE)。
