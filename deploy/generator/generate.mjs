#!/usr/bin/env node
/**
 * 订阅生成器 generate.mjs
 * 机场订阅（节点）+ clash-rules 规则库（内联规则）→ clash.yaml / shadowrocket.conf
 * 用法:
 *   node generate.mjs                     # 生成到 ./output
 *   node generate.mjs --out /app/output   # 指定输出目录
 *   node generate.mjs --serve             # 生成并启动 HTTP 服务（局域网客户端拉取）
 * 配置: 同目录 config.json（机场地址等，不入库）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
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
const PORT = CFG.listenPort || 8080;

const RULE_ORDER = [
  ['netflix', '🎥 Netflix'],
  ['direct', '🎯 Direct'],
  ['microsoft', 'Ⓜ️ Microsoft'],
  ['apple', '🍎 Apple'],
  ['telegram', '📲 Telegram'],
  ['bilibili', '📺 BiliBili'],
  ['media', '🌍 主流媒体'],
  ['block', '🛑 Block'],
];

async function fetchText(url, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.text();
      lastErr = new Error(url + ' -> HTTP ' + r.status);
    } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw lastErr;
}

async function fetchRules() {
  const raw = `https://raw.githubusercontent.com/${CFG.rulesRepo}/${CFG.branch}/rules/`;
  const cdn = `https://cdn.jsdelivr.net/gh/${CFG.rulesRepo}@${CFG.branch}/rules/`;
  const out = {};
  for (const [name] of RULE_ORDER) {
    let text = null;
    try { text = await fetchText(raw + name + '.list'); } catch { /* 尝试 CDN */ }
    if (text == null) text = await fetchText(cdn + name + '.list');
    out[name] = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  }
  // process.list（仅桌面端规则）
  try { out.process = (await fetchText(raw + 'process.list')).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')); }
  catch { out.process = []; }
  return out;
}

async function fetchNodes() {
  const txt = await fetchText(CFG.airportUrl);
  const start = txt.indexOf('proxies:');
  const end = txt.indexOf('proxy-groups:');
  if (start < 0 || end < 0) throw new Error('订阅格式异常：未找到 proxies/proxy-groups 段');
  const block = txt.slice(start + 'proxies:'.length, end).trim();
  // 提取节点名（供策略组使用）
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

const GROUPS_TAIL = [
  ['🌍 主流媒体', ['🚀 节点选择', '🚀 自动选择', '🎯 Direct']],
  ['Ⓜ️ Microsoft', ['🎯 Direct', '🚀 节点选择', '🚀 自动选择']],
  ['📺 BiliBili', ['🎯 Direct', '🚀 节点选择', '🚀 自动选择']],
  ['🎥 Netflix', ['🚀 节点选择', '🚀 自动选择', '🎯 Direct']],
  ['🍎 Apple', ['🎯 Direct', '🚀 节点选择', '🚀 自动选择']],
  ['📲 Telegram', ['🚀 节点选择', '🚀 自动选择']],
];

function buildGroups(nodeNames) {
  const y = (name, type, proxies, extra = '') =>
    `  - name: ${name}\n    type: ${type}\n${extra}    proxies: [${proxies.map((p) => (p.includes(',') || p.includes(':') ? JSON.stringify(p) : p)).join(', ')}]`;
  const lines = [];
  lines.push(y('🐟 漏网之鱼', 'select', ['🚀 节点选择', '🎯 Direct']));
  lines.push(y('🚀 节点选择', 'select', nodeNames));
  lines.push(y('🚀 自动选择', 'url-test', nodeNames, `    url: http://www.gstatic.com/generate_204\n    interval: 300\n`));
  lines.push(y('🎯 Direct', 'select', ['DIRECT']));
  lines.push(y('🛑 Block', 'select', ['REJECT']));
  for (const [name, members] of GROUPS_TAIL) lines.push(y(name, 'select', members));
  return lines.join('\n');
}

/** 内联规则：策略插到 no-resolve 之前（clash 语法要求 no-resolve 在最后） */
function inlineRule(rule, policy, keepNoResolve = true) {
  if (rule.endsWith(',no-resolve')) {
    const base = rule.slice(0, -',no-resolve'.length);
    return keepNoResolve ? `${base},${policy},no-resolve` : `${base},${policy}`;
  }
  return `${rule},${policy}`;
}

function buildClash(nodes, names, rules) {
  const L = [];
  L.push('mixed-port: 7890');
  L.push('allow-lan: true');
  L.push('mode: Rule');
  L.push('log-level: info');
  L.push('ipv6: true');
  L.push('external-controller: 127.0.0.1:9090');
  L.push('dns:');
  L.push('  enable: true');
  L.push('  enhanced-mode: fake-ip');
  L.push('  fake-ip-filter:');
  L.push('    - "+.lan"');
  L.push('    - "+.local"');
  L.push('  default-nameserver:');
  L.push('    - 223.5.5.5');
  L.push('    - 119.29.29.29');
  L.push('  nameserver:');
  L.push('    - 223.5.5.5');
  L.push('    - 119.29.29.29');
  L.push('proxies:');
  L.push(nodes);
  L.push('proxy-groups:');
  L.push(buildGroups(names));
  L.push('rules:');
  for (const [key, policy] of RULE_ORDER) for (const r of rules[key]) L.push(`  - ${inlineRule(r, policy)}`);
  for (const r of rules.process || []) L.push(`  - ${inlineRule(r, '🎯 Direct')}`);
  L.push('  - GEOIP,CN,🎯 Direct');
  L.push('  - GEOSITE,CN,🎯 Direct');
  L.push('  - MATCH,🐟 漏网之鱼');
  return L.join('\n') + '\n';
}

function buildShadowrocket(nodeObjs, nodeNames, rules) {
  const L = [];
  L.push('[General]');
  L.push('dns-server = 223.5.5.5, 119.29.29.29');
  L.push('');
  L.push('[Proxy]');
  for (const n of nodeObjs) {
    if (n.type !== 'vless') continue;
    const parts = [`${n.name} = vless, ${n.server}, ${n.port}`];
    if (n.uuid) parts.push(`username=${n.uuid}`);
    if (n.flow) parts.push(`flow=${n.flow}`);
    if (n.reality && n.reality['public-key']) parts.push(`reality-public-key=${n.reality['public-key']}`);
    if (n.reality && n.reality['short-id']) parts.push(`reality-short-id=${n.reality['short-id']}`);
    if (n.tls === 'true') parts.push('tls=true');
    if (n.servername) parts.push(`servername=${n.servername}`);
    if (n.udp === 'true') parts.push('udp=true');
    L.push(parts.join(', '));
  }
  L.push('');
  L.push('[Proxy Group]');
  const group = (name, members) => `${name} = select, ${members.join(', ')}`;
  L.push(group('🚀 节点选择', nodeNames));
  L.push('🎯 Direct = select, DIRECT');
  L.push('🛑 Block = select, REJECT');
  for (const [name, members] of GROUPS_TAIL) L.push(group(name, members));
  L.push('🐟 漏网之鱼 = select, 🚀 节点选择, 🎯 Direct');
  L.push('');
  L.push('[Rule]');
  for (const [key, policy] of RULE_ORDER) for (const r of rules[key]) L.push(inlineRule(r, policy, false));
  L.push('GEOIP,CN,🎯 Direct');
  L.push('FINAL,🐟 漏网之鱼');
  return L.join('\n') + '\n';
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
  mkdirSync(OUT, { recursive: true });
  console.log('[1/4] 拉取机场订阅节点...');
  const { block, names } = await fetchNodes();
  console.log(`      节点数: ${names.length}`);
  console.log('[2/4] 拉取 clash-rules 规则集...');
  const rules = await fetchRules();
  console.log(`      规则数: ${RULE_ORDER.reduce((s, [k]) => s + rules[k].length, 0) + (rules.process || []).length}`);
  console.log('[3/4] 生成配置...');
  writeFileSync(path.join(OUT, 'clash.yaml'), buildClash(block, names, rules), 'utf8');
  const nodeObjs = parseNodes(block);
  writeFileSync(path.join(OUT, 'shadowrocket.conf'), buildShadowrocket(nodeObjs, names, rules), 'utf8');
  console.log('[4/4] 完成：');
  for (const f of readdirSync(OUT)) console.log('      ' + f, (readFileSync(path.join(OUT, f)).length / 1024).toFixed(1) + 'KB');
  if (SERVE) startServer();
}

main().catch((e) => { console.error('生成失败:', e.message); process.exit(1); });
