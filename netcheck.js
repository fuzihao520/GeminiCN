'use strict';

/**
 * 网络状态检测
 * ---------------------------------------------------------------
 * 1) 用 Chromium 网络栈（会自动走系统代理）探测 Google / Gemini 是否可达；
 * 2) 探测出口公网 IP，并查询其真实属地（国家、省、市、运营商）；
 * 3) 输出可直接用于界面提示的结构化结果。
 */

const { net } = require('electron');
const { localizeLocation } = require('./geo-zh');

const DEFAULT_TIMEOUT = 8000;

/** 轻量 GET，带超时与长度上限 */
function httpGet(url, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let request;
    const timer = setTimeout(() => {
      try {
        request?.abort();
      } catch {}
      done({ ok: false, status: 0, body: '', error: 'timeout' });
    }, timeout);

    try {
      request = net.request({ url, method: 'GET', redirect: 'follow' });
      request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      request.setHeader('Accept-Language', 'zh-CN,zh;q=0.9');
    } catch (err) {
      clearTimeout(timer);
      return done({ ok: false, status: 0, body: '', error: String(err) });
    }

    request.on('response', (response) => {
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length <= 256 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        clearTimeout(timer);
        done({
          ok: true,
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          error: null,
        });
      });
      response.on('error', () => {
        clearTimeout(timer);
        done({ ok: false, status: 0, body: '', error: 'response-error' });
      });
    });

    request.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, status: 0, body: '', error: String(err) });
    });

    request.end();
  });
}

/** 探测 Google 系站点是否可达 */
async function probeSites() {
  const targets = [
    { key: 'google', name: 'Google 基础连通', url: 'https://www.google.com/generate_204', timeout: 6000 },
    { key: 'accounts', name: 'Google 登录页', url: 'https://accounts.google.com/', timeout: 8000 },
    { key: 'gemini', name: 'Gemini 站点', url: 'https://gemini.google.com/app?hl=zh-CN', timeout: 8000 },
  ];

  const results = await Promise.all(
    targets.map(async (target) => {
      const startedAt = Date.now();
      const response = await httpGet(target.url, { timeout: target.timeout });
      const latency = Date.now() - startedAt;
      // 有 HTTP 响应即说明链路可达（401/403 等是服务端策略，不是断网）
      const reachable = response.ok && response.status > 0 && response.status < 500;
      return {
        key: target.key,
        name: target.name,
        reachable,
        status: response.status,
        latency,
        error: response.error || (reachable ? null : `HTTP ${response.status}`),
      };
    })
  );

  const byKey = Object.fromEntries(results.map((r) => [r.key, r]));
  return {
    sites: results,
    online: byKey.google?.reachable && byKey.gemini?.reachable,
    canSignIn: Boolean(byKey.accounts?.reachable),
    latency: byKey.google?.latency ?? null,
  };
}

/** 解析 myip.ipip.net 的纯文本返回 */
function parseIpip(text) {
  const ipMatch = text.match(/当前\s*IP[：:]\s*([0-9a-fA-F.:]+)/) || text.match(/(\d+\.\d+\.\d+\.\d+)/);
  const areaMatch = text.match(/来自于[：:]\s*(.+)/);
  const ip = ipMatch ? ipMatch[1] : null;
  const area = areaMatch ? areaMatch[1].trim() : null;
  if (!ip) return null;

  const parts = (area || '').split(/\s+/).filter(Boolean);
  return {
    ip,
    country: parts[0] || null,
    region: parts[1] || null,
    city: parts[2] || null,
    isp: parts.slice(3).join(' ') || null,
    source: 'myip.ipip.net',
  };
}

/** 解析 ip-api.com / ip.sb 的 JSON 返回 */
function parseJsonGeo(body, source) {
  try {
    const data = JSON.parse(body);
    if (!data) return null;
    const ip = data.query || data.ip || null;
    if (!ip) return null;
    return {
      ip,
      country: data.country || data.country_name || null,
      countryCode: data.countryCode || data.country_code || null,
      region: data.regionName || data.region || null,
      city: data.city || null,
      isp: data.isp || data.org || data.connection?.isp || null,
      source,
    };
  } catch {
    return null;
  }
}

/** 多源查询出口 IP 属地：优先“Google 线路”上的境外接口，再用国内接口兜底 */
async function lookupIpLocation() {
  const foreignProviders = [
    {
      name: 'ip-api.com',
      // lang=zh-CN 直接返回中文国家/州/城市
      url: 'http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,isp,query&lang=zh-CN',
      parse: (res) => parseJsonGeo(res.body, 'ip-api.com'),
    },
    {
      name: 'ip.sb',
      url: 'https://api.ip.sb/geoip',
      parse: (res) => parseJsonGeo(res.body, 'ip.sb'),
    },
    {
      name: 'ipinfo.io',
      url: 'https://ipinfo.io/json',
      parse: (res) => {
        try {
          const data = JSON.parse(res.body);
          return data?.ip
            ? { ip: data.ip, country: data.country, region: data.region, city: data.city, isp: data.org, source: 'ipinfo.io' }
            : null;
        } catch {
          return null;
        }
      },
    },
  ];

  const domesticProviders = [
    {
      name: 'myip.ipip.net',
      url: 'https://myip.ipip.net/',
      parse: (res) => parseIpip(res.body),
    },
  ];

  async function firstSuccess(providers) {
    for (const provider of providers) {
      const response = await httpGet(provider.url, { timeout: 5000 });
      if (!response.ok || !response.body) continue;
      const parsed = provider.parse(response);
      if (parsed?.ip) return localizeLocation(parsed);
    }
    return null;
  }

  const [foreign, domestic] = await Promise.all([
    firstSuccess(foreignProviders),
    firstSuccess(domesticProviders),
  ]);

  return {
    // 境外接口在代理链路上通常与 Google 同一条线路，优先作为“出口 IP”
    primary: foreign || domestic,
    foreign,
    domestic,
  };
}

/** 判断属地是否在中国大陆 */
function isMainland(location) {
  if (!location) return null;
  const country = (location.country || '').trim();
  if (!country) return null;
  if (/中国|China|CN/i.test(country)) {
    // 港澳台单列，避免误判
    const region = (location.region || '').trim();
    if (/香港|澳门|臺灣|台湾|Hong Kong|Macau|Macao|Taiwan/i.test(region)) return false;
    return true;
  }
  return false;
}

/** 组装一条人类可读的属地描述 */
function describeLocation(location) {
  if (!location) return '未知（属地查询失败）';
  const parts = [location.country, location.region, location.city, location.isp].filter(Boolean);
  return parts.length ? parts.join(' · ') : '未知';
}

/**
 * 完整检测
 * @returns {Promise<object>} 结构化状态
 */
async function check() {
  const startedAt = Date.now();
  const [sites, geo] = await Promise.all([probeSites(), lookupIpLocation()]);

  const location = geo.primary;
  const mainland = isMainland(location);
  const ok = sites.online && sites.canSignIn;

  return {
    ok,
    sites,
    location,
    localLocation: geo.domestic,
    mainland,
    locationText: describeLocation(location),
    ip: location?.ip || null,
    checkedAt: new Date().toISOString(),
    elapsed: Date.now() - startedAt,
  };
}

/** 生成界面用的简短提示文案 */
function summarize(result) {
  const localLine = result.localLocation
    ? `本地直连 IP：${result.localLocation.ip}（${describeLocation(result.localLocation)}）`
    : '';

  if (result.ok) {
    return {
      ok: true,
      text: `网络正常 · 出口 IP：${result.locationText}`,
      detail: [
        '可以正常访问 Google 与 Gemini',
        `出口 IP：${result.ip || '未知'}（${result.locationText}）`,
        localLine,
        result.mainland ? '提示：出口属地显示在大陆，但当前链路能访问 Google，说明走了专线/透明代理。' : '',
        `检测时间：${new Date(result.checkedAt).toLocaleString('zh-CN')}`,
      ].filter(Boolean).join('\n'),
    };
  }

  const reason = result.mainland
    ? '当前出口 IP 属于中国大陆，Google 登录与 Gemini 一般无法直接访问。'
    : '当前链路访问 Google 失败，可能是代理未开启、代理超时或本地网络受限。';

  return {
    ok: false,
    text: `网络受限 · 出口 IP：${result.locationText}`,
    detail: [
      reason,
      `出口 IP：${result.ip || '未知'}（${result.locationText}）`,
      localLine,
      `Google 连通：${result.sites.online ? '正常' : '失败'} / 登录页：${result.sites.canSignIn ? '正常' : '失败'}`,
      `检测时间：${new Date(result.checkedAt).toLocaleString('zh-CN')}`,
    ].filter(Boolean).join('\n'),
  };
}

/**
 * 延迟采样：多次请求 Google 的 generate_204，取平均/最小 RTT
 * 用于右下角“延迟 + 信号”指示（绿=畅通，橙=中等，红=繁忙）
 */
async function measureLatency(samples = 3) {
  const results = [];
  for (let i = 0; i < samples; i += 1) {
    const startedAt = Date.now();
    const response = await httpGet('https://www.google.com/generate_204', { timeout: 6000 });
    const rtt = Date.now() - startedAt;
    if (response.ok && response.status > 0) results.push(rtt);
    if (i < samples - 1) await new Promise((r) => setTimeout(r, 300));
  }

  if (!results.length) {
    return { ok: false, avg: null, min: null, max: null, samples: [], level: 'bad' };
  }

  const min = Math.min(...results);
  const max = Math.max(...results);
  const avg = Math.round(results.reduce((a, b) => a + b, 0) / results.length);
  const level = avg < 150 ? 'ok' : avg < 400 ? 'mid' : 'bad';
  return { ok: true, avg, min, max, samples: results, level };
}

module.exports = { check, summarize, describeLocation, measureLatency };
