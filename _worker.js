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
  // 优选域名的候选名单：CF-Pages-BestCF 的 cf_domains.txt，一行一个挂在 CF 上的域名
  cfDomains: "https://raw.githubusercontent.com/cmliu/CF-Pages-BestCF/main/cf_domains.txt",
};

// 优选IP 的候选段表，与 CF-Pages-BestCF 的 IP 库下拉一一对应
const CF_LIBRARIES = {
  "cf-v4": { label: "CF官方列表v4", url: "https://api.check.proxyip.cmliussss.net/ips-v4" },
  "cf-v6": { label: "CF官方列表v6", url: "https://api.check.proxyip.cmliussss.net/ips-v6" },
  "cm-v4": { label: "CM优选列表v4", url: "https://raw.githubusercontent.com/cmliu/cmliu/main/CF-CIDR.txt" },
  "as13335-v4": { label: "AS13335列表v4", url: "https://raw.githubusercontent.com/ipverse/asn-ip/master/as/13335/ipv4-aggregated.txt" },
  "as13335-v6": { label: "AS13335列表v6", url: "https://raw.githubusercontent.com/ipverse/asn-ip/master/as/13335/ipv6-aggregated.txt" },
  "as209242-v4": { label: "AS209242列表v4", url: "https://raw.githubusercontent.com/ipverse/asn-ip/master/as/209242/ipv4-aggregated.txt" },
  "as209242-v6": { label: "AS209242列表v6", url: "https://raw.githubusercontent.com/ipverse/asn-ip/master/as/209242/ipv6-aggregated.txt" },
};

// 面板上能改的候选来源。优选IP 一份段表一行，各自采样；优选域名的名单合并去重；
// 其余五类是一份代理名单，填多行就是多份镜像，拉到的节点合并去重。
// key 只用来在池子里标记候选来自哪一行，改地址时保持不变，删掉整行才消失。
const CF_SOURCES_DEFAULT = {
  socks5: [{ key: "socks5", label: "EDT Proxy-List", url: DEFAULT_SOURCES.socks5 }],
  http: [{ key: "http", label: "EDT Proxy-List", url: DEFAULT_SOURCES.http }],
  https: [{ key: "https", label: "EDT Proxy-List", url: DEFAULT_SOURCES.https }],
  // VPN Gate 官方源是 CSV、镜像是 JSON，两行都拉、合并去重，和上面几类一样
  sstp: [
    { key: "vpngate", label: "VPN Gate 官方源", url: DEFAULT_SOURCES.vpngate },
    { key: "vpngate-mirror", label: "VPN Gate 镜像", url: DEFAULT_SOURCES.vpngateMirror },
  ],
  proxyip: [{ key: "proxyip", label: "ProxyIP 汇总", url: DEFAULT_SOURCES.proxyip }],
  cfip: Object.keys(CF_LIBRARIES).map((k) => ({
    key: k,
    label: CF_LIBRARIES[k].label,
    url: CF_LIBRARIES[k].url,
  })),
  cfdomain: [{
    key: "cf-domains",
    label: "CF-Pages 域名名单",
    url: DEFAULT_SOURCES.cfDomains,
  }],
};

// 来源列表归一化：只认 http(s) 地址，key 缺失或重名就编号，最多 20 行，全删光回落默认
function sanitizeCfSources(raw) {
  const out = {};
  for (const t of Object.keys(CF_SOURCES_DEFAULT)) {
    const list = Array.isArray(raw && raw[t]) ? raw[t] : [];
    const rows = [];
    const used = new Set();
    for (const one of list) {
      if (!one || typeof one !== "object") continue;
      const url = String(one.url || "").trim().slice(0, 400);
      if (!/^https?:\/\/[^\s]+$/i.test(url)) continue;
      let key = String(one.key || "").trim().replace(/[^\w.-]/g, "").slice(0, 40);
      if (!key || used.has(key)) {
        let n = rows.length + 1;
        while (used.has("src-" + n)) n++;
        key = "src-" + n;
      }
      used.add(key);
      const label = String(one.label || "").trim().slice(0, 26) || url.replace(/^https?:\/\//i, "").split("/")[0];
      rows.push({ key, label, url });
      if (rows.length >= 20) break;
    }
    out[t] = rows.length ? rows : CF_SOURCES_DEFAULT[t].map((x) => Object.assign({}, x));
  }
  return out;
}

// 每份段表一次拉取多少条候选，面板上按类型可改（默认值与 CF-Pages-BestCF 的 CANDIDATE_LIMIT 一致）
const CF_CANDIDATE_LIMIT = 512;
const CF_DEFAULT_PORT = 443;

// 这两类必须在浏览器里测（量的是本机到目标），走不了 Worker 的 runChunk
const CF_TYPES = ["cfip", "cfdomain"];


// 每类协议各自的并发 / 超时 / 定时抽样数（面板上按类型调，设置里不再放全局值）
// 优选IP、优选域名这两类量的是「打到 CF 边缘的往返」，超时与 BestCF 的默认值保持一致（500ms）：
// 超时只决定多久没响应算失败，不参与延迟计算
const TYPE_DEFAULTS = {
  socks5: { concurrency: 16, timeoutMs: 10000, autoSample: 20, pullCount: CF_CANDIDATE_LIMIT },
  http: { concurrency: 16, timeoutMs: 10000, autoSample: 20, pullCount: CF_CANDIDATE_LIMIT },
  https: { concurrency: 16, timeoutMs: 10000, autoSample: 20, pullCount: CF_CANDIDATE_LIMIT },
  sstp: { concurrency: 16, timeoutMs: 10000, autoSample: 20, pullCount: CF_CANDIDATE_LIMIT },
  proxyip: { concurrency: 16, timeoutMs: 10000, autoSample: 20, pullCount: CF_CANDIDATE_LIMIT },
  cfip: { concurrency: 16, timeoutMs: 500, autoSample: 20, pullCount: CF_CANDIDATE_LIMIT },
  cfdomain: { concurrency: 16, timeoutMs: 500, autoSample: 20, pullCount: CF_CANDIDATE_LIMIT },
};

const DEFAULT_CONFIG = {
  budgetMs: 5000,           // 单次 /api/optimize 调用的时间片（内部固定值，不在面板中暴露）
                            // 这个值也是「暂停优选」的响应上限：点暂停后，当前这一片跑完才会停
  autoTypes: ["socks5", "http", "https", "sstp", "proxyip"],
  cfSources: CF_SOURCES_DEFAULT,   // 候选来源（七类各一组），面板上可增删改
  libSel: {},               // 每类协议这一轮测哪一份来源（normalizeConfig 按 cfSources 补齐）
  typeCfg: TYPE_DEFAULTS,   // 每类协议自己的并发 / 超时 / 定时抽样数
};

// 取某一类协议自己的设置；配置里缺字段时回落到该类型的默认值
function typeCfgOf(cfg, type) {
  const def = TYPE_DEFAULTS[type] || TYPE_DEFAULTS.socks5;
  const all = (cfg && cfg.typeCfg) || {};
  const one = all[type] || {};
  return {
    concurrency: parseInt(one.concurrency, 10) || def.concurrency,
    timeoutMs: parseInt(one.timeoutMs, 10) || def.timeoutMs,
    autoSample: parseInt(one.autoSample, 10) || def.autoSample,
    pullCount: parseInt(one.pullCount, 10) || def.pullCount,
  };
}

// 某一类这一轮测哪一份来源（cfSources[type] 里的 key）；配置里没记就取第一份
function libSelOf(cfg, type) {
  const sel = (cfg && cfg.libSel) || {};
  if (sel[type]) return sel[type];
  const rows = (cfg && cfg.cfSources && cfg.cfSources[type]) || [];
  return rows.length ? rows[0].key : "";
}

const PROTOCOLS = ["socks5", "http", "https", "sstp", "proxyip", "cfip", "cfdomain"];const TYPE_LABEL = {
  socks5: "SOCKS5", http: "HTTP", https: "HTTPS", sstp: "SSTP", proxyip: "ProxyIP",
  cfip: "CF IP", cfdomain: "CF 域名",
};

// 检测目标：返回 ip= / loc= / colo=，一次拿到出口 IP、地区、命中的 CF 机房
// 走 TLS(443) 而不是明文 80 —— 与 edgetunnel / CF-Workers-CheckSocks5 的检测方式一致：
// 明文 80 会被一部分代理拦截或改写，也测不出「这个代理到底能不能跑 HTTPS」
const TRACE_HOST = "cloudflare.com";
const TRACE_PORT = 443;
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

// Cloudflare 机房三字码 → 所在国家/地区代码（优选的 IP、域名只能拿到 trace 里的 colo，
// 国家就从这里查；查不到的国家码为空，界面回落成直接显示三字码）
const CF_COLO_CC = {
  AAE:"DZ", ABJ:"CI", ABQ:"US", ACC:"GH", ACX:"CN", ADB:"TR", ADD:"ET", ADL:"AU",
  AGR:"IN", AIP:"IN", AKL:"NZ", AKX:"KZ", ALA:"KZ", ALG:"DZ", AMD:"IN", AMM:"JO",
  AMS:"NL", ANC:"US", ARI:"CL", ARN:"SE", ARU:"BR", ASK:"CI", ASU:"PY", ATH:"GR",
  ATL:"US", AUS:"US", AVA:"CN", BAH:"BH", BAQ:"CO", BBI:"IN", BCN:"ES", BDQ:"IN",
  BEG:"RS", BEL:"BR", BEY:"LB", BGI:"BB", BGR:"US", BGW:"IQ", BHY:"CN", BKK:"TH",
  BLR:"IN", BNA:"US", BNE:"AU", BNU:"BR", BOD:"FR", BOG:"CO", BOM:"IN", BOS:"US",
  BRU:"BE", BSB:"BR", BSR:"IQ", BTS:"SK", BUD:"HU", BUF:"US", BWN:"BN", CAI:"EG",
  CAN:"CN", CAW:"BR", CBR:"AU", CCP:"CL", CCU:"IN", CDG:"FR", CEB:"PH", CFC:"BR",
  CGB:"BR", CGD:"CN", CGK:"ID", CGO:"CN", CGP:"BD", CGY:"PH", CHC:"NZ", CJB:"IN",
  CKG:"CN", CLE:"US", CLO:"CO", CLT:"US", CMB:"LK", CMH:"US", CNF:"BR", CNN:"IN",
  CNX:"TH", COK:"IN", COR:"AR", CPH:"DK", CPT:"ZA", CRK:"PH", CSX:"CN", CTU:"CN",
  CVG:"US", CWB:"BR", CZL:"DZ", CZX:"CN", DAC:"BD", DAD:"VN", DAR:"TZ", DEL:"IN",
  DEN:"US", DFW:"US", DKR:"SN", DLA:"CM", DLC:"CN", DME:"RU", DMM:"SA", DOH:"QA",
  DPS:"ID", DTW:"US", DUB:"IE", DUR:"ZA", DUS:"DE", DXB:"AE", DYU:"TJ", EBB:"UG",
  EBL:"IQ", EDI:"GB", EVN:"AM", EWR:"US", EZE:"AR", FCO:"IT", FIH:"CD", FLN:"BR",
  FOC:"CN", FOR:"BR", FRA:"DE", FRU:"KG", FSD:"US", FUK:"JP", FUO:"CN", GBE:"BW",
  GDL:"MX", GEO:"GY", GIG:"BR", GND:"GD", GOT:"SE", GRU:"BR", GUA:"GT", GUM:"GU",
  GVA:"CH", GYD:"AZ", GYE:"EC", GYN:"BR", HAK:"CN", HAM:"DE", HAN:"VN", HBA:"AU",
  HEL:"FI", HFA:"IL", HFE:"CN", HGH:"CN", HKG:"HK", HNL:"US", HRE:"ZW", HYD:"IN",
  HYN:"CN", IAD:"US", IAH:"US", ICN:"KR", IND:"US", ISB:"PK", IST:"TR", ISU:"IQ",
  ITJ:"BR", IXC:"IN", JAX:"US", JDO:"BR", JED:"SA", JHB:"MY", JIB:"DJ", JNB:"ZA",
  JOG:"ID", JOI:"BR", JRG:"IN", JSR:"BD", JXG:"CN", KBP:"UA", KCH:"MY", KEF:"IS",
  KGL:"RW", KHH:"TW", KHI:"PK", KHN:"CN", KIN:"JM", KIV:"MD", KIX:"JP", KJA:"RU",
  KMG:"CN", KNU:"IN", KTM:"NP", KUL:"MY", KWE:"CN", KWI:"KW", LAD:"AO", LAS:"US",
  LAX:"US", LCA:"CY", LED:"RU", LHE:"PK", LHR:"GB", LHW:"CN", LIM:"PE", LIS:"PT",
  LJU:"SI", LLK:"AZ", LLW:"MW", LOS:"NG", LPB:"BO", LUH:"IN", LUN:"ZM", LUX:"LU",
  LYA:"CN", LYS:"FR", MAA:"IN", MAD:"ES", MAN:"GB", MAO:"BR", MBA:"KE", MCI:"US",
  MCT:"OM", MDE:"CO", MEL:"AU", MEM:"US", MEX:"MX", MFE:"US", MFM:"MO", MIA:"US",
  MLA:"MT", MLE:"MV", MLG:"ID", MNL:"PH", MPM:"MZ", MRS:"FR", MRU:"MU", MSP:"US",
  MSQ:"BY", MUC:"DE", MXP:"IT", NAG:"IN", NBO:"KE", NJF:"IQ", NNG:"CN", NOU:"NC",
  NQN:"AR", NQZ:"KZ", NRT:"JP", NVT:"BR", OKA:"JP", OKC:"US", OMA:"US", ORD:"US",
  ORF:"US", ORK:"IE", ORN:"DZ", OSL:"NO", OTP:"RO", OUA:"BF", PAT:"IN", PBH:"BT",
  PBM:"SR", PDX:"US", PER:"AU", PHL:"US", PHX:"US", PIT:"US", PKX:"CN", PMO:"IT",
  PMW:"BR", PNH:"KH", PNQ:"IN", POA:"BR", POS:"TT", PPT:"PF", PRG:"CZ", PRN:"XK",
  PTY:"PA", QRO:"MX", QWJ:"BR", RAO:"BR", RDU:"US", REC:"BR", RIC:"US", RIX:"LV",
  RUH:"SA", RUN:"RE", SAN:"US", SAP:"HN", SAT:"US", SCL:"CL", SDQ:"DO", SEA:"US",
  SFO:"US", SGN:"VN", SHA:"CN", SIN:"SG", SJC:"US", SJK:"BR", SJO:"CR", SJP:"BR",
  SJU:"PR", SJW:"CN", SKG:"GR", SKP:"MK", SLC:"US", SMF:"US", SOD:"BR", SOF:"BG",
  SSA:"BR", STI:"DO", STL:"US", STR:"DE", SUV:"FJ", SVX:"RU", SYD:"AU", SZX:"CN",
  TAO:"CN", TAS:"UZ", TBS:"GE", TEN:"CN", TGU:"HN", TIA:"AL", TLH:"US", TLL:"EE",
  TLV:"IL", TNA:"CN", TNR:"MG", TPA:"US", TPE:"TW", TSN:"CN", TUN:"TN", TXL:"DE",
  TYN:"CN", UDI:"BR", UDR:"IN", UIO:"EC", ULN:"MN", URT:"TH", VCP:"BR", VIE:"AT",
  VIX:"BR", VNO:"LT", VTE:"LA", WAW:"PL", WDH:"NA", WHU:"CN", WLG:"NZ", WRO:"PL",
  XAP:"BR", XFN:"CN", XIY:"CN", XNH:"IQ", XNN:"CN", YHZ:"CA", YOW:"CA", YUL:"CA",
  YVR:"CA", YWG:"CA", YXE:"CA", YYC:"CA", YYZ:"CA", ZAG:"HR", ZDM:"PS", ZGN:"CN",
  ZRH:"CH",
};

// 大洲分组，用的就是数据源那套标准大洲码（元数据里 continent 字段的值）
const CONTINENT_LABEL = {
  AS: "亚洲", EU: "欧洲", NA: "北美", SA: "南美",
  AF: "非洲", OC: "大洋洲", AN: "南极洲", OTHER: "其他",
};
const CONTINENT_EMOJI = {
  AS: "🏯", EU: "🏰", NA: "🗽", SA: "🦜", AF: "🦁", OC: "🦘", AN: "🐧", OTHER: "🌐",
};
const CONTINENT_ORDER = ["AS", "EU", "NA", "SA", "AF", "OC", "AN", "OTHER"];

// 国家码 → 大洲码。兜底用，源里有 continent 字段时以源为准。
// 注意：这里是"国家码"当键、"大洲码"当值，所以 NA(纳米比亚)→AF、AS(美属萨摩亚)→OC 不冲突。
const COUNTRY_CONTINENT = {
  AE: "AS", AF: "AS", AM: "AS", AZ: "AS", BD: "AS", BH: "AS", BN: "AS", BT: "AS", CN: "AS",
  CY: "AS", GE: "AS", HK: "AS", ID: "AS", IL: "AS", IN: "AS", IO: "AS", IQ: "AS",
  IR: "AS", JO: "AS", JP: "AS", KG: "AS", KH: "AS", KP: "AS", KR: "AS", KW: "AS",
  KZ: "AS", LA: "AS", LB: "AS", LK: "AS", MM: "AS", MN: "AS", MO: "AS", MV: "AS",
  MY: "AS", NP: "AS", OM: "AS", PH: "AS", PK: "AS", PS: "AS", QA: "AS", SA: "AS",
  SG: "AS", SY: "AS", TH: "AS", TJ: "AS", TL: "AS", TM: "AS", TR: "AS", TW: "AS",
  UZ: "AS", VN: "AS", YE: "AS",
  AD: "EU", AL: "EU", AT: "EU", AX: "EU", BA: "EU", BE: "EU", BG: "EU", BY: "EU",
  CH: "EU", CZ: "EU", DE: "EU", DK: "EU", EE: "EU", ES: "EU", FI: "EU", FO: "EU",
  FR: "EU", GB: "EU", GG: "EU", GI: "EU", GR: "EU", HR: "EU", HU: "EU", IE: "EU",
  IM: "EU", IS: "EU", IT: "EU", JE: "EU", LI: "EU", LT: "EU", LU: "EU", LV: "EU",
  MC: "EU", MD: "EU", ME: "EU", MK: "EU", MT: "EU", NL: "EU", NO: "EU", PL: "EU",
  PT: "EU", RO: "EU", RS: "EU", RU: "EU", SE: "EU", SI: "EU", SJ: "EU", SK: "EU",
  SM: "EU", UA: "EU", VA: "EU",
  AG: "NA", AI: "NA", AW: "NA", BB: "NA", BL: "NA", BM: "NA", BQ: "NA", BS: "NA",
  BZ: "NA", CA: "NA", CR: "NA", CU: "NA", CW: "NA", DM: "NA", DO: "NA", GD: "NA",
  GL: "NA", GP: "NA", GT: "NA", HN: "NA", HT: "NA", JM: "NA", KN: "NA", KY: "NA",
  LC: "NA", MF: "NA", MQ: "NA", MS: "NA", MX: "NA", NI: "NA", PA: "NA", PM: "NA",
  PR: "NA", SV: "NA", SX: "NA", TC: "NA", TT: "NA", US: "NA", VC: "NA", VG: "NA",
  VI: "NA",
  AR: "SA", BO: "SA", BR: "SA", CL: "SA", CO: "SA", EC: "SA", FK: "SA", GF: "SA",
  GY: "SA", PE: "SA", PY: "SA", SR: "SA", UY: "SA", VE: "SA",
  AO: "AF", BF: "AF", BI: "AF", BJ: "AF", BW: "AF", CD: "AF", CF: "AF", CG: "AF",
  CI: "AF", CM: "AF", CV: "AF", DJ: "AF", DZ: "AF", EG: "AF", EH: "AF", ER: "AF",
  ET: "AF", GA: "AF", GH: "AF", GM: "AF", GN: "AF", GQ: "AF", GW: "AF", KE: "AF",
  KM: "AF", LR: "AF", LS: "AF", LY: "AF", MA: "AF", MG: "AF", ML: "AF", MR: "AF",
  MU: "AF", MW: "AF", MZ: "AF", NA: "AF", NE: "AF", NG: "AF", RE: "AF", RW: "AF",
  SC: "AF", SD: "AF", SH: "AF", SL: "AF", SN: "AF", SO: "AF", SS: "AF", ST: "AF",
  SZ: "AF", TD: "AF", TG: "AF", TN: "AF", TZ: "AF", UG: "AF", YT: "AF", ZA: "AF",
  ZM: "AF", ZW: "AF",
  AS: "OC", AU: "OC", CC: "OC", CK: "OC", CX: "OC", FJ: "OC", FM: "OC", GU: "OC",
  HM: "OC", KI: "OC", MH: "OC", MP: "OC", NC: "OC", NF: "OC", NR: "OC", NU: "OC",
  NZ: "OC", PF: "OC", PG: "OC", PN: "OC", PW: "OC", SB: "OC", TK: "OC", TO: "OC",
  TV: "OC", UM: "OC", VU: "OC", WF: "OC", WS: "OC",
  AQ: "AN", BV: "AN", GS: "AN", TF: "AN",
};

function continentOf(code) {
  return COUNTRY_CONTINENT[String(code || "").toUpperCase()] || "OTHER";
}

/* ========================================================================== *
 *  二、协议实现（socks5 / http / https / sstp）
 * ========================================================================== */

const PROXY_DEFAULT_PORTS = { socks5: 1080, http: 80, https: 443, sstp: 443 };
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
// 缓存 Promise 而非结果：并发 16 条节点同时开查时只发一次请求，省下 15 张子请求额度
const IPV4_CACHE = new Map();
const IPV4_CACHE_MS = 10 * 60 * 1000;
function resolveIPv4(host) {
  const target = stripIPv6Brackets(host);
  if (isIPv4(target)) return Promise.resolve(target);
  const hit = IPV4_CACHE.get(target);
  if (hit && Date.now() - hit.at < IPV4_CACHE_MS) return hit.p;
  const pending = fetch(
    "https://1.1.1.1/dns-query?name=" + encodeURIComponent(target) + "&type=A",
    { headers: { accept: "application/dns-json" } },
  ).then((res) => res.json()).then((data) => {
    const record = (data.Answer || []).find((item) => item.type === 1 && isIPv4(item.data));
    return record ? record.data : null;
  }).catch(() => null);
  IPV4_CACHE.set(target, { at: Date.now(), p: pending });
  pending.then((ip) => { if (!ip) IPV4_CACHE.delete(target); });   // 解析失败不留在缓存里
  return pending;
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

// ---- 自研 TLS 客户端：移植自 edgetunnel / CF-Workers-CheckSocks5 ----
// 两处用到：① HTTPS 代理自身握手（公共代理多为自签证书）；② 检测时在隧道里向目标站点做 TLS。
// 不走 Cloudflare 内置的 secureTransport:"on"，原因有二：
//   1) 内置客户端会校验证书，公共 HTTPS 代理绝大多数是自签证书 → 握手直接失败；
//   2) 内置客户端只提供 AES-GCM 套件，只谈 ChaCha20-Poly1305 的服务器会握手失败。
// 这里用自研 TLS 客户端（不校验证书 + AES-GCM / ChaCha20 双套件 + TLS 1.2/1.3），与 edgetunnel 行为一致。
function isIPHostname(hostname=""){
    const host=stripIPv6Brackets(hostname);
    const ipv4Regex=/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
    if(ipv4Regex.test(host)) return true;
    if(!host.includes(":")) return false;
    try{
        new URL(`http://[${host}]/`);
        return true;
    }catch(e){
        return false;
    }
}

const TLS_VERSION_10=769,TLS_VERSION_12=771,TLS_VERSION_13=772;
const CONTENT_TYPE_CHANGE_CIPHER_SPEC=20,CONTENT_TYPE_ALERT=21,CONTENT_TYPE_HANDSHAKE=22,CONTENT_TYPE_APPLICATION_DATA=23;
const HANDSHAKE_TYPE_CLIENT_HELLO=1,HANDSHAKE_TYPE_SERVER_HELLO=2,HANDSHAKE_TYPE_NEW_SESSION_TICKET=4,HANDSHAKE_TYPE_ENCRYPTED_EXTENSIONS=8,HANDSHAKE_TYPE_CERTIFICATE=11,HANDSHAKE_TYPE_SERVER_KEY_EXCHANGE=12,HANDSHAKE_TYPE_CERTIFICATE_REQUEST=13,HANDSHAKE_TYPE_SERVER_HELLO_DONE=14,HANDSHAKE_TYPE_CERTIFICATE_VERIFY=15,HANDSHAKE_TYPE_CLIENT_KEY_EXCHANGE=16,HANDSHAKE_TYPE_FINISHED=20,HANDSHAKE_TYPE_KEY_UPDATE=24;
const EXT_SERVER_NAME=0,EXT_SUPPORTED_GROUPS=10,EXT_EC_POINT_FORMATS=11,EXT_SIGNATURE_ALGORITHMS=13,EXT_APPLICATION_LAYER_PROTOCOL_NEGOTIATION=16,EXT_SUPPORTED_VERSIONS=43,EXT_PSK_KEY_EXCHANGE_MODES=45,EXT_KEY_SHARE=51;

const ALERT_CLOSE_NOTIFY=0,ALERT_LEVEL_WARNING=1,ALERT_UNRECOGNIZED_NAME=112;
const shouldIgnoreTlsAlert=(fragment)=>fragment?.[0]===ALERT_LEVEL_WARNING&&fragment?.[1]===ALERT_UNRECOGNIZED_NAME;

// 与上面代理层的 proxyTextEncoder / proxyTextDecoder / SSTP_EMPTY_BYTES 是同一个东西，直接复用
const textEncoder=proxyTextEncoder,textDecoder=proxyTextDecoder,EMPTY_BYTES=SSTP_EMPTY_BYTES;

const CIPHER_SUITES_BY_ID=new Map([
    [4865,{id:4865,keyLen:16,ivLen:12,hash:"SHA-256",tls13:!0}],
    [4866,{id:4866,keyLen:32,ivLen:12,hash:"SHA-384",tls13:!0}],
    [4867,{id:4867,keyLen:32,ivLen:12,hash:"SHA-256",tls13:!0,chacha:!0}],
    [49199,{id:49199,keyLen:16,ivLen:4,hash:"SHA-256",kex:"ECDHE"}],
    [49200,{id:49200,keyLen:32,ivLen:4,hash:"SHA-384",kex:"ECDHE"}],
    [52392,{id:52392,keyLen:32,ivLen:12,hash:"SHA-256",kex:"ECDHE",chacha:!0}],
    [49195,{id:49195,keyLen:16,ivLen:4,hash:"SHA-256",kex:"ECDHE"}],
    [49196,{id:49196,keyLen:32,ivLen:4,hash:"SHA-384",kex:"ECDHE"}],
    [52393,{id:52393,keyLen:32,ivLen:12,hash:"SHA-256",kex:"ECDHE",chacha:!0}]
]);
const GROUPS_BY_ID=new Map([[29,"X25519"],[23,"P-256"]]);
const SUPPORTED_SIGNATURE_ALGORITHMS=[2052,2053,2054,1025,1281,1537,1027,1283,1539];

const tlsBytes=(...parts)=>{
    const flattenBytes=(values)=>values.flatMap((value)=>value instanceof Uint8Array?[...value]:Array.isArray(value)?flattenBytes(value):"number"==typeof value?[value]:[]);
    return new Uint8Array(flattenBytes(parts));
};
const uint16be=(value)=>[value>>8&255,255&value];
const readUint24=(buffer,offset)=>buffer[offset]<<16|buffer[offset+1]<<8|buffer[offset+2];
const randomBytes=(length)=>crypto.getRandomValues(new Uint8Array(length));
const constantTimeEqual=(left,right)=>{
    if(!left||!right||left.length!==right.length) return !1;
    let diff=0;
    for(let index=0;index<left.length;index++) diff|=left[index]^right[index];
    return 0===diff;
};
const hashByteLength=(hash)=>"SHA-512"===hash?64:"SHA-384"===hash?48:32;
async function hmac(hash,key,data){
    const cryptoKey=await crypto.subtle.importKey("raw",key,{name:"HMAC",hash},!1,["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC",cryptoKey,data));
}
async function digestBytes(hash,data){return new Uint8Array(await crypto.subtle.digest(hash,data));}
async function tls12Prf(secret,label,seed,length,hash="SHA-256"){
    const labelSeed=concatBytes(textEncoder.encode(label),seed);
    let output=new Uint8Array(0),currentA=labelSeed;
    for(;output.length<length;){
        currentA=await hmac(hash,secret,currentA);
        const block=await hmac(hash,secret,concatBytes(currentA,labelSeed));
        output=concatBytes(output,block);
    }
    return output.slice(0,length);
}
async function hkdfExtract(hash,salt,inputKeyMaterial){
    return salt&&salt.length||(salt=new Uint8Array(hashByteLength(hash))),hmac(hash,salt,inputKeyMaterial);
}
async function hkdfExpandLabel(hash,secret,label,context,length){
    const fullLabel=textEncoder.encode("tls13 "+label);
    return async function(hash,secret,info,length){
        const hashLen=hashByteLength(hash),roundCount=Math.ceil(length/hashLen);
        let output=new Uint8Array(0),previousBlock=new Uint8Array(0);
        for(let round=1;round<=roundCount;round++) previousBlock=await hmac(hash,secret,concatBytes(previousBlock,info,[round])),output=concatBytes(output,previousBlock);
        return output.slice(0,length);
    }(hash,secret,tlsBytes(uint16be(length),fullLabel.length,fullLabel,context.length,context),length);
}
async function generateKeyShare(group="P-256"){
    const algorithm="X25519"===group?{name:"X25519"}:{name:"ECDH",namedCurve:group};
    const keyPair=await crypto.subtle.generateKey(algorithm,!0,["deriveBits"]);
    const publicKeyRaw=await crypto.subtle.exportKey("raw",keyPair.publicKey);
    return {keyPair,publicKeyRaw:new Uint8Array(publicKeyRaw)};
}
async function deriveSharedSecret(privateKey,peerPublicKey,group="P-256"){
    const algorithm="X25519"===group?{name:"X25519"}:{name:"ECDH",namedCurve:group},
        peerKey=await crypto.subtle.importKey("raw",peerPublicKey,algorithm,!1,[]),
        bits="P-384"===group?384:"P-521"===group?528:256;
    return new Uint8Array(await crypto.subtle.deriveBits({name:algorithm.name,public:peerKey},privateKey,bits));
}
async function importAesGcmKey(key,usages){return crypto.subtle.importKey("raw",key,{name:"AES-GCM"},!1,usages);}
async function aesGcmEncryptWithKey(cryptoKey,initializationVector,plaintext,additionalData){
    return new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv:initializationVector,additionalData,tagLength:128},cryptoKey,plaintext));
}
async function aesGcmDecryptWithKey(cryptoKey,initializationVector,ciphertext,additionalData){
    return new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:initializationVector,additionalData,tagLength:128},cryptoKey,ciphertext));
}

function rotateLeft32(value,bits){return (value<<bits|value>>>32-bits)>>>0;}

function chachaQuarterRound(state,indexA,indexB,indexC,indexD){
    state[indexA]=state[indexA]+state[indexB]>>>0,state[indexD]=rotateLeft32(state[indexD]^state[indexA],16),state[indexC]=state[indexC]+state[indexD]>>>0,state[indexB]=rotateLeft32(state[indexB]^state[indexC],12),state[indexA]=state[indexA]+state[indexB]>>>0,state[indexD]=rotateLeft32(state[indexD]^state[indexA],8),state[indexC]=state[indexC]+state[indexD]>>>0,state[indexB]=rotateLeft32(state[indexB]^state[indexC],7);
}

function chacha20Block(key,counter,nonce){
    const state=new Uint32Array(16);
    state[0]=1634760805,state[1]=857760878,state[2]=2036477234,state[3]=1797285236;
    const keyView=new DataView(key.buffer,key.byteOffset,key.byteLength);
    for(let wordIndex=0;wordIndex<8;wordIndex++) state[4+wordIndex]=keyView.getUint32(4*wordIndex,!0);
    state[12]=counter;
    const nonceView=new DataView(nonce.buffer,nonce.byteOffset,nonce.byteLength);
    state[13]=nonceView.getUint32(0,!0),state[14]=nonceView.getUint32(4,!0),state[15]=nonceView.getUint32(8,!0);
    const workingState=new Uint32Array(state);
    for(let round=0;round<10;round++) chachaQuarterRound(workingState,0,4,8,12),chachaQuarterRound(workingState,1,5,9,13),chachaQuarterRound(workingState,2,6,10,14),chachaQuarterRound(workingState,3,7,11,15),chachaQuarterRound(workingState,0,5,10,15),chachaQuarterRound(workingState,1,6,11,12),chachaQuarterRound(workingState,2,7,8,13),chachaQuarterRound(workingState,3,4,9,14);
    for(let wordIndex=0;wordIndex<16;wordIndex++) workingState[wordIndex]=workingState[wordIndex]+state[wordIndex]>>>0;
    return new Uint8Array(workingState.buffer.slice(0));
}

function chacha20Xor(key,nonce,data){
    const output=new Uint8Array(data.length);
    let counter=1;
    for(let offset=0;offset<data.length;offset+=64){
        const block=chacha20Block(key,counter++,nonce),
            blockLength=Math.min(64,data.length-offset);
        for(let index=0;index<blockLength;index++) output[offset+index]=data[offset+index]^block[index];
    }
    return output;
}

function poly1305Mac(key,message){
    const rKey=function(rBytes){
        const clamped=new Uint8Array(rBytes);
        return clamped[3]&=15,clamped[7]&=15,clamped[11]&=15,clamped[15]&=15,clamped[4]&=252,clamped[8]&=252,clamped[12]&=252,clamped;
    }(key.slice(0,16)),
        sKey=key.slice(16,32);
    let accumulator=[0n,0n,0n,0n,0n];
    const rLimbs=[0x3ffffffn&BigInt(rKey[0]|rKey[1]<<8|rKey[2]<<16|rKey[3]<<24),0x3ffffffn&BigInt(rKey[3]>>2|rKey[4]<<6|rKey[5]<<14|rKey[6]<<22),0x3ffffffn&BigInt(rKey[6]>>4|rKey[7]<<4|rKey[8]<<12|rKey[9]<<20),0x3ffffffn&BigInt(rKey[9]>>6|rKey[10]<<2|rKey[11]<<10|rKey[12]<<18),0x3ffffffn&BigInt(rKey[13]|rKey[14]<<8|rKey[15]<<16)];
    for(let offset=0;offset<message.length;offset+=16){
        const chunk=message.slice(offset,offset+16),
            paddedChunk=new Uint8Array(17);
        paddedChunk.set(chunk),paddedChunk[chunk.length]=1,accumulator[0]+=BigInt(paddedChunk[0]|paddedChunk[1]<<8|paddedChunk[2]<<16|(3&paddedChunk[3])<<24),accumulator[1]+=BigInt(paddedChunk[3]>>2|paddedChunk[4]<<6|paddedChunk[5]<<14|(15&paddedChunk[6])<<22),accumulator[2]+=BigInt(paddedChunk[6]>>4|paddedChunk[7]<<4|paddedChunk[8]<<12|(63&paddedChunk[9])<<20),accumulator[3]+=BigInt(paddedChunk[9]>>6|paddedChunk[10]<<2|paddedChunk[11]<<10|paddedChunk[12]<<18),accumulator[4]+=BigInt(paddedChunk[13]|paddedChunk[14]<<8|paddedChunk[15]<<16|paddedChunk[16]<<24);
        const product=[0n,0n,0n,0n,0n];
        for(let accIndex=0;accIndex<5;accIndex++)
            for(let rIndex=0;rIndex<5;rIndex++){
                const limbIndex=accIndex+rIndex;
                limbIndex<5?product[limbIndex]+=accumulator[accIndex]*rLimbs[rIndex]:product[limbIndex-5]+=accumulator[accIndex]*rLimbs[rIndex]*5n;
            }
        let carry=0n;
        for(let index=0;index<5;index++) product[index]+=carry,accumulator[index]=0x3ffffffn&product[index],carry=product[index]>>26n;
        accumulator[0]+=5n*carry,carry=accumulator[0]>>26n,accumulator[0]&=0x3ffffffn,accumulator[1]+=carry;
    }
    let tagValue=accumulator[0]|accumulator[1]<<26n|accumulator[2]<<52n|accumulator[3]<<78n|accumulator[4]<<104n;
    tagValue=tagValue+sKey.reduce((total,byte,index)=>total+(BigInt(byte)<<BigInt(8*index)),0n)&(1n<<128n)-1n;
    const tag=new Uint8Array(16);
    for(let index=0;index<16;index++) tag[index]=Number(tagValue>>BigInt(8*index)&0xffn);
    return tag;
}

function chacha20Poly1305Encrypt(key,nonce,plaintext,additionalData){
    const polyKey=chacha20Block(key,0,nonce).slice(0,32),
        ciphertext=chacha20Xor(key,nonce,plaintext),
        aadPadding=(16-additionalData.length%16)%16,
        ciphertextPadding=(16-ciphertext.length%16)%16,
        macData=new Uint8Array(additionalData.length+aadPadding+ciphertext.length+ciphertextPadding+16);
    macData.set(additionalData,0),macData.set(ciphertext,additionalData.length+aadPadding);
    const lengthView=new DataView(macData.buffer,additionalData.length+aadPadding+ciphertext.length+ciphertextPadding);
    lengthView.setBigUint64(0,BigInt(additionalData.length),!0),lengthView.setBigUint64(8,BigInt(ciphertext.length),!0);
    const tag=poly1305Mac(polyKey,macData);
    return concatBytes(ciphertext,tag);
}

function chacha20Poly1305Decrypt(key,nonce,ciphertext,additionalData){
    if(ciphertext.length<16) throw new Error("Ciphertext too short");
    const tag=ciphertext.slice(-16),
        encryptedData=ciphertext.slice(0,-16),
        polyKey=chacha20Block(key,0,nonce).slice(0,32),
        aadPadding=(16-additionalData.length%16)%16,
        ciphertextPadding=(16-encryptedData.length%16)%16,
        macData=new Uint8Array(additionalData.length+aadPadding+encryptedData.length+ciphertextPadding+16);
    macData.set(additionalData,0),macData.set(encryptedData,additionalData.length+aadPadding);
    const lengthView=new DataView(macData.buffer,additionalData.length+aadPadding+encryptedData.length+ciphertextPadding);
    lengthView.setBigUint64(0,BigInt(additionalData.length),!0),lengthView.setBigUint64(8,BigInt(encryptedData.length),!0);
    const expectedTag=poly1305Mac(polyKey,macData);
    let diff=0;
    for(let index=0;index<16;index++) diff|=tag[index]^expectedTag[index];
    if(0!==diff) throw new Error("ChaCha20-Poly1305 authentication failed");
    return chacha20Xor(key,nonce,encryptedData);
}

const TLS_MAX_PLAINTEXT_FRAGMENT=16*1024;
function buildTlsRecord(contentType,fragment,version=TLS_VERSION_12){
    const data=toUint8(fragment);
    const record=new Uint8Array(5+data.byteLength);
    record[0]=contentType;
    record[1]=version>>8&255;
    record[2]=version&255;
    record[3]=data.byteLength>>8&255;
    record[4]=data.byteLength&255;
    record.set(data,5);
    return record;
}
function buildHandshakeMessage(handshakeType,body){return tlsBytes(handshakeType,(length=>[length>>16&255,length>>8&255,255&length])(body.length),body);}
class TlsRecordParser{
    constructor(){this.buffer=new Uint8Array(0);}
    feed(chunk){
        const bytes=toUint8(chunk);
        this.buffer=this.buffer.length?concatBytes(this.buffer,bytes):bytes;
    }
    next(){
        if(this.buffer.length<5) return null;
        const contentType=this.buffer[0],
            version=readUint16(this.buffer,1),
            length=readUint16(this.buffer,3);
        if(this.buffer.length<5+length) return null;
        const fragment=this.buffer.subarray(5,5+length);
        return this.buffer=this.buffer.subarray(5+length),{type:contentType,version,length,fragment};
    }
}
class TlsHandshakeParser{
    constructor(){this.buffer=new Uint8Array(0);}
    feed(chunk){
        const bytes=toUint8(chunk);
        this.buffer=this.buffer.length?concatBytes(this.buffer,bytes):bytes;
    }
    next(){
        if(this.buffer.length<4) return null;
        const handshakeType=this.buffer[0],
            length=readUint24(this.buffer,1);
        if(this.buffer.length<4+length) return null;
        const body=this.buffer.subarray(4,4+length),
            raw=this.buffer.subarray(0,4+length);
        return this.buffer=this.buffer.subarray(4+length),{type:handshakeType,length,body,raw};
    }
}

function parseServerHello(body){
    let offset=0;
    const legacyVersion=readUint16(body,offset);
    offset+=2;
    const serverRandom=body.slice(offset,offset+32);
    offset+=32;
    const sessionIdLength=body[offset++],
        sessionId=body.slice(offset,offset+sessionIdLength);
    offset+=sessionIdLength;
    const cipherSuite=readUint16(body,offset);
    offset+=2;
    const compression=body[offset++];
    let selectedVersion=legacyVersion,
        keyShare=null,
        alpn=null;
    if(offset<body.length){
        const extensionsLength=readUint16(body,offset);
        offset+=2;
        const extensionsEnd=offset+extensionsLength;
        for(;offset+4<=extensionsEnd;){
            const extensionType=readUint16(body,offset);
            offset+=2;
            const extensionLength=readUint16(body,offset);
            offset+=2;
            const extensionData=body.slice(offset,offset+extensionLength);
            if(offset+=extensionLength,extensionType===EXT_SUPPORTED_VERSIONS&&extensionLength>=2) selectedVersion=readUint16(extensionData,0);
            else if(extensionType===EXT_KEY_SHARE&&extensionLength>=4){
                const group=readUint16(extensionData,0),
                    keyLength=readUint16(extensionData,2);
                keyShare={group,key:extensionData.slice(4,4+keyLength)};
            }else extensionType===EXT_APPLICATION_LAYER_PROTOCOL_NEGOTIATION&&extensionLength>=3&&(alpn=textDecoder.decode(extensionData.slice(3,3+extensionData[2])));
        }
    }
    const helloRetryRequestRandom=new Uint8Array([207,33,173,116,229,154,97,17,190,29,140,2,30,101,184,145,194,162,17,22,122,187,140,94,7,158,9,226,200,168,51,156]);
    return {version:legacyVersion,serverRandom,sessionId,cipherSuite,compression,selectedVersion,keyShare,alpn,isHRR:constantTimeEqual(serverRandom,helloRetryRequestRandom),isTls13:selectedVersion===TLS_VERSION_13};
}

function parseServerKeyExchange(body){
    let offset=1;
    const namedCurve=readUint16(body,offset);
    offset+=2;
    const keyLength=body[offset++];
    return {namedCurve,serverPublicKey:body.slice(offset,offset+keyLength)};
}

function extractLeafCertificate(body,hasContext=0){
    let offset=0;
    if(hasContext){
        const contextLength=body[offset++];
        offset+=contextLength;
    }
    if(offset+3>body.length) return null;
    const certificateListLength=readUint24(body,offset);
    if(offset+=3,!certificateListLength||offset+3>body.length) return null;
    const certificateLength=readUint24(body,offset);
    return offset+=3,certificateLength?body.slice(offset,offset+certificateLength):null;
}

function parseEncryptedExtensions(body){
    const parsed={alpn:null};
    let offset=2;
    const extensionsEnd=2+readUint16(body,0);
    for(;offset+4<=extensionsEnd;){
        const extensionType=readUint16(body,offset);
        offset+=2;
        const extensionLength=readUint16(body,offset);
        if(offset+=2,extensionType===EXT_APPLICATION_LAYER_PROTOCOL_NEGOTIATION&&extensionLength>=3){
            const protocolLength=body[offset+2];
            protocolLength>0&&offset+3+protocolLength<=offset+extensionLength&&(parsed.alpn=textDecoder.decode(body.slice(offset+3,offset+3+protocolLength)));
        }
        offset+=extensionLength;
    }
    return parsed;
}

function buildClientHello(clientRandom,serverName,keyShares,{tls13:enableTls13=!0,tls12:enableTls12=!0,alpn=null,chacha=!0}={}){
    const cipherIds=[];
    enableTls13&&cipherIds.push(4865,4866,...(chacha?[4867]:[])),enableTls12&&cipherIds.push(49199,49200,49195,49196,...(chacha?[52392,52393]:[]));
    const cipherBytes=tlsBytes(...cipherIds.flatMap(uint16be)),
        extensions=[tlsBytes(255,1,0,1,0)];
    if(serverName){
        const serverNameBytes=textEncoder.encode(serverName),
            serverNameList=tlsBytes(0,uint16be(serverNameBytes.length),serverNameBytes);
        extensions.push(tlsBytes(uint16be(EXT_SERVER_NAME),uint16be(serverNameList.length+2),uint16be(serverNameList.length),serverNameList));
    }
    extensions.push(tlsBytes(uint16be(EXT_EC_POINT_FORMATS),0,2,1,0)),extensions.push(tlsBytes(uint16be(EXT_SUPPORTED_GROUPS),0,6,0,4,0,29,0,23));
    const signatureBytes=tlsBytes(...SUPPORTED_SIGNATURE_ALGORITHMS.flatMap(uint16be));
    extensions.push(tlsBytes(uint16be(EXT_SIGNATURE_ALGORITHMS),uint16be(signatureBytes.length+2),uint16be(signatureBytes.length),signatureBytes));
    const protocols=Array.isArray(alpn)?alpn.filter(Boolean):alpn?[alpn]:[];
    if(protocols.length){
        const alpnBytes=concatBytes(...protocols.map((protocol)=>{const protocolBytes=textEncoder.encode(protocol);return tlsBytes(protocolBytes.length,protocolBytes);}));
        extensions.push(tlsBytes(uint16be(EXT_APPLICATION_LAYER_PROTOCOL_NEGOTIATION),uint16be(alpnBytes.length+2),uint16be(alpnBytes.length),alpnBytes));
    }
    if(enableTls13&&keyShares){
        let keyShareBytes;
        if(extensions.push(enableTls12?tlsBytes(uint16be(EXT_SUPPORTED_VERSIONS),0,5,4,3,4,3,3):tlsBytes(uint16be(EXT_SUPPORTED_VERSIONS),0,3,2,3,4)),extensions.push(tlsBytes(uint16be(EXT_PSK_KEY_EXCHANGE_MODES),0,2,1,1)),keyShares?.x25519&&keyShares?.p256) keyShareBytes=concatBytes(tlsBytes(0,29,uint16be(keyShares.x25519.length),keyShares.x25519),tlsBytes(0,23,uint16be(keyShares.p256.length),keyShares.p256));
        else if(keyShares?.x25519) keyShareBytes=tlsBytes(0,29,uint16be(keyShares.x25519.length),keyShares.x25519);
        else if(keyShares?.p256) keyShareBytes=tlsBytes(0,23,uint16be(keyShares.p256.length),keyShares.p256);
        else{
            if(!(keyShares instanceof Uint8Array)) throw new Error("Invalid keyShares");
            keyShareBytes=tlsBytes(0,23,uint16be(keyShares.length),keyShares);
        }
        extensions.push(tlsBytes(uint16be(EXT_KEY_SHARE),uint16be(keyShareBytes.length+2),uint16be(keyShareBytes.length),keyShareBytes));
    }
    const extensionsBytes=concatBytes(...extensions);
    return buildHandshakeMessage(HANDSHAKE_TYPE_CLIENT_HELLO,tlsBytes(uint16be(TLS_VERSION_12),clientRandom,0,uint16be(cipherBytes.length),cipherBytes,1,0,uint16be(extensionsBytes.length),extensionsBytes));
}
const uint64be=(sequenceNumber)=>{const bytes=new Uint8Array(8);return new DataView(bytes.buffer).setBigUint64(0,sequenceNumber,!1),bytes;},
    xorSequenceIntoIv=(initializationVector,sequenceNumber)=>{
        const nonce=initializationVector.slice(),
            sequenceBytes=uint64be(sequenceNumber);
        for(let index=0;index<8;index++) nonce[nonce.length-8+index]^=sequenceBytes[index];
        return nonce;
    },
    deriveTrafficKeys=(hash,secret,keyLen,ivLen)=>Promise.all([hkdfExpandLabel(hash,secret,"key",EMPTY_BYTES,keyLen),hkdfExpandLabel(hash,secret,"iv",EMPTY_BYTES,ivLen)]);
class TlsClient{
    constructor(socket,options={}){
        if(this.socket=socket,this.serverName=options.serverName||"",this.supportTls13=!1!==options.tls13,this.supportTls12=!1!==options.tls12,!this.supportTls13&&!this.supportTls12) throw new Error("At least one TLS version must be enabled");
        this.alpnProtocols=Array.isArray(options.alpn)?options.alpn:options.alpn?[options.alpn]:null,this.allowChacha=options.allowChacha!==false,this.timeout=options.timeout??3e4,this.clientRandom=randomBytes(32),this.serverRandom=null,this.handshakeChunks=[],this.handshakeComplete=!1,this.negotiatedAlpn=null,this.cipherSuite=null,this.cipherConfig=null,this.isTls13=!1,this.masterSecret=null,this.handshakeSecret=null,this.clientWriteKey=null,this.serverWriteKey=null,this.clientWriteIv=null,this.serverWriteIv=null,this.clientHandshakeKey=null,this.serverHandshakeKey=null,this.clientHandshakeIv=null,this.serverHandshakeIv=null,this.clientAppKey=null,this.serverAppKey=null,this.clientAppIv=null,this.serverAppIv=null,this.clientWriteCryptoKey=null,this.serverWriteCryptoKey=null,this.clientHandshakeCryptoKey=null,this.serverHandshakeCryptoKey=null,this.clientAppCryptoKey=null,this.serverAppCryptoKey=null,this.clientSeqNum=0n,this.serverSeqNum=0n,this.recordParser=new TlsRecordParser,this.handshakeParser=new TlsHandshakeParser,this.keyPairs=new Map,this.ecdhKeyPair=null,this.sawCert=!1;
    }
    recordHandshake(chunk){this.handshakeChunks.push(chunk);}
    transcript(){return 1===this.handshakeChunks.length?this.handshakeChunks[0]:concatBytes(...this.handshakeChunks);}
    getCipherConfig(cipherSuite){return CIPHER_SUITES_BY_ID.get(cipherSuite)||null;}
    async readChunk(reader){return this.timeout?Promise.race([reader.read(),new Promise(((resolve,reject)=>setTimeout((()=>reject(new Error("TLS read timeout"))),this.timeout)))]):reader.read();}
    async readRecordsUntil(reader,predicate,closedError){
        for(;;){
            let record;
            for(;record=this.recordParser.next();)
                if(await predicate(record)) return;
            const {value,done}=await this.readChunk(reader);
            if(done) throw new Error(closedError);
            this.recordParser.feed(value);
        }
    }
    async readHandshakeUntil(reader,predicate,closedError){
        for(let message;message=this.handshakeParser.next();)
            if(await predicate(message)) return;
        return this.readRecordsUntil(reader,(async(record)=>{
            if(record.type===CONTENT_TYPE_ALERT){
                if(shouldIgnoreTlsAlert(record.fragment)) return;
                throw new Error(`TLS Alert: ${record.fragment[1]}`);
            }
            if(record.type===CONTENT_TYPE_HANDSHAKE){
                this.handshakeParser.feed(record.fragment);
                for(let message;message=this.handshakeParser.next();)
                    if(await predicate(message)) return 1;
            }
        }),closedError);
    }
    async acceptCertificate(certificate){if(!certificate?.length) throw new Error("Empty certificate");this.sawCert=!0;}
    async handshake(){
        const [p256Share,x25519Share]=await Promise.all([generateKeyShare("P-256"),generateKeyShare("X25519")]);
        this.keyPairs=new Map([[23,p256Share],[29,x25519Share]]),this.ecdhKeyPair=p256Share.keyPair;
        const reader=this.socket.readable.getReader(),
            writer=this.socket.writable.getWriter();
        try{
            const clientHello=buildClientHello(this.clientRandom,this.serverName,{x25519:x25519Share.publicKeyRaw,p256:p256Share.publicKeyRaw},{tls13:this.supportTls13,tls12:this.supportTls12,alpn:this.alpnProtocols,chacha:this.allowChacha});
            this.recordHandshake(clientHello),await writer.write(buildTlsRecord(CONTENT_TYPE_HANDSHAKE,clientHello,TLS_VERSION_10));
            const serverHello=await this.receiveServerHello(reader);
            if(serverHello.isHRR) throw new Error("HelloRetryRequest is not supported by TLSClientMini");
            if(serverHello.keyShare?.group&&this.keyPairs.has(serverHello.keyShare.group)){
                const selectedKeyPair=this.keyPairs.get(serverHello.keyShare.group);
                this.ecdhKeyPair=selectedKeyPair.keyPair;
            }
            serverHello.isTls13?await this.handshakeTls13(reader,writer,serverHello):await this.handshakeTls12(reader,writer),this.handshakeComplete=!0;
        }finally{
            reader.releaseLock(),writer.releaseLock();
        }
    }
    async receiveServerHello(reader){
        for(;;){
            const {value,done}=await this.readChunk(reader);
            if(done) throw new Error("Connection closed waiting for ServerHello");
            let record;
            for(this.recordParser.feed(value);record=this.recordParser.next();){
                if(record.type===CONTENT_TYPE_ALERT){
                    if(shouldIgnoreTlsAlert(record.fragment)) continue;
                    throw new Error(`TLS Alert: level=${record.fragment[0]}, desc=${record.fragment[1]}`);
                }
                if(record.type!==CONTENT_TYPE_HANDSHAKE) continue;
                let message;
                for(this.handshakeParser.feed(record.fragment);message=this.handshakeParser.next();){
                    if(message.type!==HANDSHAKE_TYPE_SERVER_HELLO) continue;
                    this.recordHandshake(message.raw);
                    const serverHello=parseServerHello(message.body);
                    if(this.serverRandom=serverHello.serverRandom,this.cipherSuite=serverHello.cipherSuite,this.cipherConfig=this.getCipherConfig(serverHello.cipherSuite),this.isTls13=serverHello.isTls13,this.negotiatedAlpn=serverHello.alpn||null,!this.cipherConfig) throw new Error(`Unsupported cipher suite: 0x${serverHello.cipherSuite.toString(16)}`);
                    return serverHello;
                }
            }
        }
    }
    async handshakeTls12(reader,writer){
        let serverKeyExchange=null;
        let sawServerHelloDone=!1;
        let clientCertRequested=!1;
        if(await this.readHandshakeUntil(reader,(async(message)=>{
            switch(message.type){
                case HANDSHAKE_TYPE_CERTIFICATE:{
                    this.recordHandshake(message.raw);
                    const certificate=extractLeafCertificate(message.body,1);
                    if(!certificate) throw new Error("Missing TLS 1.2 certificate");
                    await this.acceptCertificate(certificate);
                    break;
                }
                case HANDSHAKE_TYPE_SERVER_KEY_EXCHANGE:
                    this.recordHandshake(message.raw),serverKeyExchange=parseServerKeyExchange(message.body);
                    break;
                case HANDSHAKE_TYPE_SERVER_HELLO_DONE:
                    return this.recordHandshake(message.raw),sawServerHelloDone=!0,1;
                case HANDSHAKE_TYPE_CERTIFICATE_REQUEST:
                    this.recordHandshake(message.raw),clientCertRequested=!0;
                    break;
                default:
                    this.recordHandshake(message.raw);
            }
        }),"Connection closed during TLS 1.2 handshake"),!this.sawCert) throw new Error("Missing TLS 1.2 leaf certificate");
        const serverKeyExchangeData=serverKeyExchange;
        if(!serverKeyExchangeData) throw new Error("Missing TLS 1.2 ServerKeyExchange");
        const curveName=GROUPS_BY_ID.get(serverKeyExchangeData.namedCurve);
        if(!curveName) throw new Error(`Unsupported named curve: 0x${serverKeyExchangeData.namedCurve.toString(16)}`);
        const keyShare=this.keyPairs.get(serverKeyExchangeData.namedCurve);
        if(!keyShare) throw new Error(`Missing key pair for curve: 0x${serverKeyExchangeData.namedCurve.toString(16)}`);
        const preMasterSecret=await deriveSharedSecret(keyShare.keyPair.privateKey,serverKeyExchangeData.serverPublicKey,curveName),
            clientKeyExchange=buildHandshakeMessage(HANDSHAKE_TYPE_CLIENT_KEY_EXCHANGE,tlsBytes(keyShare.publicKeyRaw.length,keyShare.publicKeyRaw));
        if(clientCertRequested){
            const emptyCertificate=buildHandshakeMessage(HANDSHAKE_TYPE_CERTIFICATE,tlsBytes(0,0,0));
            this.recordHandshake(emptyCertificate),await writer.write(buildTlsRecord(CONTENT_TYPE_HANDSHAKE,emptyCertificate));
        }
        this.recordHandshake(clientKeyExchange);
        const hashName=this.cipherConfig.hash;
        this.masterSecret=await tls12Prf(preMasterSecret,"master secret",concatBytes(this.clientRandom,this.serverRandom),48,hashName);
        const keyLen=this.cipherConfig.keyLen,
            ivLen=this.cipherConfig.ivLen,
            keyBlock=await tls12Prf(this.masterSecret,"key expansion",concatBytes(this.serverRandom,this.clientRandom),2*keyLen+2*ivLen,hashName);
        this.clientWriteKey=keyBlock.slice(0,keyLen),this.serverWriteKey=keyBlock.slice(keyLen,2*keyLen),this.clientWriteIv=keyBlock.slice(2*keyLen,2*keyLen+ivLen),this.serverWriteIv=keyBlock.slice(2*keyLen+ivLen,2*keyLen+2*ivLen);
        if(!this.cipherConfig.chacha) [this.clientWriteCryptoKey,this.serverWriteCryptoKey]=await Promise.all([importAesGcmKey(this.clientWriteKey,["encrypt"]),importAesGcmKey(this.serverWriteKey,["decrypt"])]);
        await writer.write(buildTlsRecord(CONTENT_TYPE_HANDSHAKE,clientKeyExchange)),await writer.write(buildTlsRecord(CONTENT_TYPE_CHANGE_CIPHER_SPEC,tlsBytes(1)));
        const clientVerifyData=await tls12Prf(this.masterSecret,"client finished",await digestBytes(hashName,this.transcript()),12,hashName),
            finishedMessage=buildHandshakeMessage(HANDSHAKE_TYPE_FINISHED,clientVerifyData);
        this.recordHandshake(finishedMessage),await writer.write(buildTlsRecord(CONTENT_TYPE_HANDSHAKE,await this.encryptTls12(finishedMessage,CONTENT_TYPE_HANDSHAKE)));
        let sawChangeCipherSpec=!1;
        await this.readRecordsUntil(reader,(async(record)=>{
            if(record.type===CONTENT_TYPE_ALERT){
                if(shouldIgnoreTlsAlert(record.fragment)) return;
                throw new Error(`TLS Alert: ${record.fragment[1]}`);
            }
            if(record.type===CONTENT_TYPE_CHANGE_CIPHER_SPEC) return void(sawChangeCipherSpec=!0);
            if(record.type!==CONTENT_TYPE_HANDSHAKE||!sawChangeCipherSpec) return;
            const decrypted=await this.decryptTls12(record.fragment,CONTENT_TYPE_HANDSHAKE);
            if(decrypted[0]!==HANDSHAKE_TYPE_FINISHED) return;
            const verifyLength=readUint24(decrypted,1),
                verifyData=decrypted.slice(4,4+verifyLength),
                expectedVerifyData=await tls12Prf(this.masterSecret,"server finished",await digestBytes(hashName,this.transcript()),12,hashName);
            if(!constantTimeEqual(verifyData,expectedVerifyData)) throw new Error("TLS 1.2 server Finished verify failed");
            return 1;
        }),"Connection closed waiting for TLS 1.2 Finished");
    }
    async handshakeTls13(reader,writer,serverHello){
        const groupName=GROUPS_BY_ID.get(serverHello.keyShare?.group);
        if(!groupName||!serverHello.keyShare?.key?.length) throw new Error("Missing TLS 1.3 key_share");
        const hashName=this.cipherConfig.hash,
            hashLen=hashByteLength(hashName),
            keyLen=this.cipherConfig.keyLen,
            ivLen=this.cipherConfig.ivLen,
            sharedSecret=await deriveSharedSecret(this.ecdhKeyPair.privateKey,serverHello.keyShare.key,groupName),
            earlySecret=await hkdfExtract(hashName,null,new Uint8Array(hashLen)),
            derivedSecret=await hkdfExpandLabel(hashName,earlySecret,"derived",await digestBytes(hashName,EMPTY_BYTES),hashLen);
        this.handshakeSecret=await hkdfExtract(hashName,derivedSecret,sharedSecret);
        const transcriptHash=await digestBytes(hashName,this.transcript()),
            clientHandshakeTrafficSecret=await hkdfExpandLabel(hashName,this.handshakeSecret,"c hs traffic",transcriptHash,hashLen),
            serverHandshakeTrafficSecret=await hkdfExpandLabel(hashName,this.handshakeSecret,"s hs traffic",transcriptHash,hashLen);
        [this.clientHandshakeKey,this.clientHandshakeIv]=await deriveTrafficKeys(hashName,clientHandshakeTrafficSecret,keyLen,ivLen),[this.serverHandshakeKey,this.serverHandshakeIv]=await deriveTrafficKeys(hashName,serverHandshakeTrafficSecret,keyLen,ivLen);
        if(!this.cipherConfig.chacha) [this.clientHandshakeCryptoKey,this.serverHandshakeCryptoKey]=await Promise.all([importAesGcmKey(this.clientHandshakeKey,["encrypt"]),importAesGcmKey(this.serverHandshakeKey,["decrypt"])]);
        const serverFinishedKey=await hkdfExpandLabel(hashName,serverHandshakeTrafficSecret,"finished",EMPTY_BYTES,hashLen);
        let serverFinishedReceived=!1;
        let clientCertRequested=!1;
        const handleHandshakeMessage=async(message)=>{
            switch(message.type){
                case HANDSHAKE_TYPE_ENCRYPTED_EXTENSIONS:{
                    const encryptedExtensions=parseEncryptedExtensions(message.body);
                    encryptedExtensions.alpn&&(this.negotiatedAlpn=encryptedExtensions.alpn),this.recordHandshake(message.raw);
                    break;
                }
                case HANDSHAKE_TYPE_CERTIFICATE:{
                    const certificate=extractLeafCertificate(message.body);
                    if(!certificate) throw new Error("Missing TLS 1.3 certificate");
                    await this.acceptCertificate(certificate),this.recordHandshake(message.raw);
                    break;
                }
                case HANDSHAKE_TYPE_CERTIFICATE_REQUEST:
                    this.recordHandshake(message.raw),clientCertRequested=!0;
                    break;
                case HANDSHAKE_TYPE_CERTIFICATE_VERIFY:
                    this.recordHandshake(message.raw);
                    break;
                case HANDSHAKE_TYPE_FINISHED:{
                    const expectedVerifyData=await hmac(hashName,serverFinishedKey,await digestBytes(hashName,this.transcript()));
                    if(!constantTimeEqual(expectedVerifyData,message.body)) throw new Error("TLS 1.3 server Finished verify failed");
                    this.recordHandshake(message.raw),serverFinishedReceived=!0;
                    break;
                }
                default:
                    this.recordHandshake(message.raw);
            }
        };
        await this.readRecordsUntil(reader,(async(record)=>{
            if(record.type===CONTENT_TYPE_CHANGE_CIPHER_SPEC||record.type===CONTENT_TYPE_HANDSHAKE) return;
            if(record.type===CONTENT_TYPE_ALERT){
                if(shouldIgnoreTlsAlert(record.fragment)) return;
                throw new Error(`TLS Alert: ${record.fragment[1]}`);
            }
            if(record.type!==CONTENT_TYPE_APPLICATION_DATA) return;
            const decrypted=await this.decryptTls13Handshake(record.fragment),
                innerType=decrypted[decrypted.length-1],
                plaintext=decrypted.slice(0,-1);
            if(innerType===CONTENT_TYPE_HANDSHAKE){
                this.handshakeParser.feed(plaintext);
                for(let message;message=this.handshakeParser.next();)
                    if(await handleHandshakeMessage(message),serverFinishedReceived) return 1;
            }
        }),"Connection closed during TLS 1.3 handshake");
        const applicationTranscriptHash=await digestBytes(hashName,this.transcript()),
            masterDerivedSecret=await hkdfExpandLabel(hashName,this.handshakeSecret,"derived",await digestBytes(hashName,EMPTY_BYTES),hashLen),
            masterSecret=await hkdfExtract(hashName,masterDerivedSecret,new Uint8Array(hashLen)),
            clientAppTrafficSecret=await hkdfExpandLabel(hashName,masterSecret,"c ap traffic",applicationTranscriptHash,hashLen),
            serverAppTrafficSecret=await hkdfExpandLabel(hashName,masterSecret,"s ap traffic",applicationTranscriptHash,hashLen);
        [this.clientAppKey,this.clientAppIv]=await deriveTrafficKeys(hashName,clientAppTrafficSecret,keyLen,ivLen),[this.serverAppKey,this.serverAppIv]=await deriveTrafficKeys(hashName,serverAppTrafficSecret,keyLen,ivLen);
        if(!this.cipherConfig.chacha) [this.clientAppCryptoKey,this.serverAppCryptoKey]=await Promise.all([importAesGcmKey(this.clientAppKey,["encrypt"]),importAesGcmKey(this.serverAppKey,["decrypt"])]);
        let clientFlightHandshake=EMPTY_BYTES;
        if(clientCertRequested) clientFlightHandshake=buildHandshakeMessage(HANDSHAKE_TYPE_CERTIFICATE,tlsBytes(0,0,0,0)),this.recordHandshake(clientFlightHandshake);
        const clientFinishedKey=await hkdfExpandLabel(hashName,clientHandshakeTrafficSecret,"finished",EMPTY_BYTES,hashLen),
            clientFinishedVerifyData=await hmac(hashName,clientFinishedKey,await digestBytes(hashName,this.transcript())),
            clientFinishedMessage=buildHandshakeMessage(HANDSHAKE_TYPE_FINISHED,clientFinishedVerifyData);
        this.recordHandshake(clientFinishedMessage),await writer.write(buildTlsRecord(CONTENT_TYPE_APPLICATION_DATA,await this.encryptTls13Handshake(concatBytes(clientFlightHandshake,clientFinishedMessage,[CONTENT_TYPE_HANDSHAKE])))),this.clientSeqNum=0n,this.serverSeqNum=0n;
    }
    async encryptTls12(plaintext,contentType){
        const sequenceNumber=this.clientSeqNum++,
            sequenceBytes=uint64be(sequenceNumber),
            additionalData=concatBytes(sequenceBytes,[contentType],uint16be(TLS_VERSION_12),uint16be(plaintext.length));
        if(this.cipherConfig.chacha){
            const nonce=xorSequenceIntoIv(this.clientWriteIv,sequenceNumber);
            return chacha20Poly1305Encrypt(this.clientWriteKey,nonce,plaintext,additionalData);
        }
        const explicitNonce=randomBytes(8);
        if(!this.clientWriteCryptoKey) this.clientWriteCryptoKey=await importAesGcmKey(this.clientWriteKey,["encrypt"]);
        return concatBytes(explicitNonce,await aesGcmEncryptWithKey(this.clientWriteCryptoKey,concatBytes(this.clientWriteIv,explicitNonce),plaintext,additionalData));
    }
    async decryptTls12(ciphertext,contentType){
        const sequenceNumber=this.serverSeqNum++,
            sequenceBytes=uint64be(sequenceNumber);
        if(this.cipherConfig.chacha){
            const nonce=xorSequenceIntoIv(this.serverWriteIv,sequenceNumber);
            return chacha20Poly1305Decrypt(this.serverWriteKey,nonce,ciphertext,concatBytes(sequenceBytes,[contentType],uint16be(TLS_VERSION_12),uint16be(ciphertext.length-16)));
        }
        const explicitNonce=ciphertext.subarray(0,8),
            encryptedData=ciphertext.subarray(8);
        if(!this.serverWriteCryptoKey) this.serverWriteCryptoKey=await importAesGcmKey(this.serverWriteKey,["decrypt"]);
        return aesGcmDecryptWithKey(this.serverWriteCryptoKey,concatBytes(this.serverWriteIv,explicitNonce),encryptedData,concatBytes(sequenceBytes,[contentType],uint16be(TLS_VERSION_12),uint16be(encryptedData.length-16)));
    }
    async encryptTls13Handshake(plaintext){
        const nonce=xorSequenceIntoIv(this.clientHandshakeIv,this.clientSeqNum++),
            additionalData=tlsBytes(CONTENT_TYPE_APPLICATION_DATA,3,3,uint16be(plaintext.length+16));
        if(this.cipherConfig.chacha) return chacha20Poly1305Encrypt(this.clientHandshakeKey,nonce,plaintext,additionalData);
        if(!this.clientHandshakeCryptoKey) this.clientHandshakeCryptoKey=await importAesGcmKey(this.clientHandshakeKey,["encrypt"]);
        return aesGcmEncryptWithKey(this.clientHandshakeCryptoKey,nonce,plaintext,additionalData);
    }
    async decryptTls13Handshake(ciphertext){
        const nonce=xorSequenceIntoIv(this.serverHandshakeIv,this.serverSeqNum++),
            additionalData=tlsBytes(CONTENT_TYPE_APPLICATION_DATA,3,3,uint16be(ciphertext.length));
        const decrypted=this.cipherConfig.chacha?await chacha20Poly1305Decrypt(this.serverHandshakeKey,nonce,ciphertext,additionalData):await aesGcmDecryptWithKey(this.serverHandshakeCryptoKey||(this.serverHandshakeCryptoKey=await importAesGcmKey(this.serverHandshakeKey,["decrypt"])),nonce,ciphertext,additionalData);
        let innerTypeIndex=decrypted.length-1;
        for(;innerTypeIndex>=0&&!decrypted[innerTypeIndex];) innerTypeIndex--;
        return innerTypeIndex<0?EMPTY_BYTES:decrypted.slice(0,innerTypeIndex+1);
    }
    async encryptTls13(data){
        const plaintext=concatBytes(data,[CONTENT_TYPE_APPLICATION_DATA]),
            nonce=xorSequenceIntoIv(this.clientAppIv,this.clientSeqNum++),
            additionalData=tlsBytes(CONTENT_TYPE_APPLICATION_DATA,3,3,uint16be(plaintext.length+16));
        if(this.cipherConfig.chacha) return chacha20Poly1305Encrypt(this.clientAppKey,nonce,plaintext,additionalData);
        if(!this.clientAppCryptoKey) this.clientAppCryptoKey=await importAesGcmKey(this.clientAppKey,["encrypt"]);
        return aesGcmEncryptWithKey(this.clientAppCryptoKey,nonce,plaintext,additionalData);
    }
    async decryptTls13(ciphertext){
        const nonce=xorSequenceIntoIv(this.serverAppIv,this.serverSeqNum++),
            additionalData=tlsBytes(CONTENT_TYPE_APPLICATION_DATA,3,3,uint16be(ciphertext.length)),
            plaintext=this.cipherConfig.chacha?await chacha20Poly1305Decrypt(this.serverAppKey,nonce,ciphertext,additionalData):await aesGcmDecryptWithKey(this.serverAppCryptoKey||(this.serverAppCryptoKey=await importAesGcmKey(this.serverAppKey,["decrypt"])),nonce,ciphertext,additionalData);
        let innerTypeIndex=plaintext.length-1;
        for(;innerTypeIndex>=0&&!plaintext[innerTypeIndex];) innerTypeIndex--;
        if(innerTypeIndex<0) return {data:EMPTY_BYTES,type:0};
        return {data:plaintext.slice(0,innerTypeIndex),type:plaintext[innerTypeIndex]};
    }
    async write(data){
        if(!this.handshakeComplete) throw new Error("Handshake not complete");
        const plaintext=toUint8(data);
        if(!plaintext.byteLength) return;
        const writer=this.socket.writable.getWriter();
        try{
            const records=[];
            for(let offset=0;offset<plaintext.byteLength;offset+=TLS_MAX_PLAINTEXT_FRAGMENT){
                const chunk=plaintext.subarray(offset,Math.min(offset+TLS_MAX_PLAINTEXT_FRAGMENT,plaintext.byteLength));
                const encrypted=this.isTls13?await this.encryptTls13(chunk):await this.encryptTls12(chunk,CONTENT_TYPE_APPLICATION_DATA);
                records.push(buildTlsRecord(CONTENT_TYPE_APPLICATION_DATA,encrypted));
            }
            await writer.write(records.length===1?records[0]:concatBytes(...records));
        }finally{
            writer.releaseLock();
        }
    }
    async read(){
        for(;;){
            let record;
            for(;record=this.recordParser.next();){
                if(record.type===CONTENT_TYPE_ALERT){
                    if(record.fragment[1]===ALERT_CLOSE_NOTIFY) return null;
                    throw new Error(`TLS Alert: ${record.fragment[1]}`);
                }
                if(record.type!==CONTENT_TYPE_APPLICATION_DATA) continue;
                if(!this.isTls13) return this.decryptTls12(record.fragment,CONTENT_TYPE_APPLICATION_DATA);
                const {data,type}=await this.decryptTls13(record.fragment);
                if(type===CONTENT_TYPE_APPLICATION_DATA) return data;
                if(type===CONTENT_TYPE_ALERT){
                    if(data[1]===ALERT_CLOSE_NOTIFY) return null;
                    throw new Error(`TLS Alert: ${data[1]}`);
                }
                if(type!==CONTENT_TYPE_HANDSHAKE) continue;
                let message;
                for(this.handshakeParser.feed(data);message=this.handshakeParser.next();)
                    if(message.type!==HANDSHAKE_TYPE_NEW_SESSION_TICKET&&message.type===HANDSHAKE_TYPE_KEY_UPDATE) throw new Error("TLS 1.3 KeyUpdate is not supported by TLSClientMini");
            }
            const reader=this.socket.readable.getReader();
            try{
                const {value,done}=await this.readChunk(reader);
                if(done) return null;
                this.recordParser.feed(value);
            }finally{
                reader.releaseLock();
            }
        }
    }
    close(){this.socket.close();}
}

// HTTPS 代理建连：先自研 TLS 握手（不校验证书），再发 CONNECT
async function httpsConnect(targetHost,targetPort,initialData,proxyConfig){
    const {username,password}=proxyConfig;
    const host=stripIPv6Brackets(proxyConfig.host),port=proxyConfig.port;
    let tlsSocket=null;
    const tlsServerName=isIPHostname(host)?"":stripIPv6Brackets(host);
    const openTls=async(allowChacha=false)=>{
        const proxySocket=connect({hostname:host,port});
        try{
            await proxySocket.opened;
            const socket=new TlsClient(proxySocket,{serverName:tlsServerName,insecure:true,allowChacha});
            await socket.handshake();
            return socket;
        }catch(error){
            try{proxySocket.close();}catch(e){}
            throw error;
        }
    };
    try{
        try{
            tlsSocket=await openTls(false);
        }catch(error){
            if(!/cipher|handshake|TLS Alert|ServerHello|Finished|Unsupported|Missing TLS/i.test(error?.message||`${error||""}`)) throw error;
            tlsSocket=await openTls(true);
        }

        const auth=username&&password?`Proxy-Authorization: Basic ${btoa(username+":"+password)}\r\n`:"";
        const target=`${stripIPv6Brackets(targetHost)}:${targetPort}`;
        const request=`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}User-Agent: Mozilla/5.0\r\nConnection: keep-alive\r\n\r\n`;
        await tlsSocket.write(textEncoder.encode(request));

        let responseBuffer=new Uint8Array(0),headerEndIndex=-1,bytesRead=0;
        while(headerEndIndex===-1&&bytesRead<8192){
            const value=await tlsSocket.read();
            if(!value) throw new Error("HTTPS proxy closed before CONNECT response");
            responseBuffer=concatBytes(responseBuffer,value);
            bytesRead=responseBuffer.length;
            const crlfcrlf=responseBuffer.findIndex((_,i)=>i<responseBuffer.length-3&&responseBuffer[i]===0x0d&&responseBuffer[i+1]===0x0a&&responseBuffer[i+2]===0x0d&&responseBuffer[i+3]===0x0a);
            if(crlfcrlf!==-1) headerEndIndex=crlfcrlf+4;
        }
        if(headerEndIndex===-1) throw new Error("HTTPS proxy CONNECT response header too long or invalid");
        const statusMatch=textDecoder.decode(responseBuffer.slice(0,headerEndIndex)).split("\r\n")[0].match(/HTTP\/\d\.\d\s+(\d+)/);
        const statusCode=statusMatch?parseInt(statusMatch[1],10):NaN;
        if(!Number.isFinite(statusCode)||statusCode<200||statusCode>=300) throw new Error("HTTPS proxy refused connection: HTTP "+statusCode);

        if(toUint8(initialData).byteLength>0) await tlsSocket.write(toUint8(initialData));
        const bufferedData=bytesRead>headerEndIndex?responseBuffer.subarray(headerEndIndex,bytesRead):null;
        let closedSettled=!1,resolveClosed,rejectClosed;
        const settleClosed=(settle,value)=>{
            if(!closedSettled){
                closedSettled=!0;
                settle(value);
            }
        };
        const closed=new Promise((resolve,reject)=>{
            resolveClosed=resolve;
            rejectClosed=reject;
        });
        const close=()=>{
            try{tlsSocket.close();}catch(e){}
            settleClosed(resolveClosed);
        };
        const readable=new ReadableStream({
            async start(controller){
                try{
                    if(toUint8(bufferedData).byteLength>0) controller.enqueue(bufferedData);
                    while(true){
                        const data=await tlsSocket.read();
                        if(!data) break;
                        if(data.byteLength>0) controller.enqueue(data);
                    }
                    try{controller.close();}catch(e){}
                    settleClosed(resolveClosed);
                }catch(error){
                    try{controller.error(error);}catch(e){}
                    settleClosed(rejectClosed,error);
                }
            },
            cancel(){
                close();
            },
        });
        const writable=new WritableStream({
            async write(chunk){
                await tlsSocket.write(toUint8(chunk));
            },
            close,
            abort(error){
                close();
                if(error) settleClosed(rejectClosed,error);
            },
        });
        return {readable,writable,closed,close};
    }catch(error){
        try{tlsSocket?.close();}catch(e){}
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
  // HTTPS 代理：主机是 IP 时走自研 TLS 客户端（不校验证书、支持 ChaCha20），
  // 分支判断与 edgetunnel / CF-Workers-CheckSocks5 完全一致
  if (type === "https" && isIPHostname(proxyConfig.host)) {
    return await httpsConnect(targetHost, targetPort, null, proxyConfig);
  }
  if (type === "http" || type === "https") return await httpConnect(proxyConfig, targetHost, targetPort, type === "https");
  const raw = connect({ hostname: stripIPv6Brackets(proxyConfig.host), port: proxyConfig.port });
  try {
    // 握手超时对齐 CheckSocks5 的 CONNECT_TIMEOUT_MS；原来写死 2500ms，慢代理会被误判成不可用
    const pair = await socks5Connect(raw, proxyConfig, targetHost, targetPort, PROXY_CONNECT_TIMEOUT_MS);
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

// 在已建好的隧道上做 TLS，再发一个 HTTP GET 读回完整响应。
// 校验强度对齐 CF-Workers-CheckSocks5：必须拿到响应头 + HTTP 2xx，
// 读超时 / 半途断开一律算失败（旧版会把收了一半的内容当成功返回，这是「不准」的来源之一）
async function tlsGetOverSocket(socket, host, port, path, timeoutMs) {
  const tls = new TlsClient(socket, {
    serverName: stripIPv6Brackets(host),
    timeout: timeoutMs,
    allowChacha: true,
  });
  await withTimeout(tls.handshake(), timeoutMs, "目标站点 TLS 握手超时");
  const request = "GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\nUser-Agent: Mozilla/5.0\r\n"
    + "Accept: */*\r\nConnection: close\r\n\r\n";
  await withTimeout(tls.write(proxyTextEncoder.encode(request)), timeoutMs, "发送请求超时");

  let buf = new Uint8Array(0);
  const maxBytes = 65536;
  while (buf.byteLength < maxBytes) {
    const value = await withTimeout(tls.read(), timeoutMs, "读取响应超时");
    if (!value) break;
    if (!value.byteLength) continue;
    buf = concatBytes(buf, value);
    const headEnd = findHeaderEnd(buf);
    if (headEnd === -1) continue;
    const head = proxyTextDecoder.decode(buf.subarray(0, headEnd));
    const length = readContentLength(head);
    if (length !== null) {
      if (buf.byteLength >= headEnd + length) break;
    } else if (/\r\ntransfer-encoding:\s*chunked/i.test(head)
      && proxyTextDecoder.decode(buf).indexOf("\r\n0\r\n\r\n") !== -1) {
      break;
    }
  }
  if (!buf.byteLength) throw new Error("目标站点无响应");
  const headEnd = findHeaderEnd(buf);
  if (headEnd === -1) throw new Error("目标站点响应头无效");
  const head = proxyTextDecoder.decode(buf.subarray(0, headEnd));
  const statusLine = head.split("\r\n")[0] || "";
  const statusMatch = /HTTP\/\d(?:\.\d)?\s+(\d+)/i.exec(statusLine);
  const statusCode = statusMatch ? Number(statusMatch[1]) : NaN;
  if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
    throw new Error("目标站点返回异常状态：" + (statusLine || "无法解析"));
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
// 与 edgetunnel / CF-Workers-CheckSocks5 一致：先把隧道建到目标站点，再在隧道里做 TLS + HTTP 请求，
// 只有拿到真实出口 IP 才算出活；延迟取「建隧道 → 读完响应」的整段耗时
async function runCheck(type, address, cfg) {
  const timeoutMs = typeCfgOf(cfg, type).timeoutMs;
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
    const text = await tlsGetOverSocket(socket, TRACE_HOST, TRACE_PORT, TRACE_PATH, timeoutMs);
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

/* ---- 优选IP / 优选域名 的候选构造 ----
 * 与 CF-Pages-BestCF 一致：段表里每一行取一个随机地址，域名直接取名单，端口统一用设置的端口。
 * 都不做任何验证，验证在浏览器里由 trace 完成。
 */
function parseCidrLine(line) {
  const m = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(line);
  if (!m) return null;
  const bits = parseInt(m[2], 10);
  if (!(bits >= 0 && bits <= (m[1].indexOf(":") === -1 ? 32 : 128))) return null;
  return { base: m[1], bits };
}

function ipv4ToInt(ip) {
  const p = String(ip).split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const s of p) {
    const v = parseInt(s, 10);
    if (!(v >= 0 && v <= 255)) return null;
    n = n * 256 + v;
  }
  return n;
}
function intToIpv4(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}
function ipv6ToBigInt(ip) {
  let s = String(ip).trim();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  const groups = head.concat(new Array(fill).fill("0"), tail);
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}
function bigIntToIpv6(n) {
  const parts = [];
  for (let i = 0; i < 8; i++) { parts.unshift((n & 0xffffn).toString(16)); n >>= 16n; }
  return parts.join(":");
}

// 在段里随机取一个地址（保留段前缀，只随机主机位）
function randomIpFromCidr(base, bits) {
  if (String(base).indexOf(":") === -1) {
    const n = ipv4ToInt(base);
    if (n === null) return null;
    const hostBits = 32 - bits;
    if (hostBits <= 0) return base;
    const off = Math.floor(Math.random() * Math.pow(2, hostBits));
    return intToIpv4((n + off) >>> 0);
  }
  const v6 = ipv6ToBigInt(base);
  if (v6 === null) return null;
  const hostBits = 128 - bits;
  if (hostBits <= 0) return base;
  let r = 0n;
  for (let i = 0; i < 4; i++) r = (r << 16n) | BigInt(Math.floor(Math.random() * 65536));
  return bigIntToIpv6(v6 + (r % (1n << BigInt(hostBits))));
}

// IP 区间：a.b.c.d-a.b.c.e（两端都算在内），与 BestCF 的 parseIpRange 一致
function parseIpRange(line) {
  const sep = String(line).indexOf("-");
  if (sep <= 0 || sep !== line.lastIndexOf("-")) return null;
  const startText = line.slice(0, sep).replace(/^\[|\]$/g, "");
  const endText = line.slice(sep + 1).replace(/^\[|\]$/g, "");

  const s4 = ipv4ToInt(startText);
  const e4 = ipv4ToInt(endText);
  if (s4 !== null && e4 !== null) {
    if (s4 > e4) return null;
    return { v6: false, base: s4, size: e4 - s4 + 1 };
  }

  const s6 = ipv6ToBigInt(startText);
  const e6 = ipv6ToBigInt(endText);
  if (s6 !== null && e6 !== null) {
    if (s6 > e6) return null;
    return { v6: true, base: s6, size: e6 - s6 + 1n };
  }
  return null;
}

function randomIpFromRange(range) {
  if (!range.v6) {
    const off = Math.floor(Math.random() * range.size);
    return intToIpv4((range.base + off) >>> 0);
  }
  let r = 0n;
  for (let i = 0; i < 4; i++) r = (r << 16n) | BigInt(Math.floor(Math.random() * 65536));
  return bigIntToIpv6(range.base + (r % range.size));
}

// 优选IP / 优选域名 的候选只有地址有用：国家、城市、ASN 这些字段测出来才知道，
// 池子里一律留空，省得七份源合起来几千条把 KV 撑大
function cfItem(host) {
  const hostText = String(host).indexOf(":") !== -1 ? "[" + host + "]" : String(host);
  return { address: hostText + ":" + CF_DEFAULT_PORT };
}

// 段表/名单的兜底：raw.githubusercontent 拉不通时换 jsDelivr 上的同一个仓库
function mirrorUrl(url) {
  const prefix = "https://raw.githubusercontent.com/";
  if (url.indexOf(prefix) === 0) {
    const rest = url.slice(prefix.length);
    const slash = rest.indexOf("/");
    const branch = rest.indexOf("/", slash + 1);
    if (branch > 0) {
      const repo = rest.slice(0, slash) + "/" + rest.slice(slash + 1, branch);
      return "https://cdn.jsdelivr.net/gh/" + repo + "@" + rest.slice(branch + 1);
    }
  }
  return "";
}

async function fetchTextWithMirror(url, timeoutMs) {
  try {
    const res = await fetchWithTimeout(url, timeoutMs, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } catch (e) {
    const alt = mirrorUrl(url);
    if (!alt) throw e;
    const res = await fetchWithTimeout(alt, timeoutMs, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw e;
    return await res.text();
  }
}

async function fetchCfCandidates(type, cfg, srcList) {
  // 优选IP 的段表要采样，拉多少由面板上「每次拉取」决定，每份段表各拉这么多
  const limit = typeCfgOf(cfg, type).pullCount;
  if (type === "cfdomain") {
    // 几行域名名单各拉一份，全部并起来去重（名单本身不大，整份都用）；每条记下来自哪一行
    const texts = await Promise.all(srcList.map(async (src) => {
      try { return { key: src.key, text: await fetchTextWithMirror(src.url, 45000) }; }
      catch (e) { return { key: src.key, text: "" }; }
    }));
    const seen = {};
    const items = [];
    for (const one of texts) {
      for (const raw of String(one.text || "").split(/\r?\n/)) {
        const host = raw.trim().replace(/^#.*$/, "").trim();
        if (!host || host.indexOf(".") === -1 || /[\s/]/.test(host)) continue;
        if (seen[host]) continue;
        seen[host] = true;
        items.push(Object.assign(cfItem(host), { lib: one.key }));
      }
    }
    if (!items.length) throw new Error("域名名单为空");
    return items;
  }

  // 每份段表各抽满上限，候选池里同时存着所有源的地址，
  // 每条记下自己来自哪一行（lib）；优选时只挑当前选中的那份源来测
  const perLib = await Promise.all(srcList.map(async (src) => {
    try {
      return sampleLib(src.key, await fetchTextWithMirror(src.url, 45000), limit);
    } catch (e) {
      return [];   // 单份表拉不通就跳过，只要还有别的源能用
    }
  }));
  const items = [];
  const seen = new Set();
  for (const list of perLib) {
    for (const it of list) {
      if (seen.has(it.address)) continue;
      seen.add(it.address);
      items.push(it);
    }
  }
  if (!items.length) throw new Error("所有段表都没能拉到地址");
  return items;
}

// 单份段表：与 BestCF 的 prepareCandidates 一致，先分类（固定地址 / CIDR / 区间），各自打乱，
// 固定地址全部先放，CIDR 和区间轮流随机采样，凑满上限就停
function sampleLib(key, text, limit) {
  const lines = String(text || "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s.charAt(0) !== "#");

  const fixed = [];
  const cidrs = [];
  const ranges = [];
  for (const line of lines) {
    if (line.indexOf("/") !== -1) {
      const cidr = parseCidrLine(line);
      if (cidr) { cidrs.push(cidr); continue; }
    }
    const range = parseIpRange(line);
    if (range) { ranges.push(range); continue; }
    if (/^[0-9a-fA-F:.]+$/.test(line)) fixed.push(line);
  }

  const items = [];
  const seen = new Set();
  const add = (host) => {
    if (!host || seen.has(String(host)) || items.length >= limit) return false;
    seen.add(String(host));
    items.push(Object.assign(cfItem(host), { lib: key }));
    return true;
  };
  for (const host of randomSample(fixed, fixed.length)) add(host);

  if (cidrs.length && items.length < limit) {
    const order = randomSample(cidrs, cidrs.length);
    let attempts = 0;
    const maxAttempts = Math.max(limit * 12, order.length * 8);
    while (items.length < limit && attempts < maxAttempts) {
      add(randomIpFromCidr(order[attempts % order.length].base, order[attempts % order.length].bits));
      attempts++;
    }
  }

  if (ranges.length && items.length < limit) {
    const order = randomSample(ranges, ranges.length);
    let attempts = 0;
    const maxAttempts = Math.max(limit * 12, order.length * 8);
    while (items.length < limit && attempts < maxAttempts) {
      add(randomIpFromRange(order[attempts % order.length]));
      attempts++;
    }
  }
  return items;
}

// onlyLib：只拉这一份来源（定时优选传当前选中的 key）；不传则拉该类型全部来源
async function fetchCandidates(type, cfg, onlyLib) {
  const allRows = (cfg.cfSources && Array.isArray(cfg.cfSources[type]) && cfg.cfSources[type].length)
    ? cfg.cfSources[type]
    : (CF_SOURCES_DEFAULT[type] || []);
  const rows = onlyLib ? allRows.filter((r) => r.key === onlyLib) : allRows;
  if (!rows.length) throw new Error("类型 " + type + " 没有配置数据源");
  if (CF_TYPES.indexOf(type) !== -1) return fetchCfCandidates(type, cfg, rows);
  // 五类一个套路（SSTP 也一样）：全部并发拉，拉到的合并去重，全失败才报错。
  // 每条记下自己来自哪一行（lib），页面上选哪一份来源就测哪一份
  const lists = await Promise.all(rows.map(async (row) => {
    try {
      const res = await fetchWithTimeout(row.url, 45000, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      // VPN Gate 官方源是 CSV、镜像是 JSON，按内容判断；其余四类是 JSON 名单
      if (type === "sstp") return { key: row.key, items: parseSstpText(await res.text()) };
      const data = await res.json();
      const items = type === "proxyip" ? parseProxyIpList(data) : parseProxyList(data, type);
      return { key: row.key, items };
    } catch (e) {
      return { key: row.key, items: [] };   // 单个源不通就跳过，只要还有别的源能用
    }
  }));
  const merged = [];
  const seen = new Set();
  for (const one of lists) {
    for (const it of one.items) {
      if (!it || !it.address || seen.has(it.address)) continue;
      seen.add(it.address);
      merged.push(Object.assign({}, it, { lib: one.key }));
    }
  }
  if (!merged.length) throw new Error("数据源都没能拉到节点");
  return merged;
}

// VPN Gate 的两种格式：官方源是 CSV，镜像是 JSON，按内容判断，不按行号
function parseSstpText(text) {
  const s = String(text || "").trim();
  const asJson = () => {
    const data = JSON.parse(s);
    return parseMirrorJson(data);
  };
  if (s.charAt(0) === "{" || s.charAt(0) === "[") {
    try { return asJson(); } catch (e) {}
  }
  try { return parseVpngateCsv(s); } catch (e) {}
  try { return asJson(); } catch (e) {}
  return [];
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
// v3 起并发 / 超时 / 定时抽样数从全局挪到每类协议（typeCfg），旧配置读出来自动补默认值。
// v4 起 cfip / cfdomain 的默认超时对齐 BestCF 的 500ms，旧配置里的 2000 会被刷成新默认值。
// v5 起候选来源（段表列表 / 域名名单）存在 cfSources 里，面板上可增删改。
// v6 起这个字段覆盖全部七类：另外五类（SOCKS5 / HTTP / HTTPS / SSTP / ProxyIP）的列表源也能在面板上改。
// v7 起「这一轮测哪一份来源」从单一 cfLib 改成每类一份 libSel，七类页面上都有来源下拉。
// v8 起每轮只拉当前选中的那一份来源；定时优选只跑前五类，cfip / cfdomain 由浏览器手动测。
const CONFIG_VERSION = 8;

function normalizeConfig(raw) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, raw || {});
  // 定时优选不再有全局地区：每类协议用自己页面上选的地区（存 region:<type>），没选就跳过
  delete cfg.domain;
  // 并发 / 超时 / 定时抽样数改成每类协议各存一份，顶层的旧字段洗掉
  const rawTypeCfg = (raw && raw.typeCfg && typeof raw.typeCfg === "object") ? raw.typeCfg : {};
  cfg.typeCfg = {};
  for (const t of PROTOCOLS) {
    const def = TYPE_DEFAULTS[t] || TYPE_DEFAULTS.socks5;
    const one = rawTypeCfg[t] || {};
    cfg.typeCfg[t] = {
      concurrency: Math.max(1, Math.min(32, parseInt(one.concurrency, 10) || def.concurrency)),
      timeoutMs: Math.max(100, Math.min(120000, parseInt(one.timeoutMs, 10) || def.timeoutMs)),
      autoSample: Math.max(1, Math.min(4096, parseInt(one.autoSample, 10) || def.autoSample)),
      pullCount: Math.max(1, Math.min(4096, parseInt(one.pullCount, 10) || def.pullCount)),
    };
  }
  // v3 时代 cfip / cfdomain 的默认超时是 2000，现在与 BestCF 统一成 500；
  // 只刷「还是旧默认值 2000」的项，用户自己改成别的值就尊重他的设置
  if ((parseInt(raw && raw.v, 10) || 0) < 4) {
    for (const t of CF_TYPES) {
      if (parseInt(rawTypeCfg[t] && rawTypeCfg[t].timeoutMs, 10) === 2000) {
        cfg.typeCfg[t].timeoutMs = TYPE_DEFAULTS[t].timeoutMs;
      }
    }
  }
  delete cfg.concurrency;
  delete cfg.timeoutMs;
  delete cfg.autoSample;
  cfg.budgetMs = DEFAULT_CONFIG.budgetMs;   // 固定值，不接受 KV 里的旧配置覆盖
  delete cfg.maxPool;
  delete cfg.maxPerType;
  delete cfg.sstpTimeoutMs;                 // 已合并进 timeoutMs，洗掉旧配置里的字段
  // 定时优选的类型集合：只跑前五类代理，cfip / cfdomain 必须由浏览器测，不参与定时优选
  cfg.autoTypes = (Array.isArray(cfg.autoTypes) ? cfg.autoTypes : DEFAULT_CONFIG.autoTypes)
    .filter((t) => PROTOCOLS.indexOf(t) !== -1 && CF_TYPES.indexOf(t) === -1);
  if (!cfg.autoTypes.length) cfg.autoTypes = DEFAULT_CONFIG.autoTypes.slice();
  cfg.cfSources = sanitizeCfSources(raw && raw.cfSources);
  // 每类协议各记一份「这一轮测哪一份来源」：值必须是该类来源列表里的 key，
  // 选中的那份被删掉了就回落到第一份，避免下拉框空白
  const rawLibSel = (raw && raw.libSel && typeof raw.libSel === "object") ? raw.libSel : {};
  const legacyLib = String((raw && raw.cfLib) || "");   // v6 及以前只有优选IP 存了这个值
  cfg.libSel = {};
  for (const t of PROTOCOLS) {
    const keys = cfg.cfSources[t].map((x) => x.key);
    const want = String(rawLibSel[t] || (t === "cfip" ? legacyLib : "") || "");
    cfg.libSel[t] = keys.indexOf(want) !== -1 ? want : keys[0];
  }
  delete cfg.cfLib;
  delete cfg.cfPort;
  delete cfg.cfLimit;
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

// 无偏随机抽样：Fisher-Yates 部分洗牌，不改动原数组
function randomSample(arr, n) {
  const list = (Array.isArray(arr) ? arr : []).slice();
  const take = Math.min(n, list.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (list.length - i));
    const t = list[i]; list[i] = list[j]; list[j] = t;
  }
  return list.slice(0, take);
}

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
// 池子换了之后游标的作废放在 runChunk 里判断（按池子大小），不在这里一刀切清空。
async function fetchAndStore(env, type, cfg) {
  const items = await fetchCandidates(type, cfg);
  await kvPut(env, "pool:" + type, { fetchedAt: Date.now(), count: items.length, items });
  // 返回这次写进池子的条数：面板上「候选」是本类的总量，本轮实际测多少由选中的那份源决定
  return items.length;
}

// 一次调用只测一小批（受 budgetMs 约束），返回进度；面板循环调用直到 finished
// regionsOverride：传数组（空数组 = 不过滤，测全部）就优先于面板里存的地区选择；不传才读 region:<type>
async function runChunk(env, type, cfg, restart, regionsOverride) {
  const pool = await kvGet(env, "pool:" + type, { items: [], fetchedAt: 0 });
  const best = await kvGet(env, "best:" + type, EMPTY_BEST);
  const rawItems = Array.isArray(pool.items) ? pool.items : [];
  // 池子里装着该类型全部来源的候选，这一轮只测下拉选中的那一份（老池子没有 lib 字段就照旧全用）
  const selLib = libSelOf(cfg, type);
  const all = rawItems.filter((x) => !x.lib || x.lib === selLib);
  if (!all.length) {
    return { type, total: 0, done: 0, finished: true, ok: 0, poolSize: 0, filtered: 0, regions: [], message: "候选池为空，请先拉取候选" };
  }
  const regions = Array.isArray(regionsOverride) ? regionsOverride : await getRegions(env, type);
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
  const concurrency = typeCfgOf(cfg, type).concurrency;
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
        emoji: item.countryEmoji || countryFlag(code),
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
  const key = String(code || "").toUpperCase();
  return COUNTRY_ZH[key] || fallback || key || "XX";
}

// 两位国家码 → 国旗 emoji，数据源没带 emoji 时（VPN Gate）用
function countryFlag(code) {
  const key = String(code || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(key) || key === "XX") return "";
  return String.fromCodePoint(key.charCodeAt(0) + 127397, key.charCodeAt(1) + 127397);
}

async function buildState(env, cfg) {
  const state = { config: cfg, types: {}, meta: await kvGet(env, "meta", {}) };
  const built = await Promise.all(PROTOCOLS.map(async (type) => {
    const [pool, best, regionSelected] = await Promise.all([
      kvGet(env, "pool:" + type, { items: [], fetchedAt: 0 }),
      kvGet(env, "best:" + type, { runAt: 0, done: 0, items: [], ok: 0, total: 0 }),
      getRegions(env, type),
    ]);
    const items = sortedResults(best);
    const okItems = items.filter((x) => x.result && x.result.ok);
    const fastest = okItems.length ? okItems[0].result.latency : null;
    const rawPoolItems = Array.isArray(pool.items) ? pool.items : [];
    // 池子里装着该类型全部来源的候选：「候选」显示池子总量，
    // 而地区列表和本轮要测的条数只算下拉选中的那一份源
    const selLib = libSelOf(cfg, type);
    const scopedItems = rawPoolItems.filter((x) => !x.lib || x.lib === selLib);
    const filteredCount = regionSelected.length
      ? scopedItems.filter((x) => regionSelected.indexOf(pickCountry(x)) !== -1).length
      : scopedItems.length;
    const entry = {
      label: TYPE_LABEL[type],
      poolCount: rawPoolItems.length,
      libCount: scopedItems.length,
      filteredCount,
      regions: groupRegions(scopedItems, regionSelected),
      regionSelected,
      fetchedAt: pool.fetchedAt || 0,
      total: best.total || 0,
      done: best.done || 0,
      ok: okItems.length,
      fastestMs: fastest,
      runAt: best.runAt || 0,
      finished: (best.done || 0) >= (best.total || 0) && (best.total || 0) > 0,
      results: items.slice(0, 200).map((x) => {
        const isCf = CF_TYPES.indexOf(type) !== -1;
        // 优选IP / 优选域名 拿不到 IP 的归属地，只有 trace 里的 colo（机房三字码），
        // 按机房所在国家显示，格式和别的协议一致；查不到就原样显示三字码
        const colo = String((x.result && x.result.colo) || "").toUpperCase();
        const coloCC = isCf ? (CF_COLO_CC[colo] || "") : "";
        return {
          address: x.item.address,
          country: (x.result && x.result.country) || x.item.country || "",
          countryEmoji: isCf ? countryFlag(coloCC) : (x.item.countryEmoji || countryFlag((x.result && x.result.country) || x.item.country || "")),
          countryName: isCf
            ? (COUNTRY_ZH[coloCC] || colo)
            : (x.item.countryCn || countryName((x.result && x.result.country) || x.item.country, x.item.countryEn || "")),
          city: x.item.city || "",
          org: x.item.org || "",
          ok: !!(x.result && x.result.ok),
          latency: x.result ? x.result.latency : null,
          exitIp: (x.result && x.result.exitIp) || "",
          colo: colo,
          mode: (x.result && x.result.mode) || "",
          error: (x.result && x.result.error) || "",
        };
      }),
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
const TOKEN_KEY = "sub_token";   // 订阅令牌（随机串，仅用于读订阅接口）

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

// 订阅令牌：存在就返回，没有则用 crypto.randomUUID() 生成一个并写入 KV
async function ensureToken(env) {
  try {
    let tok = await env.CSP.get(TOKEN_KEY);
    if (tok) return tok;
    tok = crypto.randomUUID();
    await env.CSP.put(TOKEN_KEY, tok);
    return tok;
  } catch (e) {
    return crypto.randomUUID(); // 兜底：KV 挂了时至少本次可用
  }
}

// 登录 Cookie（值就是密码哈希），30 天有效；HttpOnly，脚本读不到
function authCookie(hash) {
  return "zq_auth=" + hash + "; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax";
}

// 管理后台鉴权：仅认 Cookie zq_auth 或 ?pwd= 明文密码 / 密码哈希
async function adminAuthed(request, env, url) {
  const cookie = getCookie(request, "zq_auth");
  if (cookie) {
    const stored = await getPwdHash(env);
    if (stored && cookie === stored) return true;
  }
  // ?pwd= 认两种值：明文密码（老配置里填的），或密码哈希（老版面板复制的地址）
  const pwd = url.searchParams.get("pwd");
  if (!pwd) return false;
  const stored = await getPwdHash(env);
  if (!stored) return false;
  return pwd === stored || (await hashPwd(pwd)) === stored;
}

// 订阅接口鉴权：Cookie zq_auth 优先，其次 ?token= 订阅令牌，再其次 ?pwd= 也认订阅令牌（兼容）
async function subAuthed(request, env, url) {
  const cookie = getCookie(request, "zq_auth");
  if (cookie) {
    const stored = await getPwdHash(env);
    if (stored && cookie === stored) return true;
  }
  const subToken = await env.CSP.get(TOKEN_KEY);
  if (!subToken) return false;
  const tok = url.searchParams.get("token");
  if (tok && tok === subToken) return true;
  // 兼容老的 ?pwd=：也认订阅令牌（老地址不至于立刻失效）
  const pwd = url.searchParams.get("pwd");
  if (pwd && pwd === subToken) return true;
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
  if (!(await adminAuthed(request, env, url))) {
    return new Response(loginHtml(), { status: 401, headers: pageHeaders });
  }
  const cfg = await loadConfig(env);
  const subToken = await ensureToken(env);
  return new Response(renderPanel(cfg, subToken), { headers: pageHeaders });
}

// 单点检测需要订阅令牌（Cookie 或 ?token= / ?pwd=），免得被陌生人当免费检测器
async function handleCheck(request, env, url) {
  if (!(await subAuthed(request, env, url))) {
    return json({ error: "未授权：这个地址要带上订阅令牌，例如 /check?socks5=host:port&token=你的令牌" }, 401);
  }
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

// 结果接口：GET /list/<协议|all>（需带 ?token=订阅令牌 / ?pwd=令牌，或已登录的 Cookie）
//   默认 text/plain，每行「地址#协议-国家-延迟」
//   带 ?format=json 时返回 JSON（含协议/地址/延迟/出口IP/国家/机房）
async function handleList(request, env, url) {
  if (!env.CSP) return textError("未绑定 KV 命名空间（变量名必须填 CSP）");
  if (!(await subAuthed(request, env, url))) {
    return new Response("未授权：这个地址要带上订阅令牌，例如 /list/socks5?token=你的令牌", {
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
      // CF 两类只有机房三字码，注释里写机房所在地区的中文名，查不到再退回三字码
      const colo = String((x.result && x.result.colo) || "").toUpperCase();
      const cname = CF_TYPES.indexOf(t) !== -1
        ? (COUNTRY_ZH[CF_COLO_CC[colo] || ""] || colo || "CF")
        : (x.item.countryCn || countryName((x.result && x.result.country) || x.item.country, x.item.countryEn || ""));
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
    // 首次设密时同时生成订阅令牌
    const subToken = crypto.randomUUID();
    await env.CSP.put(TOKEN_KEY, subToken);
    return json({ success: true, token: subToken }, 200, { "Set-Cookie": authCookie(h) });
  }

  // 密码登录：校验通过后下发 Cookie，同时确保订阅令牌存在
  if (path === "/api/login") {
    const stored = await getPwdHash(env);
    if (!stored) return json({ error: "还没有设置管理密码" }, 400);
    const pw = String(body.password || "");
    if (!pw || (await hashPwd(pw)) !== stored) return json({ error: "密码错误" }, 401);
    const subToken = await ensureToken(env);
    return json({ success: true, token: subToken }, 200, { "Set-Cookie": authCookie(stored) });
  }

  if (!(await adminAuthed(request, env, url))) return json({ error: "未授权，请打开 /admin 登录" }, 401);
  const cfg = await loadConfig(env);

  if (path === "/api/state") return json(await buildState(env, cfg));

  // 优选IP / 优选域名：候选由服务端拉取并随机采样，检测放到浏览器里做
  if (path === "/api/cfpool") {
    const t = url.searchParams.get("type") || body.type;
    if (CF_TYPES.indexOf(t) === -1) return json({ error: "类型无效" }, 400);
    const pool = await kvGet(env, "pool:" + t, { items: [], fetchedAt: 0 });
    const raw = Array.isArray(pool.items) ? pool.items : [];
    // 池子里装着全部来源的候选，只取下拉选中的那一份（老池子没有 lib 字段就照旧全用）
    const selLib = libSelOf(cfg, t);
    const list = raw.filter((x) => !x.lib || x.lib === selLib);
    const items = list.map((x) => x.address);
    return json({ type: t, total: items.length, items });
  }

  // 访问者自己的出口 IP：取 CF-Connecting-IP，供外部脚本查询
  if (path === "/api/self") {
    return json({ ip: request.headers.get("CF-Connecting-IP") || "" });
  }

  // 浏览器测完一轮把结果写回来，存进 best:<type>，表格和订阅都从这里读
  if (path === "/api/cfresults") {
    const t = String(body.type || "");
    if (CF_TYPES.indexOf(t) === -1) return json({ error: "类型无效" }, 400);
    if (body.restart) {
      await kvPut(env, "best:" + t, Object.assign({}, EMPTY_BEST));
      return json({ success: true, reset: true });
    }
    const pool = await kvGet(env, "pool:" + t, { items: [] });
    const poolItems = Array.isArray(pool.items) ? pool.items : [];
    // 前端只测「当前选中来源」的那一份，下标是过滤后的；池子里装着全部来源，
    // 直接按 index 取会串到别的来源的地址上，所以先用地址精确对上
    const byAddr = new Map();
    for (const it of poolItems) if (it && it.address) byAddr.set(it.address, it);
    const items = (Array.isArray(body.items) ? body.items : []).map((x) => {
      const idx = parseInt(x.index, 10) || 0;
      const hit = x.address ? byAddr.get(x.address) : null;
      return {
        index: idx,
        item: hit || poolItems[idx] || { address: x.address || "" },
        result: {
          ok: !!x.ok,
          latency: Number.isFinite(x.latency) ? x.latency : null,
          exitIp: x.exitIp || "",
          country: "",
          colo: x.colo || "",
          mode: "trace",
          error: x.error || "",
        },
      };
    });
    // 续测时把本轮结果并回旧结果（按 index 覆盖），不清掉已经测完的那些
    const oldBest = await kvGet(env, "best:" + t, EMPTY_BEST);
    const mergedMap = new Map();
    for (const it of (Array.isArray(oldBest.items) ? oldBest.items : [])) mergedMap.set(it.index, it);
    for (const it of items) mergedMap.set(it.index, it);
    const merged = Array.from(mergedMap.values()).sort((a, b) => a.index - b.index);
    await kvPut(env, "best:" + t, {
      runAt: Date.now(),
      done: parseInt(body.done, 10) || 0,
      items: merged,
      ok: merged.filter((x) => x.result && x.result.ok).length,
      total: parseInt(body.total, 10) || 0,
      regionsKey: "",
    });
    return json({ success: true });
  }

  const type = body.type || url.searchParams.get("type");

  if (path === "/api/pwd") {
    const np = String(body.newPwd || "");
    if (np.length < 4) return json({ error: "新密码至少 4 位" }, 400);
    const h = await hashPwd(np);
    await env.CSP.put(PWD_KEY, h);
    // 改密码不影响订阅令牌，返回当前 token（便于前端同步）
    const subToken = await ensureToken(env);
    return json({ success: true, token: subToken }, 200, { "Set-Cookie": authCookie(h) });
  }

  // 订阅令牌：查看或重新生成
  if (path === "/api/token") {
    if (body.action === "regenerate") {
      const newToken = crypto.randomUUID();
      await env.CSP.put(TOKEN_KEY, newToken);
      return json({ success: true, token: newToken });
    }
    return json({ success: true, token: (await env.CSP.get(TOKEN_KEY)) || "" });
  }

  if (path === "/api/config") {
    // typeCfg 按类型逐项合并：面板上只改某一类的并发 / 超时 / 抽样数时，不能把别的类型冲掉
    const patch = Object.assign({}, body.config || body);
    if (patch.typeCfg && typeof patch.typeCfg === "object") {
      const merged = Object.assign({}, cfg.typeCfg);
      for (const t of PROTOCOLS) {
        if (patch.typeCfg[t]) merged[t] = Object.assign({}, merged[t], patch.typeCfg[t]);
      }
      patch.typeCfg = merged;
    }
    // 来源列表按类型合并：改哪一类就只覆盖哪一类，别的类型保留原样
    if (patch.cfSources && typeof patch.cfSources === "object") {
      const merged = Object.assign({}, cfg.cfSources);
      for (const t of PROTOCOLS) {
        if (Array.isArray(patch.cfSources[t])) merged[t] = patch.cfSources[t];
      }
      patch.cfSources = merged;
    }
    // 来源选择也按类型合并，换一类的下拉不影响别类
    if (patch.libSel && typeof patch.libSel === "object") {
      patch.libSel = Object.assign({}, cfg.libSel, patch.libSel);
    }
    const next = normalizeConfig(Object.assign({}, cfg, patch));
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
    // CF IP / CF 域名由浏览器测，结果走 /api/cfresults
    if (CF_TYPES.indexOf(type) !== -1) return json({ success: false, type, error: "这一类由浏览器检测，走 /api/cfresults" }, 200);
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

function renderPanel(cfg, subToken) {
  const initial = JSON.stringify({
    subToken: subToken || "",
    protocols: PROTOCOLS,
    labels: TYPE_LABEL,
    continents: CONTINENT_LABEL,
    continentOrder: CONTINENT_ORDER,
    countryZh: COUNTRY_ZH,
    coloCC: CF_COLO_CC,
    config: cfg,
    // 每类协议的下拉选项：来源列表在面板上可改，改完前端直接用新列表重画
    libs: Object.fromEntries(PROTOCOLS.map((t) => [
      t,
      (cfg.cfSources[t] || []).map((x) => ({ key: x.key, label: x.label })),
    ])),
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
  --bg:#f4f6fa; --panel:#fff; --line:#e3e8ef; --line2:#eef1f6;
  --tx:#0f172a; --tx2:#475467; --tx3:#98a2b3;
  --brand:#185FA5; --brand-d:#134d87; --brand-l:#eaf2fb;
  --ok:#067647; --ok-bg:#e7f6ec; --bad:#b42318; --bad-bg:#feeceb;
  --r:16px; --sh:0 1px 2px rgba(16,24,40,.04),0 4px 14px rgba(16,24,40,.05);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--brand);text-decoration:none}
a:hover{text-decoration:underline}

.top{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.88);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.top .in{max-width:1180px;margin:0 auto;padding:11px 18px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.brand{font-size:15px;font-weight:600;display:flex;align-items:center;gap:9px}
.brand i{width:9px;height:9px;border-radius:3px;background:var(--brand);display:block}
.spacer{flex:1}
.chip{font-size:12px;color:var(--tx2);background:#f2f4f7;border:1px solid var(--line);border-radius:999px;padding:2px 10px;white-space:nowrap}

.wrap{max-width:1180px;margin:0 auto;padding:18px 18px 64px}

.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:20px 22px;margin-bottom:16px}
.card h2{font-size:15px;font-weight:600;margin:0 0 14px;display:flex;align-items:center;gap:9px;flex-wrap:wrap;letter-spacing:.01em}
.card h2 .dot{width:7px;height:7px;border-radius:50%;background:var(--brand);flex:none}
.card h2 .apibox{margin:0 0 0 auto;padding:2px 8px 2px 3px;font-weight:400;flex:0 1 auto;max-width:100%}
.tag{font-size:11.5px;font-weight:500;color:var(--tx2);background:#f2f4f7;border:1px solid var(--line2);border-radius:999px;padding:1px 9px}
.tag.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}

details.card>summary{cursor:pointer;font-size:14px;font-weight:600;list-style:none;display:flex;align-items:center;gap:9px}
details.card>summary::-webkit-details-marker{display:none}
details.card>summary::after{content:"展开";margin-left:auto;font-size:12px;font-weight:400;color:var(--tx3)}
details.card[open]>summary::after{content:"收起"}
details.card[open]>summary{margin-bottom:14px}

button{font:inherit;font-size:13px;font-weight:500;height:34px;padding:0 14px;border:1px solid var(--line);background:#fff;border-radius:10px;cursor:pointer;color:var(--tx);transition:background .15s,border-color .15s,transform .06s;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:6px}
button:hover{border-color:#cdd3dc;background:#fafbfc}
button:active{transform:translateY(1px)}
button:focus-visible{outline:2px solid #9cc3e8;outline-offset:1px}
button.primary{background:var(--brand);border-color:var(--brand);color:#fff;box-shadow:0 1px 2px rgba(24,95,165,.25)}
button.primary:hover{background:var(--brand-d);border-color:var(--brand-d)}
button.ghost{background:#f8f9fb;color:var(--tx2)}
button.danger{color:var(--bad);border-color:#f2c7c3;background:#fff}
button.danger:hover{background:var(--bad-bg);border-color:#e6a6a0}
button.sm{height:28px;padding:0 10px;font-size:12.5px;border-radius:8px}
button:disabled{opacity:.45;cursor:not-allowed;transform:none;box-shadow:none}

.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}

/* 工具栏：左主操作、右参数胶囊，第二行留给单点测试 */
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.toolbar + .toolbar{margin-top:10px}
.tgroup{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0}
.tgroup.right{margin-left:auto}
.params{display:flex;align-items:center;background:#f7f9fc;border:1px solid var(--line2);border-radius:12px;padding:4px}
.param{display:flex;align-items:center;gap:6px;padding:0 8px}
.param + .param{border-left:1px solid var(--line)}
.param label{font-size:11.5px;color:var(--tx3);white-space:nowrap}
.param input{width:54px;height:26px;padding:0 6px;border:1px solid var(--line2);background:#fff;font-size:12.5px;font-variant-numeric:tabular-nums;text-align:right;border-radius:7px;color:var(--tx)}
.param input[data-tcfg=timeoutMs]{width:66px}
.param input:hover{background:#fff;border-color:var(--line)}
.param input:focus{background:#fff;border-color:#7fb0dd;box-shadow:0 0 0 3px rgba(24,95,165,.13);outline:none}
.param .u{font-size:11px;color:var(--tx3);margin-left:-2px}
.tinput{flex:1;min-width:240px;max-width:560px}
label.f{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--tx2)}
input[type=text],input[type=number],input[type=password]{font:inherit;font-size:13px;height:34px;padding:0 10px;border:1px solid var(--line);border-radius:10px;color:var(--tx);width:100%;background:#fff;transition:.15s}
select{font:inherit;font-size:13px;height:34px;padding:0 10px;border:1px solid var(--line);border-radius:10px;color:var(--tx);background:#fff;transition:.15s}
select:focus{outline:none;border-color:#7fb0dd;box-shadow:0 0 0 3px rgba(24,95,165,.13)}
input[type=text]:focus,input[type=number]:focus,input[type=password]:focus{outline:none;border-color:#7fb0dd;box-shadow:0 0 0 3px rgba(24,95,165,.13)}

.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(124px,1fr));gap:10px;margin:0 0 14px}
.metric{background:#fafbfc;border:1px solid var(--line2);border-radius:12px;padding:10px 13px;min-width:0}
.metric .k{display:block;font-size:11.5px;color:var(--tx3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.02em}
.metric b{font-size:19px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.3;letter-spacing:-.01em}
.metric.hi b{color:var(--brand)}
.metric.zero b{color:var(--tx3);font-weight:500}

.bar{height:5px;border-radius:999px;background:#eef1f6;overflow:hidden;margin:0 0 14px}
.bar>i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--brand),#4a92d6);transition:width .35s ease}
.bar.done>i{background:linear-gradient(90deg,#0f9d58,#45c07f)}

.card.proto{position:relative;overflow:hidden;padding-left:26px}
.card.proto::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--acc,var(--brand))}
.card.proto h2{font-size:16px}
.scroll{max-height:414px;overflow:auto;border:1px solid var(--line);border-radius:12px;margin-top:14px;background:#fff;box-shadow:inset 0 -16px 14px -15px rgba(16,24,40,.13)}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;table-layout:fixed}
thead th{position:sticky;top:0;z-index:1;background:#f9fafb;text-align:left;color:var(--tx2);font-weight:600;font-size:12px;letter-spacing:.02em;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
tbody td{padding:8px 12px;border-bottom:1px solid var(--line2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:#f7faff}
tr.dead td{color:var(--tx3)}
th.num,td.num{text-align:right;font-variant-numeric:tabular-nums}
th.c,td.c{text-align:center}
tr.dead td.num{color:#b0b8c4}
tr.dead td.errline{font-size:12px;color:#98a2b3;padding-top:0;padding-bottom:9px;white-space:normal}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.pill{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:500;line-height:1.5}
.pill::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.pill.ok{background:var(--ok-bg);color:var(--ok)}
.pill.bad{background:var(--bad-bg);color:var(--bad)}

/* 表格里的地址：点了就复制 */
.addr{cursor:pointer}
.addr:hover{color:var(--brand);text-decoration:underline dotted;text-underline-offset:3px}
.toast{position:fixed;left:50%;bottom:28px;z-index:90;max-width:80vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#101828;color:#fff;font-size:12.5px;padding:8px 15px;border-radius:999px;opacity:0;pointer-events:none;transform:translate(-50%,8px);transition:opacity .18s ease,transform .18s ease}
.toast.on{opacity:1;transform:translate(-50%,0)}

/* 单点测试结果条：左侧色条 + 状态胶囊 + 延迟 + 出口 */
.tres{position:relative;display:flex;align-items:center;gap:22px;row-gap:10px;flex-wrap:wrap;overflow:hidden;margin-top:8px;padding:10px 14px 10px 18px;border:1px solid var(--line2);border-radius:10px;background:#f8f9fb;font-size:12.5px;color:var(--tx2)}
.tres::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--tx3)}
.tres.ok{background:var(--ok-bg);border-color:#cbe9d8;color:var(--tx)}
.tres.ok::before{background:var(--ok)}
.tres.bad{background:var(--bad-bg);border-color:#f5cdc9;color:var(--tx)}
.tres.bad::before{background:var(--bad)}
.tres .pill{color:#fff}
.tres .pill.ok{background:var(--ok)}
.tres .pill.bad{background:var(--bad)}
.tres .geo{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.tres .err{min-width:0;color:var(--bad);word-break:break-word}

.hint{color:var(--tx2);font-size:12.5px;margin-top:8px}
.hint code,.row code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
code{background:#f2f4f7;border:1px solid var(--line2);border-radius:6px;padding:2px 7px;font-size:12.5px;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
.empty{margin-top:14px;border:1px dashed var(--line);border-radius:12px;padding:30px 16px;text-align:center;color:var(--tx3);font-size:12.5px;background:#fcfcfd}
.ovfoot{margin-top:2px;padding-top:12px;border-top:1px solid var(--line2);font-size:11.5px;color:var(--tx3)}
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

.tabs{display:flex;gap:2px;flex-wrap:wrap;margin-left:10px;padding:3px;background:#f2f4f7;border-radius:11px}
.tab{background:transparent;border:0;color:var(--tx2);font-size:13px;font-weight:500;height:28px;padding:0 11px;border-radius:8px;box-shadow:none}
.tab:hover{background:rgba(255,255,255,.75);color:var(--tx);border-color:transparent}
.tab.on{color:var(--brand-d);background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.09)}
.icon{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:1px solid var(--line);background:#fff;border-radius:9px;color:var(--tx2)}
.icon:hover{color:var(--tx);border-color:#cdd3dc;background:#fafbfc}
.icon.spin svg{animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.apibox{display:flex;align-items:center;gap:6px;margin-top:12px;padding:2px 8px 2px 3px;background:#f7f8fa;border:1px solid var(--line2);border-radius:7px;min-width:0;max-width:100%}
.apik{flex:none;font-size:10px;font-weight:700;letter-spacing:.4px;line-height:1.5;color:var(--brand);background:var(--brand-l);border-radius:5px;padding:1px 6px}
.apiv{cursor:pointer;background:transparent;border:0;padding:0;margin:0;flex:1 1 auto;min-width:0;max-width:100%;font-size:11.5px;line-height:1.5;color:var(--tx2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.apiv:hover{color:var(--brand);text-decoration:underline}
#cfgToken{background:#fff;border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:12px;color:var(--tx)}
#cfgToken:hover{color:var(--tx);text-decoration:none;border-color:#cdd3dc}

.ovgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(152px,1fr));gap:10px;margin-bottom:14px}
.ovcard{position:relative;overflow:hidden;display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:13px;box-shadow:0 1px 2px rgba(16,24,40,.04);padding:12px 14px 15px 18px;cursor:pointer;transition:border-color .15s,box-shadow .15s}
.ovcard::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--acc,var(--brand))}
.ovcard .bar{position:absolute;left:0;right:0;bottom:0;height:3px;margin:0!important;border-radius:0;background:#f0f2f6}
.ovcard .bar>i{border-radius:0}
.ovcard:hover{border-color:#c3cad6;box-shadow:0 3px 10px rgba(16,24,40,.07)}
.ovtop{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.ovtop b{font-size:12.5px;color:var(--tx2);font-weight:600;letter-spacing:.01em}
.ovnum{display:flex;align-items:baseline;gap:6px}
.ovnum span{font-size:11px;color:var(--tx3)}
.ovnum b{font-size:21px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.25}
.ovsub{font-size:11px;color:var(--tx3);margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ovsub b{font-weight:600;color:var(--tx2);font-variant-numeric:tabular-nums}
.ovsec{padding-left:11px;border-left:3px solid var(--acc,var(--brand))}
.ovsec + .ovsec{margin-top:6px}
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
/* 来源管理：一行 = 名称 + 地址 + 删除 */
#mSources .mbox{max-width:680px}
.srow{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.srow input{margin:0}
.srow .sl{flex:0 0 132px}
/* 地址一列给足宽度，字号小一点好多露几个字符 */
.srow .su{flex:1 1 0;min-width:0;font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.srow .sx{flex:none;width:34px;height:34px;padding:0;line-height:1;font-size:13px;color:var(--tx3)}
.srow .sx:hover{color:var(--bad);border-color:var(--bad)}

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
  .card.proto{padding-left:18px}
  .params{width:100%;justify-content:space-between}
  .tgroup.right{margin-left:0;width:100%}
  .param{flex:1;padding:0 6px}
  .param input{width:100%}
  .tinput{max-width:none}
  /* 窄屏放开固定列宽，否则地址列会被压成 0 */
  table{table-layout:auto;min-width:520px}
  col{width:auto!important}
  .card h2{font-size:13.5px;margin-bottom:10px}
  .card h2 .apibox{flex:0 0 100%;margin:6px 0 0;padding:2px 8px 2px 3px;max-width:none}
  .apiv{flex:1 1 0;min-width:0}
  .metrics{grid-template-columns:repeat(2,1fr);gap:7px}
  .metric{padding:7px 9px}
  .metric b{font-size:15px}
  .rgrid{grid-template-columns:1fr}
  tbody td{max-width:150px}
  thead th,tbody td{padding:6px 8px}
  .scroll{max-height:250px}
  .mbox{padding:16px 14px}
  .srow{gap:6px}
  .srow .sl{flex:0 0 96px}
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
    <label class="f">管理密码<input type="text" id="cfgPwd" autocomplete="off" placeholder="至少 4 位" style="-webkit-text-security:disc" onfocus="this.type='password'" onblur="this.type='text'"></label>
    <div class="hint" style="margin-top:12px">订阅令牌（用于 /list/* 和 /check 接口，可与他人分享，<b>不能登录后台</b>）</div>
    <div class="row" style="gap:6px">
      <code id="cfgToken" class="apiv" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;cursor:pointer" title="点击复制"></code>
      <button class="sm ghost" id="btnRegenToken" style="flex:none">重新生成</button>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:16px">
      <button id="btnSettingsCancel">取消</button>
      <button class="primary" id="btnSettingsSave">保存</button>
    </div>
  </div>
</div>

<div class="modal" id="mSources">
  <div class="mbox">
    <h3><span class="dot"></span><span id="srcTitle">来源管理</span></h3>
    <div id="srcRows"></div>
    <div class="row" style="margin-bottom:14px">
      <button type="button" class="sm ghost" id="btnSrcAdd">添加一行</button>
    </div>
    <div class="row" style="justify-content:flex-end">
      <button id="btnSrcCancel">取消</button>
      <button class="primary" id="btnSrcSave">保存并重拉</button>
    </div>
  </div>
</div>

<script>
(function(){
  var BOOT = ${initial};
  // 订阅令牌：由服务端在渲染本页时注入（随机生成，仅用于读订阅接口，不是管理密码）
  var SUB_TOKEN = BOOT.subToken || '';
  var PROTOCOLS = BOOT.protocols;
  var LABELS = BOOT.labels;
  // 这两类在浏览器里测（量本机到目标），不走服务端检测
  var CF_TYPES = ['cfip', 'cfdomain'];
  // 某一类的来源列表（下拉选项）与当前选中的那一份
  function libListOf(type){
    var libs = BOOT.libs || {};
    return libs[type] || [];
  }
  function libOf(type){
    var cfg = (STATE && STATE.config) || BOOT.config || {};
    var sel = (cfg && cfg.libSel) || {};
    if(sel[type]) return sel[type];
    var list = libListOf(type);
    return list.length ? list[0].key : '';
  }

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
  var POOL_PLACEHOLDER = { socks5: 'socks5://user:pass@host:port', http: 'http://host:port', https: 'https://host:port', sstp: 'sstp://vpn:vpn@host:port', proxyip: 'ip:port', cfip: 'ip:port', cfdomain: 'domain:port' };

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
    var url = path + '?token=' + encodeURIComponent(SUB_TOKEN);
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

  // 复制后弹一条提示：日志卡片在页面底部，表格里点一下看不到反馈
  var toastTimer = null;
  function toast(msg){
    var node = el('toast');
    if(!node){ node = document.createElement('div'); node.id = 'toast'; node.className = 'toast'; document.body.appendChild(node); }
    node.textContent = msg;
    node.className = 'toast on';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ node.className = 'toast'; }, 1800);
  }

  function apiUrl(type){ return location.origin + '/list/' + type + (SUB_TOKEN ? '?token=' + encodeURIComponent(SUB_TOKEN) : ''); }

  function apiBox(type){
    var u = apiUrl(type);
    return '<div class="apibox">'
      + '<span class="apik">API</span>'
      + '<code class="apiv" data-copy="' + esc(u) + '" title="点击复制">' + esc(u) + '</code>'
      + '</div>';
  }

  function openSettings(){
    el('cfgPwd').value = '';
    el('cfgToken').textContent = SUB_TOKEN || '（未生成）';
    el('mSettings').classList.add('open');
  }
  function closeSettings(){ el('mSettings').classList.remove('open'); }

  /* ---- 来源管理 ----
   * 优选IP 的段表、优选域名的名单都在这里改：一行一个地址，改完按新地址重拉候选。
   * 地址只接受 http(s) 的纯文本（每行一个 IP / CIDR / IP 区间，或每行一个域名）。
   */
  var SRC_TYPE = 'cfip';

  function srcRowHtml(src){
    return '<div class="srow" data-key="' + esc(src.key || '') + '">'
      + '<input type="text" class="sl" data-k="label" value="' + esc(src.label || '') + '" placeholder="名称">'
      + '<input type="text" class="su" data-k="url" value="' + esc(src.url || '') + '" placeholder="https://…" autocomplete="off" spellcheck="false">'
      + '<button type="button" class="sm ghost sx" data-delsrc="1" title="删除这一行">✕</button>'
      + '</div>';
  }

  function srcListOf(type){
    var cfg = (STATE && STATE.config) || BOOT.config || {};
    var list = cfg.cfSources && cfg.cfSources[type];
    return Array.isArray(list) ? list : [];
  }

  function openSources(type){
    SRC_TYPE = type;
    el('srcTitle').textContent = '来源管理 · ' + LABELS[type];
    var list = srcListOf(type);
    var html = '';
    for(var i = 0; i < list.length; i++) html += srcRowHtml(list[i]);
    el('srcRows').innerHTML = html;
    el('mSources').classList.add('open');
  }
  function closeSources(){ el('mSources').classList.remove('open'); }
  function addSrcRow(){ el('srcRows').insertAdjacentHTML('beforeend', srcRowHtml({})); }

  // 保存：采集每行的名称和地址，交给服务端归一化后再清结果、按新地址重拉
  function saveSources(){
    var rows = document.querySelectorAll('#srcRows .srow');
    var out = [];
    for(var i = 0; i < rows.length; i++){
      var url = (rows[i].querySelector('[data-k="url"]').value || '').trim();
      if(!url) continue;
      if(!/^https?:[/][/]/i.test(url)){ log('第 ' + (i + 1) + ' 行地址要以 http:// 或 https:// 开头', SRC_TYPE); return; }
      out.push({
        key: rows[i].getAttribute('data-key') || '',
        label: (rows[i].querySelector('[data-k="label"]').value || '').trim(),
        url: url
      });
    }
    if(!out.length){ log('至少要留一个来源', SRC_TYPE); return; }
    var type = SRC_TYPE;
    var patch = {};
    patch[type] = out;
    api('/api/config', { config: { cfSources: patch } }).then(function(r){
      STATE.config = r.config;
      BOOT.config = r.config;
      // 下拉选项跟着新保存的来源列表重画
      var srcs = (r.config && r.config.cfSources) || {};
      var libs = {};
      for(var p = 0; p < PROTOCOLS.length; p++){
        var pt = PROTOCOLS[p];
        libs[pt] = (srcs[pt] || []).map(function(x){ return { key: x.key, label: x.label }; });
      }
      BOOT.libs = libs;
      closeSources();
      log(LABELS[type] + ' 来源已保存 ' + out.length + ' 行，正在按新地址拉取候选…', type);
      return api('/api/clear', { type: type }).then(function(){
        return api('/api/fetch', { type: type });
      }).then(function(f){
        log(LABELS[type] + ' 候选已重新拉取 ' + ((f && f.poolCount) || 0) + ' 条', type);
        return loadState();
      });
    }).catch(function(e){ log('保存失败：' + e.message, type); });
  }

  // 重新生成订阅令牌
  function regenToken(){
    if(!confirm('重新生成后，旧的订阅地址会立即失效，确定吗？')) return;
    api('/api/token', { action: 'regenerate' }).then(function(r){
      SUB_TOKEN = r.token;
      el('cfgToken').textContent = SUB_TOKEN;
      log('订阅令牌已更新，旧令牌已失效');
    }).catch(function(e){ log('操作失败：' + e.message); });
  }

  function saveSettings(){
    var newPwd = (el('cfgPwd').value || '').trim();
    if(!newPwd){ closeSettings(); return; }
    if(newPwd.length < 4){ log('新密码至少 4 位，密码未修改'); closeSettings(); return; }
    api('/api/pwd', { newPwd: newPwd }).then(function(p){
      // 服务端已换新令牌，这里同步内存里的值，改密后面板上的地址立刻可用
      if(p.token) SUB_TOKEN = p.token;
      log('管理密码已更新');
      closeSettings();
    }).catch(function(e){ log('保存设置失败：' + e.message); });
  }

  var ACCENT = { socks5: '#c0269a', http: '#5c6672', https: '#7a5cf0', sstp: '#d98800', proxyip: '#d2544d', cfip: '#f6821f', cfdomain: '#0ea5e9' };

  function metric(k, v, cls, title){
    return '<div class="metric' + (cls ? ' ' + cls : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '><span class="k">' + k + '</span><b>' + v + '</b></div>';
  }

  // 某一类协议自己的并发 / 超时 / 定时抽样数（服务端按同样结构存在 config.typeCfg 里）
  function typeCfg(type){
    var all = (STATE && STATE.config && STATE.config.typeCfg) || (BOOT.config && BOOT.config.typeCfg) || {};
    var o = all[type] || {};
    var quick = (type === 'cfip' || type === 'cfdomain');
    return {
      concurrency: parseInt(o.concurrency, 10) || 16,
      timeoutMs: parseInt(o.timeoutMs, 10) || (quick ? 500 : 10000),
      autoSample: parseInt(o.autoSample, 10) || 20,
      pullCount: parseInt(o.pullCount, 10) || 512
    };
  }

  // 来源下拉：池子里该类全部来源的候选都有，这里只决定这一轮测哪一份
  function cfLibOptions(type){
    var list = libListOf(type);
    if(!list.length) return '';
    var cur = libOf(type);
    var out = '';
    for(var i = 0; i < list.length; i++){
      var x = list[i];
      out += '<option value="' + esc(x.key) + '"' + (x.key === cur ? ' selected' : '') + '>' + esc(x.label) + '</option>';
    }
    return out;
  }

  function pctOf(t){ return t.total > 0 ? Math.min(100, Math.round(t.done * 100 / t.total)) : 0; }

  // 进度条：跑完变绿；style 用于概览卡把进度条吸到底部
  function barHtml(t, style){
    return '<div class="bar' + (t.finished && t.total > 0 ? ' done' : '') + '"' + (style ? ' style="' + style + '"' : '') + '><i style="width:' + pctOf(t) + '%"></i></div>';
  }

  function countryCell(r){ return esc((r.countryEmoji ? r.countryEmoji + ' ' : '') + (r.countryName || r.country)); }

  // 结果行：协议页（带「状态」列和失败原因行）与概览（不带）共用
  function rowHtml(r, idx, withStatus){
    var html = '<tr' + (withStatus && !r.ok ? ' class="dead"' : '') + '>';
    html += '<td class="mono c">' + (idx + 1) + '</td>';
    html += '<td class="mono addr" data-copy="' + esc(r.address) + '" title="点击复制">' + esc(r.address) + '</td>';
    if(withStatus) html += '<td>' + (r.ok ? '<span class="pill ok">成功</span>' : '<span class="pill bad">失败</span>') + '</td>';
    html += '<td class="mono num">' + fmtMs(r.latency) + '</td>';
    html += '<td class="mono">' + esc(r.exitIp) + '</td>';
    html += '<td' + (r.colo ? ' title="' + esc(r.colo) + '"' : '') + '>' + countryCell(r) + '</td>';
    html += '</tr>';
    if(withStatus && !r.ok && r.error) html += '<tr class="dead"><td></td><td colspan="5" class="errline" title="' + esc(r.error) + '">' + esc(r.error) + '</td></tr>';
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
    // 停在一半就显示「继续优选」，七类都一样
    var partial = t.done > 0 && !t.finished && t.total > 0;
    var html = '';
    html += '<div class="card proto" style="--acc:' + (ACCENT[type] || '#185FA5') + '">';
    html += '<h2>' + LABELS[type];
    if(t.poolCount > 0) html += ' <span class="tag">候选更新 ' + fmtTime(t.fetchedAt) + '</span>';
    html += apiBox(type);
    html += '</h2>';
    html += '<div class="metrics" style="margin-top:12px">';
    // 候选 = 池子里的总条数（优选IP 是七份源合起来的量）；待测 = 这一轮真正要测的条数
    // （优选IP 只测下拉选中的那份源，其余协议按已选地区过滤，没选地区就是 0）
    var needRegion = type !== 'cfdomain' && type !== 'cfip';
    var todo = (needRegion && !picked.length) ? 0 : t.filteredCount;
    var todoLabel = type === 'cfip' ? '待测 IP' : (type === 'cfdomain' ? '待测域名' : '待测');
    html += metric('候选', t.poolCount, t.poolCount > 0 ? 'hi' : 'zero');
    html += metric(todoLabel, todo, todo > 0 ? 'hi' : 'zero');
    html += metric('已测', t.done + ' / ' + t.total);
    html += metric('可用', t.ok, t.ok > 0 ? 'hi' : 'zero');
    html += metric('最快', fmtMs(t.fastestMs));
    html += '</div>';
    if(t.total > 0) html += barHtml(t);
    var noRegion = type !== 'cfdomain' && type !== 'cfip' && !picked.length;
    var gate = ' data-gate="region"' + (noRegion ? ' disabled title="请先选择地区"' : '');
    var tc = typeCfg(type);
    html += '<div class="toolbar">';
    html += '<div class="tgroup">';
    if(RUNNING[type]){
      html += '<button type="button" class="primary" data-act="pause" data-type="' + type + '">暂停优选</button>';
    } else if(partial){
      html += '<button type="button" class="primary" data-act="cont" data-type="' + type + '"' + gate + '>继续优选</button>';
    } else {
      html += '<button type="button" class="primary" data-act="start" data-type="' + type + '"' + gate + '>开始优选</button>';
    }
    if(type !== 'cfdomain' && type !== 'cfip') html += '<button type="button" data-act="region" data-type="' + type + '">' + (picked.length ? '地区：' + esc(pickedName) : '选择地区') + '</button>';
    html += '<button type="button" class="danger" data-act="clear" data-type="' + type + '">清空结果</button>';
    // 池子里该类全部来源的候选都有，这个下拉只决定「这一轮测哪一份源」
    html += '<select id="cfLib-' + type + '" data-lib="' + type + '" style="flex:none;width:auto" title="来源">' + cfLibOptions(type) + '</select>';
    // 候选来源的地址在弹窗里改，改完按新地址重拉候选
    html += '<button type="button" data-act="srcs" data-type="' + type + '">来源</button>';
    html += '</div>';
    // 这一类自己的并发 / 超时 / 定时抽样数，改完即时存回配置
    html += '<div class="tgroup right"><div class="params">';
    // 优选IP 的段表按这个数采样，每份段表各拉这么多条；优选域名名单直接整份用
    if(type === 'cfip') html += '<span class="param"><label>每次拉取</label><input type="number" data-tcfg="pullCount" data-type="' + type + '" min="1" max="4096" value="' + tc.pullCount + '"></span>';
    html += '<span class="param"><label>并发数量</label><input type="number" data-tcfg="concurrency" data-type="' + type + '" min="1" max="32" value="' + tc.concurrency + '"></span>';
    html += '<span class="param"><label>超时时间</label><input type="number" data-tcfg="timeoutMs" data-type="' + type + '" min="100" max="120000" step="100" value="' + tc.timeoutMs + '"><span class="u">ms</span></span>';
    if(type !== 'cfdomain' && type !== 'cfip') html += '<span class="param"><label>自动优选数量</label><input type="number" data-tcfg="autoSample" data-type="' + type + '" min="1" max="4096" value="' + tc.autoSample + '"></span>';
    html += '</div></div>';
    html += '</div>';
    html += '<div class="toolbar">';
    if(noRegion) html += '<span class="hint" style="margin:0;color:var(--bad)">先点「选择地区」选一个地区</span>';
    html += '<input type="text" id="test-' + type + '" class="mono tinput" autocomplete="off" placeholder="单点测试：' + esc(POOL_PLACEHOLDER[type]) + '">';
    html += '<button type="button" data-act="test" data-type="' + type + '">测试</button>';
    html += '</div>';
    html += '<div class="regbox' + (REGOPEN[type] ? ' open' : '') + '" id="regionbox-' + type + '">';
    html += '<div class="regscroll" style="margin-top:8px">' + regionList(type, t.regions || []) + '</div>';
    html += '</div>';
    html += '<div id="testout-' + type + '" class="tres" style="display:none"></div>';
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
    html += '<div class="ovfoot">上次完成优选：' + fmtTime(STATE.meta && STATE.meta.lastRun) + '</div>';
    html += '</div>';

    html += '<div class="ovgrid">';
    for(var k = 0; k < PROTOCOLS.length; k++){
      var ty = PROTOCOLS[k];
      var tt = STATE.types[ty];
      html += '<div class="ovcard" data-goto="' + ty + '" style="--acc:' + (ACCENT[ty] || '#185FA5') + '" title="点击进入 ' + LABELS[ty] + '">';
      html += '<div class="ovtop"><b>' + LABELS[ty] + '</b></div>';
      html += '<div class="ovnum"><span>可用</span><b>' + tt.ok + '</b></div>';
      html += '<div class="ovsub">候选 ' + tt.poolCount + ' · 已测 ' + tt.done + ' / ' + tt.total + '</div>';
      html += '<div class="ovsub">最快 <b>' + fmtMs(tt.fastestMs) + '</b></div>';
      html += barHtml(tt, 'margin:0');
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
        var orows = [];
        for(var n = 0; n < prows.length; n++) orows.push(prows[n].r);
        html += tableShell(orows, false, 'max-height:none');
      }
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // 结果表外壳：概览页不带「状态」列、也不限高，列头和外壳就收在这一处
  function tableShell(rows, withStatus, style){
    var head = '<tr><th class="c">#</th><th>地址</th>' + (withStatus ? '<th>状态</th>' : '') + '<th class="num">延迟</th><th>出口 IP</th><th>国家/地区</th></tr>';
    var cols = '<colgroup><col style="width:52px"><col>' + (withStatus ? '<col style="width:104px">' : '') + '<col style="width:94px"><col style="width:172px"><col style="width:138px"></colgroup>';
    var body = '';
    for(var i = 0; i < rows.length; i++) body += rowHtml(rows[i], i, withStatus);
    return '<div class="scroll"' + (style ? ' style="' + style + '"' : '') + '><table>' + cols + '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }

  function resultTable(rows){
    if(!rows || !rows.length) return '<div class="empty">还没有结果，点「开始优选」会先拉取候选再检测。</div>';
    return tableShell(rows, true);
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
        if(cp){ ev.preventDefault(); copyText(cp); toast('已复制：' + cp); return; }
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
        else if(act === 'srcs') openSources(type);
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
    var libSel = document.querySelectorAll('select[data-lib]');
    for(var s = 0; s < libSel.length; s++){
      libSel[s].addEventListener('change', function(){
        switchLib(this.getAttribute('data-lib'), this.value);
      });
    }
    var tcfgs = document.querySelectorAll('input[data-tcfg]');
    for(var k = 0; k < tcfgs.length; k++){
      tcfgs[k].addEventListener('change', function(){
        saveTypeCfg(this.getAttribute('data-type'), this.getAttribute('data-tcfg'), this.value, this);
      });
    }
  }

  // 页面上改某一类的并发 / 超时 / 自动数量：只提交这一类，服务端按类型合并
  function saveTypeCfg(type, key, value, input){
    var n = parseInt(value, 10);
    if(!isFinite(n) || n <= 0){ input.value = typeCfg(type)[key]; return; }
    var body = { typeCfg: {} };
    body.typeCfg[type] = {};
    body.typeCfg[type][key] = n;
    api('/api/config', { config: body }).then(function(r){
      STATE.config = r.config;
      input.value = typeCfg(type)[key];
      // 拉取数量变了，池子里的候选整批换掉：先清掉上一轮结果，再按新数量重新拉一次
      if(key === 'pullCount'){
        log(LABELS[type] + ' 每次拉取已设为 ' + typeCfg(type).pullCount + '，正在重新拉取候选…', type);
        return api('/api/clear', { type: type }).then(function(){
          return api('/api/fetch', { type: type });
        }).then(function(f){
          log(LABELS[type] + ' 候选已重新拉取 ' + ((f && f.poolCount) || 0) + ' 条', type);
          return loadState();
        });
      }
      log(LABELS[type] + ' 已设为 并发 ' + typeCfg(type).concurrency + ' / 超时 ' + typeCfg(type).timeoutMs + 'ms / 自动数量 ' + typeCfg(type).autoSample, type);
    }).catch(function(e){
      input.value = typeCfg(type)[key];
      log('保存失败：' + e.message, type);
    });
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

  function loadState(quiet){
    return api('/api/state').then(function(s){
      STATE = s;
      if(quiet) return;
      // 正在输入参数时不要整页重绘：重绘会把输入框换成新节点，光标和还没提交的值都会丢。
      // 单选/复选不算输入（选地区就靠它），必须重绘，否则顶部「地区：X」不会跟着变
      var a = document.activeElement;
      if(a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
      if(a && a.tagName === 'INPUT' && /^(text|number|search|email|password|tel|url)$/i.test(a.type || 'text')) return;
      // 重绘会把地区面板的滚动位置带回顶部，先记下来再还原
      var rs = document.querySelector('.regscroll');
      var keepTop = rs ? rs.scrollTop : 0;
      render();
      var rs2 = document.querySelector('.regscroll');
      if(rs2 && keepTop) rs2.scrollTop = keepTop;
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
    if(CF_TYPES.indexOf(type) === -1 && !regionPicked(type)){ log('还没选地区，先在「选择地区」里选一个再优选', type); return false; }
    closeRegion(type);
    RUNNING[type] = true;
    STOPPING[type] = false;
    render();
    setBusy(type, true);
    log(msg, type);
    return true;
  }

  // 开始优选 = 直接用进面板时已拉取的候选池，从零优选（不再重复拉取）
  function doStart(type){
    if(type === 'cfdomain' || type === 'cfip') return runCf(type, true);
    if(!beginRun(type, '开始优选 ' + LABELS[type] + '…')) return;
    runChunks(type, true, function(msg){ finish(type, LABELS[type] + ' ' + msg); });
  }

  // 继续优选 = 用现有池子接着上次的进度跑（不重拉）
  function doContinue(type){
    if(type === 'cfdomain' || type === 'cfip') return runCf(type, false);
    if(!beginRun(type, '继续优选 ' + LABELS[type] + '…')) return;
    runChunks(type, false, function(msg){ finish(type, LABELS[type] + ' ' + msg); });
  }

  // 换来源：该类全部来源的候选进面板时就都拉好放在池子里了，
  // 这个下拉只是换个筛子，不需要重新拉取
  function switchLib(type, key){
    if(!key) return;
    if(key === libOf(type)) return;
    var name = key;
    var list = libListOf(type);
    for(var i = 0; i < list.length; i++){ if(list[i].key === key){ name = list[i].label; break; } }
    var body = { libSel: {} };
    body.libSel[type] = key;
    // 换源只是换筛子：上一轮结果原样留着，点「开始优选」才会覆盖
    api('/api/config', { config: body }).then(function(){
      log('来源已切到 ' + name + '，上一轮结果保留', type);
      loadState();
    }).catch(function(e){
      log('切换来源失败：' + ((e && e.message) || '未知错误'), type);
    });
  }

  /* ---- 浏览器侧测速（CF 域名 / CF IP） ----
   * 两类都在本机浏览器里发请求，量的是本机到目标的往返：
   * - CF 域名：GET https://域名[:端口]/cdn-cgi/trace，校验 h 是本域名、loc 是 CN，
   *   然后串行发 3 次取最小值当延迟。
   * - CF IP：把 IP 编成泛解析域名的子域名，请求 https://<label>.<BEST_HOST>/ip.json，
   *   同样是 OPTIONS 建连 + GET 掐表，改写成子域名是为了让浏览器带上 SNI。
   */
  function cfHostPort(address){
    var s = String(address || '').trim();
    var host = s, port = 443;
    if(host.charAt(0) === '['){
      var close = host.indexOf(']');
      if(close === -1) return null;
      var tail = host.slice(close + 1);
      host = host.slice(1, close);
      if(tail.charAt(0) === ':') port = parseInt(tail.slice(1), 10) || 443;
    } else if(host.split(':').length === 2){
      // 只有一个冒号才是 host:port；IPv6 裸地址（多个冒号）不切端口，端口按 443
      var c = host.lastIndexOf(':');
      port = parseInt(host.slice(c + 1), 10) || 443;
      host = host.slice(0, c);
    }
    if(!host) return null;
    return { host: host, port: port };
  }

  function cfUrl(hp){
    var suffix = (hp.port && hp.port !== 443) ? ':' + hp.port : '';
    var host = hp.host.indexOf(':') !== -1 ? '[' + hp.host + ']' : hp.host;
    return 'https://' + host + suffix + '/cdn-cgi/trace?_t=' + Date.now();
  }

  function cfFetch(url, ms, method){
    var ctl = new AbortController();
    var timer = setTimeout(function(){ try{ ctl.abort(); }catch(e){} }, ms);
    return fetch(url, { method: method || 'GET', cache: 'no-store', credentials: 'omit', signal: ctl.signal })
      .then(function(r){
        // 与 BestCF 的 fetchWithTimeout 对齐：响应头到了就撤掉超时，body 再慢也不再掐断
        clearTimeout(timer);
        return r.text().then(function(t){ return { ok: r.ok, status: r.status, text: t }; });
      }, function(e){
        clearTimeout(timer);
        throw e;
      });
  }

  function cfParse(text){
    var o = {};
    String(text || '').split(/\\r\\n|\\r|\\n/).forEach(function(line){
      var eq = line.indexOf('=');
      if(eq <= 0) return;
      o[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    });
    return o;
  }

  /* ---- 优选IP ----
   * 浏览器不能直连裸 IP（TLS 不给 IP 字面量发 SNI），源码的做法是把 IP 编成子域名：
   * 104.16.1.1 → 68100101.ns.psb.kdns.fr，这个泛解析域名会把前缀解回 104.16.1.1，
   * 浏览器就有域名可用，请求落到该 IP 上的 CF 边缘，那边回 /ip.json。
   * 测法与源码一致：OPTIONS 先探 3 次（超时给两倍），再 GET 一次计时，超过超时判失败。
   */
  var BEST_HOST = 'ns.psb.kdns.fr';

  function ipProbeLabel(host){
    if(host.indexOf(':') !== -1) return host.toLowerCase().replace(/:/g, '-');
    var p = host.split('.');
    if(p.length !== 4) return '';
    var out = '';
    for(var i = 0; i < 4; i++){
      var n = parseInt(p[i], 10);
      if(!(n >= 0 && n <= 255)) return '';
      out += ('0' + n.toString(16)).slice(-2).toUpperCase();
    }
    return out;
  }

  function ipProbeUrl(address, path){
    var hp = cfHostPort(address);
    if(!hp) return '';
    var label = ipProbeLabel(hp.host);
    if(!label) return '';
    return 'https://' + label + '.' + BEST_HOST + ':' + hp.port + '/' + path + '?_t=' + Date.now();
  }

  function testCfIp(address, timeoutMs){
    var url = ipProbeUrl(address, 'ip.json');
    if(!url) return Promise.resolve({ ok: false, error: '地址格式无效' });

    function options(n){
      return cfFetch(url, timeoutMs * 2, 'OPTIONS').then(function(r){
        if(r.ok) return null;
        throw new Error('OPTIONS HTTP ' + r.status);
      }).catch(function(e){
        if(n >= 2) throw e;
        return options(n + 1);
      });
    }

    return options(0).then(function(){
      var started = performance.now();
      return cfFetch(url, timeoutMs).then(function(r){
        if(!r.ok) throw new Error('GET 不可用');
        var d;
        try { d = JSON.parse(r.text); } catch(e){ throw new Error('返回内容不是 JSON'); }
        var latency = Math.max(1, Math.round(performance.now() - started));
        if(latency > timeoutMs) throw new Error('延迟超过超时时间');
        var ip = String(d.ip || '');
        return { ok: true, latency: latency, exitIp: ip, colo: d.colo || '' };
      });
    }).catch(function(e){
      return { ok: false, error: (e && e.message) || '失败' };
    });
  }

  function testCf(address, timeoutMs){
    var hp = cfHostPort(address);
    if(!hp) return Promise.resolve({ ok: false, error: '地址格式无效' });
    var url = cfUrl(hp);

    function grab(n){
      return cfFetch(url, timeoutMs).then(function(r){
        if(!r.ok) throw new Error('GET 不可用');
        var trace = cfParse(r.text);
        if(String(trace.h || '').toLowerCase() !== hp.host.toLowerCase()) throw new Error('h 与请求域名不一致');
        if(String(trace.loc || '').toUpperCase() !== 'CN') throw new Error('出口不在国内');
        return trace;
      }).catch(function(e){
        if(n >= 3) throw e;
        return grab(n + 1);
      });
    }

    return grab(0).then(function(trace){
      var samples = [], round = 0;
      function measure(){
        if(round >= 3) return Promise.resolve();
        round++;
        var started = performance.now();
        return cfFetch(url, timeoutMs).then(function(r){
          if(r.ok) samples.push(Math.max(1, Math.round(performance.now() - started)));
        }).catch(function(){}).then(measure);
      }
      return measure().then(function(){
        if(!samples.length) return { ok: false, error: '测速失败' };
        return { ok: true, latency: Math.min.apply(null, samples), colo: trace.colo || '', exitIp: trace.ip || '' };
      });
    }).catch(function(e){
      return { ok: false, error: (e && e.message) || '失败' };
    });
  }

  function runCf(type, restart){
    if(RUNNING[type]) return;
    if(!STATE || !STATE.types || !STATE.types[type]) return;
    RUNNING[type] = true;
    STOPPING[type] = false;
    render();
    setBusy(type, true);
    log((restart ? '开始优选 ' : '继续优选 ') + LABELS[type] + '…', type);

    var list = [], conc = 16, timeoutMs = 10000, results = [], finished = 0;
    var chain = Promise.resolve();
    // 两类都从浏览器发请求，只是取参数的端点不同：优选IP 走 /ip.json，优选域名走 /cdn-cgi/trace
    var probe = (type === 'cfip') ? testCfIp : testCf;

    function snapshot(){
      var items = [];
      for(var i = 0; i < list.length; i++){
        var r = results[i];
        if(!r) continue;
        items.push({ index: i, address: list[i], ok: r.ok, latency: r.latency, colo: r.colo, exitIp: r.exitIp, error: r.error });
      }
      return { type: type, done: finished, total: list.length, items: items };
    }
    function save(){
      var payload = snapshot();
      chain = chain.then(function(){
        return api('/api/cfresults', payload).catch(function(){});
      }).then(function(){ return loadState(); });
      return chain;
    }

    // 重启就清空上一轮结果；续测不清空，从上次停下的位置接着测
    var prep = restart ? api('/api/cfresults', { type: type, restart: true }) : Promise.resolve(null);
    prep
      .then(function(){ return api('/api/cfpool', { type: type }); })
      .then(function(pool){
        list = (pool && pool.items) || [];
        if(!list.length){
          var e = new Error('候选池为空，刷新一次数据源再试');
          e.friendly = e.message;
          throw e;
        }
        var tcf = typeCfg(type);
        conc = Math.max(1, Math.min(32, tcf.concurrency));
        timeoutMs = tcf.timeoutMs;
        // 续测：池子总条数与上次一致才认为下标对得上，否则从头测
        var prev = STATE.types[type] || {};
        var startAt = 0;
        if(!restart && parseInt(prev.total, 10) === list.length){
          startAt = Math.max(0, Math.min(parseInt(prev.done, 10) || 0, list.length));
        }
        finished = startAt;
        results = new Array(list.length);
        log('候选 ' + list.length + ' 条，并发 ' + conc + (startAt ? '，从第 ' + (startAt + 1) + ' 条接着测' : ''), type);
        var next = startAt, active = 0;
        return new Promise(function(resolve){
          function pump(){
            if(next >= list.length && active === 0){ resolve(); return; }
            while(!STOPPING[type] && active < conc && next < list.length){
              (function(idx){
                active++;
                probe(list[idx], timeoutMs).then(function(r){
                  results[idx] = r;
                  active--;
                  finished++;
                  if(STOPPING[type]) log('已暂停，不再发新的候选', type);
                  if(finished % 20 === 0) save();
                  pump();
                });
              })(next++);
            }
            if(STOPPING[type] && active === 0) resolve();
          }
          pump();
        });
      })
      .then(function(){ return save(); })
      .then(function(){
        var okN = 0;
        for(var i = 0; i < results.length; i++) if(results[i] && results[i].ok) okN++;
        finish(type, LABELS[type] + ' ' + (STOPPING[type] ? '已暂停，本轮可用 ' : '优选完成，本轮可用 ') + okN + ' 个');
      })
      .catch(function(e){
        finish(type, LABELS[type] + ' ' + ((e && (e.friendly || e.message)) || '优选失败'));
      });
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

  // 出口 IP → 中文地理位置「日本 / 東京都 / 中野區」（ipwho.is，免 key，HTTPS + CORS）
  // 由浏览器直接请求：用访问者自己的配额，避开 Worker 共享出网 IP 被上游限流
  function lookupGeo(ip, cb){
    var clean = String(ip || '').replace(/^\[|\]$/g, '').trim();
    if(!clean){ cb(''); return; }
    var done = false;
    var fin = function(v){ if(done) return; done = true; cb(v || ''); };
    setTimeout(function(){ fin(''); }, 4000);
    fetch('https://ipwho.is/' + encodeURIComponent(clean) + '?lang=zh-CN')
      .then(function(res){ return res.json(); })
      .then(function(d){
        if(!d || !d.success) return fin('');
        // 三级同名很常见（香港三级都是「香港」、日本省市都是「東京都」），整串去重只留先出现的
        var raw = [d.country || d.country_code || '', d.region || '', d.city || ''];
        var p = [];
        for(var i = 0; i < raw.length; i++){
          var v = String(raw[i] || '').trim();
          if(v && p.indexOf(v) < 0) p.push(v);
        }
        fin(p.join(' / '));
      })
      .catch(function(){ fin(''); });
  }

  // 单点测试结果：状态胶囊 + 地理位置 + 延迟，形如「✓ 通过  日本 / 東京都 / 中野區  1756 ms」
  function testHtml(r){
    if(!r.ok){
      return '<span class="pill bad">✕ 失败</span>'
        + '<span class="err">' + esc(r.error || '未知错误') + '</span>'
        + (r.latency ? '<span class="tag mono">' + esc(r.latency) + ' ms</span>' : '');
    }
    return '<span class="pill ok">✓ 通过</span>'
      + '<span class="geo">' + esc(r.location || r.exitIp || '—') + '</span>'
      + '<span class="tag mono">' + esc(r.latency) + ' ms</span>';
  }

  function showTest(type, r){
    var out = el('testout-' + type);
    var show = function(){
      out.className = 'tres ' + (r.ok ? 'ok' : 'bad');
      out.innerHTML = testHtml(r);
    };
    // CF 两类的 exitIp 是访问者自己的出口 IP，查归属地只会显示访问者所在地；
    // 与结果表保持一致，改看请求落到的机房 colo
    if(r.ok && CF_TYPES.indexOf(type) !== -1){
      var colo = String(r.colo || '').toUpperCase();
      var cc = (BOOT.coloCC && BOOT.coloCC[colo]) || '';
      r.location = cc ? ((BOOT.countryZh && BOOT.countryZh[cc]) || cc) : (colo || '—');
      show();
    } else if(r.ok && r.exitIp){
      lookupGeo(r.exitIp, function(loc){ r.location = loc; show(); });
    } else {
      show();
    }
  }

  function doTest(type){
    var input = el('test-' + type);
    var out = el('testout-' + type);
    var address = (input.value || '').trim();
    out.style.display = 'flex';   // 必须 flex：写 block 会用内联样式盖掉 .tres 的 display:flex，gap 失效
    out.className = 'tres';
    if(!address){ out.textContent = '请先填一个地址'; return; }
    out.textContent = '测试中…';
    // 优选域名 / 优选IP 都从本机浏览器发请求，只是取参数的端点不同
    if(type === 'cfdomain' || type === 'cfip'){
      var runOne = (type === 'cfip') ? testCfIp : testCf;
      runOne(address, typeCfg(type).timeoutMs).then(function(r){
        showTest(type, r);
      }).catch(function(e){
        showTest(type, { ok: false, error: (e && e.message) || '失败' });
      });
      return;
    }
    api('/api/test', { type: type, address: address }).then(function(r){
      showTest(type, r);
    }).catch(function(e){
      out.className = 'tres bad';
      out.innerHTML = '<span class="pill bad">✕ 异常</span><span class="err">' + esc(e.message) + '</span>';
    });
  }

  bind('btnRefreshAll', function(){
    if(AUTOFETCH){ log('正在自动拉取候选，请稍候…'); return; }
    log('手动刷新：开始拉取全部协议候选…');
    autoFetchAll();
  });
  bind('btnSettings', openSettings);
  bind('btnSettingsCancel', closeSettings);
  bind('btnSettingsSave', saveSettings);
  // 来源管理：增行 / 删行 / 保存
  bind('btnSrcAdd', addSrcRow);
  bind('btnSrcCancel', closeSources);
  bind('btnSrcSave', saveSources);
  (function(){
    var box = el('srcRows');
    if(box) box.addEventListener('click', function(ev){
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-delsrc]') : null;
      if(!btn) return;
      var row = btn.parentNode;
      if(row && row.parentNode) row.parentNode.removeChild(row);
    });
  })();
  bind('btnRegenToken', regenToken);
  // 点击令牌区域复制
  (function(){
    var node = el('cfgToken');
    if(node) node.addEventListener('click', function(){
      var t = (SUB_TOKEN || '').trim();
      if(t) copyText(t);
    });
  })();
  bind('btnClearLog', function(){
    var key = PROTOCOLS.indexOf(ACTIVE) !== -1 ? ACTIVE : '';
    if(key) LOGS[key] = [];
    renderLog();
  });
  (function(){
    var m = el('mSettings');
    if(m) m.addEventListener('click', function(ev){ if(ev.target === m) closeSettings(); });
    var ms = el('mSources');
    if(ms) ms.addEventListener('click', function(ev){ if(ev.target === ms) closeSources(); });
  })();

  renderBoot();
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
    const types = cfg.autoTypes;
    ctx.waitUntil((async () => {
      const summary = [];
      // 每轮只跑一个类型：游标存在 meta.autoCursor，跑完推进一格，五类依次轮转
      const meta = await kvGet(env, "meta", {});
      const cursor = types.length ? (parseInt(meta.autoCursor, 10) || 0) % types.length : 0;
      const nextCursor = types.length ? (cursor + 1) % types.length : 0;
      for (const type of types.slice(cursor, cursor + 1)) {
        try {
          // 定时用这一类自己选的地区；没选地区就跳过这一类。
          const typeRegions = await getRegions(env, type);
          if (!typeRegions.length) {
            summary.push(type + ":未选地区已跳过");
            continue;
          }
          const regionCode = typeRegions[0];
          // 只拉当前选中的那一份来源
          const selLib = libSelOf(cfg, type);
          const fresh = await fetchCandidates(type, cfg, selLib);
          if (!fresh.length) {
            summary.push(type + "/当前来源没拉到节点已跳过");
            continue;
          }
          // 本轮按这一类自己的「自动数量」抽样：先取所选地区的节点，
          // 不足抽样数时从剩余里随机补齐。这样既保住地区偏好，又把子请求额度集中给单个类型。
          const sampleCount = typeCfgOf(cfg, type).autoSample;
          const hits = fresh.filter((x) => pickCountry(x) === regionCode);
          let sample;
          if (hits.length >= sampleCount) {
            sample = randomSample(hits, sampleCount);
          } else {
            // 地区节点不足抽样数 → 全取，再从剩余（非该地区）里随机补足
            const hitSet = new Set(hits);
            const rest = fresh.filter((x) => !hitSet.has(x));
            sample = hits.concat(randomSample(rest, sampleCount - hits.length));
          }
          // 池子里其它来源的旧候选原样留着（面板切源时还有数据可看），当前源换成这次抽到的这批
          const oldPool = await kvGet(env, "pool:" + type, { items: [] });
          const keep = (Array.isArray(oldPool.items) ? oldPool.items : []).filter((x) => x.lib && x.lib !== selLib);
          await kvPut(env, "pool:" + type, {
            fetchedAt: Date.now(), count: keep.length + sample.length, items: keep.concat(sample),
          });
          summary.push(
            type + "(" + regionCode + ")拉" + fresh.length +
            "/地区命中" + hits.length + "，本轮抽样" + sample.length + "条"
          );
          let guard = 0;
          let result = null;
          do {
            // 第一片强制 restart：定时任务每轮都从零跑，不受上一轮结果影响
            result = await runChunk(env, type, cfg, guard === 0, []);
            guard++;
          } while (!result.finished && guard < 60);
          // 把本轮结果补到上面那条摘要末尾（同一元素，不再 push 第二条）
          summary[summary.length - 1] += "/可用" + result.ok;
        } catch (e) {
          summary.push(type + ":失败(" + ((e && e.message) || e) + ")");
        }
      }
      await kvPut(env, "meta", Object.assign({}, meta, {
        lastRun: Date.now(), lastAuto: summary, lastAutoAt: Date.now(), autoCursor: nextCursor,
      }));
    })());
  },
};