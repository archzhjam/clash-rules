#!/usr/bin/env node
/**
 * 订阅生成器 generate.mjs
 * 机场订阅（节点）+ clash-rules 规则库（内联规则）→ clash.yaml / shadowrocket.conf
 * 支持：剔除指定节点、按名称筛选节点进策略组（url-test 自动选最快）
 * 用法:
 *   node generate.mjs                     # 生成到 ./output
 *   node generate.mjs --out /app/output   # 指定输出目录
 *   node generate.mjs --serve             # 生成并启动 HTTP 服务
 *   node generate.mjs --serve-only        # 只启动 HTTP 服务（不重新生成，供 entrypoint 生成完再起服务）
 * 配置: 同目录 config.json（机场地址等，不入库）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function loadConfig() {
  const p = path.join(__dirname, 'config.json');
  if (!existsSync(p)) throw new Error('缺少 config.json（参考 config.example.json）');
  return JSON.parse(readFileSync(p, 'utf8'));
}

const CFG = loadConfig();
const OUT = (args.indexOf('--out') !== -1 ? args[args.indexOf('--out') + 1] : (CFG.outputDir || path.join(__dirname, 'output')));
const SERVE = args.includes('--serve');
const SERVE_ONLY = args.includes('--serve-only');
const PORT = CFG.listenPort || 8080;
const EXCLUDE = CFG.excludeNodes || [];
const FILTERS = CFG.groupFilters || {}; // { nodeSelect: '香港', media: '香港', netflix: 'Gemini' }
const TEST_URL = CFG.testUrl || 'http://www.gstatic.com/generate_204';
// Facebook 组独立测速 URL：测到 Meta 的真实延迟（Reels/IG 走 Meta CDN，gstatic 延迟不具代表性）
const FB_TEST_URL = CFG.facebookTestUrl || 'https://www.instagram.com';
// 媒体组（YouTube 等）独立测速 URL
const MEDIA_TEST_URL = CFG.mediaTestUrl || 'https://www.youtube.com';
// Telegram 组独立测速 URL
const TG_TEST_URL = CFG.telegramTestUrl || 'https://core.telegram.org';
// Telegram 组测速间隔（默认一天一次：避免频繁切换出口 IP 触发风控）
const TG_INTERVAL = CFG.telegramInterval || 86400;
// Emby 组默认节点池：日本 + 美国非 Gemini（config.json 的 groupFilters.emby 可覆盖；数组=多条件并集）
const EMBY_DEFAULT_FILTER = ['日本', { include: ['美国'], exclude: ['Gemini'] }];
// 🎲Random 轮换国家池（javdb 每日轮换出口规避 7 天 IP 封禁；可按实测可用性增删）
const RANDOM_COUNTRIES = (CFG.randomCountries && CFG.randomCountries.length ? CFG.randomCountries : ['美国', '台湾', '德国', '英国', '加拿大', '澳大利亚', '法国', '印度']);

const RULE_ORDER = [
  ['netflix', '🎥 Netflix'],
  ['llm', '🤖 大模型'],
  ['direct', '🎯 Direct'],
  ['microsoft', '🎯 Direct'],
  ['apple', '🍎 Apple'],
  ['telegram', '📲 Telegram'],
  ['bilibili', '🎯 Direct'],
  ['facebook', '💙 Facebook'],
  ['media', '🌍 主流媒体'],
  ['tiktok', '🎵 tiktok'],
  ['emby', '🎬 Emby'],
  ['emby-us', '🎲 Random'],
  ['block', '🛑 Block'],
];

async function fetchText(url, tries = 2, timeoutMs = 20000) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return await r.text();
      lastErr = new Error(url + ' -> HTTP ' + r.status);
    } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw lastErr;
}

async function fetchRules() {
  const raw = `https://raw.githubusercontent.com/${CFG.rulesRepo}/${CFG.branch}/rules/`;
  const cdn = `https://cdn.jsdelivr.net/gh/${CFG.rulesRepo}@${CFG.branch}/rules/`;
  const out = {};
  for (const [name] of RULE_ORDER) {
    let text = null;
    try { text = await fetchText(cdn + name + '.list'); } catch { /* 尝试 raw */ }
    if (text == null) text = await fetchText(raw + name + '.list');
    out[name] = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  }
  try {
    let text = null;
    try { text = await fetchText(cdn + 'process.list'); } catch { /* 尝试 raw */ }
    if (text == null) text = await fetchText(raw + 'process.list');
    out.process = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  }
  catch { out.process = []; }
  return out;
}

/** 剔除指定节点：删除其整块（含前置锚点行） */
function filterBlock(block, excluded) {
  if (!excluded.length) return block;
  const lines = block.split(/\r?\n/);
  const out = [];
  let skip = false;
  let anchorLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const m = line.match(/^-?\s*name:\s*(.+)$/);
    if (m) {
      const nm = m[1].replace(/^["']|["']$/g, '');
      if (excluded.some((e) => nm.includes(e))) {
        skip = true;
        if (anchorLineIdx >= 0) { out.pop(); anchorLineIdx = -1; } // 去掉前置 "- &锚点" 行
        continue;
      }
      skip = false;
      anchorLineIdx = -1;
      out.push(raw);
      continue;
    }
    if (skip) continue;
    if (/^\s*-\s*&/.test(line)) { anchorLineIdx = out.length; out.push(raw); continue; }
    anchorLineIdx = -1;
    out.push(raw);
  }
  return out.join('\n');
}

async function fetchNodes() {
  const txt = await fetchText(CFG.airportUrl);
  const start = txt.indexOf('proxies:');
  const end = txt.indexOf('proxy-groups:');
  if (start < 0 || end < 0) throw new Error('订阅格式异常：未找到 proxies/proxy-groups 段');
  const block = filterBlock(txt.slice(start + 'proxies:'.length, end).trim(), EXCLUDE);
  const names = [];
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^[ \t]*-?[ \t]*name:\s*(.+?)\s*$/);
    if (m) names.push(m[1].replace(/^["']|["']$/g, ''));
  }
  return { block, names };
}

/** 解析 vless 节点字段（行式解析，适配机场生成器格式） */
function parseNodes(block) {
  const nodes = [];
  let cur = null;
  let inReality = false;
  for (const line of block.split(/\r?\n/)) {
    const t = line.trim();
    if (/^- name:/.test(t)) {
      if (cur) nodes.push(cur);
      cur = { name: t.replace(/^- name:\s*/, '').replace(/^["']|["']$/g, ''), reality: {} };
      inReality = false;
      continue;
    }
    if (!cur) continue;
    const m = t.match(/^([a-z-]+):\s*(.*)$/);
    if (!m) continue;
    const [k, v] = [m[1], m[2].replace(/^["']|["']$/g, '')];
    if (k === 'reality-opts') { inReality = true; continue; }
    if (inReality) { cur.reality[k] = v; continue; }
    cur[k] = v;
  }
  if (cur) nodes.push(cur);
  return nodes;
}

/** 筛选节点名。
 *  filter 为字符串：节点名包含该关键词；
 *  filter 为对象：{ include: [...], exclude: [...] }，名称须包含全部 include、不含任何 exclude；
 *  filter 为数组：多个筛选条件的并集（任一命中即入组，保序去重）。
 */
function filterNames(names, filter) {
  if (!filter) return names;
  if (Array.isArray(filter)) {
    const seen = new Set();
    const out = [];
    for (const f of filter) {
      for (const n of filterNames(names, f)) {
        if (!seen.has(n)) { seen.add(n); out.push(n); }
      }
    }
    return out;
  }
  if (typeof filter === 'string') return names.filter((n) => n.includes(filter));
  const inc = (Array.isArray(filter.include) ? filter.include : [filter.include]).filter(Boolean);
  const exc = (Array.isArray(filter.exclude) ? filter.exclude : [filter.exclude]).filter(Boolean);
  return names.filter((n) => inc.every((k) => n.includes(k)) && !exc.some((k) => n.includes(k)));
}

/** 拉取 v2ray 原生 URI 订阅（Shadowrocket 官方格式），并按名称剔除节点 */
async function fetchV2rayNodes() {
  const url = CFG.v2rayUrl || (CFG.airportUrl + '/v2ray');
  const txt = await fetchText(url);
  const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const kept = [];
  for (const line of lines) {
    const frag = line.split('#')[1] || '';
    let name = '';
    try { name = decodeURIComponent(frag); } catch { name = frag; }
    if (EXCLUDE.some((e) => name.includes(e))) continue;
    kept.push({ line, name });
  }
  return kept;
}

/** 输出 YAML 策略组定义 */
function buildGroups(names, hkNames, mediaNames, taiwanNames, usGeminiNames, usNonGeminiNames, fbNames, tgNames, embyNames) {
  const select = (name, members) => `  - name: ${name}\n    type: select\n    proxies: [${members.join(', ')}]`;
  const urlTest = (name, members, url = TEST_URL, interval = 300) =>
    `  - name: ${name}\n    type: url-test\n    url: ${url}\n    interval: ${interval}\n    proxies: [${members.join(', ')}]`;
  // 🎲 Random：单一组，每日轮换国家（javdb 规避 7 天 IP 封禁）
  // 组内节点 = 今天 UTC 日期轮到的国家的全部节点（url-test 国内自动选快）；跨天重新生成后自动换国
  const todayCountry = RANDOM_COUNTRIES[Math.floor(Date.now() / 86400000) % RANDOM_COUNTRIES.length];
  const L = [];
  L.push(urlTest('🚀 节点选择', hkNames.length ? hkNames : names));
  L.push(select('🎯 Direct', ['DIRECT']));
  L.push(select('🛑 Block', ['REJECT']));
  L.push(urlTest('🌍 主流媒体', mediaNames.length ? mediaNames : (hkNames.length ? hkNames : names), MEDIA_TEST_URL));
  L.push(select('Ⓜ️ Microsoft', ['🎯 Direct', '🚀 节点选择']));
  L.push(select('📺 BiliBili', ['🎯 Direct', '🚀 节点选择']));
  L.push(urlTest('💙 Facebook', fbNames.length ? fbNames : names, FB_TEST_URL));
  L.push(urlTest('🎥 Netflix', taiwanNames.length ? taiwanNames : names));
  L.push(urlTest('🎬 Emby', embyNames.length ? embyNames : names));
  const randomMembers = filterNames(names, todayCountry);
  L.push(urlTest('🎲 Random', randomMembers.length ? randomMembers : names));
  L.push(urlTest('🤖 大模型', usGeminiNames.length ? usGeminiNames : names));
  L.push(select('🍎 Apple', ['🎯 Direct', '🚀 节点选择']));
  L.push(urlTest('📲 Telegram', tgNames.length ? tgNames : names, TG_TEST_URL, TG_INTERVAL));
  L.push(urlTest('🎵 tiktok', usNonGeminiNames.length ? usNonGeminiNames : names));
  L.push(select('🐟 漏网之鱼', ['🚀 节点选择', '🎯 Direct']));
  return L.join('\n');
}

function buildClash(nodes, names, hkNames, mediaNames, taiwanNames, usGeminiNames, usNonGeminiNames, fbNames, tgNames, embyNames, rules) {
  const L = [];
  L.push('mixed-port: 7890');
  L.push('allow-lan: true');
  L.push('mode: Rule');
  L.push('log-level: info');
  L.push('ipv6: false');
  L.push('external-controller: 127.0.0.1:9090');
  L.push('dns:');
  L.push('  enable: true');
  L.push('  enhanced-mode: fake-ip');
  L.push('  respect-rules: true');
  L.push('  fake-ip-filter:');
  L.push('    - "+.lan"');
  L.push('    - "+.local"');
  L.push('    # Windows UWP / 微软商店：直连域名返回真实 IP，避免 UWP 应用不认假 IP');
  L.push('    - "+.microsoft.com"');
  L.push('    - "+.windowsupdate.com"');
  L.push('    - "+.msftconnecttest.com"');
  L.push('    - "+.msftncsi.com"');
  L.push('    - "+.office.com"');
  L.push('    - "+.live.com"');
  L.push('  default-nameserver:');
  L.push('    - 223.5.5.5');
  L.push('    - 119.29.29.29');
  L.push('  nameserver:');
  L.push('    - 223.5.5.5');
  L.push('    - 119.29.29.29');
  L.push('    - https://dns.alidns.com/dns-query');
  L.push('    - https://doh.pub/dns-query');
  L.push('  proxy-server-nameserver:');
  L.push('    - 223.5.5.5');
  L.push('    - 119.29.29.29');
  L.push('proxies:');
  L.push(nodes);
  L.push('proxy-groups:');
  L.push(buildGroups(names, hkNames, mediaNames, taiwanNames, usGeminiNames, usNonGeminiNames, fbNames, tgNames, embyNames));
  L.push('rules:');
  for (const [key, policy] of RULE_ORDER) for (const r of rules[key]) L.push(`  - ${inlineRule(r, policy)}`);
  for (const r of rules.process || []) L.push(`  - ${inlineRule(r, '🎯 Direct')}`);
  L.push('  - GEOIP,CN,🎯 Direct');
  L.push('  - GEOSITE,CN,🎯 Direct');
  L.push('  - MATCH,🐟 漏网之鱼');
  return L.join('\n') + '\n';
}

function buildShadowrocket(v2nodes, rules, filters) {
  const v2names = v2nodes.map((n) => n.name);
  const mediaNames = filterNames(v2names, filters.media);
  const taiwanNames = filterNames(v2names, filters.netflix);
  const usGeminiNames = filterNames(v2names, filters.llm);
  const usNonGeminiNames = filterNames(v2names, filters.tiktok);
  const fbNames = filterNames(v2names, filters.facebook);
  const tgNames = filterNames(v2names, filters.telegram);
  const embyNames = filterNames(v2names, filters.emby || EMBY_DEFAULT_FILTER);
  const L = [];
  L.push('[General]');
  L.push('dns-server = 223.5.5.5, 119.29.29.29');
  L.push('');
  L.push('[Proxy]');
  for (const n of v2nodes) L.push(n.line);
  L.push('');
  L.push('[Proxy Group]');
  const sel = (name, members) => `${name} = select, ${members.join(', ')}`;
  const urlTest = (name, members, url = TEST_URL, interval = 300) => `${name} = url-test, ${members.join(', ')}, url = ${url}, interval = ${interval}`;
  L.push(sel('🚀 节点选择', v2names));
  L.push(sel('🎯 Direct', ['DIRECT']));
  L.push(sel('🛑 Block', ['REJECT']));
  L.push(urlTest('🌍 主流媒体', mediaNames.length ? mediaNames : v2names, MEDIA_TEST_URL));
  L.push(sel('Ⓜ️ Microsoft', ['🎯 Direct', '🚀 节点选择']));
  L.push(sel('📺 BiliBili', ['🎯 Direct', '🚀 节点选择']));
  L.push(urlTest('💙 Facebook', fbNames.length ? fbNames : v2names, FB_TEST_URL));
  L.push(urlTest('🎥 Netflix', taiwanNames.length ? taiwanNames : v2names));
  L.push(urlTest('🎬 Emby', embyNames.length ? embyNames : v2names));
  // 🎲 Random：单一组，每日轮换国家；组内节点 = 当天国家全部节点
  const todayCountry = RANDOM_COUNTRIES[Math.floor(Date.now() / 86400000) % RANDOM_COUNTRIES.length];
  const randomMembers = filterNames(v2names, todayCountry);
  L.push(urlTest('🎲 Random', randomMembers.length ? randomMembers : v2names));
  L.push(urlTest('🤖 大模型', usGeminiNames.length ? usGeminiNames : v2names));
  L.push(sel('🍎 Apple', ['🎯 Direct', '🚀 节点选择']));
  L.push(urlTest('📲 Telegram', tgNames.length ? tgNames : v2names, TG_TEST_URL, TG_INTERVAL));
  L.push(urlTest('🎵 tiktok', usNonGeminiNames.length ? usNonGeminiNames : v2names));
  L.push(sel('🐟 漏网之鱼', ['🚀 节点选择', '🎯 Direct']));
  L.push('');
  L.push('[Rule]');
  for (const [key, policy] of RULE_ORDER) for (const r of rules[key]) L.push(inlineRule(r, policy, false));
  L.push('GEOIP,CN,🎯 Direct');
  L.push('FINAL,🐟 漏网之鱼');
  return L.join('\n') + '\n';
}

/** 内联规则：策略插到 no-resolve 之前（clash 语法要求 no-resolve 在最后） */
function inlineRule(rule, policy, keepNoResolve = true) {
  if (rule.endsWith(',no-resolve')) {
    const base = rule.slice(0, -',no-resolve'.length);
    return keepNoResolve ? `${base},${policy},no-resolve` : `${base},${policy}`;
  }
  return `${rule},${policy}`;
}

function startServer() {
  const mime = { '.yaml': 'text/yaml', '.conf': 'text/plain', '.list': 'text/plain' };
  http.createServer((req, res) => {
    const p = path.join(OUT, path.basename(req.url.split('?')[0]));
    if (existsSync(p)) {
      res.writeHead(200, { 'Content-Type': mime[path.extname(p)] || 'text/plain' });
      res.end(readFileSync(p));
    } else {
      res.writeHead(404);
      res.end('not found: ' + path.basename(req.url));
    }
  }).listen(PORT, '0.0.0.0', () => console.log(`[serve] http://0.0.0.0:${PORT}/ (clash.yaml / shadowrocket.conf)`));
}

async function main() {
  if (SERVE_ONLY) { startServer(); return; }
  mkdirSync(OUT, { recursive: true });
  console.log('[1/4] 拉取机场订阅节点...');
  const { block, names } = await fetchNodes();
  console.log(`      节点数: ${names.length}（剔除: ${EXCLUDE.join(', ') || '无'}）`);
  const hkNames = filterNames(names, FILTERS.nodeSelect);
  const mediaNames = filterNames(names, FILTERS.media);
  const taiwanNames = filterNames(names, FILTERS.netflix);
  const usGeminiNames = filterNames(names, FILTERS.llm);
  const usNonGeminiNames = filterNames(names, FILTERS.tiktok);
  const fbNames = filterNames(names, FILTERS.facebook);
  const tgNames = filterNames(names, FILTERS.telegram);
  const embyNames = filterNames(names, FILTERS.emby || EMBY_DEFAULT_FILTER);
  console.log(`      节点选择: ${hkNames.length} | 媒体: ${mediaNames.length} | 台湾(Netflix): ${taiwanNames.length} | 美Gemini(大模型): ${usGeminiNames.length} | 美非Gemini(tiktok): ${usNonGeminiNames.length} | Facebook: ${fbNames.length} | Telegram: ${tgNames.length} | Emby: ${embyNames.length} | Random轮换: ${RANDOM_COUNTRIES.length}国`);
  console.log('[1b/4] 拉取 v2ray URI 订阅（Shadowrocket 原生格式）...');
  let v2nodes = await fetchV2rayNodes();
  const srFilter = CFG.shadowrocketNodeFilter;
  if (srFilter) v2nodes = v2nodes.filter((n) => n.name.includes(srFilter));
  console.log(`      v2ray URI: ${v2nodes.length} 条（shadowrocket 过滤: ${srFilter || '无'}）`);
  console.log('[2/4] 拉取 clash-rules 规则集...');
  const rules = await fetchRules();
  console.log(`      规则数: ${RULE_ORDER.reduce((s, [k]) => s + rules[k].length, 0) + (rules.process || []).length}`);
  console.log('[3/4] 生成配置...');
  writeFileSync(path.join(OUT, 'clash.yaml'), buildClash(block, names, hkNames, mediaNames, taiwanNames, usGeminiNames, usNonGeminiNames, fbNames, tgNames, embyNames, rules), 'utf8');
  writeFileSync(path.join(OUT, 'shadowrocket.conf'), buildShadowrocket(v2nodes, rules, FILTERS), 'utf8');
  console.log('[4/4] 完成：');
  for (const f of readdirSync(OUT)) {
    const fp = path.join(OUT, f);
    try { if (statSync(fp).isFile()) console.log('      ' + f, (readFileSync(fp).length / 1024).toFixed(1) + 'KB'); } catch { /* 跳过目录 */ }
  }
  if (SERVE) startServer();
}

main().catch((e) => { console.error('生成失败:', e.message); process.exit(1); });
