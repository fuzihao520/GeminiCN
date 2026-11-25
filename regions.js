'use strict';

/**
 * 出口地区是否属于 Google AI / Gemini 可用地区
 * ---------------------------------------------------------------
 * 只做界面提示用的粗略判断：以“明确不支持”的地区名单为准，
 * 其余一律按可用处理（避免误报把正常节点标成红）。
 * 名单依据 Google 官方长期不提供 Google AI 服务的地区，仅作提示，
 * 真正能否使用以 Gemini 页面实际表现为准。
 */

const UNSUPPORTED = {
  CN: '中国大陆',
  IR: '伊朗',
  KP: '朝鲜',
  SY: '叙利亚',
  CU: '古巴',
  RU: '俄罗斯',
};

/** 按属地判断 */
function judge(location) {
  if (!location) {
    return { supported: null, level: 'unknown', text: '出口地区未知' };
  }

  const code = String(location.countryCode || '').toUpperCase();
  const country = String(location.country || '').trim();

  // 没有国家代码时用中文/英文国名兜底
  let matched = null;
  if (code && UNSUPPORTED[code]) matched = UNSUPPORTED[code];
  if (!matched && country) {
    for (const [, name] of Object.entries(UNSUPPORTED)) {
      if (country.includes(name)) {
        matched = name;
        break;
      }
    }
  }
  if (!matched && /China|China Mainland/i.test(country)) matched = '中国大陆';

  const label = country || matched || '未知地区';
  if (matched) {
    return { supported: false, level: 'bad', text: `${label} · Google AI 不支持地区` };
  }
  return { supported: true, level: 'ok', text: `${label} · Google AI 可用地区` };
}

module.exports = { judge, UNSUPPORTED };
