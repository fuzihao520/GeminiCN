'use strict';

/**
 * 地理名称中文化
 * ---------------------------------------------------------------
 * 优先用 ip-api.com 的中文返回；其它接口给英文时，
 * 用本地词典兜底翻译国家/州/城市，保证界面不出现英文地名。
 */

const COUNTRIES = {
  'United States': '美国', 'United States of America': '美国', US: '美国',
  China: '中国', CN: '中国',
  Japan: '日本', JP: '日本',
  'South Korea': '韩国', Korea: '韩国', KR: '韩国',
  Singapore: '新加坡', SG: '新加坡',
  'Hong Kong': '中国香港', HK: '中国香港',
  Macau: '中国澳门', Macao: '中国澳门', MO: '中国澳门',
  Taiwan: '中国台湾', TW: '中国台湾',
  Germany: '德国', DE: '德国',
  Netherlands: '荷兰', NL: '荷兰',
  France: '法国', FR: '法国',
  'United Kingdom': '英国', GB: '英国', UK: '英国',
  Canada: '加拿大', CA: '加拿大',
  Australia: '澳大利亚', AU: '澳大利亚',
  Russia: '俄罗斯', RU: '俄罗斯',
  India: '印度', IN: '印度',
  Brazil: '巴西', BR: '巴西',
  Thailand: '泰国', TH: '泰国',
  Malaysia: '马来西亚', MY: '马来西亚',
  Indonesia: '印度尼西亚', ID: '印度尼西亚',
  Philippines: '菲律宾', PH: '菲律宾',
  Vietnam: '越南', VN: '越南',
  'United Arab Emirates': '阿联酋', AE: '阿联酋',
  Turkey: '土耳其', TR: '土耳其',
  Israel: '以色列', IL: '以色列',
  Poland: '波兰', PL: '波兰',
  Sweden: '瑞典', SE: '瑞典',
  Switzerland: '瑞士', CH: '瑞士',
  Spain: '西班牙', ES: '西班牙',
  Italy: '意大利', IT: '意大利',
  Ireland: '爱尔兰', IE: '爱尔兰',
  Finland: '芬兰', FI: '芬兰',
  Norway: '挪威', NO: '挪威',
  Denmark: '丹麦', DK: '丹麦',
  Austria: '奥地利', AT: '奥地利',
  Belgium: '比利时', BE: '比利时',
  'Czech Republic': '捷克', Czechia: '捷克', CZ: '捷克',
  Ukraine: '乌克兰', UA: '乌克兰',
  Mexico: '墨西哥', MX: '墨西哥',
  Argentina: '阿根廷', AR: '阿根廷',
  Chile: '智利', CL: '智利',
  Colombia: '哥伦比亚', CO: '哥伦比亚',
  'South Africa': '南非', ZA: '南非',
  Egypt: '埃及', EG: '埃及',
  'Saudi Arabia': '沙特阿拉伯', SA: '沙特阿拉伯',
};

const REGIONS = {
  California: '加州', 'New York': '纽约州', Virginia: '弗吉尼亚州', Texas: '德州',
  Florida: '佛罗里达州', Illinois: '伊利诺伊州', Washington: '华盛顿州',
  Oregon: '俄勒冈州', 'New Jersey': '新泽西州', Massachusetts: '马萨诸塞州',
  Arizona: '亚利桑那州', Colorado: '科罗拉多州', Georgia: '佐治亚州',
  Michigan: '密歇根州', Nevada: '内华达州', Ohio: '俄亥俄州',
  Pennsylvania: '宾夕法尼亚州', Utah: '犹他州', 'North Carolina': '北卡罗来纳州',
  Singapore: '新加坡', Tokyo: '东京都', Osaka: '大阪府',
  Guangdong: '广东', Zhejiang: '浙江', Jiangsu: '江苏', Beijing: '北京',
  Shanghai: '上海', Sichuan: '四川', Fujian: '福建', Hubei: '湖北',
  Henan: '河南', Shandong: '山东', Liaoning: '辽宁', Tianjin: '天津',
  Chongqing: '重庆', 'Hong Kong': '香港',
};

const CITIES = {
  'Los Angeles': '洛杉矶', 'San Francisco': '旧金山', 'San Jose': '圣何塞',
  Oakland: '奥克兰', 'Santa Clara': '圣克拉拉', Fremont: '弗里蒙特',
  Sunnyvale: '森尼韦尔', 'Palo Alto': '帕罗奥图', 'Mountain View': '山景城',
  'New York': '纽约', 'New York City': '纽约', Ashburn: '阿什本',
  Seattle: '西雅图', Chicago: '芝加哥', Dallas: '达拉斯', Denver: '丹佛',
  Miami: '迈阿密', Houston: '休斯敦', Phoenix: '凤凰城', Atlanta: '亚特兰大',
  Boston: '波士顿', Detroit: '底特律', Portland: '波特兰', Orlando: '奥兰多',
  Toronto: '多伦多', Vancouver: '温哥华', Montreal: '蒙特利尔',
  London: '伦敦', Frankfurt: '法兰克福', 'Frankfurt am Main': '法兰克福',
  Amsterdam: '阿姆斯特丹', Paris: '巴黎', Berlin: '柏林', Munich: '慕尼黑',
  Zurich: '苏黎世', Geneva: '日内瓦', Dublin: '都柏林', Milan: '米兰',
  Madrid: '马德里', Barcelona: '巴塞罗那', Stockholm: '斯德哥尔摩',
  Oslo: '奥斯陆', Copenhagen: '哥本哈根', Helsinki: '赫尔辛基',
  Vienna: '维也纳', Brussels: '布鲁塞尔', Prague: '布拉格', Warsaw: '华沙',
  Moscow: '莫斯科', Istanbul: '伊斯坦布尔', Dubai: '迪拜', 'Tel Aviv': '特拉维夫',
  Tokyo: '东京', Osaka: '大阪', Seoul: '首尔', Busan: '釜山',
  Singapore: '新加坡', 'Hong Kong': '香港', Taipei: '台北',
  Bangkok: '曼谷', 'Kuala Lumpur': '吉隆坡', Jakarta: '雅加达',
  Manila: '马尼拉', 'Ho Chi Minh City': '胡志明市', Hanoi: '河内',
  Mumbai: '孟买', 'New Delhi': '新德里', Bangalore: '班加罗尔',
  Sydney: '悉尼', Melbourne: '墨尔本', Auckland: '奥克兰',
  'São Paulo': '圣保罗', 'Sao Paulo': '圣保罗', 'Rio de Janeiro': '里约热内卢',
  'Mexico City': '墨西哥城', Cairo: '开罗', Johannesburg: '约翰内斯堡',
  'Cape Town': '开普敦', Riyadh: '利雅得', 'Abu Dhabi': '阿布扎比',
};

/** 是否已包含中文 */
function hasCjk(text) {
  return /[\u4e00-\u9fa5]/.test(String(text || ''));
}

/** 查词典：完整匹配 → 忽略大小写 → 城市加“州/市”后缀 */
function translateTerm(term, dict) {
  if (!term) return term;
  const value = String(term).trim();
  if (!value || hasCjk(value)) return value;
  if (dict[value]) return dict[value];

  const lower = value.toLowerCase();
  for (const key of Object.keys(dict)) {
    if (key.toLowerCase() === lower) return dict[key];
  }
  // "Los Angeles, California" 这类复合值
  if (value.includes(',')) {
    return value
      .split(',')
      .map((part) => translateTerm(part, dict))
      .join('，');
  }
  return value;
}

/** 把一条属地记录转成中文 */
function localizeLocation(location) {
  if (!location) return null;
  return {
    ...location,
    country: translateTerm(location.country, COUNTRIES),
    region: translateTerm(location.region, REGIONS),
    city: translateTerm(location.city, CITIES),
    isp: location.isp ? String(location.isp).trim() : location.isp,
  };
}

module.exports = { localizeLocation, translateTerm, COUNTRIES, REGIONS, CITIES };
