// zbadge / verify-pack.js  (2026-08-30 重建)
// 重打包校验:文件总数一致、原 unpacked 清单 ⊆ 新 unpacked 清单、包内目标文件含补丁标记。
// 用法: node verify-pack.js <origAsar> <patchedAsar> <rendererFile反斜杠路径>

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const [orig, patched, rendererFile] = process.argv.slice(2);
if (!orig || !patched || !rendererFile) { console.error('usage: node verify-pack.js <origAsar> <patchedAsar> <rendererFile>'); process.exit(2); }
const MARKER = 'chat-toolbar-plan-quota-';

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  const b16 = Buffer.alloc(16);
  fs.readSync(fd, b16, 0, 16, 0);
  const jsonLen = b16.readUInt32LE(8);
  const jb = Buffer.alloc(jsonLen);
  fs.readSync(fd, jb, 0, jsonLen, 16);
  fs.closeSync(fd);
  const jsonStr = jb.toString('utf8');
  return JSON.parse(jsonStr.slice(0, jsonStr.lastIndexOf('}') + 1));
}

function stats(header) {
  let unpacked = [], total = 0;
  (function walk(node, p) {
    if (node.files) { for (const k of Object.keys(node.files)) walk(node.files[k], p + '/' + k); return; }
    total++;
    if (node.unpacked) unpacked.push(p);
  })(header, '');
  return { total, unpacked };
}

const A = readHeader(orig), B = readHeader(patched);
const sa = stats(A), sb = stats(B);
const result = { ok: true, origFiles: sa.total, patchedFiles: sb.total };

if (sa.total !== sb.total) { result.ok = false; result.error = 'file count mismatch'; }
const missing = sa.unpacked.filter(p => !sb.unpacked.includes(p));
if (missing.length) { result.ok = false; result.error = 'native bin missing: ' + missing.join(','); result.missing = missing; }

const tmp = path.join(os.tmpdir(), 'zbadge-verify-' + process.pid);
fs.mkdirSync(tmp, { recursive: true });
try {
  execFileSync('npx.cmd', ['--yes', '@electron/asar', 'extract-file', patched, rendererFile],
    { stdio: 'ignore', encoding: 'utf8', cwd: tmp, shell: process.platform === 'win32' });
  const outPath = path.join(tmp, path.basename(rendererFile));
  if (!fs.existsSync(outPath)) { result.ok = false; result.error = 'extract-file produced no output'; }
  else {
    const content = fs.readFileSync(outPath, 'utf8');
    if (!content.includes(MARKER)) { result.ok = false; result.error = 'marker not found inside packed asar'; }
  }
} catch (e) {
  result.ok = false; result.error = 'extract-file failed: ' + (e.message || String(e)).slice(0, 200);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 2);
