#!/usr/bin/env node
// model-speed skill · 测速钩子脚本(v3.2,静默版)
// 双时机触发(Stop=主;UserPromptSubmit=兜底):从本机 rollout 记录中计算"刚完成的这一轮"
// main 调用的加权 TPS,静默写入 ~/.zcode/zbadge/last-speed.json,供 zbadge 注入的
// 对话末尾 ⚡ 速度行读取(按 turnId 精确归因)。
// - Stop(回合结束):尾部最后一个 turnId 组 = 刚完成的这轮,数值即时正确;
// - UserPromptSubmit(用户提交下一条):最后一组仍是刚完成轮,同值幂等重写(兜底中断等
//   Stop 未触发的情况)。
// 不注入 additionalContext、模型零参与、零上下文开销。
// v3.2 新增 workflow 段:回合条目可带 wf 数组(本轮"处理其完成通知"的 workflow 运行,
// 从 db.sqlite 的 dwf_run/dwf_actor 表采集:名称/状态/计费 tokens/子代理数/墙钟),
// 由 zbadge ⚡ 行下方逐条渲染 🔎🔩 行。计费口径=Σ各子代理会话全部 API 调用(含上下文重发)。
//
// 约定:
//   argv[2]          会话 ID(${CLAUDE_SESSION_ID} 展开;可省略走兜底)
//   stdin            钩子输入 JSON(可能含 session_id,作次选来源)
//   输出             无(静默);任何情况下 exit 0
//   测试钩子         环境变量 MS_ROLLOUT_DIR / MS_STATE_DIR / MS_DB_PATH 覆盖数据源(仅测试用)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROLLOUT_DIR = process.env.MS_ROLLOUT_DIR || path.join(os.homedir(), '.zcode', 'cli', 'rollout');
const STATE_DIR = process.env.MS_STATE_DIR || path.join(os.homedir(), '.zcode', 'zbadge');
const STATE_FILE = path.join(STATE_DIR, 'last-speed.json');
const DB_PATH = process.env.MS_DB_PATH || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
const TAIL_BYTES = 16 * 1024 * 1024; // 单行可达数百 KB(含全量消息窗口),读大尾部防漏计
const MAX_LOOKBACK_LINES = 300;
const MIN_OUT_TOKENS = 50; // 口径:单调用输出 <50 tokens 视为探活/摘要类微调用,不计入

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

let stdinJson; // 钩子输入 JSON(解析失败则视为空对象)
try {
  stdinJson = JSON.parse(readStdin());
  if (!stdinJson || typeof stdinJson !== 'object') stdinJson = {};
} catch {
  stdinJson = {};
}

function resolveSessionId() {
  const arg = process.argv[2] ?? '';
  if (arg && !arg.includes('${')) return arg;
  const id = stdinJson.session_id ?? stdinJson.sessionId ?? stdinJson.session?.id;
  return typeof id === 'string' && id ? id : null;
}

function rolloutFile(sessionId) {
  if (sessionId) {
    const f = path.join(ROLLOUT_DIR, `model-io-${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  try {
    return fs.readdirSync(ROLLOUT_DIR)
      .filter(n => /^model-io-.*\.jsonl$/.test(n))
      .map(n => path.join(ROLLOUT_DIR, n))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
  } catch {
    return null;
  }
}

// 读文件尾部并按行切分(丢弃截断的首行)
function readTailLines(file) {
  const size = fs.statSync(file).size;
  const len = Math.min(size, TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  let text = buf.toString('utf8');
  if (size > len) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  return text.split('\n').filter(Boolean);
}

// 兼容两种 rollout 序列化:滑动窗口格式 request.messages;
// 新 schema 把全量历史放在 request.body.messages(request.messages 为空数组)
function getMessages(obj) {
  const r = obj.request ?? {};
  const m = r.messages?.length ? r.messages : r.body?.messages;
  return Array.isArray(m) ? m : null;
}

// 本轮提示词指纹:窗口内最后一条"真实用户文本"的尾部
// (跳过 assistant/tool 消息与纯 tool_result 的 user 消息)。
// 同一轮的多次调用(工具循环)得到相同指纹,跨轮则不同;
// 超长轮次中窗口滑过用户消息时返回 undefined,视为"仍在本轮"继续向前收集。
function promptKey(obj) {
  const msgs = getMessages(obj);
  if (!msgs) return undefined;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'user') continue;
    const c = msgs[i].content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      const texts = c.filter(b => b && b.type === 'text').map(b => b.text ?? '');
      if (!texts.length) continue; // 纯工具结果消息,继续向前找
      text = texts.join('');
    }
    if (text.trim()) return `${text.length}:${text.slice(-80)}`;
  }
  return undefined;
}

function extractCall(obj) {
  const usage = obj.response?.usage ?? obj.usage;
  const ms = obj.durationMs;
  if (!usage?.outputTokens || !ms || ms <= 0) return null;
  // role 兼容:旧 schema 为 model.role="main";新 schema 该字段消失(仅 model.variant),
  // querySource="main_turn" 即主链路调用,杂项(标题生成等)另行排除
  const role = obj.model?.role ?? (obj.querySource === 'main_turn' ? 'main' : '');
  if (obj.model?.role === undefined && obj.querySource !== 'main_turn') return null;
  return {
    role,
    outputTokens: usage.outputTokens,
    durationMs: ms,
    // modelId=模型名(新 schema 字段名是 modelId,旧 schema 为 id);variant=思考档位(max/high/…)
    model: obj.model?.modelId ?? obj.model?.id ?? obj.modelId ?? null,
    variant: typeof obj.model?.variant === 'string' ? obj.model.variant : null,
    requestId: typeof obj.requestId === 'string' ? obj.requestId : null,
    completedAt: Number.isFinite(Date.parse(obj.completedAt)) ? Date.parse(obj.completedAt) : null,
    startedAt: Number.isFinite(Date.parse(obj.startedAt)) ? Date.parse(obj.startedAt) : null,
  };
}

// 从尾部向前收集"与最后一次 main 调用同轮"的 main 调用。
// 首选 turnId 聚合(rollout 每条记录带 turnId,同轮完全一致);老记录缺失 turnId
// 时退回提示词指纹法。返回 {calls, lastEnd, turnId, start0}:lastEnd=末调用完成时间;
// start0=本轮最早调用开始时间(回合起点,渲染侧按它与回合单元做时间窗归因);
// turnId=本轮 turnId(仅 turnId 聚合生效时有值,指纹法兜底时为 null)。
function collectTurnCalls(lines) {
  const calls = [];
  let lastEnd = null;
  let start0 = null;
  let refTurnId;
  let refKey; // 指纹法兜底:undefined = 尚未见到用户文本,继续向前
  for (let i = lines.length - 1; i >= 0 && calls.length < MAX_LOOKBACK_LINES; i--) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    const c = extractCall(obj);
    if (!c || c.role !== 'main') continue;
    const tid = obj.turnId;
    if (refTurnId === undefined) {
      refTurnId = tid ?? null; // null = 该记录无 turnId,走指纹法
      if (refTurnId === null) {
        const key = promptKey(obj);
        if (key !== undefined) refKey = key;
      }
    } else if (refTurnId !== null) {
      if (tid !== refTurnId) break; // turnId 变了 = 上一轮,停止
    } else {
      const key = promptKey(obj);
      if (key !== undefined) {
        if (refKey === undefined) refKey = key;
        else if (key !== refKey) break;
      }
    }
    calls.unshift(c);
    if (c.completedAt) lastEnd = lastEnd === null ? c.completedAt : Math.max(lastEnd, c.completedAt);
    if (c.startedAt && (start0 === null || c.startedAt < start0)) start0 = c.startedAt;
  }
  return { calls, lastEnd, turnId: refTurnId ?? null, start0 };
}

// 从应用本地 SQLite(db.sqlite 的 model_usage 表)取本会话近 8 天的 main 调用行。
// rollout 记录没有 TTFT 字段;应用把每次调用的 time_to_first_token_ms 入库,
// turn_id 与 rollout 的 turnId 同源(已核对真实样本)。只读打开(WAL 并发安全),
// node:sqlite 动态导入(旧 node 无此模块则静默降级为 null)。
// 用途:①当前轮的 TTFT 配对;②历史速度回填(每轮保留展示)。
async function dbModelRows(sessionId) {
  try {
    if (!sessionId) return null;
    const dbPath = DB_PATH;
    if (!fs.existsSync(dbPath)) return null;
    let DatabaseSync;
    try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return null; }
    let db;
    try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return null; }
    try {
      const since = Date.now() - 8 * 864e5;
      const rows = db.prepare(
        "select turn_id, started_at, completed_at, duration_ms as dur, output_tokens as out, model_id, variant, time_to_first_token_ms as ttft from model_usage " +
        "where session_id=? and query_source='main_turn' and status='completed' and output_tokens>=50 and started_at>?"
      ).all(sessionId, since);
      return rows.length ? rows : null;
    } finally { try { db.close(); } catch {} }
  } catch {
    return null;
  }
}

// workflow 运行段(dwf_run/dwf_actor 表,v3.2):采集本会话"刚完成、且由本回合处理其
// 完成通知"的运行。归因窗口 = (sinceMs, untilMs]:主用法 since=上一回合的 ts(回合末次
// 调用完成时刻)、until=本回合末次调用+60s——后台运行通常在本回合开始前一点完成、
// 通知随下一回合进入上下文,该窗口把它归到"展示通知的那一轮";兜底(无历史)回看 30 分钟。
// excludeIds = 已写入过历史条目 wf 的运行(幂等,UserPromptSubmit 重算不重复)。
// 口径:tokens=db 的 spent_tokens(计费口径,Σ各子代理会话全部 API 调用,含上下文重发);
// agents=dwf_actor 行数;wallMs=time_updated-time_created(墙钟,含并行与限流等待)。
async function dbWorkflowRuns(sessionId, sinceMs, untilMs, excludeIds) {
  try {
    if (!sessionId || !fs.existsSync(DB_PATH)) return [];
    let DatabaseSync;
    try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return []; }
    let db;
    try { db = new DatabaseSync(DB_PATH, { readOnly: true }); } catch { return []; }
    try {
      const rows = db.prepare(
        "select r.id, r.name, r.status, r.spent_tokens as tokens, r.time_created as created, r.time_updated as updated, " +
        "(select count(*) from dwf_actor a where a.run_id = r.id) as agents " +
        "from dwf_run r where r.parent_session_id=? and r.status in ('completed','failed','cancelled') " +
        "and r.time_updated>? and r.time_updated<=? order by r.time_updated limit 8"
      ).all(sessionId, sinceMs, untilMs);
      return rows
        .filter(r => !excludeIds.has(r.id))
        .map(r => ({
          id: r.id ?? '',
          name: r.name ?? '',
          status: r.status ?? 'completed',
          tokens: r.tokens ?? 0,
          agents: r.agents ?? 0,
          created: r.created ?? 0,
          updated: r.updated ?? 0,
          wallMs: Math.max(0, (r.updated ?? 0) - (r.created ?? 0)),
        }))
        .slice(0, 5);
    } finally { try { db.close(); } catch {} }
  } catch {
    return [];
  }
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// 加权 TPS 定义(与 SKILL.md 文档一致):
//   Σ outputTokens ÷ Σ durationMs × 1000(仅 role=main 且单调用输出 ≥MIN_OUT_TOKENS)
// "加权"指按 token 量权衡——长调用对结果贡献大,区别于各调用 TPS 的算术平均。
function buildState(calls, lastEnd, turnId, ttftRows, start0) {
  const usable = calls.filter(c => c.outputTokens >= MIN_OUT_TOKENS);
  const out = usable.reduce((a, c) => a + c.outputTokens, 0);
  const ms = usable.reduce((a, c) => a + c.durationMs, 0);
  if (!usable.length || out < 1 || ms <= 0) return null;
  // 模型归属:按输出 token 占比最大的调用(主导模型);variant=思考档位单列
  const dom = usable.reduce((a, c) => (c.outputTokens > a.outputTokens ? c : a), usable[0]);
  // TTFT 解剖:db 行与可用调用按"输出 tokens 相等 + 耗时最接近"贪心配对。
  // 同一调用两端计时口径差 ~40-70ms(db 恒偏大),精确相等永不命中(DL-049 同族:
  // 先比对真实样本再定匹配策略)。只为真实计入本口径的调用配 TTFT;无配对 → null。
  let ttftSum = 0, ttftN = 0;
  if (ttftRows && ttftRows.length) {
    const pool = ttftRows.map(r => ({ dur: r.dur, out: r.out, ttft: r.ttft }));
    for (const c of usable) {
      let bi = -1, bd = Infinity;
      for (let i = 0; i < pool.length; i++) {
        if (pool[i].out !== c.outputTokens) continue;
        const d = Math.abs(pool[i].dur - c.durationMs);
        if (d <= 3000 && d < bd) { bd = d; bi = i; }
      }
      if (bi >= 0) { ttftSum += pool[bi].ttft; ttftN++; pool.splice(bi, 1); }
    }
  }
  return {
    weighted: Math.round((out / (ms / 1000)) * 10) / 10,
    median: Math.round(median(usable.map(c => c.outputTokens / (c.durationMs / 1000))) * 10) / 10,
    tokens: out,
    ms,
    calls: usable.length,
    model: dom.model ?? dom.variant ?? '未知模型',
    variant: dom.variant ?? null,
    ts: lastEnd ?? Date.now(),
    turnId: turnId ?? null, // 调试用;渲染侧归因用 startedAt 时间窗(见速度历史)
    startedAt: start0 ?? null, // 回合起点(最早调用开始时间),渲染侧按它匹配各轮数据
    ttftSum: ttftN ? Math.round(ttftSum) : null,
    ttftN: ttftN || null,
  };
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE); // 原子替换,防徽章读到半截文件
}

// ---- 速度历史(每轮保留,供对话内逐轮展示与跨轮对比) ----
// speed-history.json = 按 startedAt 升序的条目数组,上限 50 轮、7 天窗口。
// 写入:当前轮 upsert(turnId 相同或 startedAt 相差 ≤3s 视为同轮)+ 从 db 回填
// 历史缺失轮(turn-stats 改版前的轮次也能立即带数据)。
const HISTORY_FILE = path.join(STATE_DIR, 'speed-history.json');
const HISTORY_MAX = 50;

function sameTurn(a, b) {
  if (a && b && a.turnId && b.turnId) return a.turnId === b.turnId;
  if (a && b && Number.isFinite(a.startedAt) && Number.isFinite(b.startedAt)) {
    return Math.abs(a.startedAt - b.startedAt) <= 3000;
  }
  return false;
}

// db 行组(同一 turn_id)→ 历史条目(口径与实时管道一致:输出≥50、有效 TTFT<耗时)
function entryFromDbGroup(g) {
  if (!g.length) return null;
  const ms = g.reduce((a, r) => a + (r.dur || 0), 0);
  const tok = g.reduce((a, r) => a + (r.out || 0), 0);
  if (!(ms > 0) || !(tok >= 1)) return null;
  const dom = g.reduce((a, r) => ((r.out || 0) > (a.out || 0) ? r : a), g[0]);
  let tsum = 0, tn = 0;
  for (const r of g) if (Number.isFinite(r.ttft) && r.ttft < r.dur) { tsum += r.ttft; tn++; }
  const s0 = Math.min(...g.map(r => (Number.isFinite(r.started_at) ? r.started_at : Infinity)));
  const ce = Math.max(...g.map(r => (Number.isFinite(r.completed_at) ? r.completed_at : 0)));
  return {
    turnId: g[0].turn_id ?? null,
    startedAt: Number.isFinite(s0) ? s0 : null,
    ts: ce || Date.now(),
    weighted: Math.round((tok / (ms / 1000)) * 10) / 10,
    tokens: tok,
    ms,
    calls: g.length,
    ttftSum: tn ? Math.round(tsum) : null,
    ttftN: tn || null,
    model: dom.model_id ?? dom.variant ?? '未知模型',
    variant: dom.variant ?? null,
  };
}

function updateHistory(sessionId, curEntry, dbRows) {
  try {
    let hist = null;
    try {
      const j = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (Array.isArray(j)) hist = j.filter(e => e && Number.isFinite(e.weighted));
    } catch {}
    hist = hist ?? [];
    const cutoff = Date.now() - 7 * 864e5;
    // 回填:db 里有而历史缺的轮(仅 7 天内、turn_id 非空的轮)
    if (dbRows) {
      const groups = new Map();
      for (const r of dbRows) {
        if (!r.turn_id) continue;
        if (!Number.isFinite(r.started_at) || r.started_at < cutoff) continue;
        if (!groups.has(r.turn_id)) groups.set(r.turn_id, []);
        groups.get(r.turn_id).push(r);
      }
      for (const g of groups.values()) {
        const e = entryFromDbGroup(g);
        if (!e || hist.some(h => sameTurn(h, e))) continue;
        hist.push(e);
      }
    }
    // 当前轮 upsert(无法识别的轮——无 turnId 且无 startedAt——跳过,防重复膨胀)
    if (curEntry && (curEntry.turnId || Number.isFinite(curEntry.startedAt))) {
      const i = hist.findIndex(h => sameTurn(h, curEntry));
      if (i >= 0) hist[i] = curEntry;
      else hist.push(curEntry);
    }
    hist = hist
      .filter(e => !Number.isFinite(e.startedAt) || e.startedAt >= cutoff - 864e5)
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
      .slice(-HISTORY_MAX);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(hist));
    fs.renameSync(tmp, HISTORY_FILE); // 原子替换
  } catch { /* 历史失败不影响主状态写入 */ }
}

async function main() {
  const sid = resolveSessionId();
  const file = rolloutFile(sid);
  if (!file) return;
  // 钩子未拿到会话 ID 时从选中的 rollout 文件名回推(agents 目录定位需要它)
  const effSid = sid ?? path.basename(file).replace(/^model-io-/, '').replace(/\.jsonl$/, '');
  let state = null;
  let dbRows = null;
  for (let attempt = 0; attempt < 2 && !state; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 500)); // 尾行可能尚未写完,稍候重试
    const { calls, lastEnd, turnId, start0 } = collectTurnCalls(readTailLines(file));
    dbRows = await dbModelRows(effSid);
    const ttftRows = (dbRows && turnId) ? dbRows.filter(r => r.turn_id === turnId) : null;
    state = buildState(calls, lastEnd, turnId, ttftRows, start0);
  }
  // 静默写状态文件(当前轮,调试/兼容)与速度历史(每轮保留+7 天回填);不再注入 additionalContext。
  if (state) {
    // workflow 段(v3.2):归因窗口上一回合 ts → 本回合末次调用+60s;已入历史的运行不重复。
    // 失败静默——workflow 段缺失只损失 🔎 行,不影响速度行。
    try {
      let prevTs = null;
      const done = new Set();
      let hist = null;
      try { hist = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch {}
      if (Array.isArray(hist)) {
        for (const en of hist) {
          if (!en) continue;
          // 同回合条目(兜底重算)不参与去重与 prevTs——归因窗口由 rollout 数据确定性
          // 推出,同回合重算得到同一集合;跨回合才排除,防重叠窗口双记。
          const sameTurn = (state.turnId && en.turnId)
            ? en.turnId === state.turnId
            : (state.startedAt && Number.isFinite(en.startedAt) && Math.abs(en.startedAt - state.startedAt) <= 3000);
          if (sameTurn) continue;
          for (const w of (Array.isArray(en.wf) ? en.wf : [])) if (w && w.id) done.add(w.id);
          if (state.startedAt && Number.isFinite(en.startedAt) && en.startedAt < state.startedAt) {
            prevTs = prevTs === null ? (en.ts ?? en.startedAt) : Math.max(prevTs, en.ts ?? en.startedAt);
          }
        }
      }
      const since = prevTs ?? (state.startedAt ? state.startedAt - 30 * 60e3 : Date.now() - 30 * 60e3);
      const wfs = await dbWorkflowRuns(effSid, since, (state.ts ?? Date.now()) + 60e3, done);
      if (wfs.length) state.wf = wfs;
    } catch {}
    try { writeState(state); } catch { /* 静默失败,不影响对话 */ }
    try { updateHistory(effSid, state, dbRows); } catch { /* 静默失败 */ }
  }
}

main().catch(() => { /* 静默失败,不影响对话 */ });
