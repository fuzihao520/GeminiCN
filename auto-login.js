'use strict';

/**
 * 账号自动填写：通过 Chromium 调试协议（CDP）驱动真实 Edge 页面的登录表单。
 * 只做“把已保存的邮箱/密码填进输入框并点下一步”，不触碰验证码、二次验证、设备确认。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { method: 'GET' });
  return res.json();
}

/** 等到某个页面出现（按 URL 片段匹配） */
async function waitForTarget(port, urlPart, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await listTargets(port);
      const target = list.find((t) => t.type === 'page' && String(t.url || '').includes(urlPart));
      if (target?.webSocketDebuggerUrl) return target;
    } catch {}
    await sleep(700);
  }
  return null;
}

/** 极简 CDP 客户端 */
function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();

    ws.addEventListener('message', (event) => {
      let msg = null;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg?.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });

    ws.addEventListener('error', (err) => reject(err), { once: true });
    ws.addEventListener('open', () => {
      const send = (method, params = {}) =>
        new Promise((res) => {
          const id = ++seq;
          pending.set(id, res);
          ws.send(JSON.stringify({ id, method, params }));
        });

      const evaluate = async (expression) => {
        const reply = await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (reply?.result?.exceptionDetails) {
          return { ok: false, error: reply.result.exceptionDetails.text || 'eval-error' };
        }
        return { ok: true, value: reply?.result?.result?.value };
      };

      resolve({ send, evaluate, close: () => ws.close() });
    });
  });
}

const SEL_EMAIL = '#identifierId, input[name="identifier"], input[type="email"]';
const SEL_EMAIL_NEXT = '#identifierNext button, #identifierNext, button[jsname="V67aGc"]';
const SEL_PASS = 'input[type="password"][name="Passwd"], input[name="password"], input[type="password"]';
const SEL_PASS_NEXT = '#passwordNext button, #passwordNext, button[jsname="V67aGc"]';

/** 在页面内等到某元素出现 */
async function waitForElement(cdp, selector, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  const expr = `Boolean(document.querySelector(${JSON.stringify(selector)}))`;
  while (Date.now() < deadline) {
    const res = await cdp.evaluate(expr);
    if (res.ok && res.value) return true;
    await sleep(500);
  }
  return false;
}

/** 用原生 setter 写值并派发事件，避免 React/Google 受控组件接收不到 */
function fillScript(selector, value) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'no-element';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'filled';
  })()`;
}

function clickScript(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'no-element';
    el.click();
    return 'clicked';
  })()`;
}

/**
 * 打开登录页并填入账号（有密码就一起填）
 * @returns {Promise<{ok:boolean, stage:string, message:string}>}
 */
async function fillSignin({ port, email, password, log = () => {} }) {
  if (!email) return { ok: false, stage: 'input', message: '没有可填写的账号' };

  const target = await waitForTarget(port, 'accounts.google.com');
  if (!target) return { ok: false, stage: 'target', message: '没等到登录页，可能是 Edge 没起来或窗口还没加载完' };

  let cdp;
  try {
    cdp = await connectCdp(target.webSocketDebuggerUrl);
  } catch (err) {
    return { ok: false, stage: 'connect', message: `连不上窗口调试通道：${err?.message || err}` };
  }

  try {
    const hasEmail = await waitForElement(cdp, SEL_EMAIL, 15000);
    if (!hasEmail) return { ok: false, stage: 'email-field', message: '登录页没有出现邮箱输入框（可能停在别的页面）' };

    log(`fill email: ${email}`);
    const emailRes = await cdp.evaluate(fillScript(SEL_EMAIL, email));
    if (emailRes.value !== 'filled') return { ok: false, stage: 'email', message: '邮箱没有写进输入框' };

    await sleep(500);
    await cdp.evaluate(clickScript(SEL_EMAIL_NEXT));
    await sleep(3500);

    if (!password) {
      return { ok: true, stage: 'email-only', message: '邮箱已填入并点了下一步（没有保存密码，密码请手动输入）' };
    }

    const hasPass = await waitForElement(cdp, SEL_PASS, 15000);
    if (!hasPass) {
      return { ok: true, stage: 'email-only', message: '邮箱已填入；密码框没出现（可能需要验证码或账号确认，请手动继续）' };
    }

    await sleep(600);
    const passRes = await cdp.evaluate(fillScript(SEL_PASS, password));
    if (passRes.value !== 'filled') return { ok: false, stage: 'password', message: '密码没有写进输入框' };

    await sleep(400);
    await cdp.evaluate(clickScript(SEL_PASS_NEXT));
    await sleep(2500);

    return { ok: true, stage: 'password', message: '邮箱和密码都已填入并提交；如有验证码/设备确认请手动完成' };
  } finally {
    try {
      cdp.close();
    } catch {}
  }
}

module.exports = { fillSignin, waitForTarget };
