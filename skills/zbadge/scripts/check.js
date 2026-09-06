// zbadge / check.js  (加固版 2026-08-30)
// 判断安装的 app.asar 补丁状态 + 运行中进程是否已加载它。只读、免管理员。
// 输出 JSON: {status: 'patched'|'changed'|'no-state'|'stale-process'|'disabled'|'error'}
//   patched       = 磁盘补丁最新,运行进程也已加载
//   stale-process = 磁盘补丁最新但进程启动早于补丁应用时间——彻底退出(含托盘)再启动
//   changed       = ZCode 更新覆盖了补丁(计划任务最长 10 分钟内自动恢复)
//   disabled      = 杀开关 zbadge/DISABLED 存在,补丁被有意停用

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const skillRoot = path.resolve(__dirname, '..');
const statePath = path.join(skillRoot, 'work', 'state.json');
// 目标安装目录解析:环境变量 ZCODE_INSTALL_DIR 优先,其次常见安装位置探测。
function resolveTarget() {
  const cands = [];
  if (process.env.ZCODE_INSTALL_DIR) cands.push(process.env.ZCODE_INSTALL_DIR.replace(/\\/g, '/').replace(/\/$/, ''));
  cands.push('C:/Program Files/ZCode', 'D:/Program Files/ZCode', 'E:/Program Files/ZCode');
  if (process.env.LOCALAPPDATA) cands.push(process.env.LOCALAPPDATA.replace(/\\/g, '/') + '/Programs/ZCode');
  for (const c of cands) {
    if (!c) continue;
    const p = c + '/resources/app.asar';
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return (cands[0] || 'C:/Program Files/ZCode') + '/resources/app.asar'; // 不存在时由调用方给出明确错误
}
const target = resolveTarget();

function sha256(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}
function runningSince() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-Process ZCode -ErrorAction Stop | Sort-Object StartTime | Select-Object -First 1 -ExpandProperty StartTime -ErrorAction Stop | ForEach-Object { $_.ToString(\'o\') } 2>$null'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const d = new Date(out.trim());
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch { return null; }
}

(async () => {
  if (fs.existsSync(path.join(skillRoot, 'DISABLED'))) { console.log(JSON.stringify({ status: 'disabled' })); process.exit(0); }
  if (!fs.existsSync(target)) { console.log(JSON.stringify({ status: 'error', detail: 'target asar not found: ' + target })); process.exit(2); }
  const since = runningSince();
  if (!fs.existsSync(statePath)) { console.log(JSON.stringify({ status: 'no-state', runningSince: since })); process.exit(0); }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const cur = await sha256(target);
  const hashPatched = state.installedSha256 && cur === state.installedSha256.toLowerCase();
  const patchedAt = state.patchedAt ? new Date(state.patchedAt) : null;
  const stale = hashPatched && since && patchedAt && new Date(since) < patchedAt;
  if (stale) {
    console.log(JSON.stringify({ status: 'stale-process', runningSince: since, patchedAt: state.patchedAt, detail: '磁盘补丁最新但运行中 ZCode 启动更早;彻底退出(含托盘)后重启生效' }, null, 2));
    process.exit(0);
  }
  console.log(JSON.stringify({ status: hashPatched ? 'patched' : 'changed', current: cur, recorded: state.installedSha256, patchedAt: state.patchedAt, runningSince: since }, null, 2));
  process.exit(0);
})().catch(e => { console.log(JSON.stringify({ status: 'error', detail: e.message })); process.exit(2); });
