/**
 * ============================================================================
 *  ZQ-CSP —— Cloudflare Worker 单文件版
 *  仓库：https://github.com/bayueqi/ZQ-CSP
 * ----------------------------------------------------------------------------
 *  做什么：
 *    1. 定时（Cron）从公开数据源抓取代理候选：socks5 / http / https / sstp / proxyip
 *    2. 用每种协议真的把隧道建起来，连 cloudflare.com:80/cdn-cgi/trace 实测
 *         「通不通 / 延迟多少 / 出口 IP 和落在哪个国家 / 命中哪个 CF 机房」
 *    3. 结果写进 KV；面板按协议分页展示、可优选、可清空、可复制结果 API
 *
 *  ── 部署 ─────────────────────────────────────────────────────────────────
 *    a) Cloudflare 控制台 → Workers 和 Pages → 创建 Worker → 粘贴本文件全部内容
 *    b) 设置 → KV 命名空间绑定：变量名必须填 CSP（指向任意一个 KV 命名空间）
 *       （不需要再设置 ADMIN 变量，管理密码改为首次打开面板时自己设）
 *    c) 设置 → 触发器 → Cron：按需要填，例如 30 分钟一次的表达式
 *       （分钟字段写 斜杠30 或逗号分隔的 0,30；定时任务只跑默认的 socks5/http/https/sstp，
 *        并按设置里的 DOMAIN 地区优选，默认 香港）
 *    d) 打开 https://你的域名/admin → 首次进入会让你设管理密码
 *
 *  ── 路由 ─────────────────────────────────────────────────────────────────
 *    GET  /                     → 跳 /admin
 *    GET  /admin                → 管理面板（首次进入引导设置密码；登录后地址栏不留密码，靠 Cookie）
 *    GET  /list/<协议>           → 该协议优选出的可用节点清单（需带 ?pwd=管理密码）
 *                                 协议 = socks5 / http / https / sstp / proxyip / all
 *                                 默认 text/plain（地址#备注），?format=json 返回 JSON
 *    GET  /api/state            → 面板数据（配置 + 各类统计 + 结果）
 *    POST /api/setup            → 首次设置管理密码（未设密码时可用）
 *    POST /api/pwd              → 修改管理密码
 *    POST /api/config           → 保存配置（DOMAIN / 并发 / 超时）
 *    POST /api/fetch            → 拉取某类候选，存 KV
 *    POST /api/optimize         → 分批优选某类（一次调用测一小批，返回进度）
 *    POST /api/test             → 单点测试一个地址
 *    POST /api/clear            → 清空某类结果
 *    GET  /check?<协议>=<地址>   → 单点检测，edgetunnel 同款接口
 *    GET  /health               → 存活探针
 * ============================================================================
 */
import { connect } from "cloudflare:sockets";

/* ========================================================================== *
 *  一、配置
 * ========================================================================== */

const DEFAULT_SOURCES = {
  socks5: "https://raw.githubusercontent.com/EDT-Pages/Proxy-List/main/data/socks5.json",
  http: "https://raw.githubusercontent.com/EDT-Pages/Proxy-List/main/data/http.json",
  https: "https://raw.githubusercontent.com/EDT-Pages/Proxy-List/main/data/https.json",
  proxyip: "https://zip.cm.edu.kg.cmliussss.net/all.json",
  vpngate: "http://www.vpngate.net/api/iphone/",
  vpngateMirror: "https://raw.githubusercontent.com/fdciabdul/Vpngate-Scraper-API/main/json/data.json",
};

const DEFAULT_CONFIG = {
  domain: "香港",            // 定时任务默认优选的地区（可填国家中文名或两位国家码，如 香港 / HK）
  concurrency: 16,          // 并发检测数
  timeoutMs: 10000,         // 单条检测超时，所有协议统一使用
  budgetMs: 5000,           // 单次 /api/optimize 调用的时间片（内部固定值，不在面板中暴露）
                            // 这个值也是「暂停优选」的响应上限：点暂停后，当前这一片跑完才会停
  autoTypes: ["socks5", "http", "https", "sstp"],  // 定时任务跑哪些
  sources: DEFAULT_SOURCES,
};

const PROTOCOLS = ["socks5", "http", "https", "sstp", "proxyip"];
const TYPE_LABEL = {
  socks5: "SOCKS5", http: "HTTP", https: "HTTPS", sstp: "SSTP", proxyip: "ProxyIP",
};

// 检测目标：明文 HTTP（80），不重定向，返回 ip= / loc= / colo=
const TRACE_HOST = "cloudflare.com";
const TRACE_PORT = 80;
const TRACE_PATH = "/cdn-cgi/trace";

// 国家码 → 中文名。数据源（socks5/http/https 的 country_cn、proxyip 的 meta.country_cn）
// 自己就带中文名，这里是**兜底**，覆盖全部 ISO 3166-1 两字母码，所以不会出现只显示裸码的情况。
const COUNTRY_ZH = {
  AD: "安道尔", AE: "阿联酋", AF: "阿富汗", AG: "安提瓜和巴布达", AI: "安圭拉", AL: "阿尔巴尼亚",
  AM: "亚美尼亚", AO: "安哥拉", AQ: "南极洲", AR: "阿根廷", AS: "美属萨摩亚", AT: "奥地利",
  AU: "澳大利亚", AW: "阿鲁巴", AX: "奥兰群岛", AZ: "阿塞拜疆", BA: "波黑", BB: "巴巴多斯",
  BD: "孟加拉国", BE: "比利时", BF: "布基纳法索", BG: "保加利亚", BH: "巴林", BI: "布隆迪",
  BJ: "贝宁", BL: "圣巴泰勒米", BM: "百慕大", BN: "文莱", BO: "玻利维亚", BQ: "加勒比荷兰",
  BR: "巴西", BS: "巴哈马", BT: "不丹", BV: "布韦岛", BW: "博茨瓦纳", BY: "白俄罗斯",
  BZ: "伯利兹", CA: "加拿大", CC: "科科斯群岛", CD: "刚果(金)", CF: "中非", CG: "刚果(布)",
  CH: "瑞士", CI: "科特迪瓦", CK: "库克群岛", CL: "智利", CM: "喀麦隆", CN: "中国",
  CO: "哥伦比亚", CR: "哥斯达黎加", CU: "古巴", CV: "佛得角", CW: "库拉索", CX: "圣诞岛",
  CY: "塞浦路斯", CZ: "捷克", DE: "德国", DJ: "吉布提", DK: "丹麦", DM: "多米尼克",
  DO: "多米尼加", DZ: "阿尔及利亚", EC: "厄瓜多尔", EE: "爱沙尼亚", EG: "埃及", EH: "西撒哈拉",
  ER: "厄立特里亚", ES: "西班牙", ET: "埃塞俄比亚", FI: "芬兰", FJ: "斐济", FK: "福克兰群岛",
  FM: "密克罗尼西亚", FO: "法罗群岛", FR: "法国", GA: "加蓬", GB: "英国", GD: "格林纳达",
  GE: "格鲁吉亚", GF: "法属圭亚那", GG: "根西", GH: "加纳", GI: "直布罗陀", GL: "格陵兰",
  GM: "冈比亚", GN: "几内亚", GP: "瓜德罗普", GQ: "赤道几内亚", GR: "希腊", GS: "南乔治亚",
  GT: "危地马拉", GU: "关岛", GW: "几内亚比绍", GY: "圭亚那", HK: "中国香港", HM: "赫德岛",
  HN: "洪都拉斯", HR: "克罗地亚", HT: "海地", HU: "匈牙利", ID: "印度尼西亚", IE: "爱尔兰",
  IL: "以色列", IM: "马恩岛", IN: "印度", IO: "英属印度洋领地", IQ: "伊拉克", IR: "伊朗",
  IS: "冰岛", IT: "意大利", JE: "泽西", JM: "牙买加", JO: "约旦", JP: "日本",
  KE: "肯尼亚", KG: "吉尔吉斯斯坦", KH: "柬埔寨", KI: "基里巴斯", KM: "科摩罗",
  KN: "圣基茨和尼维斯", KP: "朝鲜", KR: "韩国", KW: "科威特", KY: "开曼群岛", KZ: "哈萨克斯坦",
  LA: "老挝", LB: "黎巴嫩", LC: "圣卢西亚", LI: "列支敦士登", LK: "斯里兰卡", LR: "利比里亚",
  LS: "莱索托", LT: "立陶宛", LU: "卢森堡", LV: "拉脱维亚", LY: "利比亚", MA: "摩洛哥",
  MC: "摩纳哥", MD: "摩尔多瓦", ME: "黑山", MF: "圣马丁", MG: "马达加斯加", MH: "马绍尔群岛",
  MK: "北马其顿", ML: "马里", MM: "缅甸", MN: "蒙古", MO: "中国澳门", MP: "北马里亚纳群岛",
  MQ: "马提尼克", MR: "毛里塔尼亚", MS: "蒙特塞拉特", MT: "马耳他", MU: "毛里求斯",
  MV: "马尔代夫", MW: "马拉维", MX: "墨西哥", MY: "马来西亚", MZ: "莫桑比克", NA: "纳米比亚",
  NC: "新喀里多尼亚", NE: "尼日尔", NF: "诺福克岛", NG: "尼日利亚", NI: "尼加拉瓜", NL: "荷兰",
  NO: "挪威", NP: "尼泊尔", NR: "瑙鲁", NU: "纽埃", NZ: "新西兰", OM: "阿曼", PA: "巴拿马",
  PE: "秘鲁", PF: "法属波利尼西亚", PG: "巴布亚新几内亚", PH: "菲律宾", PK: "巴基斯坦",
  PL: "波兰", PM: "圣皮埃尔和密克隆", PN: "皮特凯恩", PR: "波多黎各", PS: "巴勒斯坦",
  PT: "葡萄牙", PW: "帕劳", PY: "巴拉圭", QA: "卡塔尔", RE: "留尼汪", RO: "罗马尼亚",
  RS: "塞尔维亚", RU: "俄罗斯", RW: "卢旺达", SA: "沙特阿拉伯", SB: "所罗门群岛", SC: "塞舌尔",
  SD: "苏丹", SE: "瑞典", SG: "新加坡", SH: "圣赫勒拿", SI: "斯洛文尼亚", SJ: "斯瓦尔巴和扬马延",
  SK: "斯洛伐克", SL: "塞拉利昂", SM: "圣马力诺", SN: "塞内加尔", SO: "索马里", SR: "苏里南",
  SS: "南苏丹", ST: "圣多美和普林西比", SV: "萨尔瓦多", SX: "荷属圣马丁", SY: "叙利亚",
  SZ: "斯威士兰", TC: "特克斯和凯科斯", TD: "乍得", TF: "法属南方领地", TG: "多哥", TH: "泰国",
  TJ: "塔吉克斯坦", TK: "托克劳", TL: "东帝汶", TM: "土库曼斯坦", TN: "突尼斯", TO: "汤加",
  TR: "土耳其", TT: "特立尼达和多巴哥", TV: "图瓦卢", TW: "中国台湾", TZ: "坦桑尼亚",
  UA: "乌克兰", UG: "乌干达", UM: "美国本土外小岛", US: "美国", UY: "乌拉圭", UZ: "乌兹别克斯坦",
  VA: "梵蒂冈", VC: "圣文森特和格林纳丁斯", VE: "委内瑞拉", VG: "英属维尔京群岛",
  VI: "美属维尔京群岛", VN: "越南", VU: "瓦努阿图", WF: "瓦利斯和富图纳", WS: "萨摩亚",
  YE: "也门", YT: "马约特", ZA: "南非", ZM: "赞比亚", ZW: "津巴布韦",
};

// 大洲分组，用的就是数据源那套标准大洲码（元数据里 continent 字段的值）
const CONTINENT_LABEL = {
  AS: "亚洲", EU: "欧洲", NA: "北美", SA: "南美",
  AF: "非洲", OC: "大洋洲", AN: "南极洲", OTHER: "其他",
};
const CONTINENT_EMOJI = {
  AS: "🌏", EU: "🌍", NA: "🌎", SA: "🌎", AF: "🌍", OC: "🌏", AN: "❄️", OTHER: "🌐",
};
const CONTINENT_ORDER = ["AS", "EU", "NA", "SA", "AF", "OC", "AN", "OTHER"];

// 国家码 → 大洲码。兜底用，源里有 continent 字段时以源为准。
// 注意：这里是"国家码"当键、"大洲码"当值，所以 NA(纳米比亚)→AF、AS(美属萨摩亚)→OC 不冲突。
const COUNTRY_CONTINENT = {
  // 亚洲
  AE: "AS", AF: "AS", AM: "AS", AZ: "AS", BD: "AS", BH: "AS", BN: "AS", BT: "AS", CN: "AS",
  CY: "AS", GE: "AS", HK: "AS", ID: "AS", IL: "AS", IN: "AS", IO: "AS", IQ: "AS",
  IR: "AS", JO: "AS", JP: "AS", KG: "AS", KH: "AS", KP: "AS", KR: "AS", KW: "AS",
  KZ: "AS", LA: "AS", LB: "AS", LK: "AS", MM: "AS", MN: "AS", MO: "AS", MV: "AS",
  MY: "AS", NP: "AS", OM: "AS", PH: "AS", PK: "AS", PS: "AS", QA: "AS", SA: "AS",
  SG: "AS", SY: "AS", TH: "AS", TJ: "AS", TL: "AS", TM: "AS", TR: "AS", TW: "AS",
  UZ: "AS", VN: "AS", YE: "AS",
  // 欧洲
  AD: "EU", AL: "EU", AT: "EU", AX: "EU", BA: "EU", BE: "EU", BG: "EU", BY: "EU",
  CH: "EU", CZ: "EU", DE: "EU", DK: "EU", EE: "EU", ES: "EU", FI: "EU", FO: "EU",
  FR: "EU", GB: "EU", GG: "EU", GI: "EU", GR: "EU", HR: "EU", HU: "EU", IE: "EU",
  IM: "EU", IS: "EU", IT: "EU", JE: "EU", LI: "EU", LT: "EU", LU: "EU", LV: "EU",
  MC: "EU", MD: "EU", ME: "EU", MK: "EU", MT: "EU", NL: "EU", NO: "EU", PL: "EU",
  PT: "EU", RO: "EU", RS: "EU", RU: "EU", SE: "EU", SI: "EU", SJ: "EU", SK: "EU",
  SM: "EU", UA: "EU", VA: "EU",
  // 北美 / 中美 / 加勒比
  AG: "NA", AI: "NA", AW: "NA", BB: "NA", BL: "NA", BM: "NA", BQ: "NA", BS: "NA",
  BZ: "NA", CA: "NA", CR: "NA", CU: "NA", CW: "NA", DM: "NA", DO: "NA", GD: "NA",
  GL: "NA", GP: "NA", GT: "NA", HN: "NA", HT: "NA", JM: "NA", KN: "NA", KY: "NA",
  LC: "NA", MF: "NA", MQ: "NA", MS: "NA", MX: "NA", NI: "NA", PA: "NA", PM: "NA",
  PR: "NA", SV: "NA", SX: "NA", TC: "NA", TT: "NA", US: "NA", VC: "NA", VG: "NA",
  VI: "NA",
  // 南美
  AR: "SA", BO: "SA", BR: "SA", CL: "SA", CO: "SA", EC: "SA", FK: "SA", GF: "SA",
  GY: "SA", PE: "SA", PY: "SA", SR: "SA", UY: "SA", VE: "SA",
  // 非洲
  AO: "AF", BF: "AF", BI: "AF", BJ: "AF", BW: "AF", CD: "AF", CF: "AF", CG: "AF",
  CI: "AF", CM: "AF", CV: "AF", DJ: "AF", DZ: "AF", EG: "AF", EH: "AF", ER: "AF",
  ET: "AF", GA: "AF", GH: "AF", GM: "AF", GN: "AF", GQ: "AF", GW: "AF", KE: "AF",
  KM: "AF", LR: "AF", LS: "AF", LY: "AF", MA: "AF", MG: "AF", ML: "AF", MR: "AF",
  MU: "AF", MW: "AF", MZ: "AF", NA: "AF", NE: "AF", NG: "AF", RE: "AF", RW: "AF",
  SC: "AF", SD: "AF", SH: "AF", SL: "AF", SN: "AF", SO: "AF", SS: "AF", ST: "AF",
  SZ: "AF", TD: "AF", TG: "AF", TN: "AF", TZ: "AF", UG: "AF", YT: "AF", ZA: "AF",
  ZM: "AF", ZW: "AF",
  // 大洋洲
  AS: "OC", AU: "OC", CC: "OC", CK: "OC", CX: "OC", FJ: "OC", FM: "OC", GU: "OC",
  HM: "OC", KI: "OC", MH: "OC", MP: "OC", NC: "OC", NF: "OC", NR: "OC", NU: "OC",
  NZ: "OC", PF: "OC", PG: "OC", PN: "OC", PW: "OC", SB: "OC", TK: "OC", TO: "OC",
  TV: "OC", UM: "OC", VU: "OC", WF: "OC", WS: "OC",
  // 南极洲
  AQ: "AN", BV: "AN", GS: "AN", TF: "AN",
};

function continentOf(code) {
  return COUNTRY_CONTINENT[String(code || "").toUpperCase()] || "OTHER";
}

/* ========================================================================== *
 *  二、协议实现（socks5 / http / https / sstp）
 * ========================================================================== */

const PROXY_DEFAULT_PORTS = { socks5: 1080, http: 8080, https: 443, sstp: 443 };
const PROXY_CONNECT_TIMEOUT_MS = 9999;
const proxyTextEncoder = new TextEncoder();
const proxyTextDecoder = new TextDecoder();
const SSTP_EMPTY_BYTES = new Uint8Array(0);
const SSTP_TCP_MSS = 1400;

function stripIPv6Brackets(host) {
  const value = String(host || "").trim();
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function isIPv4(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    return Number(part) <= 255;
  });
}

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data || 0);
}

function concatBytes() {
  const chunks = Array.prototype.slice.call(arguments);
  if (!chunks.length) return new Uint8Array(0);
  const list = chunks.map(toUint8);
  let total = 0;
  for (const chunk of list) total += chunk.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of list) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function readUint16(bytes, offset) {
  const at = offset || 0;
  return (bytes[at] << 8) | bytes[at + 1];
}

function readUint32(bytes, offset) {
  const at = offset || 0;
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function randomUint16() {
  return readUint16(crypto.getRandomValues(new Uint8Array(2)));
}

function internetChecksum(bytes, offset, length) {
  let sum = 0;
  for (let i = offset; i < offset + length - 1; i += 2) sum += readUint16(bytes, i);
  if (length & 1) sum += bytes[offset + length - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

// SSTP 要自己拼 IP 包，必须先拿到目标 A 记录
async function resolveIPv4(host) {
  const target = stripIPv6Brackets(host);
  if (isIPv4(target)) return target;
  try {
    const res = await fetch(
      "https://1.1.1.1/dns-query?name=" + encodeURIComponent(target) + "&type=A",
      { headers: { accept: "application/dns-json" } },
    );
    const data = await res.json();
    const record = (data.Answer || []).find((item) => item.type === 1 && isIPv4(item.data));
    return record ? record.data : null;
  } catch (e) {
    return null;
  }
}

// 把地址解析成 { type, host, port, username, password }
function parseProxyAddress(proxyStr) {
  if (!proxyStr) return null;
  const raw = String(proxyStr).trim().split("#")[0].trim();
  if (!raw) return null;
  const matched = /^(socks5|socks|http|https|sstp|turn):\/\//i.exec(raw);
  let type = "socks5";
  let rest = raw;
  if (matched) {
    type = matched[1].toLowerCase();
    rest = raw.slice(matched[0].length);
  }
  if (type === "socks") type = "socks5";
  if (!PROXY_DEFAULT_PORTS[type]) return null;
  const at = rest.lastIndexOf("@");
  const credential = at === -1 ? "" : rest.slice(0, at);
  const server = (at === -1 ? rest : rest.slice(at + 1)).split("/")[0];
  let username = "";
  let password = "";
  if (credential) {
    const split = credential.indexOf(":");
    if (split === -1) return null;
    try {
      username = decodeURIComponent(credential.slice(0, split));
      password = decodeURIComponent(credential.slice(split + 1));
    } catch (e) {
      username = credential.slice(0, split);
      password = credential.slice(split + 1);
    }
  }
  let host = server;
  let port = PROXY_DEFAULT_PORTS[type] || 0;
  let hasExplicitPort = false;
  if (server.startsWith("[")) {
    const close = server.indexOf("]");
    if (close === -1) return null;
    host = server.slice(0, close + 1);
    const tail = server.slice(close + 1);
    if (tail.startsWith(":")) {
      port = parseInt(tail.slice(1), 10);
      hasExplicitPort = true;
    }
  } else if (server.indexOf(":") !== -1) {
    const parts = server.split(":");
    if (parts.length !== 2) return null;
    host = parts[0];
    port = parseInt(parts[1], 10);
    hasExplicitPort = true;
  }
  if (!matched && !hasExplicitPort) return null;
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { type, host, port, username, password };
}

async function socks5Connect(socket, proxyConfig, targetHost, targetPort, timeoutMs) {
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  try {
    const authMethods = proxyConfig.username && proxyConfig.password
      ? new Uint8Array([0x05, 0x02, 0x00, 0x02])
      : new Uint8Array([0x05, 0x01, 0x00]);
    await writer.write(authMethods);
    let res = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ timeout: true }), timeoutMs)),
    ]);
    if (!res || res.timeout) throw new Error("SOCKS5 握手超时");
    const method = new Uint8Array(res.value)[1];
    if (method === 0x02) {
      if (!proxyConfig.username || !proxyConfig.password) throw new Error("SOCKS5 要求账号密码");
      const uBytes = proxyTextEncoder.encode(proxyConfig.username);
      const pBytes = proxyTextEncoder.encode(proxyConfig.password);
      const auth = new Uint8Array(3 + uBytes.length + pBytes.length);
      auth[0] = 0x01;
      auth[1] = uBytes.length;
      auth.set(uBytes, 2);
      auth[2 + uBytes.length] = pBytes.length;
      auth.set(pBytes, 3 + uBytes.length);
      await writer.write(auth);
      res = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ timeout: true }), timeoutMs)),
      ]);
      if (!res || res.timeout || new Uint8Array(res.value)[1] !== 0x00) throw new Error("SOCKS5 认证失败");
    } else if (method !== 0x00) {
      throw new Error("SOCKS5 不支持的认证方式: " + method);
    }
    const hostBytes = proxyTextEncoder.encode(targetHost);
    const connect = new Uint8Array(7 + hostBytes.length);
    connect[0] = 0x05;
    connect[1] = 0x01;
    connect[2] = 0x00;
    connect[3] = 0x03;
    connect[4] = hostBytes.length;
    connect.set(hostBytes, 5);
    new DataView(connect.buffer).setUint16(5 + hostBytes.length, targetPort, false);
    await writer.write(connect);
    res = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ timeout: true }), timeoutMs)),
    ]);
    if (!res || res.timeout || new Uint8Array(res.value)[1] !== 0x00) throw new Error("SOCKS5 CONNECT 失败");
    return { writer, reader };
  } catch (e) {
    writer.releaseLock();
    reader.releaseLock();
    throw e;
  }
}

// HTTP / HTTPS 代理：CONNECT 隧道
async function httpConnect(proxyConfig, targetHost, targetPort, useTLS) {
  const serverHost = stripIPv6Brackets(proxyConfig.host);
  const socket = useTLS
    ? connect({ hostname: serverHost, port: proxyConfig.port }, { secureTransport: "on", allowHalfOpen: false })
    : connect({ hostname: serverHost, port: proxyConfig.port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  try {
    if (useTLS) await withTimeout(socket.opened, PROXY_CONNECT_TIMEOUT_MS, "HTTPS 代理连接超时");
    const auth = proxyConfig.username && proxyConfig.password
      ? "Proxy-Authorization: Basic " + btoa(proxyConfig.username + ":" + proxyConfig.password) + "\r\n"
      : "";
    const target = stripIPv6Brackets(targetHost) + ":" + targetPort;
    const request = "CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n" + auth
      + "User-Agent: Mozilla/5.0\r\nConnection: keep-alive\r\n\r\n";
    await writer.write(proxyTextEncoder.encode(request));
    writer.releaseLock();

    let head = new Uint8Array(0);
    let headEnd = -1;
    while (headEnd === -1 && head.byteLength < 8192) {
      const { done, value } = await withTimeout(reader.read(), PROXY_CONNECT_TIMEOUT_MS, "代理 CONNECT 响应超时");
      if (done || !value) throw new Error((useTLS ? "HTTPS" : "HTTP") + " 代理在返回 CONNECT 结果前断开");
      head = concatBytes(head, value);
      headEnd = findHeaderEnd(head);
    }
    if (headEnd === -1) throw new Error("代理 CONNECT 响应头过长或无效");
    const statusLine = proxyTextDecoder.decode(head.slice(0, headEnd)).split("\r\n")[0];
    const statusMatch = /HTTP\/\d\.\d\s+(\d+)/.exec(statusLine);
    const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : NaN;
    if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
      throw new Error("代理拒绝连接: HTTP " + statusCode);
    }
    reader.releaseLock();

    if (head.byteLength > headEnd) {
      const bridge = new TransformStream();
      const bridgeWriter = bridge.writable.getWriter();
      await bridgeWriter.write(head.subarray(headEnd, head.byteLength));
      bridgeWriter.releaseLock();
      socket.readable.pipeTo(bridge.writable).catch(() => {});
      return { readable: bridge.readable, writable: socket.writable, closed: socket.closed, close: () => socket.close() };
    }
    return socket;
  } catch (error) {
    try { writer.releaseLock(); } catch (e) {}
    try { reader.releaseLock(); } catch (e) {}
    try { socket.close(); } catch (e) {}
    throw error;
  }
}

// SSTP 客户端：VPN Gate 那类只给隧道协议的家宽节点走这个
async function sstpConnect(proxyConfig, targetHost, targetPort) {
  const username = proxyConfig.username === undefined ? null : proxyConfig.username;
  const password = proxyConfig.password === undefined ? null : proxyConfig.password;
  let buffer = SSTP_EMPTY_BYTES;
  let pppId = 1;
  let socket = null;
  let reader = null;
  let writer = null;
  let settled = false;
  let settleResolve;
  let settleReject;
  const closed = new Promise((resolve, reject) => { settleResolve = resolve; settleReject = reject; });
  const settle = (fn, value) => { if (settled) return; settled = true; fn(value); };
  const close = () => {
    try { reader && reader.cancel && reader.cancel().catch(() => {}); } catch (e) {}
    try { reader && reader.releaseLock && reader.releaseLock(); } catch (e) {}
    try { writer && writer.close && writer.close().catch(() => {}); } catch (e) {}
    try { writer && writer.releaseLock && writer.releaseLock(); } catch (e) {}
    try { socket && socket.close && socket.close(); } catch (e) {}
    settle(settleResolve);
  };
  const readChunk = async () => {
    const { value, done } = await reader.read();
    if (done || !value) throw new Error("SSTP 连接已关闭");
    return toUint8(value);
  };
  const readN = async (length) => {
    while (buffer.byteLength < length) {
      const chunk = await readChunk();
      buffer = buffer.byteLength ? concatBytes(buffer, chunk) : chunk;
    }
    const result = buffer.subarray(0, length);
    buffer = buffer.subarray(length);
    return result;
  };
  const readLine = async () => {
    for (;;) {
      const index = buffer.indexOf(10);
      if (index >= 0) {
        const line = proxyTextDecoder.decode(buffer.subarray(0, index));
        buffer = buffer.subarray(index + 1);
        return line.replace(/\r$/, "");
      }
      const chunk = await readChunk();
      buffer = buffer.byteLength ? concatBytes(buffer, chunk) : chunk;
    }
  };
  const readPacket = async (timeoutMs) => {
    const header = await withTimeout(readN(4), timeoutMs, "SSTP 读取超时");
    const length = readUint16(header, 2) & 0x0fff;
    if (length < 4) throw new Error("SSTP 包长度无效");
    const body = length > 4 ? await withTimeout(readN(length - 4), timeoutMs, "SSTP 包体读取超时") : SSTP_EMPTY_BYTES;
    return { isControl: (header[1] & 1) !== 0, body };
  };
  const packData = (pppFrame) => {
    const length = 6 + pppFrame.byteLength;
    const packet = new Uint8Array(length);
    packet.set([0x10, 0x00, ((length >> 8) & 0x0f) | 0x80, length & 0xff, 0xff, 0x03]);
    packet.set(pppFrame, 6);
    return packet;
  };
  const buildPppConfig = (protocol, code, id, options) => {
    const list = options || [];
    const optionsLength = list.reduce((sum, option) => sum + 2 + option.data.byteLength, 0);
    const frame = new Uint8Array(6 + optionsLength);
    const view = new DataView(frame.buffer);
    view.setUint16(0, protocol);
    frame[2] = code;
    frame[3] = id;
    view.setUint16(4, 4 + optionsLength);
    list.reduce((offset, option) => {
      frame[offset] = option.type;
      frame[offset + 1] = 2 + option.data.byteLength;
      frame.set(option.data, offset + 2);
      return offset + 2 + option.data.byteLength;
    }, 6);
    return frame;
  };
  const parsePppFrame = (data) => {
    const offset = data.byteLength >= 2 && data[0] === 0xff && data[1] === 0x03 ? 2 : 0;
    if (data.byteLength - offset < 4) return null;
    const protocol = readUint16(data, offset);
    if (protocol === 0x0021) return { protocol, ipPacket: data.subarray(offset + 2) };
    if (data.byteLength - offset < 6) return null;
    return {
      protocol,
      code: data[offset + 2],
      id: data[offset + 3],
      payload: data.subarray(offset + 6),
      rawPacket: data.subarray(offset),
    };
  };
  const parsePppOptions = (data) => {
    const options = [];
    for (let offset = 0; offset + 2 <= data.byteLength;) {
      const type = data[offset];
      const length = data[offset + 1];
      if (length < 2 || offset + length > data.byteLength) break;
      options.push({ type, data: data.subarray(offset + 2, offset + length) });
      offset += length;
    }
    return options;
  };

  try {
    const serverHost = stripIPv6Brackets(proxyConfig.host);
    const serverPort = proxyConfig.port;
    socket = connect({ hostname: serverHost, port: serverPort }, { secureTransport: "on", allowHalfOpen: false });
    await withTimeout(socket.opened, PROXY_CONNECT_TIMEOUT_MS, "SSTP 服务器连接超时");
    reader = socket.readable.getReader();
    writer = socket.writable.getWriter();

    const displayHost = serverHost.indexOf(":") !== -1 ? "[" + serverHost + "]" : serverHost;
    const httpRequest = proxyTextEncoder.encode(
      "SSTP_DUPLEX_POST /sra_{BA195980-CD49-458b-9E23-C84EE0ADCD75}/ HTTP/1.1\r\n"
      + "Host: " + (Number(serverPort) === 443 ? displayHost : displayHost + ":" + serverPort) + "\r\n"
      + "Content-Length: 18446744073709551615\r\n"
      + "SSTPCORRELATIONID: {" + crypto.randomUUID() + "}\r\n\r\n",
    );
    const encapsulation = new Uint8Array(2);
    new DataView(encapsulation.buffer).setUint16(0, 1);
    const maxReceiveUnit = new Uint8Array(2);
    new DataView(maxReceiveUnit.buffer).setUint16(0, 1500);
    const connectRequest = new Uint8Array(12 + encapsulation.byteLength);
    const connectView = new DataView(connectRequest.buffer);
    connectRequest[0] = 0x10;
    connectRequest[1] = 0x01;
    connectView.setUint16(2, connectRequest.byteLength | 0x8000);
    connectView.setUint16(4, 0x0001);
    connectView.setUint16(6, 1);
    connectRequest[9] = 1;
    connectView.setUint16(10, 4 + encapsulation.byteLength);
    connectRequest.set(encapsulation, 12);

    await withTimeout(
      writer.write(concatBytes(
        httpRequest,
        connectRequest,
        packData(buildPppConfig(0xc021, 1, pppId++, [{ type: 1, data: maxReceiveUnit }])),
      )),
      PROXY_CONNECT_TIMEOUT_MS,
      "SSTP 握手请求超时",
    );

    const statusLine = await withTimeout(readLine(), PROXY_CONNECT_TIMEOUT_MS, "SSTP HTTP 握手超时");
    for (;;) {
      const line = await withTimeout(readLine(), PROXY_CONNECT_TIMEOUT_MS, "SSTP HTTP 头超时");
      if (line === "") break;
    }
    if (!/HTTP\/\d(?:\.\d)?\s+2\d\d/i.test(statusLine)) {
      throw new Error("SSTP HTTP 握手失败: " + (statusLine || "无效状态行"));
    }

    let localLcpAcked = false;
    let peerLcpAcked = false;
    let needsPap = false;
    let papSent = false;
    let papDone = false;
    let ipcpSent = false;
    let ipcpDone = false;
    let localAddress = null;

    const sendPap = async () => {
      if (!localLcpAcked || !peerLcpAcked || !needsPap || papSent) return;
      if (username === null || password === null) throw new Error("SSTP 服务器要求 PAP 认证");
      const userBytes = proxyTextEncoder.encode(username);
      const passBytes = proxyTextEncoder.encode(password);
      if (userBytes.byteLength > 255 || passBytes.byteLength > 255) throw new Error("SSTP 账号或密码过长");
      const papLength = 6 + userBytes.byteLength + passBytes.byteLength;
      const frame = new Uint8Array(2 + papLength);
      const view = new DataView(frame.buffer);
      view.setUint16(0, 0xc023);
      frame[2] = 1;
      frame[3] = pppId++;
      view.setUint16(4, papLength);
      frame[6] = userBytes.byteLength;
      frame.set(userBytes, 7);
      frame[7 + userBytes.byteLength] = passBytes.byteLength;
      frame.set(passBytes, 8 + userBytes.byteLength);
      await withTimeout(writer.write(packData(frame)), PROXY_CONNECT_TIMEOUT_MS, "SSTP PAP 请求超时");
      papSent = true;
    };
    const startIpcp = async () => {
      if (!localLcpAcked || !peerLcpAcked || ipcpSent || (needsPap && !papDone)) return;
      await withTimeout(
        writer.write(packData(buildPppConfig(0x8021, 1, pppId++, [{ type: 3, data: new Uint8Array(4) }]))),
        PROXY_CONNECT_TIMEOUT_MS,
        "SSTP IPCP 请求超时",
      );
      ipcpSent = true;
    };

    for (let round = 0; round < 50 && !ipcpDone; round++) {
      const packet = await readPacket(PROXY_CONNECT_TIMEOUT_MS);
      if (packet.isControl) continue;
      const ppp = parsePppFrame(packet.body);
      if (!ppp) continue;

      if (ppp.protocol === 0xc021) {
        if (ppp.code === 1) {
          const authOption = parsePppOptions(ppp.payload).find((option) => option.type === 3);
          if (authOption && authOption.data && authOption.data.byteLength >= 2) {
            const authProtocol = readUint16(authOption.data);
            if (authProtocol !== 0xc023) throw new Error("SSTP 不支持的 PPP 认证协议: 0x" + authProtocol.toString(16));
            needsPap = true;
          }
          const ack = new Uint8Array(ppp.rawPacket);
          ack[2] = 2;
          await withTimeout(writer.write(packData(ack)), PROXY_CONNECT_TIMEOUT_MS, "SSTP LCP ACK 超时");
          peerLcpAcked = true;
          await sendPap();
          await startIpcp();
        } else if (ppp.code === 2) {
          localLcpAcked = true;
          await sendPap();
          await startIpcp();
        }
        continue;
      }

      if (ppp.protocol === 0xc023) {
        if (ppp.code === 2) {
          papDone = true;
          await startIpcp();
        } else if (ppp.code === 3) {
          throw new Error("SSTP PAP 认证失败");
        }
        continue;
      }

      if (ppp.protocol === 0x8021) {
        if (ppp.code === 1) {
          const ack = new Uint8Array(ppp.rawPacket);
          ack[2] = 2;
          await withTimeout(writer.write(packData(ack)), PROXY_CONNECT_TIMEOUT_MS, "SSTP IPCP ACK 超时");
          await startIpcp();
        } else if (ppp.code === 3) {
          const addressOption = parsePppOptions(ppp.payload).find((option) => option.type === 3);
          if (addressOption && addressOption.data && addressOption.data.byteLength === 4) {
            localAddress = Array.prototype.slice.call(addressOption.data).join(".");
            await withTimeout(
              writer.write(packData(buildPppConfig(0x8021, 1, pppId++, [{ type: 3, data: addressOption.data }]))),
              PROXY_CONNECT_TIMEOUT_MS,
              "SSTP IPCP 地址请求超时",
            );
            ipcpSent = true;
          }
        } else if (ppp.code === 2) {
          const addressOption = parsePppOptions(ppp.payload).find((option) => option.type === 3);
          if (addressOption && addressOption.data && addressOption.data.byteLength === 4) {
            localAddress = Array.prototype.slice.call(addressOption.data).join(".");
          }
          ipcpDone = true;
        }
      }
    }
    if (!localAddress) throw new Error("SSTP 没有分配到 IPv4 地址");

    const target = stripIPv6Brackets(targetHost);
    const targetIp = isIPv4(target) ? target : await resolveIPv4(target);
    if (!targetIp) throw new Error("SSTP 无法把 " + targetHost + " 解析成 IPv4");

    const sourcePort = 10000 + (randomUint16() % 50000);
    const sourceBytes = new Uint8Array(String(localAddress).split(".").map(Number));
    const targetBytes = new Uint8Array(String(targetIp).split(".").map(Number));
    let sequence = readUint32(crypto.getRandomValues(new Uint8Array(4)));
    let ackNumber = 0;
    const ipHeaderTemplate = new Uint8Array(20);
    ipHeaderTemplate.set([0x45, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 64, 6]);
    ipHeaderTemplate.set(sourceBytes, 12);
    ipHeaderTemplate.set(targetBytes, 16);
    const tcpPseudoHeader = new Uint8Array(1432);
    tcpPseudoHeader.set(sourceBytes);
    tcpPseudoHeader.set(targetBytes, 4);
    tcpPseudoHeader[9] = 6;
    const buildTcpFrame = (flags, payload) => {
      const bytes = toUint8(payload || SSTP_EMPTY_BYTES);
      const payloadLength = bytes.byteLength;
      const tcpLength = 20 + payloadLength;
      const ipLength = 20 + tcpLength;
      const sstpLength = 8 + ipLength;
      const frame = new Uint8Array(sstpLength);
      const view = new DataView(frame.buffer);
      frame.set([0x10, 0x00, ((sstpLength >> 8) & 0x0f) | 0x80, sstpLength & 0xff, 0xff, 0x03, 0x00, 0x21]);
      frame.set(ipHeaderTemplate, 8);
      view.setUint16(10, ipLength);
      view.setUint16(12, randomUint16());
      view.setUint16(18, internetChecksum(frame, 8, 20));
      view.setUint16(28, sourcePort);
      view.setUint16(30, targetPort);
      view.setUint32(32, sequence);
      view.setUint32(36, ackNumber);
      frame[40] = 0x50;
      frame[41] = flags;
      view.setUint16(42, 65535);
      if (payloadLength) frame.set(bytes, 48);
      tcpPseudoHeader[10] = tcpLength >> 8;
      tcpPseudoHeader[11] = tcpLength & 0xff;
      tcpPseudoHeader.set(frame.subarray(28, 28 + tcpLength), 12);
      view.setUint16(44, internetChecksum(tcpPseudoHeader, 0, 12 + tcpLength));
      return frame;
    };
    const matchInbound = (ipPacket) => {
      if (ipPacket.byteLength < 40 || ipPacket[9] !== 6) return null;
      const headerLength = (ipPacket[0] & 0x0f) * 4;
      if (ipPacket.byteLength < headerLength + 20) return null;
      if (readUint16(ipPacket, headerLength) !== targetPort) return null;
      if (readUint16(ipPacket, headerLength + 2) !== sourcePort) return null;
      return {
        flags: ipPacket[headerLength + 13],
        sequence: readUint32(ipPacket, headerLength + 4),
        payloadOffset: headerLength + ((ipPacket[headerLength + 12] >> 4) & 0x0f) * 4,
      };
    };

    await withTimeout(writer.write(buildTcpFrame(0x02)), PROXY_CONNECT_TIMEOUT_MS, "SSTP 内层 TCP SYN 超时");
    sequence = (sequence + 1) >>> 0;

    let tcpReady = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const packet = await readPacket(PROXY_CONNECT_TIMEOUT_MS);
      if (packet.isControl) continue;
      const ppp = parsePppFrame(packet.body);
      if (!ppp || ppp.protocol !== 0x0021) continue;
      const tcp = matchInbound(ppp.ipPacket);
      if (!tcp || (tcp.flags & 0x12) !== 0x12) continue;
      ackNumber = (tcp.sequence + 1) >>> 0;
      await withTimeout(writer.write(buildTcpFrame(0x10)), PROXY_CONNECT_TIMEOUT_MS, "SSTP 内层 TCP ACK 超时");
      tcpReady = true;
      break;
    }
    if (!tcpReady) throw new Error("SSTP 内层 TCP 握手超时");

    let streamController = null;
    const readable = new ReadableStream({
      start(controller) { streamController = controller; },
      cancel() { close(); },
    });

    (async () => {
      try {
        let pendingChunks = [];
        let pendingLength = 0;
        const flush = () => {
          if (!pendingLength) return;
          if (!streamController) throw new Error("SSTP 可读流未就绪");
          streamController.enqueue(pendingChunks.length === 1 ? pendingChunks[0] : concatBytes.apply(null, pendingChunks));
          pendingChunks = [];
          pendingLength = 0;
          writer.write(buildTcpFrame(0x10)).catch(() => {});
        };
        for (;;) {
          const packet = await readPacket(60000);
          if (packet.isControl) continue;
          const ppp = parsePppFrame(packet.body);
          if (!ppp || ppp.protocol !== 0x0021) continue;
          const inbound = matchInbound(ppp.ipPacket);
          if (!inbound) continue;
          if (inbound.payloadOffset < ppp.ipPacket.byteLength) {
            const payload = ppp.ipPacket.subarray(inbound.payloadOffset);
            if (payload.byteLength) {
              ackNumber = (inbound.sequence + payload.byteLength) >>> 0;
              pendingChunks.push(new Uint8Array(payload));
              pendingLength += payload.byteLength;
            }
          }
          if (inbound.flags & 0x01) {
            flush();
            ackNumber = (ackNumber + 1) >>> 0;
            writer.write(buildTcpFrame(0x11)).catch(() => {});
            const controller = streamController;
            if (controller) { try { controller.close(); } catch (e) {} }
            close();
            return;
          }
          if (buffer.byteLength < 4 || pendingLength >= 32768) flush();
        }
      } catch (error) {
        const controller = streamController;
        if (controller) { try { controller.error(error); } catch (e) {} }
        settle(settleReject, error);
        try { socket && socket.close && socket.close(); } catch (e) {}
      }
    })();

    const writable = new WritableStream({
      async write(chunk) {
        const bytes = toUint8(chunk);
        if (!bytes.byteLength) return;
        if (bytes.byteLength <= SSTP_TCP_MSS) {
          await writer.write(buildTcpFrame(0x18, bytes));
          sequence = (sequence + bytes.byteLength) >>> 0;
          return;
        }
        const frames = [];
        for (let offset = 0; offset < bytes.byteLength; offset += SSTP_TCP_MSS) {
          const segment = bytes.subarray(offset, Math.min(offset + SSTP_TCP_MSS, bytes.byteLength));
          frames.push(buildTcpFrame(0x18, segment));
          sequence = (sequence + segment.byteLength) >>> 0;
        }
        await writer.write(concatBytes.apply(null, frames));
      },
      close() { return writer.write(buildTcpFrame(0x11)).catch(() => {}); },
      abort(error) {
        close();
        if (error) settle(settleReject, error);
      },
    });

    return { readable, writable, closed, close };
  } catch (error) {
    close();
    throw error;
  }
}

// 统一入口：按类型建连接，返回可直接当 socket 用的对象
async function connectViaProxy(proxyConfig, targetHost, targetPort) {
  if (!proxyConfig || !proxyConfig.host) throw new Error("链式代理配置为空");
  const type = proxyConfig.type || "socks5";
  if (type === "sstp") return await sstpConnect(proxyConfig, targetHost, targetPort);
  if (type === "http" || type === "https") return await httpConnect(proxyConfig, targetHost, targetPort, type === "https");
  const raw = connect({ hostname: stripIPv6Brackets(proxyConfig.host), port: proxyConfig.port });
  try {
    const pair = await socks5Connect(raw, proxyConfig, targetHost, targetPort, 2500);
    pair.writer.releaseLock();
    pair.reader.releaseLock();
    return raw;
  } catch (error) {
    try { raw.close(); } catch (e) {}
    throw error;
  }
}

/* ========================================================================== *
 *  三、检测层
 * ========================================================================== */

function findHeaderEnd(bytes) {
  for (let i = 0; i + 3 < bytes.byteLength; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i + 4;
  }
  return -1;
}

function readContentLength(head) {
  const lower = head.toLowerCase();
  const index = lower.indexOf("content-length:");
  if (index === -1) return null;
  let end = lower.indexOf("\r\n", index);
  if (end === -1) end = head.length;
  const num = parseInt(head.slice(index + 15, end).trim(), 10);
  return Number.isFinite(num) ? num : null;
}

function parseTrace(text) {
  const out = { ip: "", loc: "", colo: "" };
  const sep = text.indexOf("\r\n\r\n");
  if (sep === -1) return out;
  const body = text.slice(sep + 4);
  const lines = body.split("\n");
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "ip") out.ip = value;
    else if (key === "loc") out.loc = value;
    else if (key === "colo") out.colo = value;
  }
  return out;
}

// 在已建好的隧道上发一个明文 HTTP GET，读回响应
async function httpGetOverSocket(socket, host, port, path, timeoutMs) {
  const writer = socket.writable.getWriter();
  try {
    const request = "GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\nUser-Agent: Mozilla/5.0\r\n"
      + "Accept: */*\r\nConnection: close\r\n\r\n";
    await withTimeout(writer.write(proxyTextEncoder.encode(request)), timeoutMs, "发送请求超时");
  } catch (e) {
    try { writer.releaseLock(); } catch (err) {}
    throw e;
  }
  try { writer.releaseLock(); } catch (e) {}

  const reader = socket.readable.getReader();
  let buf = new Uint8Array(0);
  const maxBytes = 32768;
  try {
    for (;;) {
      const { done, value } = await withTimeout(reader.read(), timeoutMs, "读取响应超时");
      if (done) break;
      if (value && value.byteLength) {
        buf = buf.byteLength ? concatBytes(buf, value) : toUint8(value);
        const headEnd = findHeaderEnd(buf);
        if (headEnd !== -1) {
          const head = proxyTextDecoder.decode(buf.subarray(0, headEnd));
          const length = readContentLength(head);
          if (length !== null && buf.byteLength >= headEnd + length) break;
        }
        if (buf.byteLength >= maxBytes) break;
      }
    }
  } catch (e) {
    // 超时/半途断开也把已收到的内容返回，交给上层判断
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }
  return proxyTextDecoder.decode(buf);
}

// ProxyIP：先按 443 试一次 TLS（能握手说明是活着的 CF 边缘），失败退回纯 TCP 连通性
async function checkProxyIp(address, timeoutMs) {
  const started = Date.now();
  const at = address.lastIndexOf("@");
  const server = at === -1 ? address : address.slice(at + 1);
  let host = server;
  let port = 443;
  if (server.startsWith("[")) {
    const close = server.indexOf("]");
    if (close === -1) return { ok: false, latency: 0, error: "IPv6 地址无效" };
    host = server.slice(0, close + 1);
    const tail = server.slice(close + 1);
    if (tail.startsWith(":")) port = parseInt(tail.slice(1), 10);
  } else if (server.indexOf(":") !== -1) {
    const parts = server.split(":");
    host = parts[0];
    port = parseInt(parts[1], 10);
  }
  const cleanHost = stripIPv6Brackets(host);
  if (!cleanHost) return { ok: false, latency: 0, error: "地址为空" };

  let socket = null;
  try {
    socket = connect({ hostname: cleanHost, port }, { secureTransport: "on", allowHalfOpen: false });
    await withTimeout(socket.opened, timeoutMs, "TLS 握手超时");
    const latency = Date.now() - started;
    try { socket.close(); } catch (e) {}
    return { ok: true, latency, exitIp: cleanHost, mode: "tls" };
  } catch (e) {
    try { socket && socket.close && socket.close(); } catch (err) {}
  }
  try {
    socket = connect({ hostname: cleanHost, port });
    await withTimeout(socket.opened, timeoutMs, "TCP 连接超时");
    const latency = Date.now() - started;
    try { socket.close(); } catch (e) {}
    return { ok: true, latency, exitIp: cleanHost, mode: "tcp" };
  } catch (e) {
    try { socket && socket.close && socket.close(); } catch (err) {}
    return { ok: false, latency: Date.now() - started, error: String((e && e.message) || e) };
  }
}

// 单点检测：返回 { ok, latency, exitIp, country, colo, error }
async function runCheck(type, address, opts) {
  const options = opts || {};
  const timeoutMs = options.timeoutMs || DEFAULT_CONFIG.timeoutMs;
  const started = Date.now();
  if (type === "proxyip") return await checkProxyIp(address, timeoutMs);

  let socket = null;
  try {
    const parsed = parseProxyAddress(address);
    if (!parsed) throw new Error("地址解析失败（没写协议前缀时必须带端口）");
    // 地址没带协议前缀时，按调用方指定的类型走（例如 SSTP 卡片里直接填 host:port）
    if (String(address).indexOf("://") === -1) parsed.type = type;
    socket = await withTimeout(
      connectViaProxy(parsed, TRACE_HOST, TRACE_PORT),
      timeoutMs,
      TYPE_LABEL[type] + " 建隧道超时",
    );
    const text = await httpGetOverSocket(socket, TRACE_HOST, TRACE_PORT, TRACE_PATH, timeoutMs);
    const info = parseTrace(text);
    if (!info.ip) throw new Error("响应里没有出口 IP");
    return {
      ok: true,
      latency: Date.now() - started,
      exitIp: info.ip,
      country: info.loc || "",
      colo: info.colo || "",
    };
  } catch (error) {
    return { ok: false, latency: Date.now() - started, error: String((error && error.message) || error) };
  } finally {
    try { socket && socket.close && socket.close(); } catch (e) {}
  }
}

/* ========================================================================== *
 *  四、数据源层
 * ========================================================================== */

async function fetchWithTimeout(url, timeoutMs, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, init || {}, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function b64ToText(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return proxyTextDecoder.decode(bytes);
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// VPN Gate：官方只给 OpenVPN 配置，从里面借出 host:port 拼成 sstp://
function parseVpngateCsv(text) {
  const lines = text.split("\n").filter((line) => line.trim());
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/^#/, "").indexOf("HostName") === 0) { headerIdx = i; break; }
  }
  if (headerIdx === -1) throw new Error("VPN Gate CSV 表头未找到");
  const header = lines[headerIdx].replace(/^#/, "").split(",").map((h) => h.trim().replace(/^\*/, "").toLowerCase());
  let iHost = header.indexOf("hostname");
  let iCountry = header.indexOf("countryshort");
  let iCountryLong = header.indexOf("countrylong");
  let iB64 = header.indexOf("openvpn_configdata_base64");
  if (iB64 === -1) {
    for (let i = 0; i < header.length; i++) {
      if (header[i].indexOf("base64") !== -1) { iB64 = i; break; }
    }
  }
  if (iHost === -1) iHost = 0;
  if (iCountry === -1) iCountry = 6;
  const out = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length < 7) continue;
    const host = (cols[iHost] || "").trim();
    const b64 = iB64 >= 0 ? (cols[iB64] || "").trim() : "";
    if (!host || !b64) continue;
    let cfgText = "";
    try { cfgText = b64ToText(b64); } catch (e) { continue; }
    if (!/^proto\s+(tcp|tcp4|tcp6)\b/m.test(cfgText)) continue;
    const m = /^remote\s+\S+\s+(\d+)/m.exec(cfgText);
    if (!m) continue;
    const port = parseInt(m[1], 10);
    if (!(port >= 1 && port <= 65535)) continue;
    const fullHost = host.indexOf(".opengw.net") === -1 ? host + ".opengw.net" : host;
    const cc = (cols[iCountry] || "").trim().toUpperCase();
    out.push({
      address: "sstp://vpn:vpn@" + fullHost + ":" + port,
      country: cc,
      countryCn: "",
      countryEn: iCountryLong >= 0 ? (cols[iCountryLong] || "").trim() : "",
      countryEmoji: "",
      continent: continentOf(cc),   // VPN Gate 不提供大洲，本地兜底
      continentCn: "",
      city: "",
      asn: "",
      org: "VPN Gate",
    });
  }
  return out;
}

function parseMirrorJson(data) {
  const items = Array.isArray(data) ? data : [data];
  const servers = [];
  for (const item of items) {
    if (item && Array.isArray(item.servers)) servers.push.apply(servers, item.servers);
    else if (item && typeof item === "object") servers.push(item);
  }
  const out = [];
  for (const s of servers) {
    const host = String(s.hostname || s.host || "").trim();
    const b64 = String(s.openvpn_configdata_base64 || s.config_b64 || "").trim();
    if (!host || !b64) continue;
    let cfgText = "";
    try { cfgText = b64ToText(b64); } catch (e) { continue; }
    if (!/^proto\s+(tcp|tcp4|tcp6)\b/m.test(cfgText)) continue;
    const m = /^remote\s+\S+\s+(\d+)/m.exec(cfgText);
    if (!m) continue;
    const port = parseInt(m[1], 10);
    const fullHost = host.indexOf(".opengw.net") === -1 ? host + ".opengw.net" : host;
    const cc = String(s.countryshort || s.country_short || "").trim().toUpperCase();
    out.push({
      address: "sstp://vpn:vpn@" + fullHost + ":" + port,
      country: cc,
      countryCn: "",
      countryEn: String(s.countrylong || s.country_long || "").trim(),
      countryEmoji: "",
      continent: continentOf(cc),
      continentCn: "",
      city: "", asn: "", org: "VPN Gate",
    });
  }
  return out;
}

function parseProxyList(data, type) {
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.proxies) ? data.proxies : []);
  const out = [];
  for (const item of list) {
    if (!item) continue;
    let address = String(item.proxy || item.address || "").trim();
    if (!address) {
      const ip = item.ip;
      const port = item.port;
      if (!ip || !port) continue;
      address = type + "://" + ip + ":" + port;
    }
    if (address.indexOf("://") === -1) address = type + "://" + address;
    out.push({
      address,
      country: String(item.country || "").trim().toUpperCase(),
      countryCn: String(item.country_cn || "").trim(),
      countryEn: String(item.country_en || "").trim(),
      countryEmoji: String(item.country_emoji || "").trim(),
      continent: String(item.continent || "").trim().toUpperCase(),
      continentCn: String(item.continent_cn || "").trim(),
      city: String(item.city || "").trim(),
      asn: String(item.asn || "").trim(),
      org: String(item.asOrganization || item.org || "").trim(),
    });
  }
  return out;
}

function parseProxyIpList(data) {
  const arr = data && Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
  const out = [];
  for (const item of arr) {
    if (!item || !item.ip) continue;
    let ports = item.port;
    if (!Array.isArray(ports)) ports = ports ? [ports] : [443];
    const port = ports.indexOf(443) !== -1 ? 443 : ports[0];
    if (!port) continue;
    const meta = item.meta || {};
    out.push({
      address: String(item.ip).trim() + ":" + port,
      country: String(meta.country || "").trim().toUpperCase(),
      countryCn: String(meta.country_cn || "").trim(),
      countryEn: String(meta.country_en || "").trim(),
      countryEmoji: String(meta.country_emoji || "").trim(),
      continent: String(meta.continent || "").trim().toUpperCase(),
      continentCn: String(meta.continent_cn || "").trim(),
      city: String(meta.city || "").trim(),
      asn: String(meta.asn || "").trim(),
      org: String(meta.asOrganization || "").trim(),
    });
  }
  return out;
}

async function fetchCandidates(type, cfg) {
  const sources = Object.assign({}, DEFAULT_SOURCES, cfg.sources || {});
  if (type === "sstp") {
    try {
      const res = await fetchWithTimeout(sources.vpngate, 30000, { headers: { "User-Agent": "Mozilla/5.0 (compatible; proxy-optimizer)" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const rows = parseVpngateCsv(await res.text());
      if (!rows.length) throw new Error("官方源解析出 0 个 SSTP 节点");
      return rows;
    } catch (e) {
      const res = await fetchWithTimeout(sources.vpngateMirror, 30000, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error("VPN Gate 官方源与镜像都失败: " + e.message);
      return parseMirrorJson(await res.json());
    }
  }
  const url = sources[type];
  if (!url) throw new Error("类型 " + type + " 没有配置数据源");
  const res = await fetchWithTimeout(url, 45000, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("数据源返回 HTTP " + res.status);
  const data = await res.json();
  return type === "proxyip" ? parseProxyIpList(data) : parseProxyList(data, type);
}

/* ========================================================================== *
 *  五、KV 与状态
 * ========================================================================== */

async function kvGet(env, key, fallback) {
  try {
    const raw = await env.CSP.get(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

async function kvPut(env, key, value) {
  await env.CSP.put(key, JSON.stringify(value));
}

// 配置版本。v1 的旧配置里存过 maxPool / maxPerType 两个人为上限，v2 起不再有这两项，
// 旧配置里的残留字段在 normalizeConfig 里被忽略掉，等价于全量。
const CONFIG_VERSION = 2;

function normalizeConfig(raw) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, raw || {});
  cfg.domain = String(cfg.domain === undefined || cfg.domain === null ? "" : cfg.domain).trim() || DEFAULT_CONFIG.domain;
  cfg.concurrency = Math.max(1, Math.min(32, parseInt(cfg.concurrency, 10) || DEFAULT_CONFIG.concurrency));
  cfg.timeoutMs = Math.max(1000, Math.min(120000, parseInt(cfg.timeoutMs, 10) || DEFAULT_CONFIG.timeoutMs));
  cfg.budgetMs = DEFAULT_CONFIG.budgetMs;   // 固定值，不接受 KV 里的旧配置覆盖
  delete cfg.maxPool;
  delete cfg.maxPerType;
  delete cfg.sstpTimeoutMs;                 // 已合并进 timeoutMs，洗掉旧配置里的字段
  if (!Array.isArray(cfg.autoTypes)) cfg.autoTypes = DEFAULT_CONFIG.autoTypes.slice();
  cfg.autoTypes = cfg.autoTypes.filter((t) => PROTOCOLS.indexOf(t) !== -1);
  cfg.sources = Object.assign({}, DEFAULT_SOURCES, cfg.sources || {});
  cfg.v = CONFIG_VERSION;
  return cfg;
}

async function loadConfig(env) {
  const raw = await kvGet(env, "config", null);
  const cfg = normalizeConfig(raw);
  // 老配置里带着已经废掉的 maxPool / maxPerType，顺手写回一份干净的
  if (raw && parseInt(raw.v, 10) !== CONFIG_VERSION) {
    try { await kvPut(env, "config", cfg); } catch (e) { /* 写回失败不影响本次 */ }
  }
  return cfg;
}

const EMPTY_BEST = { runAt: 0, done: 0, items: [], ok: 0, total: 0, regionsKey: "" };

// 地区选择：KV key = region:<type>，存国家码数组；空数组 = 全部地区
// 面板只允许单选；历史数据里若存了多个，这里只保留第一个
async function getRegions(env, type) {
  const raw = await kvGet(env, "region:" + type, null);
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x || "").toUpperCase()).filter((x) => x).slice(0, 1);
}

function pickCountry(item) {
  return String((item && item.country) || "").toUpperCase() || "XX";
}

// 只刷新候选池，绝对不动 best（已优选出的结果与进度）。
// 之前这里会把 best 重置成 EMPTY_BEST，导致每次进面板自动拉取后结果全没了。
// 池子换了之后游标的作废放在 runChunk 里判断（按池子大小），不在这里一刀切清空。
async function fetchAndStore(env, type, cfg) {
  const items = await fetchCandidates(type, cfg);
  await kvPut(env, "pool:" + type, { fetchedAt: Date.now(), count: items.length, items });
  return items.length;
}

// 一次调用只测一小批（受 budgetMs 约束），返回进度；面板循环调用直到 finished
// regionsOverride：定时任务用 DOMAIN 指定的地区，传进来就优先于面板里存的地区选择
async function runChunk(env, type, cfg, restart, regionsOverride) {
  const pool = await kvGet(env, "pool:" + type, { items: [], fetchedAt: 0 });
  const best = await kvGet(env, "best:" + type, EMPTY_BEST);
  const all = Array.isArray(pool.items) ? pool.items : [];
  if (!all.length) {
    return { type, total: 0, done: 0, finished: true, ok: 0, poolSize: 0, filtered: 0, regions: [], message: "候选池为空，请先拉取候选" };
  }
  const regions = (regionsOverride && regionsOverride.length) ? regionsOverride : await getRegions(env, type);
  const items = regions.length ? all.filter((x) => regions.indexOf(pickCountry(x)) !== -1) : all;
  if (!items.length) {
    await kvPut(env, "best:" + type, Object.assign({}, EMPTY_BEST, { regionsKey: regions.join(",") }));
    return {
      type, total: 0, done: 0, finished: true, ok: 0,
      poolSize: all.length, filtered: 0, regions,
      message: "所选地区在候选池里没有节点（池里共 " + all.length + " 条），换个地区试试",
    };
  }
  // 地区选择变了 → 游标作废，从头测
  const regionsKey = regions.join(",");
  const reset = restart || String(best.regionsKey || "") !== regionsKey;
  const limit = items.length;
  // 用 index 作 key 收集，天然去重：重测同一条会覆盖旧结果，不会在表里出现两遍
  const colMap = new Map();
  if (!reset && Array.isArray(best.items)) {
    for (const it of best.items) colMap.set(it.index, it);
  }
  let cursor = reset ? 0 : (parseInt(best.done, 10) || 0);
  // 候选池大小变了 → 旧的 done 索引不再对得上，游标作废从头测；
  // 已测出的结果仍然保留（按 index 覆盖），不会因为重拉候选而清空
  const prevTotal = parseInt(best.total, 10) || 0;
  if (!reset && prevTotal && prevTotal !== limit) cursor = 0;
  if (cursor > limit) cursor = limit;

  const deadline = Date.now() + cfg.budgetMs;
  const concurrency = cfg.concurrency;
  while (cursor < limit && Date.now() < deadline) {
    const batch = [];
    for (let i = 0; i < concurrency && cursor < limit; i++, cursor++) {
      batch.push({ index: cursor, item: items[cursor] });
    }
    const settled = await Promise.all(batch.map(async (job) => {
      const result = await runCheck(type, job.item.address, cfg);
      return { index: job.index, item: job.item, result };
    }));
    for (const s of settled) colMap.set(s.index, s);
  }

  const collected = Array.from(colMap.values()).sort((a, b) => a.index - b.index);
  const done = cursor;
  const okCount = collected.filter((x) => x.result && x.result.ok).length;
  await kvPut(env, "best:" + type, {
    runAt: Date.now(),
    done,
    items: collected,
    ok: okCount,
    total: limit,
    regionsKey,
  });
  return {
    type,
    total: limit,
    done,
    ok: okCount,
    finished: done >= limit,
    poolSize: all.length,
    filtered: items.length,
    regions,
  };
}

// 按国家码把候选池分组，供面板「选择地区」用。
// 国家中文名/emoji/大洲优先用数据源自带的字段（socks5/http/https 有 country_cn/country_emoji/continent，
// proxyip 有 meta.country_cn/meta.continent），源里没有才落到本地映射表。
function groupRegions(items, selected) {
  const sel = {};
  for (const s of (selected || [])) sel[s] = true;
  const map = {};
  for (const item of (items || [])) {
    const code = pickCountry(item);
    if (!map[code]) {
      const continent = String(item.continent || "").toUpperCase() || continentOf(code);
      map[code] = {
        code,
        name: item.countryCn || countryName(code, item.countryEn || ""),
        emoji: item.countryEmoji || "",
        continent,
        continentName: item.continentCn || CONTINENT_LABEL[continent] || continent,
        continentEmoji: CONTINENT_EMOJI[continent] || "🌐",
        count: 0,
      };
    }
    map[code].count++;
  }
  const rank = (c) => {
    const i = CONTINENT_ORDER.indexOf(c);
    return i === -1 ? CONTINENT_ORDER.length : i;
  };
  const out = [];
  for (const code in map) {
    map[code].selected = !!sel[code];
    out.push(map[code]);
  }
  out.sort((a, b) => (rank(a.continent) - rank(b.continent)) || (b.count - a.count));
  return out;
}

function sortedResults(entry) {
  const items = (entry && Array.isArray(entry.items)) ? entry.items.slice() : [];
  items.sort((a, b) => {
    const aOk = a.result && a.result.ok ? 0 : 1;
    const bOk = b.result && b.result.ok ? 0 : 1;
    if (aOk !== bOk) return aOk - bOk;
    const aL = a.result && Number.isFinite(a.result.latency) ? a.result.latency : 999999;
    const bL = b.result && Number.isFinite(b.result.latency) ? b.result.latency : 999999;
    return aL - bL;
  });
  return items;
}

function countryName(code, fallback) {
  if (fallback) return fallback;
  const key = String(code || "").toUpperCase();
  return COUNTRY_ZH[key] || key || "XX";
}

// 中文国名 → 两位国家码（COUNTRY_ZH 的反查表），供 DOMAIN 变量用
// 顺便把「中国香港 / 中国台湾 / 中国澳门」这类带前缀的名字，额外注册一个短名（香港 / 台湾 / 澳门）
const COUNTRY_CODE_BY_ZH = (function () {
  const m = {};
  const add = (name, code) => { if (name && !m[name]) m[name] = code; };
  for (const code in COUNTRY_ZH) {
    const zh = COUNTRY_ZH[code];
    add(zh, code);
    if (zh && zh.indexOf("中国") === 0 && zh.length > 2) add(zh.slice(2), code);
  }
  return m;
})();

// DOMAIN / 地区输入 → 两位国家码。认：两位码（hk）、中文名（香港）、带前缀写法的短名、英文名取不到就返回空
function resolveCountryCode(input) {
  const s = String(input === undefined || input === null ? "" : input).trim();
  if (!s) return "";
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  const up = s.toUpperCase();
  if (COUNTRY_ZH[up]) return up;
  if (COUNTRY_CODE_BY_ZH[s]) return COUNTRY_CODE_BY_ZH[s];

  // 兜底：按结尾匹配，取名字最短的那个（最具体），避免「几内亚」误配到「赤道几内亚」
  let best = "";
  let bestLen = Infinity;
  for (const code in COUNTRY_ZH) {
    const zh = COUNTRY_ZH[code];
    if (!zh || zh.length < 2) continue;
    if (zh === s || (s.length >= 2 && zh.endsWith(s))) {
      if (zh.length < bestLen) { bestLen = zh.length; best = code; }
    }
  }
  return best;
}

async function buildState(env, cfg) {
  const state = { config: cfg, types: {}, meta: await kvGet(env, "meta", {}) };
  // 并发读：原来 5 个协议逐个 await（共 16 次串行 KV 读），池子大的协议一读就是几百毫秒。
  // 改成一轮 Promise.all，协议内 pool/best/regions 也并发，首屏等待从"累加"变"取最慢那个"。
  const built = await Promise.all(PROTOCOLS.map(async (type) => {
    const [pool, best, regionSelected] = await Promise.all([
      kvGet(env, "pool:" + type, { items: [], fetchedAt: 0 }),
      kvGet(env, "best:" + type, { runAt: 0, done: 0, items: [], ok: 0, total: 0 }),
      getRegions(env, type),
    ]);
    const items = sortedResults(best);
    const okItems = items.filter((x) => x.result && x.result.ok);
    const fastest = okItems.length ? okItems[0].result.latency : null;
    const poolItems = Array.isArray(pool.items) ? pool.items : [];
    const filteredCount = regionSelected.length
      ? poolItems.filter((x) => regionSelected.indexOf(pickCountry(x)) !== -1).length
      : poolItems.length;
    const entry = {
      label: TYPE_LABEL[type],
      poolCount: poolItems.length,
      filteredCount,
      regions: groupRegions(poolItems, regionSelected),
      regionSelected,
      fetchedAt: pool.fetchedAt || 0,
      total: best.total || 0,
      done: best.done || 0,
      ok: okItems.length,
      fastestMs: fastest,
      runAt: best.runAt || 0,
      finished: (best.done || 0) >= (best.total || 0) && (best.total || 0) > 0,
      results: items.slice(0, 200).map((x) => ({
        address: x.item.address,
        country: (x.result && x.result.country) || x.item.country || "",
        countryEmoji: x.item.countryEmoji || "",
        countryName: x.item.countryCn || countryName((x.result && x.result.country) || x.item.country, x.item.countryEn || ""),
        city: x.item.city || "",
        org: x.item.org || "",
        ok: !!(x.result && x.result.ok),
        latency: x.result ? x.result.latency : null,
        exitIp: (x.result && x.result.exitIp) || "",
        colo: (x.result && x.result.colo) || "",
        mode: (x.result && x.result.mode) || "",
        error: (x.result && x.result.error) || "",
      })),
    };
    return { type, entry };
  }));
  for (const b of built) state.types[b.type] = b.entry;
  return state;
}

/* ========================================================================== *
 *  六、HTTP 路由
 * ========================================================================== */

function json(data, status, extraHeaders) {
  const headers = { "Content-Type": "application/json;charset=utf-8", "Cache-Control": "no-store" };
  if (extraHeaders) for (const k in extraHeaders) headers[k] = extraHeaders[k];
  return new Response(JSON.stringify(data, null, 2), { status: status || 200, headers });
}

function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const parts = raw.split(";");
  for (const part of parts) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const PWD_KEY = "pwd";

// 管理密码存在 KV（键 pwd），落盘的是 SHA-256 十六进制，明文不落盘
async function hashPwd(pwd) {
  const data = new TextEncoder().encode("zq-csp::" + String(pwd === undefined || pwd === null ? "" : pwd));
  const buf = await crypto.subtle.digest("SHA-256", data);
  const arr = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
  return out;
}

async function getPwdHash(env) {
  try {
    const v = await env.CSP.get(PWD_KEY);
    return v || "";
  } catch (e) {
    return "";
  }
}

// 登录 Cookie（值就是密码哈希），30 天有效；HttpOnly，脚本读不到
function authCookie(hash) {
  return "zq_auth=" + hash + "; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax";
}

// 认两种凭证：Cookie zq_auth（值就是密码哈希）或 URL 上的 ?pwd=明文密码
async function authed(request, env, url) {
  const stored = await getPwdHash(env);
  if (!stored) return false;
  const cookie = getCookie(request, "zq_auth");
  if (cookie && cookie === stored) return true;
  // ?pwd= 认两种值：明文密码（老配置里填的），或令牌（= 密码哈希，面板复制的地址里带的就是它）
  const pwd = url.searchParams.get("pwd");
  if (pwd && (pwd === stored || (await hashPwd(pwd)) === stored)) return true;
  return false;
}

function textError(message) {
  return new Response(message, { status: 500, headers: { "Content-Type": "text/plain;charset=utf-8" } });
}

async function handleAdmin(request, env, url) {
  if (!env.CSP) {
    return textError("未绑定 KV 命名空间：请在 Worker 的「设置 → 绑定」里添加一个 KV 命名空间，变量名必须填 CSP。");
  }
  const stored = await getPwdHash(env);
  const pageHeaders = { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" };
  // 还没设过密码 → 引导设置（第一次部署进来就是这个页面）
  if (!stored) return new Response(setupHtml(), { headers: pageHeaders });

  // 兼容老的 ?pwd= 入口：校验通过就种 Cookie，并立刻跳回不带密码的 /admin，不让明文密码留在地址栏
  const pwdParam = url.searchParams.get("pwd");
  if (pwdParam) {
    const rHeaders = { "Cache-Control": "no-store", "Location": "/admin" };
    if ((await hashPwd(pwdParam)) === stored) {
      rHeaders["Set-Cookie"] = authCookie(stored);
    }
    return new Response(null, { status: 302, headers: rHeaders });
  }
  if (!(await authed(request, env, url))) {
    return new Response(loginHtml(), { status: 401, headers: pageHeaders });
  }
  const cfg = await loadConfig(env);
  return new Response(renderPanel(cfg, stored), { headers: pageHeaders });
}

async function handleCheck(request, env, url) {
  const protocol = ["socks5", "http", "https", "sstp", "proxyip"].find((k) => url.searchParams.has(k));
  if (!protocol) return json({ error: "缺少代理参数，用法 /check?socks5=host:port（支持 socks5/http/https/sstp/proxyip）" }, 400);
  const address = url.searchParams.get(protocol);
  const cfg = await loadConfig(env);
  const result = await runCheck(protocol, address, cfg);
  return json({
    success: result.ok,
    proxy: protocol + "://" + address,
    ip: result.exitIp || null,
    loc: result.country || null,
    colo: result.colo || null,
    mode: result.mode || null,
    responseTime: result.latency,
    error: result.error || null,
  });
}

// 结果接口：GET /list/<协议|all>（需带 ?pwd=管理密码，或已登录的 Cookie）
//   默认 text/plain，每行「地址#协议-国家-延迟」
//   带 ?format=json 时返回 JSON（含协议/地址/延迟/出口IP/国家/机房）
async function handleList(request, env, url) {
  if (!env.CSP) return textError("未绑定 KV 命名空间（变量名必须填 CSP）");
  if (!(await authed(request, env, url))) {
    return new Response("未授权：这个地址要带上管理密码，例如 /list/socks5?pwd=你的密码", {
      status: 401,
      headers: { "Content-Type": "text/plain;charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
    });
  }
  let seg = "";
  try {
    seg = decodeURIComponent(url.pathname.slice("/list/".length));
  } catch (e) {
    seg = url.pathname.slice("/list/".length);
  }
  seg = seg.replace(/\/+$/, "").trim().toLowerCase();
  const type = (seg === "" || seg === "all") ? "" : seg;
  if (type && PROTOCOLS.indexOf(type) === -1) {
    return json({ error: "协议类型无效，可选 socks5 / http / https / sstp / proxyip / all" }, 400);
  }
  const types = type ? [type] : PROTOCOLS.slice();
  const rows = [];
  const lines = [];
  for (const t of types) {
    const best = await kvGet(env, "best:" + t, EMPTY_BEST);
    const okItems = sortedResults(best).filter((x) => x.result && x.result.ok);
    for (const x of okItems) {
      const cname = x.item.countryCn || countryName((x.result && x.result.country) || x.item.country, x.item.countryEn || "");
      const lat = (x.result && Number.isFinite(x.result.latency)) ? x.result.latency : 0;
      lines.push(x.item.address + "#" + TYPE_LABEL[t] + "-" + cname + "-" + lat + "ms");
      rows.push({
        protocol: t,
        address: x.item.address,
        latency: lat,
        exitIp: (x.result && x.result.exitIp) || "",
        country: cname,
        colo: (x.result && x.result.colo) || "",
      });
    }
  }
  if (url.searchParams.get("format") === "json") {
    return json({ count: rows.length, type: type || "all", updatedAt: Date.now(), nodes: rows });
  }
  return new Response(lines.length ? lines.join("\n") + "\n" : "", {
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handleApi(request, env, url, ctx) {
  if (!env.CSP) return json({ error: "未绑定 KV 命名空间（变量名必须填 CSP）" }, 500);
  const path = url.pathname;
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

  // 首次设置管理密码：此时 KV 里还没有密码，必须先于鉴权处理
  if (path === "/api/setup") {
    const stored = await getPwdHash(env);
    if (stored) return json({ error: "管理密码已经设置过了" }, 400);
    const np = String(body.password || "");
    if (np.length < 4) return json({ error: "密码至少 4 位" }, 400);
    const h = await hashPwd(np);
    await env.CSP.put(PWD_KEY, h);
    return json({ success: true, token: h }, 200, { "Set-Cookie": authCookie(h) });
  }

  // 密码登录：校验通过后下发 Cookie，前端随后跳到干净的 /admin，地址栏不留明文密码
  if (path === "/api/login") {
    const stored = await getPwdHash(env);
    if (!stored) return json({ error: "还没有设置管理密码" }, 400);
    const pw = String(body.password || "");
    if (!pw || (await hashPwd(pw)) !== stored) return json({ error: "密码错误" }, 401);
    return json({ success: true, token: stored }, 200, { "Set-Cookie": authCookie(stored) });
  }

  if (!(await authed(request, env, url))) return json({ error: "未授权，请打开 /admin 登录" }, 401);
  const cfg = await loadConfig(env);

  if (path === "/api/state") return json(await buildState(env, cfg));

  const type = body.type || url.searchParams.get("type");

  if (path === "/api/pwd") {
    const np = String(body.newPwd || "");
    if (np.length < 4) return json({ error: "新密码至少 4 位" }, 400);
    const h = await hashPwd(np);
    await env.CSP.put(PWD_KEY, h);
    return json({ success: true, token: h }, 200, { "Set-Cookie": authCookie(h) });
  }

  if (path === "/api/config") {
    const next = normalizeConfig(Object.assign({}, cfg, body.config || body));
    await kvPut(env, "config", next);
    return json({ success: true, config: next });
  }

  if (path === "/api/fetch") {
    if (PROTOCOLS.indexOf(type) === -1) return json({ error: "类型无效" }, 400);
    try {
      const count = await fetchAndStore(env, type, cfg);
      return json({ success: true, type, poolCount: count });
    } catch (e) {
      return json({ success: false, type, error: String((e && e.message) || e) }, 200);
    }
  }

  if (path === "/api/region") {
    if (PROTOCOLS.indexOf(type) === -1) return json({ error: "类型无效" }, 400);
    const regions = Array.isArray(body.regions)
      ? body.regions.map((x) => String(x || "").toUpperCase()).filter((x) => x).slice(0, 1)
      : [];
    await kvPut(env, "region:" + type, regions);
    // 换了地区，之前那轮的游标和结果就对不上了，直接作废重来
    await kvPut(env, "best:" + type, Object.assign({}, EMPTY_BEST, { regionsKey: regions.join(",") }));
    const state = await buildState(env, cfg);
    return json({ success: true, type, regions, filteredCount: state.types[type].filteredCount });
  }

  if (path === "/api/optimize") {
    if (PROTOCOLS.indexOf(type) === -1) return json({ error: "类型无效" }, 400);
    try {
      const result = await runChunk(env, type, cfg, !!body.restart);
      if (result.finished) {
        const meta = await kvGet(env, "meta", {});
        meta.lastRun = Date.now();
        meta.lastType = type;
        await kvPut(env, "meta", meta);
      }
      return json(Object.assign({ success: true }, result));
    } catch (e) {
      return json({ success: false, type, error: String((e && e.message) || e) }, 200);
    }
  }

  if (path === "/api/test") {
    if (PROTOCOLS.indexOf(type) === -1) return json({ error: "类型无效" }, 400);
    if (!body.address) return json({ error: "缺少 address" }, 400);
    const result = await runCheck(type, body.address, cfg);
    return json(Object.assign({ success: true, type, address: body.address }, result));
  }

  if (path === "/api/clear") {
    if (PROTOCOLS.indexOf(type) === -1) return json({ error: "类型无效" }, 400);
    await kvPut(env, "best:" + type, { runAt: 0, done: 0, items: [], ok: 0, total: 0 });
    return json({ success: true, type });
  }

  return json({ error: "未知接口" }, 404);
}

/* ========================================================================== *
 *  七、管理面板
 * ========================================================================== */

const AUTH_CSS = `*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;
background:#eef1f6;background-image:radial-gradient(900px 420px at 12% -10%,#dfeaf7 0%,rgba(223,234,247,0) 60%),radial-gradient(700px 380px at 92% 108%,#e6ecfa 0%,rgba(230,236,250,0) 60%);
font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#101828}
form{width:100%;max-width:360px;background:#fff;padding:30px 26px 26px;border-radius:16px;border:1px solid #e4e7ec;box-shadow:0 10px 30px rgba(16,24,40,.08)}
h1{margin:0 0 6px;font-size:16px;font-weight:600;letter-spacing:.2px;text-align:center}
p{margin:0 0 18px;font-size:12.5px;color:#667085;line-height:1.7}
p b{color:#344054}
input{width:100%;padding:10px 12px;border:1px solid #d0d5dd;border-radius:10px;font:inherit;font-size:14px;transition:.15s;margin-bottom:10px}
input:focus{outline:none;border-color:#7fb0dd;box-shadow:0 0 0 3px rgba(24,95,165,.13)}
button{margin-top:6px;width:100%;padding:10px;border:0;border-radius:10px;background:#185FA5;color:#fff;font:inherit;font-size:14px;font-weight:500;cursor:pointer;transition:.15s}
button:hover{background:#134d87}
.msg{margin-top:10px;font-size:12.5px;color:#b42318;min-height:16px}
`;

// 站点图标（内联 SVG，不额外占用路由）；登录页与管理面板共用同一份
const FAVICON_LINK = "<link rel=\"icon\" type=\"image/svg+xml\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='13' cy='13' r='8.5' fill='none' stroke='%23185FA5' stroke-width='3'/><path d='M20 20 27.2 27.2' stroke='%23185FA5' stroke-width='3.4' stroke-linecap='round'/><text x='13' y='16.9' font-family='sans-serif' font-size='11' font-weight='800' fill='%23185FA5' text-anchor='middle'>IP</text></svg>\">";

function authPage(inner, script) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZQ-CSP</title>
${FAVICON_LINK}
<style>${AUTH_CSS}</style>
</head>
<body>
${inner}
${script}
</body>
</html>`;
}

// 登录 / 首次设密两页的表单脚本：流程完全一样，只有「取值字段、校验规则、接口、失败文案」不同
function authScript(formId, valueIds, checks, endpoint, failMsg) {
  return "<script>"
    + "var f=document.getElementById('" + formId + "'),m=document.getElementById('msg'),I=" + JSON.stringify(valueIds) + ";"
    + "f.addEventListener('submit',function(e){"
    + "e.preventDefault();"
    + "var v={};for(var i=0;i<I.length;i++){v[I[i]]=document.getElementById(I[i]).value;}"
    + "m.textContent='';"
    + checks
    + "fetch('" + endpoint + "',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:v[I[0]]})})"
    + ".then(function(r){return r.json();})"
    + ".then(function(j){if(j.success){location.replace('/admin');}else{m.textContent=j.error||'" + failMsg + "';}})"
    + ".catch(function(err){m.textContent='异常：'+err.message;});"
    + "});"
    + "</" + "script>";
}

function loginHtml() {
  const form = ""
    + "<form id=\"loginForm\">"
    + "<h1>ZQ-CSP</h1>"
    + "<input type=\"password\" id=\"pwd\" placeholder=\"管理密码\" autofocus>"
    + "<button type=\"submit\">进入</button>"
    + "<div class=\"msg\" id=\"msg\"></div>"
    + "</form>";
  const script = authScript("loginForm", ["pwd"],
    "if(!v[I[0]]){m.textContent='请输入管理密码';return;}",
    "/api/login", "密码错误");
  return authPage(form, script);
}

function setupHtml() {
  const form = ""
    + "<form id=\"setupForm\">"
    + "<h1>先设置管理密码</h1>"
    + "<p>这是第一次进入，密码会存进你的 KV（只存哈希，不存明文）。忘了的话，可以在 Cloudflare 后台把 KV 里的 <b>pwd</b> 键删掉，再回来重设。</p>"
    + "<input type=\"password\" id=\"p1\" placeholder=\"设置密码（至少 4 位）\" autofocus>"
    + "<input type=\"password\" id=\"p2\" placeholder=\"再输入一次\">"
    + "<button type=\"submit\">完成并进入</button>"
    + "<div class=\"msg\" id=\"msg\"></div>"
    + "</form>";
  const script = authScript("setupForm", ["p1", "p2"],
    "if(v[I[0]].length<4){m.textContent='密码至少 4 位';return;}"
    + "if(v[I[0]]!==v[I[1]]){m.textContent='两次输入不一致';return;}",
    "/api/setup", "设置失败");
  return authPage(form, script);
}

function renderPanel(cfg, token) {
  const initial = JSON.stringify({
    token: token || "",
    protocols: PROTOCOLS,
    labels: TYPE_LABEL,
    continents: CONTINENT_LABEL,
    continentOrder: CONTINENT_ORDER,
    countryZh: COUNTRY_ZH,
    config: cfg,
    repo: "https://github.com/bayueqi/ZQ-CSP",
  });
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZQ-CSP</title>
${FAVICON_LINK}
<style>
:root{
  --bg:#eef1f6; --panel:#fff; --line:#e4e7ec; --line2:#eef1f5;
  --tx:#101828; --tx2:#475467; --tx3:#98a2b3;
  --brand:#185FA5; --brand-d:#134d87; --brand-l:#eaf2fb;
  --ok:#067647; --ok-bg:#e7f6ec; --bad:#b42318; --bad-bg:#feeceb;
  --r:14px; --sh:0 1px 2px rgba(16,24,40,.04),0 2px 6px rgba(16,24,40,.05);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
a{color:var(--brand);text-decoration:none}
a:hover{text-decoration:underline}

.top{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.88);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.top .in{max-width:1180px;margin:0 auto;padding:11px 18px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.brand{font-size:15px;font-weight:600;display:flex;align-items:center;gap:9px}
.brand i{width:9px;height:9px;border-radius:3px;background:var(--brand);display:block}
.spacer{flex:1}
.chip{font-size:12px;color:var(--tx2);background:#f2f4f7;border:1px solid var(--line);border-radius:999px;padding:2px 10px;white-space:nowrap}

.wrap{max-width:1180px;margin:0 auto;padding:18px 18px 64px}

.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px;margin-bottom:14px}
.card h2{font-size:14px;font-weight:600;margin:0 0 12px;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.card h2 .dot{width:7px;height:7px;border-radius:50%;background:var(--brand);flex:none}
.card h2 .apibox{margin:0 0 0 auto;padding:5px 9px;font-size:12px;font-weight:400}
.tag{font-size:11.5px;font-weight:500;color:var(--tx2);background:#f2f4f7;border:1px solid var(--line2);border-radius:999px;padding:1px 9px}
.tag.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}

details.card>summary{cursor:pointer;font-size:14px;font-weight:600;list-style:none;display:flex;align-items:center;gap:9px}
details.card>summary::-webkit-details-marker{display:none}
details.card>summary::after{content:"展开";margin-left:auto;font-size:12px;font-weight:400;color:var(--tx3)}
details.card[open]>summary::after{content:"收起"}
details.card[open]>summary{margin-bottom:14px}

button{font:inherit;font-size:13px;font-weight:500;padding:7px 13px;border:1px solid var(--line);background:#fff;border-radius:9px;cursor:pointer;color:var(--tx);transition:background .15s,border-color .15s,transform .06s;white-space:nowrap}
button:hover{border-color:#cdd3dc;background:#fafbfc}
button:active{transform:translateY(1px)}
button:focus-visible{outline:2px solid #9cc3e8;outline-offset:1px}
button.primary{background:var(--brand);border-color:var(--brand);color:#fff;box-shadow:0 1px 2px rgba(24,95,165,.25)}
button.primary:hover{background:var(--brand-d);border-color:var(--brand-d)}
button.ghost{background:#f8f9fb;color:var(--tx2)}
button.danger{color:var(--bad);border-color:#f2c7c3;background:#fff}
button.danger:hover{background:var(--bad-bg);border-color:#e6a6a0}
button.sm{padding:5px 10px;font-size:12.5px}
button:disabled{opacity:.45;cursor:not-allowed;transform:none;box-shadow:none}

.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
label.f{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--tx2)}
input[type=text],input[type=number],input[type=password]{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--line);border-radius:9px;color:var(--tx);width:100%;background:#fff;transition:.15s}
input[type=text]:focus,input[type=number]:focus,input[type=password]:focus{outline:none;border-color:#7fb0dd;box-shadow:0 0 0 3px rgba(24,95,165,.13)}

.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;margin:0 0 12px}
.metric{background:#f8f9fb;border:1px solid var(--line2);border-radius:10px;padding:8px 10px;min-width:0}
.metric .k{display:block;font-size:11.5px;color:var(--tx3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.metric b{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}
.metric.hi b{color:var(--brand)}
.metric.zero b{color:var(--tx3);font-weight:500}

.bar{height:6px;border-radius:999px;background:#e9edf2;overflow:hidden;margin:0 0 12px}
.bar>i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--brand),#4a92d6);transition:width .35s ease}
.bar.done>i{background:linear-gradient(90deg,#0f9d58,#45c07f)}

.card.proto{position:relative;overflow:hidden;padding-left:21px}
.card.proto::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--acc,var(--brand))}
.scroll{max-height:330px;overflow:auto;border:1px solid var(--line2);border-radius:10px;margin-top:10px}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px}
thead th{position:sticky;top:0;z-index:1;background:#f8f9fb;text-align:left;color:var(--tx2);font-weight:600;padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
tbody td{padding:6px 10px;border-bottom:1px solid var(--line2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:#fafbfc}
tr.dead td{color:var(--tx3)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11.5px;font-weight:500}
.pill.ok{background:var(--ok-bg);color:var(--ok)}
.pill.bad{background:var(--bad-bg);color:var(--bad)}

.hint{color:var(--tx2);font-size:12.5px;margin-top:8px}
.hint code,.row code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
code{background:#f2f4f7;border:1px solid var(--line2);border-radius:6px;padding:2px 7px;font-size:12.5px;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
.empty{color:var(--tx3);font-size:12.5px;padding:14px 2px;text-align:center}
.boot{display:flex;align-items:center;justify-content:center;gap:9px;padding:38px 0;color:var(--tx3);font-size:13px}
.boot .sp{width:15px;height:15px;border:2px solid #dfe4ea;border-top-color:var(--brand);border-radius:50%;animation:spin .8s linear infinite;flex:none}

.log{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.7;background:#111827;color:#c7d2e0;border-radius:10px;padding:11px 13px;max-height:150px;overflow:auto;white-space:pre-wrap;margin-top:12px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.04)}

.regbox{display:none;margin-top:10px;border:1px solid var(--line2);border-radius:10px;background:#fafbfc;padding:4px 12px 12px}
.regbox.open{display:block}
.rgroup{margin-bottom:4px}
.rtitle{font-size:11px;font-weight:600;color:var(--tx3);letter-spacing:.4px;margin:12px 0 5px}
.rgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:1px 8px}
.rline{display:flex;align-items:center;gap:7px;padding:3px 6px;border-radius:7px;cursor:pointer;font-size:12.5px}
.rline:hover{background:#eef1f5}
.rline input{flex:none;margin:0;accent-color:var(--brand);width:14px;height:14px}
.rname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rcode{color:var(--tx3);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.rcount{color:var(--tx2);font-size:11.5px;min-width:40px;text-align:right;font-variant-numeric:tabular-nums}
.regscroll{max-height:300px;overflow:auto;padding-right:4px}

.tabs{display:flex;gap:2px;flex-wrap:wrap;margin-left:4px}
.tab{background:transparent;border:0;color:var(--tx2);font-size:13.5px;font-weight:500;padding:6px 12px;border-radius:8px}
.tab:hover{background:#f2f4f7;color:var(--tx);border-color:transparent}
.tab.on{color:var(--brand);background:var(--brand-l)}
.icon{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:1px solid var(--line);background:#fff;border-radius:9px;color:var(--tx2)}
.icon:hover{color:var(--tx);border-color:#cdd3dc;background:#fafbfc}
.icon.spin svg{animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.apibox{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;padding:9px 12px;background:#f8f9fb;border:1px solid var(--line2);border-radius:10px;min-width:0;max-width:100%}
.apik{flex:none;font-size:11px;font-weight:700;letter-spacing:.5px;color:var(--brand);background:var(--brand-l);border-radius:6px;padding:2px 7px}
.apiv{cursor:pointer;background:#fff;margin:0;min-width:0;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.apiv:hover{border-color:#9cc3e8;color:var(--brand)}

.ovgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px;margin-bottom:14px}
.ovcard{position:relative;overflow:hidden;display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:13px 15px 14px 20px;cursor:pointer;transition:border-color .15s}
.ovcard::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--acc,var(--brand))}
.ovcard:hover{border-color:#c3cad6}
.ovtop{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.ovtop b{font-size:13.5px}
.ovnum{display:flex;align-items:baseline;gap:7px}
.ovnum span{font-size:11.5px;color:var(--tx3)}
.ovnum b{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.ovsub{font-size:11.5px;color:var(--tx2);margin-top:6px;margin-bottom:9px}
.ovsec{padding-left:12px;border-left:3px solid var(--acc,var(--brand))}
.ovsec + .ovsec{margin-top:20px}
.ovsech{display:flex;align-items:center;gap:8px;width:100%;text-align:left;font:inherit;font-weight:600;padding:4px 0;border:0;background:transparent;border-radius:0;color:var(--tx);white-space:normal;cursor:pointer}
.ovsech:hover{background:transparent;border-color:transparent;color:var(--tx)}
.ovsech:active{transform:none}
.ovsech b{font-size:13.5px}
.ovsecn{margin-left:auto;font-size:11.5px;font-weight:400;color:var(--tx3)}
.ovsec .chev{width:13px;height:13px;flex:none;color:var(--tx3);transition:transform .15s}
.ovsec.open .chev{transform:rotate(90deg)}
.ovsec.open .ovsech{color:var(--tx)}
.ovbody{display:none;margin-top:8px}
.ovsec.open .ovbody{display:block}

.modal{display:none;position:fixed;inset:0;z-index:60;background:rgba(16,24,40,.45);align-items:center;justify-content:center;padding:18px}
.modal.open{display:flex}
.mbox{width:100%;max-width:430px;max-height:90vh;overflow:auto;background:#fff;border-radius:16px;padding:20px 20px 18px;box-shadow:0 24px 60px rgba(16,24,40,.24)}
.mbox h3{margin:0 0 16px;font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px}
.mbox .f{margin-bottom:12px}
.mbox .hint{margin-top:2px}

@media (max-width:760px){
  .wrap{padding:14px 12px 48px}
  .top .in{padding:10px 12px;gap:8px}
  .brand{font-size:13px}
  /* 顶栏重排：第一行 品牌 + 右侧图标，第二行 Tab 横滑，第三行 状态文字 */
  .spacer{order:2}
  .top .in>.icon{order:3}
  .chip{order:5;flex:0 0 100%}
  .tabs{order:4;flex:0 0 100%;width:100%;margin:0;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}
  .tabs::-webkit-scrollbar{display:none}
  .tab{padding:6px 11px;font-size:13px;flex:none}
  .icon{width:32px;height:32px}
  .card{padding:14px}
  .card h2{font-size:13.5px;margin-bottom:10px}
  .card h2 .apibox{flex:0 0 100%;margin:8px 0 0;padding:8px 10px}
  .apiv{flex:1 1 0;min-width:0}
  .metrics{grid-template-columns:repeat(2,1fr);gap:7px}
  .metric{padding:7px 9px}
  .metric b{font-size:15px}
  .rgrid{grid-template-columns:1fr}
  tbody td{max-width:150px}
  thead th,tbody td{padding:6px 8px}
  .scroll{max-height:250px}
  .mbox{padding:16px 14px}
  .row{gap:7px}
  button{padding:7px 12px}
}
</style>
</head>
<body>
<div class="top"><div class="in">
  <span class="brand"><i></i>ZQ-CSP</span>
  <nav class="tabs" id="tabs"></nav>
  <span class="chip" id="autoStat" style="display:none"></span>
  <span class="spacer"></span>
  <button class="icon" id="btnRefreshAll" title="刷新候选（全部协议）" aria-label="刷新候选">
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>
  </button>
  <a class="icon" href="https://github.com/bayueqi/ZQ-CSP" target="_blank" rel="noopener" title="GitHub 仓库" aria-label="GitHub">
    <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
  </a>
  <button class="icon" id="btnSettings" title="设置" aria-label="设置">
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/><path fill="currentColor" d="M20.3 12.9c.05-.3.08-.6.08-.9s-.03-.6-.08-.9l1.6-1.24a.5.5 0 0 0 .12-.64l-1.9-3.28a.5.5 0 0 0-.6-.22l-2 .8a6.6 6.6 0 0 0-1.56-.9l-.3-2.12A.5.5 0 0 0 15.16 3h-3.8a.5.5 0 0 0-.5.42l-.3 2.12c-.56.24-1.08.54-1.56.9l-2-.8a.5.5 0 0 0-.6.22L4.2 9.14a.5.5 0 0 0 .12.64l1.6 1.24c-.05.3-.08.6-.08.9s.03.6.08.9l-1.6 1.24a.5.5 0 0 0-.12.64l1.9 3.28c.13.22.38.3.6.22l2-.8c.48.36 1 .66 1.56.9l.3 2.12c.04.24.25.42.5.42h3.8c.25 0 .46-.18.5-.42l.3-2.12c.56-.24 1.08-.54 1.56-.9l2 .8c.22.08.47 0 .6-.22l1.9-3.28a.5.5 0 0 0-.12-.64l-1.6-1.24z"/></svg>
  </button>
</div></div>

<main class="wrap">
  <section id="view"></section>

  <section class="card" id="logCard">
    <h2><span class="dot"></span>运行日志
      <button class="sm ghost" id="btnClearLog" style="margin-left:auto">清空日志</button>
    </h2>
    <div class="log" id="logBox">就绪。</div>
  </section>
</main>

<div class="modal" id="mSettings">
  <div class="mbox">
    <h3><span class="dot"></span>设置</h3>
    <label class="f">管理密码（留空 = 不修改）<input type="password" id="cfgPwd" placeholder="至少 4 位"></label>
    <label class="f">DOMAIN · 定时优选地区<input type="text" id="cfgDomain" placeholder="香港"></label>
    <label class="f">并发数（1–32）<input type="number" id="cfgConcurrency" min="1" max="32"></label>
    <label class="f">超时时间 ms<input type="number" id="cfgTimeoutMs" min="1000" max="120000" step="500"></label>
    <div class="hint">DOMAIN 填国家名（香港 / 日本）或两位国家码（HK / JP），定时任务按它挑地区；候选池里没有该地区时会自动跑全部地区。定时任务固定跑 SOCKS5、HTTP、HTTPS、SSTP 四类。</div>
    <div class="row" style="justify-content:flex-end;margin-top:16px">
      <button id="btnSettingsCancel">取消</button>
      <button class="primary" id="btnSettingsSave">保存</button>
    </div>
  </div>
</div>

<script>
(function(){
  var BOOT = ${initial};
  // 凭据令牌：由服务端在渲染本页时注入（值就是密码哈希，与登录 Cookie 同源）
  var PWD = BOOT.token || '';
  var PROTOCOLS = BOOT.protocols;
  var LABELS = BOOT.labels;
  var STATE = null;
  var RUNNING = {};
  var STOPPING = {};
  var ACTIVE = 'overview';
  var REGOPEN = {};
  var OVOPEN = {};
  var AUTOFETCH = false;
  var LOGS = {};
  var TABS = [{ key: 'overview', name: '概览' }];
  for(var ti = 0; ti < PROTOCOLS.length; ti++) TABS.push({ key: PROTOCOLS[ti], name: LABELS[PROTOCOLS[ti]] });
  var POOL_PLACEHOLDER = { socks5: 'socks5://user:pass@host:port', http: 'http://host:port', https: 'https://host:port', sstp: 'sstp://vpn:vpn@host:port', proxyip: 'ip:port' };

  function el(id){ return document.getElementById(id); }
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function esc(s){
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function(c){ return ESC_MAP[c]; });
  }
  // 运行日志：每个协议各存各的，互不混用
  function logPush(type, msg){
    var arr = LOGS[type] || (LOGS[type] = []);
    arr.push({ t: Date.now(), msg: msg });
    if(arr.length > 200) arr.splice(0, arr.length - 200);
  }
  // type 省略时：在协议页记到该协议名下；在概览页（日志不显示）则记给每个协议，免得丢消息
  function log(msg, type){
    var key = type || (PROTOCOLS.indexOf(ACTIVE) !== -1 ? ACTIVE : '');
    if(key) logPush(key, msg);
    else for(var i = 0; i < PROTOCOLS.length; i++) logPush(PROTOCOLS[i], msg);
    renderLog();
  }
  function renderLog(){
    var box = el('logBox');
    if(!box) return;
    var key = PROTOCOLS.indexOf(ACTIVE) !== -1 ? ACTIVE : '';
    var arr = (key && LOGS[key]) ? LOGS[key] : [];
    if(!arr.length){ box.textContent = '就绪。'; return; }
    var lines = [];
    for(var i = arr.length - 1; i >= 0; i--){
      lines.push(new Date(arr[i].t).toLocaleTimeString() + '  ' + arr[i].msg);
    }
    var text = lines.join(String.fromCharCode(10));
    if(text.length > 4000) text = text.slice(0, 4000);
    box.textContent = text;
  }
  function api(path, body){
    var url = path + (path.indexOf('?') >= 0 ? '&' : '?') + 'pwd=' + encodeURIComponent(PWD);
    return fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function(r){
      return r.json().then(function(j){ if(!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
    });
  }
  function fmtTime(ts){ return ts ? new Date(ts).toLocaleString() : '—'; }
  function fmtMs(v){ return (v === null || v === undefined) ? '—' : (v + ' ms'); }

  function bind(id, fn){ var node = el(id); if(node) node.addEventListener('click', fn); }

  function copyText(text){
    function ok(){ log('已复制：' + text); }
    function fallback(){
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { log('复制失败，请手动复制：' + text); }
      document.body.removeChild(ta);
    }
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(ok, fallback);
    } else { fallback(); }
  }

  function apiUrl(type){ return location.origin + '/list/' + type + (PWD ? '?pwd=' + encodeURIComponent(PWD) : ''); }

  function apiBox(type){
    var u = apiUrl(type);
    return '<div class="apibox">'
      + '<span class="apik">API</span>'
      + '<code class="apiv" data-copy="' + esc(u) + '" title="点击复制">' + esc(u) + '</code>'
      + '</div>';
  }

  function openSettings(){
    var c = (STATE && STATE.config) || BOOT.config;
    el('cfgPwd').value = '';
    el('cfgDomain').value = c.domain || '';
    el('cfgConcurrency').value = c.concurrency;
    el('cfgTimeoutMs').value = c.timeoutMs;
    el('mSettings').classList.add('open');
  }
  function closeSettings(){ el('mSettings').classList.remove('open'); }

  function saveSettings(){
    var newPwd = (el('cfgPwd').value || '').trim();
    var cfg = {
      domain: el('cfgDomain').value.trim(),
      concurrency: parseInt(el('cfgConcurrency').value, 10),
      timeoutMs: parseInt(el('cfgTimeoutMs').value, 10)
    };
    api('/api/config', { config: cfg }).then(function(r){
      STATE.config = r.config;
      log('设置已保存（DOMAIN ' + (r.config.domain || '') + '，并发 ' + r.config.concurrency + '，超时 ' + r.config.timeoutMs + 'ms）');
      if(!newPwd){ closeSettings(); return; }
      if(newPwd.length < 4){ log('新密码至少 4 位，密码未修改'); closeSettings(); return; }
      return api('/api/pwd', { newPwd: newPwd }).then(function(p){
        // 服务端已换新令牌，这里同步内存里的值，改密后面板上的地址立刻可用
        if(p.token) PWD = p.token;
        log('管理密码已更新');
        closeSettings();
      });
    }).catch(function(e){ log('保存设置失败：' + e.message); });
  }

  var ACCENT = { socks5: '#c0269a', http: '#5c6672', https: '#7a5cf0', sstp: '#d98800', proxyip: '#d2544d' };

  function metric(k, v, cls){
    return '<div class="metric' + (cls ? ' ' + cls : '') + '"><span class="k">' + k + '</span><b>' + v + '</b></div>';
  }

  // 已测进度百分比
  function pctOf(t){ return t.total > 0 ? Math.min(100, Math.round(t.done * 100 / t.total)) : 0; }

  // 进度条：跑完变绿；style 用于概览卡把进度条吸到底部
  function barHtml(t, style){
    return '<div class="bar' + (t.finished && t.total > 0 ? ' done' : '') + '"' + (style ? ' style="' + style + '"' : '') + '><i style="width:' + pctOf(t) + '%"></i></div>';
  }

  // 国家/地区单元格：旗帜 + 中文名
  function countryCell(r){ return esc((r.countryEmoji ? r.countryEmoji + ' ' : '') + (r.countryName || r.country)); }

  // 结果行：协议页（带「状态」列和失败原因行）与概览（不带）共用
  function rowHtml(r, idx, withStatus){
    var html = '<tr' + (withStatus && !r.ok ? ' class="dead"' : '') + '>';
    html += '<td class="mono">' + (idx + 1) + '</td>';
    html += '<td class="mono" title="' + esc(r.address) + '">' + esc(r.address) + '</td>';
    if(withStatus) html += '<td>' + (r.ok ? '<span class="pill ok">通</span>' : '<span class="pill bad">失败</span>') + '</td>';
    html += '<td class="mono">' + fmtMs(r.latency) + '</td>';
    html += '<td class="mono">' + esc(r.exitIp) + '</td>';
    html += '<td>' + countryCell(r) + '</td>';
    html += '</tr>';
    if(withStatus && !r.ok && r.error) html += '<tr class="dead"><td></td><td colspan="5" title="' + esc(r.error) + '">' + esc(r.error) + '</td></tr>';
    return html;
  }

  function protocolView(type){
    var t = STATE.types[type];
    var picked = t.regionSelected || [];
    var pickedName = '';
    if(picked.length){
      var rlist = t.regions || [];
      for(var pi = 0; pi < rlist.length; pi++){
        if(rlist[pi].code === picked[0]){ pickedName = rlist[pi].name || picked[0]; break; }
      }
      if(!pickedName) pickedName = picked[0];
    }
    var partial = t.done > 0 && !t.finished && t.total > 0;
    var html = '';
    html += '<div class="card proto" style="--acc:' + (ACCENT[type] || '#185FA5') + '">';
    html += '<h2>' + LABELS[type];
    if(t.poolCount > 0) html += ' <span class="tag">候选更新 ' + fmtTime(t.fetchedAt) + '</span>';
    html += apiBox(type);
    html += '</h2>';
    html += '<div class="metrics" style="margin-top:12px">';
    html += metric('候选', t.poolCount + (picked.length ? ' / ' + esc(pickedName) + t.filteredCount : ''), t.poolCount > 0 ? 'hi' : 'zero');
    html += metric('已测', t.done + ' / ' + t.total);
    html += metric('可用', t.ok, t.ok > 0 ? 'hi' : 'zero');
    html += metric('最快', fmtMs(t.fastestMs));
    html += '</div>';
    html += barHtml(t);
    var noRegion = !picked.length;
    var gate = ' data-gate="region"' + (noRegion ? ' disabled title="请先选择地区"' : '');
    html += '<div class="row">';
    if(RUNNING[type]){
      html += '<button class="primary" data-act="pause" data-type="' + type + '">暂停优选</button>';
    } else if(partial){
      html += '<button class="primary" data-act="cont" data-type="' + type + '"' + gate + '>继续优选</button>';
    } else {
      html += '<button class="primary" data-act="start" data-type="' + type + '"' + gate + '>开始优选</button>';
    }
    html += '<button data-act="region" data-type="' + type + '">' + (picked.length ? '地区：' + esc(pickedName) : '选择地区') + '</button>';
    html += '<button class="danger" data-act="clear" data-type="' + type + '">清空结果</button>';
    if(noRegion) html += '<span class="hint" style="margin:0;color:var(--bad)">先点「选择地区」选一个地区</span>';
    html += '<input type="text" id="test-' + type + '" class="mono" placeholder="单点测试：' + esc(POOL_PLACEHOLDER[type]) + '" style="flex:1;min-width:200px">';
    html += '<button data-act="test" data-type="' + type + '">测试</button>';
    html += '</div>';
    html += '<div class="regbox' + (REGOPEN[type] ? ' open' : '') + '" id="regionbox-' + type + '">';
    html += '<div class="regscroll" style="margin-top:8px">' + regionList(type, t.regions || []) + '</div>';
    html += '</div>';
    html += '<div id="testout-' + type + '" class="hint" style="display:none"></div>';
    html += resultTable(t.results);
    html += '</div>';
    return html;
  }

  function overviewView(){
    var totalOk = 0, totalDone = 0, totalPool = 0;
    var okRows = [];
    for(var i = 0; i < PROTOCOLS.length; i++){
      var tp = PROTOCOLS[i];
      var t = STATE.types[tp];
      totalOk += t.ok;
      totalDone += t.done;
      totalPool += t.poolCount;
      var list = t.results || [];
      for(var j = 0; j < list.length; j++){
        if(list[j].ok) okRows.push({ type: tp, r: list[j] });
      }
    }
    okRows.sort(function(a, b){ return (a.r.latency || 999999) - (b.r.latency || 999999); });

    var html = '';
    html += '<div class="card">';
    html += '<h2><span class="dot"></span>概览' + apiBox('all') + '</h2>';
    html += '<div class="metrics">';
    html += metric('协议', PROTOCOLS.length);
    html += metric('候选总数', totalPool, totalPool > 0 ? 'hi' : 'zero');
    html += metric('已测', totalDone);
    html += metric('可用节点', totalOk, totalOk > 0 ? 'hi' : 'zero');
    html += '</div>';
    html += '<div class="hint">上次完成优选：' + fmtTime(STATE.meta && STATE.meta.lastRun) + '</div>';
    html += '</div>';

    html += '<div class="ovgrid">';
    for(var k = 0; k < PROTOCOLS.length; k++){
      var ty = PROTOCOLS[k];
      var tt = STATE.types[ty];
      html += '<div class="ovcard" data-goto="' + ty + '" style="--acc:' + (ACCENT[ty] || '#185FA5') + '" title="点击进入 ' + LABELS[ty] + '">';
      html += '<div class="ovtop"><b>' + LABELS[ty] + '</b><span class="tag mono">' + ty + '</span></div>';
      html += '<div class="ovnum"><span>可用</span><b>' + tt.ok + '</b></div>';
      html += '<div class="ovsub">候选 ' + tt.poolCount + ' · 已测 ' + tt.done + '/' + tt.total + ' · 最快 ' + fmtMs(tt.fastestMs) + '</div>';
      html += barHtml(tt, 'margin:auto 0 0');
      html += '</div>';
    }
    html += '</div>';

    html += '<div class="card" style="margin-top:14px"><h2><span class="dot"></span>可用节点</h2>';
    if(!okRows.length){
      html += '<div class="empty">还没有可用节点，去各协议页点「开始优选」。</div></div>';
      return html;
    }
    for(var p = 0; p < PROTOCOLS.length; p++){
      var pt = PROTOCOLS[p];
      var prows = [];
      for(var q = 0; q < okRows.length; q++){
        if(okRows[q].type === pt) prows.push(okRows[q]);
      }
      html += '<div class="ovsec' + (OVOPEN[pt] ? ' open' : '') + '" id="ovsec-' + pt + '" style="--acc:' + (ACCENT[pt] || '#185FA5') + '">';
      html += '<button class="ovsech" data-act="ovtoggle" data-type="' + pt + '">';
      html += '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
      html += '<b>' + LABELS[pt] + '</b><span class="ovsecn">可用 ' + prows.length + '</span>';
      html += '</button>';
      html += '<div class="ovbody">';
      if(!prows.length){
        html += '<div class="empty">暂无可用节点。</div>';
      } else {
        html += '<div class="scroll" style="max-height:none"><table><thead><tr><th>#</th><th>地址</th><th>延迟</th><th>出口 IP</th><th>国家/地区</th></tr></thead><tbody>';
        for(var n = 0; n < prows.length; n++) html += rowHtml(prows[n].r, n, false);
        html += '</tbody></table></div>';
      }
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function resultTable(rows){
    if(!rows || !rows.length) return '<div class="scroll"><div class="empty">还没有结果，点「开始优选」会先拉取候选再检测。</div></div>';
    var html = '<div class="scroll"><table><thead><tr><th>#</th><th>地址</th><th>状态</th><th>延迟</th><th>出口 IP</th><th>国家/地区</th></tr></thead><tbody>';
    for(var i = 0; i < rows.length; i++) html += rowHtml(rows[i], i, true);
    html += '</tbody></table></div>';
    return html;
  }

  function regionList(type, regions){
    if(!regions || !regions.length) return '<div class="hint" style="padding:8px 0">还没有候选，点「开始优选」会先拉取候选，然后再选地区。</div>';
    var order = BOOT.continentOrder || [];
    var groups = {};
    for(var i = 0; i < regions.length; i++){
      var r = regions[i];
      var c = r.continent || 'OTHER';
      if(!groups[c]){
        groups[c] = {
          list: [],
          name: r.continentName || (BOOT.continents && BOOT.continents[c]) || c,
          emoji: r.continentEmoji || '🌐',
          rank: order.indexOf(c) === -1 ? order.length : order.indexOf(c)
        };
      }
      groups[c].list.push(r);
    }
    var keys = [];
    for(var key in groups) keys.push(key);
    keys.sort(function(a, b){ return groups[a].rank - groups[b].rank; });

    var html = '';
    for(var g = 0; g < keys.length; g++){
      var grp = groups[keys[g]];
      var list = grp.list;
      list.sort(function(a, b){ return b.count - a.count; });
      html += '<div class="rgroup"><div class="rtitle">' + esc(grp.emoji + ' ' + grp.name) + ' / ' + esc(keys[g]) + '</div><div class="rgrid">';
      for(var k = 0; k < list.length; k++){
        var item = list[k];
        html += '<label class="rline">'
          + '<input type="radio" name="reg-' + type + '" data-reg="' + type + '" value="' + esc(item.code) + '"' + (item.selected ? ' checked' : '') + '>'
          + '<span class="rname">' + esc((item.emoji ? item.emoji + ' ' : '') + item.name) + '</span>'
          + '<span class="rcode">' + esc(item.code) + '</span>'
          + '<span class="rcount">' + item.count + '</span>'
          + '</label>';
      }
      html += '</div></div>';
    }
    return html;
  }

  function saveRegion(type){
    var boxes = document.querySelectorAll('input[data-reg="' + type + '"]');
    var picked = [];
    for(var i = 0; i < boxes.length; i++){ if(boxes[i].checked) picked.push(boxes[i].value); }
    if(!picked.length) return;
    api('/api/region', { type: type, regions: picked }).then(function(r){
      if(!r.success){ log('选择地区失败：' + r.error, type); return; }
      log(type + ' 地区已选 ' + picked.join(', ') + '，候选 ' + r.filteredCount + ' 条（之前的测试结果已清空，点「开始优选」跑一遍）', type);
      return loadState();
    }).catch(function(e){ log('保存地区异常：' + e.message, type); });
  }

  function renderTabs(){
    var html = '';
    for(var i = 0; i < TABS.length; i++){
      var tb = TABS[i];
      var on = (tb.key === ACTIVE);
      html += '<button class="tab' + (on ? ' on' : '') + '" data-tab="' + tb.key + '">' + esc(tb.name) + '</button>';
    }
    el('tabs').innerHTML = html;
  }

  // 运行日志卡：概览页不显示（只有协议页看得到）
  function showLogCard(on){
    var lc = el('logCard');
    if(lc) lc.style.display = on ? '' : 'none';
  }

  // 首屏占位：脚本一跑就把 Tab 和一个「加载中」画出来，
  // 不让用户在 /api/state 返回前面对空白页（尤其是那 1MB+ 的大池子在读的时候）。
  function renderBoot(){
    renderTabs();
    el('view').innerHTML = '<div class="card"><div class="boot"><span class="sp"></span>加载中…</div></div>';
    showLogCard(false);
  }

  function render(){
    renderTabs();
    var quiet = (ACTIVE === 'overview');
    el('view').innerHTML = quiet ? overviewView() : protocolView(ACTIVE);
    showLogCard(!quiet);
    renderLog();
    bindActs();
    if(!quiet && RUNNING[ACTIVE]) setBusy(ACTIVE, true);
  }

  function bindActs(){
    var nodes = document.querySelectorAll('[data-act],[data-tab],[data-goto],[data-copy]');
    for(var i = 0; i < nodes.length; i++){
      nodes[i].addEventListener('click', function(ev){
        var cp = this.getAttribute('data-copy');
        if(cp){ ev.preventDefault(); copyText(cp); return; }
        var tab = this.getAttribute('data-tab');
        if(tab){ ACTIVE = tab; render(); return; }
        var goto = this.getAttribute('data-goto');
        if(goto){ ACTIVE = goto; render(); return; }
        var act = this.getAttribute('data-act');
        var type = this.getAttribute('data-type');
        if(!act) return;
        if(act === 'start') doStart(type);
        else if(act === 'cont') doContinue(type);
        else if(act === 'pause') doPause(type);
        else if(act === 'clear') doClear(type);
        else if(act === 'test') doTest(type);
        else if(act === 'region' || act === 'ovtoggle'){
          // 两个都是「展开/收起」：换各自的开关变量和元素 id 前缀
          var isRegion = (act === 'region');
          var flags = isRegion ? REGOPEN : OVOPEN;
          flags[type] = !flags[type];
          var node = el((isRegion ? 'regionbox-' : 'ovsec-') + type);
          if(node) node.classList.toggle('open', !!flags[type]);
        }
      });
    }
    var radios = document.querySelectorAll('input[data-reg]');
    for(var j = 0; j < radios.length; j++){
      radios[j].addEventListener('change', function(){
        saveRegion(this.getAttribute('data-reg'));
      });
    }
  }

  function closeRegion(type){
    REGOPEN[type] = false;
    var box = el('regionbox-' + type);
    if(box) box.classList.remove('open');
  }

  function regionPicked(type){
    return !!(STATE && STATE.types && STATE.types[type] && (STATE.types[type].regionSelected || []).length);
  }

  function setBusy(type, busy){
    var buttons = document.querySelectorAll('[data-type="' + type + '"][data-act]');
    for(var i = 0; i < buttons.length; i++){
      // 暂停按钮任何时候都得能点，否则跑起来就停不下来了
      if(buttons[i].getAttribute('data-act') === 'pause'){ buttons[i].disabled = false; continue; }
      var gated = buttons[i].getAttribute('data-gate') === 'region';
      buttons[i].disabled = busy || (gated && !regionPicked(type));
    }
  }

  function loadState(){
    return api('/api/state').then(function(s){
      STATE = s;
      render();
    }).catch(function(e){
      log('加载状态失败：' + e.message);
      // 首屏还没成功过就别把用户永远留在「加载中…」
      if(!STATE) el('view').innerHTML = '<div class="card"><div class="empty">加载失败：' + esc(e.message) + '<br>刷新页面重试。</div></div>';
    });
  }

  // 顶部状态条：自动拉取进度（只在拉取时出现，拉完自己消失）
  function setAutoStat(text){
    var node = el('autoStat');
    if(!node) return;
    if(text){ node.textContent = text; node.style.display = ''; }
    else { node.textContent = ''; node.style.display = 'none'; }
    var btn = el('btnRefreshAll');
    if(btn) btn.classList.toggle('spin', !!text);
  }

  // 进入面板后自动刷新全部协议的候选池（后台依次跑，不阻塞界面）
  function autoFetchAll(){
    if(AUTOFETCH) return;
    AUTOFETCH = true;
    var total = PROTOCOLS.length;
    var idx = 0;
    var okN = 0;
    var failN = 0;
    function step(){
      if(idx >= total){
        AUTOFETCH = false;
        setAutoStat('');
        log('自动拉取候选完成：成功 ' + okN + ' 个' + (failN ? '，失败 ' + failN + ' 个' : ''));
        return;
      }
      var type = PROTOCOLS[idx];
      idx++;
      setAutoStat('自动拉取候选 ' + idx + '/' + total + '：' + LABELS[type]);
      if(RUNNING[type]){ log(LABELS[type] + ' 正在优选，已跳过自动拉取', type); step(); return; }
      api('/api/fetch', { type: type }).then(function(f){
        if(f && f.success){
          okN++;
          log(LABELS[type] + ' 候选已更新 ' + f.poolCount + ' 条（已优选结果保留）', type);
        } else {
          failN++;
          log(LABELS[type] + ' 自动拉取失败：' + ((f && f.error) || '未知错误'), type);
        }
      }).catch(function(e){
        failN++;
        log(LABELS[type] + ' 自动拉取异常：' + e.message, type);
      }).then(function(){
        return loadState();
      }).then(function(){
        step();
      });
    }
    step();
  }

  function finish(type, msg){
    RUNNING[type] = false;
    STOPPING[type] = false;
    setBusy(type, false);
    if(msg) log(msg, type);
    return loadState();
  }

  // 一轮一轮调 /api/optimize，直到这一类测完
  function runChunks(type, restart, done){
    var body = { type: type };
    if(restart) body.restart = true;
    api('/api/optimize', body).then(function(r){
      if(!r.success) return done('优选失败：' + (r.error || '未知错误'));
      if(r.message && !r.total) return done(r.message);
      log(LABELS[type] + ' 进度 ' + r.done + '/' + r.total + (r.filtered ? '（本地区 ' + r.filtered + '）' : '') + ' · 可用 ' + r.ok, type);
      loadState();
      if(r.finished) return done('优选完成，可用 ' + r.ok + ' 个');
      setTimeout(function(){
        if(STOPPING[type]) return done('已暂停，点「继续优选」接着跑');
        runChunks(type, false, done);
      }, 120);
    }).catch(function(e){ done('优选异常：' + e.message); });
  }

  // 「开始 / 继续」优选共用的启动流程：校验地区 → 置运行位 → 刷新界面 → 记日志
  function beginRun(type, msg){
    if(RUNNING[type]) return false;
    if(!regionPicked(type)){ log('还没选地区，先在「选择地区」里选一个再优选', type); return false; }
    closeRegion(type);
    RUNNING[type] = true;
    STOPPING[type] = false;
    render();
    setBusy(type, true);
    log(msg, type);
    return true;
  }

  // 开始优选 = 先拉取候选（刷新池子）+ 从零优选
  function doStart(type){
    if(!beginRun(type, '开始优选 ' + LABELS[type] + '：拉取候选…')) return;
    api('/api/fetch', { type: type }).then(function(f){
      if(!f.success){ finish(type, LABELS[type] + ' 拉取候选失败：' + f.error); return; }
      log(LABELS[type] + ' 候选 ' + f.poolCount + ' 条，开始检测…', type);
      runChunks(type, true, function(msg){ finish(type, LABELS[type] + ' ' + msg); });
    }).catch(function(e){ finish(type, LABELS[type] + ' 异常：' + e.message); });
  }

  // 继续优选 = 用现有池子接着上次的进度跑（不重拉）
  function doContinue(type){
    if(!beginRun(type, '继续优选 ' + LABELS[type] + '…')) return;
    runChunks(type, false, function(msg){ finish(type, LABELS[type] + ' ' + msg); });
  }

  // 暂停优选 = 不再发下一批；已经在跑的那一批会跑完再停，进度不丢
  function doPause(type){
    if(!RUNNING[type] || STOPPING[type]) return;
    STOPPING[type] = true;
    log(LABELS[type] + ' 正在暂停（等当前这批测完）…', type);
    var b = document.querySelector('[data-act="pause"][data-type="' + type + '"]');
    if(b){ b.disabled = true; b.textContent = '暂停中…'; }
  }

  function doClear(type){
    setBusy(type, true);
    api('/api/clear', { type: type }).then(function(){
      setBusy(type, false);
      log(type + ' 结果已清空', type);
      return loadState();
    }).catch(function(e){ setBusy(type, false); log(type + ' 清空异常：' + e.message, type); });
  }

  function doTest(type){
    var input = el('test-' + type);
    var out = el('testout-' + type);
    var address = (input.value || '').trim();
    if(!address){ out.style.display = 'block'; out.textContent = '请先填一个地址'; return; }
    out.style.display = 'block';
    out.textContent = '测试中…';
    api('/api/test', { type: type, address: address }).then(function(r){
      if(r.ok) out.textContent = '通过：' + r.latency + ' ms · 出口 ' + (r.exitIp || '') + ' · ' + (r.country || '') + (r.colo ? (' · ' + r.colo) : '') + (r.mode ? (' · ' + r.mode) : '');
      else out.textContent = '失败：' + (r.error || '未知错误') + '（' + r.latency + ' ms）';
    }).catch(function(e){ out.textContent = '异常：' + e.message; });
  }

  bind('btnRefreshAll', function(){
    if(AUTOFETCH){ log('正在自动拉取候选，请稍候…'); return; }
    log('手动刷新：开始拉取全部协议候选…');
    autoFetchAll();
  });
  bind('btnSettings', openSettings);
  bind('btnSettingsCancel', closeSettings);
  bind('btnSettingsSave', saveSettings);
  bind('btnClearLog', function(){
    var key = PROTOCOLS.indexOf(ACTIVE) !== -1 ? ACTIVE : '';
    if(key) LOGS[key] = [];
    renderLog();
  });
  (function(){
    var m = el('mSettings');
    if(m) m.addEventListener('click', function(ev){ if(ev.target === m) closeSettings(); });
  })();

  renderBoot();
  // 先等首屏状态回来，再开始自动拉取 —— 避免 /api/fetch 的大写入跟 /api/state 的读取抢资源，
  // 把首屏又往后推（原来这两句是挨着同时发的）。
  loadState().then(function(){ autoFetchAll(); });
})();
</script>
</body>
</html>`;
}

/* ========================================================================== *
 *  八、入口
 * ========================================================================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/") return Response.redirect(url.origin + "/admin", 302);
      if (path === "/admin" || path === "/admin/") return await handleAdmin(request, env, url);
      if (path === "/health") return json({ ok: true, time: Date.now() });
      if (path === "/check") return await handleCheck(request, env, url);
      if (path.indexOf("/list/") === 0) return await handleList(request, env, url);

      if (path.indexOf("/api/") === 0) return await handleApi(request, env, url, ctx);

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      return json({ error: String((error && error.message) || error) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.CSP) return;
    const cfg = await loadConfig(env);
    const types = (cfg.autoTypes || []).filter((t) => PROTOCOLS.indexOf(t) !== -1);
    const domainCode = resolveCountryCode(cfg.domain);
    ctx.waitUntil((async () => {
      const summary = [];
      for (const type of types) {
        try {
          const poolCount = await fetchAndStore(env, type, cfg);
          // 定时任务只跑 DOMAIN 指定的这一个地区；池里没有这个地区就直接跳过，
          // 不再退回「全部地区」（候选太多、请求量太大，很容易整轮失败）
          const regions = domainCode ? [domainCode] : [];
          if (regions.length) {
            const pool = await kvGet(env, "pool:" + type, { items: [] });
            const hit = (Array.isArray(pool.items) ? pool.items : []).some((x) => pickCountry(x) === domainCode);
            if (!hit) {
              summary.push(type + "(" + domainCode + ")池" + poolCount + "/无该地区节点，已跳过");
              continue;
            }
          }
          let guard = 0;
          let result = null;
          do {
            // 第一片强制 restart：定时任务每轮都从零跑，不受上一轮结果影响
            result = await runChunk(env, type, cfg, guard === 0, regions);
            guard++;
          } while (!result.finished && guard < 60);
          summary.push(type + "(" + (regions.length ? domainCode : "全部地区") + ")池" + poolCount + "/可用" + (result ? result.ok : 0));
        } catch (e) {
          summary.push(type + ":失败(" + ((e && e.message) || e) + ")");
        }
      }
      await kvPut(env, "meta", { lastRun: Date.now(), lastAuto: summary, lastAutoAt: Date.now() });
    })());
  },
};
