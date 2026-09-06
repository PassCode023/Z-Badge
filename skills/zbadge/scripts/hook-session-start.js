// zbadge / hook-session-start.js  (加固版 2026-08-30)
// SessionStart 钩子:只读、静默、绝不阻塞会话(任何异常 exit 0)。
// 输出严格 schema JSON 的 additionalContext,仅在有值得告知时输出。
// 技能目录/脚本被删时:ENOENT 被捕获,静默退出——不会产生任何弹窗或报错。

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try {
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
  const disabled = path.join(skillRoot, 'DISABLED');

  function emit(context) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context }
    }));
  }

  if (fs.existsSync(disabled)) process.exit(0);           // 杀开关:静默
  if (!fs.existsSync(target)) process.exit(0);             // 目标不存在:静默
  if (!fs.existsSync(statePath)) {
    emit('[zbadge] status=no-state: 工具栏套餐额度徽章(5 小时/每周/ZCode MCP 剩余百分比+自动刷新)尚未安装;若用户想要,可加载技能 zbadge 安装(计划任务会一并注册,装任务弹一次 UAC)。');
    process.exit(0);
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const h = crypto.createHash('sha256');
  const s = fs.createReadStream(target);
  s.on('error', () => process.exit(0));
  s.on('data', d => h.update(d));
  s.on('end', () => {
    try {
      const cur = h.digest('hex');
      if (state.installedSha256 && cur === state.installedSha256.toLowerCase()) {
        // 哈希一致:检查进程陈旧(关窗重开≠重启,DL-023)
        try {
          const { execFileSync } = require('child_process');
          const out = execFileSync('powershell', ['-NoProfile', '-Command',
            'Get-Process ZCode -ErrorAction Stop | Sort-Object StartTime | Select-Object -First 1 -ExpandProperty StartTime -ErrorAction Stop | ForEach-Object { $_.ToString(\'o\') } 2>$null'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          const since = new Date(out.trim());
          const patchedAt = state.patchedAt ? new Date(state.patchedAt) : null;
          if (!Number.isNaN(since.getTime()) && patchedAt && since < patchedAt) {
            emit('[zbadge] status=stale-process: 磁盘补丁已是最新(' + state.patchedAt + '),但运行中的 ZCode 启动于 ' + since.toISOString() + ',仍是旧代码。请告知用户彻底退出 ZCode(含托盘图标)后重启;关窗重开不够。');
          }
        } catch {}
        process.exit(0);
      }
      emit('[zbadge] status=changed: ZCode 更新覆盖了补丁,工具栏额度徽章会消失。计划任务 ZbadgeAutoPatch(登录+每 10 分钟,免 UAC)会自动重打,最长 10 分钟内恢复。立即恢复可运行 schtasks /Run /TN ZbadgeAutoPatch;详情看技能 work/auto-repatch.log。');
    } catch {}
    process.exit(0);
  });
} catch { process.exit(0); }
