#!/usr/bin/env node
// model-speed skill · 历史统计与受控基准（零依赖）
//
// 用法:
//   node zcode-speed.mjs report            解析 ~/.zcode/cli/rollout 历史调用记录，按模型统计输出速度
//   node zcode-speed.mjs bench             生成受控基准测试 prompt（手动粘贴到 ZCode 新会话里跑）
//   node zcode-speed.mjs bench --collect   从 rollout 收集基准结果并统计
//
// 速度口径: tokens/s = outputTokens / (durationMs / 1000)，包含首字延迟(TTFT)。
// 数据源为 ZCode 自身记录的 per-call durationMs 与 usage，非墙钟计时。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CLI_DIR = process.env.ZCODE_CLI_DIR || path.join(os.homedir(), '.zcode', 'cli');
const ROLLOUT_DIR = path.join(CLI_DIR, 'rollout');
const AGENTS_DIR = path.join(CLI_DIR, 'agents');
const BENCH_STATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.speedbench.json');

// ---------- 通用 ----------

function listFiles(dir, filter) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && filter(e.name))
      .map(e => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

// 逐行读 JSONL（单行可能数 MB，不整文件读入）
async function* readJsonl(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch { /* 尾部损坏行跳过 */ }
  }
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function p90(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)];
}

function fmt(n, digits = 1) {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

// 从 rollout 一行提取模型调用关键信息；非模型调用返回 null
function extractCall(obj) {
  const usage = obj.response?.usage ?? obj.usage;
  const ms = obj.durationMs;
  if (!usage?.outputTokens || !ms || ms <= 0) return null;
  return {
    modelId: obj.model?.modelId ?? 'unknown',
    variant: obj.model?.variant ?? '',
    role: obj.model?.role ?? '',
    providerId: obj.model?.providerId ?? '',
    durationMs: ms,
    outputTokens: usage.outputTokens,
    inputTokens: usage.inputTokens ?? 0,
    finishReason: obj.response?.finishReason ?? '',
    completedAt: obj.completedAt ?? '',
  };
}

function summarize(calls) {
  const speeds = calls.map(c => c.outputTokens / (c.durationMs / 1000));
  const totalOut = calls.reduce((a, c) => a + c.outputTokens, 0);
  const totalMs = calls.reduce((a, c) => a + c.durationMs, 0);
  const times = calls.map(c => c.completedAt).filter(Boolean).sort();
  return {
    n: calls.length,
    totalOut,
    median: median(speeds),
    p90: p90(speeds),
    min: Math.min(...speeds),
    max: Math.max(...speeds),
    weighted: totalOut / (totalMs / 1000),
    medianMs: median(calls.map(c => c.durationMs)),
    first: times[0] ?? '',
    last: times[times.length - 1] ?? '',
  };
}

function printGroup(name, calls, { showWindow = false } = {}) {
  const s = summarize(calls);
  const variants = [...new Set(calls.map(c => c.variant).filter(Boolean))];
  console.log(`\n■ ${name}   (${s.n} 次调用, 输出 ${s.totalOut.toLocaleString()} tokens)`);
  console.log(
    `  中位 ${fmt(s.median)} tok/s | 加权均值 ${fmt(s.weighted)} tok/s | P90 ${fmt(s.p90)} | ` +
    `区间 ${fmt(s.min)}~${fmt(s.max)} | 中位单次耗时 ${(s.medianMs / 1000).toFixed(1)}s`
  );
  if (variants.length > 1) {
    for (const v of variants) {
      const sub = calls.filter(c => c.variant === v);
      const ss = summarize(sub);
      console.log(`    · variant=${v}: ${ss.n} 次, 中位 ${fmt(ss.median)} tok/s, 加权 ${fmt(ss.weighted)} tok/s`);
    }
  }
  if (showWindow && s.first) {
    console.log(`  数据时间: ${s.first.slice(0, 16)} ~ ${s.last.slice(0, 16)} (UTC)`);
  }
}

// ---------- report：历史数据 ----------

async function collectRolloutCalls() {
  const files = listFiles(ROLLOUT_DIR, n => /^model-io-.*\.jsonl$/.test(n));
  const calls = [];
  for (const f of files) {
    for await (const obj of readJsonl(f)) {
      const c = extractCall(obj);
      if (c) calls.push(c);
    }
  }
  return calls;
}

// agent transcript: model_network_status 事件内嵌的 completed 对象带首字延迟，可估算纯解码速度
async function collectTranscriptDecode() {
  // agents/<sess>/<agent>/transcript.jsonl，两层均为目录
  const files = [];
  try {
    for (const sess of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
      if (!sess.isDirectory()) continue;
      const sessDir = path.join(AGENTS_DIR, sess.name);
      for (const agent of fs.readdirSync(sessDir, { withFileTypes: true })) {
        if (!agent.isDirectory()) continue;
        const f = path.join(sessDir, agent.name, 'transcript.jsonl');
        if (fs.existsSync(f)) files.push(f);
      }
    }
  } catch { /* 目录结构异常则跳过 */ }
  const findCompleted = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4) return null;
    if (o.type === 'model_request_completed') return o;
    for (const k of Object.keys(o)) {
      const r = findCompleted(o[k], depth + 1);
      if (r) return r;
    }
    return null;
  };
  const out = [];
  for (const f of files) {
    for await (const e of readJsonl(f)) {
      if (e.type !== 'model_network_status') continue;
      const c = findCompleted(e.payload ?? {}, 0);
      if (!c) continue;
      const outTok = c.usage?.outputTokens;
      const ttft = c.timeToFirstContentMs;
      if (outTok >= 50 && c.durationMs > 0 && Number.isFinite(ttft) && ttft < c.durationMs) {
        out.push({
          modelId: c.model?.modelId ?? e.payload?.model?.modelId ?? 'unknown',
          outputTokens: outTok,
          totalMs: c.durationMs,
          ttftMs: ttft,
        });
      }
    }
  }
  return out;
}

async function cmdReport() {
  if (!fs.existsSync(ROLLOUT_DIR)) {
    console.error(`未找到 rollout 目录: ${ROLLOUT_DIR}`);
    process.exit(1);
  }
  const all = await collectRolloutCalls();
  const main = all.filter(c => c.role === 'main' && c.outputTokens >= 50);
  const skipped = all.length - main.length;

  console.log('==== ZCode 模型输出速度 · 历史数据统计 ====');
  console.log(`数据源: ${ROLLOUT_DIR}`);
  console.log(`模型调用 ${all.length} 次；统计 ${main.length} 次（仅 role=main 且输出≥50 tokens）` +
    (skipped ? `，剔除 ${skipped} 次（lite 标题生成/短调用/无用量）` : ''));

  const groups = new Map();
  for (const c of main) {
    if (!groups.has(c.modelId)) groups.set(c.modelId, []);
    groups.get(c.modelId).push(c);
  }
  for (const [modelId, calls] of groups) printGroup(modelId, calls, { showWindow: true });

  // 纯解码速度（排除 TTFT），数据来自 agent transcript
  const dec = await collectTranscriptDecode();
  if (dec.length) {
    const byModel = new Map();
    for (const d of dec) {
      if (!byModel.has(d.modelId)) byModel.set(d.modelId, []);
      byModel.get(d.modelId).push(d);
    }
    console.log('\n---- 纯解码速度估算（排除首字延迟，来自 agent transcript，样本较少仅供参考）----');
    for (const [modelId, rows] of byModel) {
      const speeds = rows.map(d => d.outputTokens / ((d.totalMs - d.ttftMs) / 1000));
      const ttfts = rows.map(d => d.ttftMs);
      console.log(`■ ${modelId}   (${rows.length} 次)`);
      console.log(`  纯解码中位 ${fmt(median(speeds))} tok/s | 首字延迟中位 ${fmt(median(ttfts), 0)} ms`);
    }
  }
}

// ---------- bench：受控基准 ----------

const BENCH_PROMPT = marker => `【输出速度基准测试 ${marker}】请严格遵守：不要使用任何工具，不要读取任何文件，不要输出思考过程说明，直接连续输出一篇约 3000 字的中文长文。主题：《城市公共交通的百年演变》，从十九世纪的马拉轨道车讲到当代的无人驾驶地铁，按时间顺序分节论述。正文中不要提及本次测试。现在直接开始正文。`;

function loadBenchMarker() {
  try { return JSON.parse(fs.readFileSync(BENCH_STATE, 'utf8')).marker; }
  catch { return null; }
}

function cmdBenchPrint() {
  const marker = 'SB-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  fs.writeFileSync(BENCH_STATE, JSON.stringify({ marker, createdAt: new Date().toISOString() }, null, 2));
  console.log('==== ZCode 输出速度 · 受控基准 ====');
  console.log(`标记: ${marker}（已存入 ${path.basename(BENCH_STATE)}）\n`);
  console.log('步骤:');
  console.log('1. 在 ZCode 里打开一个【新会话】，选择要测的模型');
  console.log('2. 粘贴下面的 prompt 发送，等它完整跑完（不干预、不追问）');
  console.log('3. 重复 3~5 次（每次建议开新会话；同一会话连跑也可以，脚本能正确识别）');
  console.log('4. 换下一个要对比的模型，重复步骤 1~3');
  console.log('5. 全部跑完后执行: node zcode-speed.mjs bench --collect\n');
  console.log('---- 复制以下 prompt ----');
  console.log(BENCH_PROMPT(marker));
  console.log('---- 结束 ----');
}

// 兼容两种 rollout 序列化：新格式 request.messages，旧格式 request.body.messages
function getMessages(obj) {
  const m = obj.request?.messages ?? obj.request?.body?.messages;
  return Array.isArray(m) ? m : null;
}

// 判断该调用的最后一条 user 消息是否含标记（排除历史消息中的旧标记）
function lastUserHasMarker(obj, marker) {
  const msgs = getMessages(obj);
  if (!msgs) return false;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'user') continue;
    const c = msgs[i].content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.map(b => typeof b === 'string' ? b : (b.text ?? '')).join(' ')
      : '';
    return text.includes(marker);
  }
  return false;
}

async function cmdBenchCollect() {
  const marker = loadBenchMarker();
  if (!marker) {
    console.error('未找到基准标记，请先运行: node zcode-speed.mjs bench');
    process.exit(1);
  }
  const runs = [];
  for (const f of listFiles(ROLLOUT_DIR, n => /^model-io-.*\.jsonl$/.test(n))) {
    for await (const obj of readJsonl(f)) {
      if (!getMessages(obj)) continue;
      if (!lastUserHasMarker(obj, marker)) continue;
      const c = extractCall(obj);
      if (c) runs.push(c);
    }
  }
  if (!runs.length) {
    console.error(`rollout 中未找到含标记 ${marker} 的调用。确认已在 ZCode 里跑过基准 prompt，且 rollout 目录正确: ${ROLLOUT_DIR}`);
    process.exit(1);
  }
  runs.sort((a, b) => a.completedAt.localeCompare(b.completedAt));

  console.log(`==== 基准结果 · 标记 ${marker}（${runs.length} 次采样）====`);
  console.log('时间(UTC)          模型        variant   输出tok   耗时s   tok/s');
  for (const r of runs) {
    const tps = r.outputTokens / (r.durationMs / 1000);
    console.log(
      (r.completedAt.slice(0, 19) || '?').padEnd(20) +
      r.modelId.padEnd(12) + (r.variant || '-').padEnd(10) +
      String(r.outputTokens).padEnd(10) +
      (r.durationMs / 1000).toFixed(1).padEnd(8) +
      fmt(tps)
    );
  }
  const byModel = new Map();
  for (const r of runs) {
    if (!byModel.has(r.modelId)) byModel.set(r.modelId, []);
    byModel.get(r.modelId).push(r);
  }
  for (const [m, cs] of byModel) {
    const s = summarize(cs);
    console.log(`\n■ ${m}: 中位 ${fmt(s.median)} tok/s | 加权 ${fmt(s.weighted)} tok/s | 最快 ${fmt(s.max)} | 最慢 ${fmt(s.min)}（${s.n} 次）`);
  }
}

// ---------- 入口 ----------

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'bench' && rest.includes('--collect')) {
  await cmdBenchCollect();
} else if (cmd === 'bench') {
  cmdBenchPrint();
} else {
  await cmdReport();
}
