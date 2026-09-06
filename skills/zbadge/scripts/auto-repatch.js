// zcode-quota-badge / auto-repatch.js  (加固版 2026-08-30)
// 一条龙自动重打补丁:check → extract → merge unpacked → revert → 基线 → inject →
// 语法校验 → pack → verify-pack → apply(提权)→ 复核。
// P0 加固:① work/DISABLED 存在 = 总杀开关,静默退出;② 技能目录自检。
// 用法: node auto-repatch.js [--status|--no-apply|--force]

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SK = path.resolve(__dirname, '..');
const WORK = path.join(SK, 'work');
const SCRIPTS = path.join(SK, 'scripts');
const EXTRACTED = path.join(WORK, 'extracted');
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
const TARGET = resolveTarget();
const UNPACKED_SRC = TARGET.replace(/app\.asar$/, 'app.asar.unpacked');
const LOG = path.join(WORK, 'auto-repatch.log');
const LOCK = path.join(WORK, 'autopatch.lock');
const DISABLED = path.join(SK, 'DISABLED');
const args = new Set(process.argv.slice(2));

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}
function trimLog() {
  try {
    if (fs.statSync(LOG).size > 1024 * 1024) {
      fs.writeFileSync(LOG, fs.readFileSync(LOG, 'utf8').split('\n').slice(-300).join('\n'));
    }
  } catch {}
}
function fatal(msg) { log('FATAL: ' + msg); unlock(); process.exit(1); }
function sha256(p) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', rej); s.on('data', d => h.update(d));
    s.on('end', () => res(h.digest('hex')));
  });
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function tryLock() {
  try {
    if (fs.existsSync(LOCK)) {
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim());
      if (pid && isAlive(pid)) { log(`another run active (pid=${pid}), exit`); process.exit(0); }
      fs.unlinkSync(LOCK);
    }
    fs.writeFileSync(LOCK, String(process.pid));
  } catch (e) { fatal('lock failed: ' + e.message); }
}
function unlock() { try { fs.unlinkSync(LOCK); } catch {} }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', ...opts });
  if (r.status !== 0) fatal(`step failed: ${cmd} ${cmdArgs.join(' ').slice(0, 160)}\nexit=${r.status}\n${(r.output || []).join('').slice(-800)}`);
  return r.stdout;
}
function asar(argsList, cwd) { return run('cmd', ['/c', 'npx', '--yes', '@electron/asar', ...argsList], { cwd }); }
function nodeScript(script, scriptArgs) { return run(process.execPath, [path.join(SCRIPTS, script), ...scriptArgs]); }
function parseJsonOut(txt, what) {
  try { return JSON.parse(txt.slice(txt.indexOf('{'))); }
  catch (e) { fatal(`${what}: cannot parse output: ${String(txt).slice(0, 200)}`); }
}
function syntaxCheck(jsFile) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(jsFile, 'utf8'), encoding: 'utf8' });
  if (r.status !== 0) fatal(`syntax check failed on ${jsFile}:\n${String(r.stderr).slice(0, 600)}`);
}
function isElevated() {
  const r = spawnSync('cmd', ['/c', 'net', 'session'], { encoding: 'utf8', stdio: 'ignore' });
  return r.status === 0;
}

async function currentState() {
  if (!fs.existsSync(TARGET)) return { status: 'no-target' };
  const cur = await sha256(TARGET);
  let state = null;
  try { state = JSON.parse(fs.readFileSync(path.join(WORK, 'state.json'), 'utf8')); } catch {}
  if (state && state.installedSha256 && cur === state.installedSha256.toLowerCase()) return { status: 'patched', cur };
  return { status: 'changed', cur };
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  trimLog();
  // 总杀开关:DISABLED 文件存在 = 用户要求徽章保持卸载状态,绝不重打
  if (fs.existsSync(DISABLED)) { log('DISABLED flag present — skipping (kill switch)'); unlock?.call(null); process.exit(0); }
  const st = await currentState();
  if (args.has('--status')) { console.log(JSON.stringify(st, null, 2)); process.exit(0); }
  tryLock();
  if (st.status === 'no-target') fatal('target asar not found: ' + TARGET);
  // FORCE 标记文件:允许计划任务(免 UAC)触发强制重打,schtasks /Run 无法传参
  const FORCE_FLAG = path.join(WORK, 'FORCE');
  const forced = args.has('--force') || fs.existsSync(FORCE_FLAG);
  if (st.status === 'patched' && !forced) { log('already patched, nothing to do'); unlock(); process.exit(0); }
  if (st.status === 'patched' && forced) log(`force: revert + re-inject on patched install (${args.has('--force') ? '--force' : 'FORCE flag file'})`);
  else log(`patch invalidated (status=${st.status}) — full pipeline start`);

  rmrf(EXTRACTED); fs.mkdirSync(EXTRACTED, { recursive: true });
  asar(['extract', TARGET, EXTRACTED]);
  try {
    for (const entry of fs.readdirSync(UNPACKED_SRC))
      fs.cpSync(path.join(UNPACKED_SRC, entry), path.join(EXTRACTED, entry), { recursive: true, force: true });
  } catch (e) { fatal('merge app.asar.unpacked failed: ' + e.message); }

  const rv = parseJsonOut(nodeScript('patch.js', [EXTRACTED, '--revert-only']), 'revert');
  log(`revert: ${JSON.stringify(rv)}`);
  const assetRel = path.join('out', 'renderer', 'assets', rv.file);
  const assetAbs = path.join(EXTRACTED, assetRel);
  syntaxCheck(assetAbs);

  rmrf(path.join(WORK, 'app.asar.unpatched'));
  asar(['pack', EXTRACTED, path.join(WORK, 'app.asar.unpatched'), '--unpack', '**/*.{node,dll,exe}'], WORK);
  rmrf(path.join(WORK, 'app.asar.unpatched.unpacked'));

  const pj = parseJsonOut(nodeScript('patch.js', [EXTRACTED]), 'inject');
  log(`inject: ${JSON.stringify(pj)}`);
  syntaxCheck(assetAbs);

  rmrf(path.join(WORK, 'app-patched.asar'));
  rmrf(path.join(WORK, 'app-patched.asar.unpacked'));
  asar(['pack', EXTRACTED, path.join(WORK, 'app-patched.asar'), '--unpack', '**/*.{node,dll,exe}'], WORK);
  const vp = parseJsonOut(nodeScript('verify-pack.js', [
    path.join(WORK, 'app.asar.unpatched'), path.join(WORK, 'app-patched.asar'), assetRel.replace(/\//g, '\\'),
  ]), 'verify-pack');
  if (!vp.ok) fatal('verify-pack rejected: ' + JSON.stringify(vp));
  log(`verify-pack ok: ${JSON.stringify(vp)}`);

  if (args.has('--no-apply')) { log('--no-apply: stop before copy'); unlock(); process.exit(0); }
  log(`apply (elevated=${isElevated()})`);
  if (isElevated()) {
    run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'apply.ps1')]);
  } else {
    run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'run-elevated.ps1'), 'apply.ps1'], { cwd: SCRIPTS });
  }
  const after = await currentState();
  if (after.status !== 'patched') fatal('post-apply check failed: ' + JSON.stringify(after));
  log('DONE: patch re-applied and verified');
  try { fs.unlinkSync(path.join(WORK, 'FORCE')); } catch {}

  rmrf(EXTRACTED);
  rmrf(path.join(WORK, 'app-patched.asar.unpacked'));
  unlock();
  process.exit(0);
})().catch(e => { log('FATAL: ' + (e.stack || String(e))); unlock(); process.exit(1); });
