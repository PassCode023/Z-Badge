#!/usr/bin/env node
// model-speed skill · 钩子安装器（幂等）
// 把测速钩子合并进 ~/.zcode/cli/config.json，指向本 skill 目录下的 turn-stats.mjs。
// v3.1 双时机:Stop(主,回合结束→算出刚完成的这轮) + UserPromptSubmit(兜底,同值幂等
// 重写,覆盖中断等 Stop 未触发的场景)。v3.0 起为静默写文件、不注入上下文——旧版
// "Stop 会把正文挤进折叠区"的顾虑只针对 v2 注入式设计,已失效。
// 用法:
//   node install.mjs              安装 / 修复钩子
//   node install.mjs --uninstall  移除钩子
//   node install.mjs --status     查看当前状态

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const CONFIG = path.join(os.homedir(), '.zcode', 'cli', 'config.json');
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'turn-stats.mjs');
const MARKER = 'turn-stats.mjs'; // 用于识别"这是我们注册的钩子"
const EVENTS = ['Stop', 'UserPromptSubmit']; // Stop=主;UserPromptSubmit=兜底
const STATUS_MSG = { Stop: '统计本轮模型测速', UserPromptSubmit: '统计模型测速(兜底)' };

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return {}; // 文件不存在或损坏则从空配置开始（存在时会先备份）
  }
}

function saveConfig(cfg) {
  if (fs.existsSync(CONFIG)) {
    fs.copyFileSync(CONFIG, `${CONFIG}.bak-${Date.now()}`);
  } else {
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  }
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
}

function ourEntriesIn(cfg, event) {
  return (cfg.hooks?.events?.[event] ?? []).flatMap(g => g.hooks ?? [])
    .filter(h => (h.args ?? []).some(a => String(a).includes(MARKER)));
}

function dropOurEntries(cfg, event) {
  const groups = cfg.hooks?.events?.[event] ?? [];
  const kept = groups.filter(g => !(g.hooks ?? []).some(h => (h.args ?? []).some(a => String(a).includes(MARKER))));
  if (kept.length === groups.length) return false;
  if (kept.length) cfg.hooks.events[event] = kept;
  else delete cfg.hooks.events[event];
  return true;
}

function install() {
  const cfg = loadConfig();
  cfg.hooks ??= {};
  cfg.hooks.enabled = true;
  cfg.hooks.events ??= {};
  let added = [];
  for (const ev of EVENTS) {
    if (ourEntriesIn(cfg, ev).length) continue;
    cfg.hooks.events[ev] ??= [];
    cfg.hooks.events[ev].push({
      hooks: [{
        type: 'process',
        command: process.execPath, // 绝对路径：钩子子进程 PATH 里可能解析不到裸 "node"
        args: [SCRIPT, '${CLAUDE_SESSION_ID}'],
        timeoutMs: 8000,
        statusMessage: STATUS_MSG[ev] ?? '统计模型测速',
      }],
    });
    added.push(ev);
  }
  if (!added.length) {
    console.log('✓ 钩子已存在，无需重复安装');
    return;
  }
  saveConfig(cfg);
  console.log(`✓ 已注册钩子: ${added.join(' + ')} → ${CONFIG}`);
  console.log(`  脚本: ${SCRIPT}`);
  console.log('  注意: 桌面端需完全退出并重启 ZCode 应用后生效（headless 每次新进程不受影响）。');
}

function uninstall() {
  const cfg = loadConfig();
  let removedAny = false;
  for (const ev of [...EVENTS, 'Stop']) { // 'Stop' 重复无妨;再扫一遍兼容旧残留
    if (dropOurEntries(cfg, ev)) removedAny = true;
  }
  if (!removedAny) {
    console.log('✓ 未发现已安装的钩子');
    return;
  }
  saveConfig(cfg);
  console.log('✓ 钩子已移除');
}

function status() {
  const cfg = loadConfig();
  const enabled = cfg.hooks?.enabled === true;
  console.log(`钩子开关 hooks.enabled: ${enabled ? '开' : '关'}`);
  for (const ev of EVENTS) {
    const found = ourEntriesIn(cfg, ev);
    console.log(`已注册的本 skill 钩子（${ev}）: ${found.length} 个`);
    if (found.length) console.log(JSON.stringify(found[0], null, 2));
  }
  console.log(`rollout 目录存在: ${fs.existsSync(path.join(os.homedir(), '.zcode', 'cli', 'rollout')) ? '是' : '否（本机尚无 ZCode 调用记录）'}`);
}

const arg = process.argv[2] ?? '';
if (arg === '--uninstall') uninstall();
else if (arg === '--status') status();
else install();
