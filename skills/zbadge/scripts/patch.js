// zcode-quota-badge / patch.js  (加固版,2026-08-30 重建)
// 在解包后的 ZCode renderer bundle 中动态发现锚点并注入"套餐额度徽章"组件。
// 不硬编码任何 minified 标识符/文件名——每次从稳定字面量重新发现。
//
// P0 加固(DL-037,2026-08-30):
//   1. 错误边界类(Err)包住徽章输出——渲染/副作用抛错只损失徽章,不伤应用;
//   2. 组件渲染体整体 try/catch,任何异常返回 null;
//   3. 所有 effect 内逻辑 try/catch;
//   4. 移除全局 pointermove 监听(P0 头号嫌疑),保留:徽章 pointerEnter(局部)、
//      window focus、visibilitychange、60s setInterval 强制兜底;
//   5. 碰撞降档保留但全路 try/catch,仅在 RO 回调与刷新节流后触发。
//
// 用法: node patch.js <extractedRoot> [--dry-run] [--revert-only] [--upgrade]
// 退出码:0=成功/已打过/干净树no-op;2=锚点未找到(禁止盲打);3=写入失败。

'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const root = args.find(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const revertOnly = args.includes('--revert-only');
const upgrade = args.includes('--upgrade');
if (!root) { console.error('usage: node patch.js <extractedRoot> [--dry-run] [--revert-only] [--upgrade]'); process.exit(3); }

const assetsDir = path.join(root, 'out', 'renderer', 'assets');
const MARKER = 'chat-toolbar-plan-quota-';

function fail(code, msg, extra) {
  console.log(JSON.stringify({ ok: false, code, error: msg, ...extra }, null, 2));
  process.exit(code);
}

// ---- 1. 定位包含工具栏组件与套餐面板的 renderer asset 文件 ----
let files;
try { files = fs.readdirSync(assetsDir).filter(f => f.endsWith('.js')); }
catch (e) { fail(2, 'assets dir not found: ' + assetsDir); }

let target = null;
for (const f of files) {
  const s = fs.readFileSync(path.join(assetsDir, f), 'utf8');
  if (s.includes('codingPlanUsageRemaining') && s.includes('sidebar.usage.plan.fiveHour')) { target = { file: f, s }; break; }
}
if (!target) fail(2, 'no renderer asset contains both codingPlanUsageRemaining and sidebar.usage.plan.fiveHour', { assetsChecked: files.length });

let { file, s } = target;
const wasPatched = s.includes(MARKER);

// ---- 2. 幂等 / 干净树处理 ----
if (wasPatched && !revertOnly && !upgrade) {
  console.log(JSON.stringify({ ok: true, alreadyPatched: true, file }, null, 2));
  process.exit(0);
}
if (!wasPatched && revertOnly) {
  console.log(JSON.stringify({ ok: true, alreadyClean: true, file }, null, 2));
  process.exit(0);
}

// ---- 3. 发现锚点(对已打补丁文件同样有效:注入物不匹配这些形状) ----
const mDef = s.match(/function ([A-Za-z_$][\w$]*)\(\{codingPlanUsageRemaining/);
if (!mDef) fail(2, 'toolbar component def not found');
const comp = mDef[1];

const callRe = new RegExp('\\(0,([A-Za-z_$][\\w$]*)\\.(jsx|jsxs)\\)\\(' + comp.replace(/\$/g, '\\$&') + ',\\{codingPlanUsageRemaining:');
const mCall = s.match(callRe);
if (!mCall) fail(2, 'toolbar call site not found for component ' + comp);
const jsx = mCall[1];
const callSite = mCall[0];
const propsRegion = s.slice(mCall.index, mCall.index + 600);
const mCfg = propsRegion.match(/codingPlanUsageRemaining:([A-Za-z_$][\w$]*)/);
const mIntl = propsRegion.match(/\bintl:([A-Za-z_$][\w$]*)/);
const mLocale = propsRegion.match(/\blocale:([A-Za-z_$][\w$]*)/);
const mStart = propsRegion.match(/\bstartPlanBalance:([A-Za-z_$][\w$]*)/);
if (!mCfg || !mIntl || !mLocale) fail(2, 'props (config/intl/locale) not found near call site');

const idxFive = s.indexOf('sidebar.usage.plan.fiveHour');
const panelStart = s.lastIndexOf('function ', idxFive);
if (idxFive < 0 || panelStart < 0) fail(2, 'plan panel window not found');
const panelWin = s.slice(panelStart, s.length);

const mRes = panelWin.match(/\(0,([A-Za-z_$][\w$]*)\.useMemo\)\(\(\)=>([A-Za-z_$][\w$]*)\(e\),\[e\]\)/);
if (!mRes) fail(2, 'resolver useMemo not found in panel window');
const react = mRes[1], resolver = mRes[2];

const mFind = panelWin.match(/([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),`TOKENS_LIMIT`,3,5\)/);
if (!mFind) fail(2, 'quota finder (TOKENS_LIMIT,3,5) not found in panel window');
const finder = mFind[1];

const mFmt = panelWin.match(/percentage:([A-Za-z_$][\w$]*)\(e\.limit\),.{0,200}?value:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),e\.limit\)/);
if (!mFmt) fail(2, 'percent/formatter shape not found in panel window');
const fmt = mFmt[2];

let i18nOk = false, i18nFile = null;
for (const f of files) {
  if (f === file) continue;
  try {
    const head = fs.readFileSync(path.join(assetsDir, f), 'utf8');
    if (head.includes('sidebar.usage.plan.fiveHour') && head.includes('sidebar.usage.plan.mcp')) { i18nOk = true; i18nFile = f; break; }
  } catch {}
}

const defAnchor = 'function ' + comp + '({codingPlanUsageRemaining';

// ---- 3.5 主进程/preload 注入(IPC 兜底,2026-09-05) ----
// 渲染进程实测 nodeIntegration:false + contextIsolation:true + sandbox:true
// → 无 require/fs(DL-043 后续实证)。⚡ 速度徽章数据改为经主进程只读通道:
//   main(ESM,动态 import)注册 ipcMain.handle('zbadge:read-speed')只读固定文件(64KB 上限);
//   preload(CJS)contextBridge 暴露 window.zbadgeSpeed.read()。
// 追加式注入(文件尾),标记 ;/*zbadge-patch*/,逆转=从首个标记截断。
// 语法门:追加后的整文件分别按 module/commonjs 过 node --check,不过即 fail(禁止盲打)。
const MAIN_REL = 'out/main/index.js';
const PRELOAD_REL = 'out/preload/index.cjs';
const AUX_MARK = ';/*zbadge-patch*/';
const MAIN_SNIPPET = '\n' + AUX_MARK + 'try{(async()=>{try{let em=await import("electron"),fm=await import("fs"),pp="";try{pp=(globalThis.process&&globalThis.process.env&&(globalThis.process.env.USERPROFILE||globalThis.process.env.HOME))||""}catch(_){}pp+="/.zcode/zbadge/speed-history.json";(em.default||em).ipcMain.handle("zbadge:read-speed",()=>{try{let st=(fm.default||fm).statSync(pp);if(!st||st.size>65536)return null;return JSON.parse((fm.default||fm).readFileSync(pp,"utf8"))}catch(_){return null}})}catch(_){}})()}catch(_){}';
const PRELOAD_SNIPPET = '\n' + AUX_MARK + 'try{let e=require("electron");e.contextBridge.exposeInMainWorld("zbadgeSpeed",{read:()=>e.ipcRenderer.invoke("zbadge:read-speed")})}catch(_){}';

function auxPath(rel) { return path.join(root, rel); }
function revertAux(rel) {
  let src;
  try { src = fs.readFileSync(auxPath(rel), 'utf8'); } catch (e) { fail(2, 'aux read failed: ' + rel + ': ' + e.message); }
  const i = src.indexOf(AUX_MARK);
  if (i < 0) return { rel, reverted: false };
  const out = src.slice(0, i);
  if (!dryRun) { try { fs.writeFileSync(auxPath(rel), out); } catch (e) { fail(3, 'aux write failed: ' + rel + ': ' + e.message); } }
  return { rel, reverted: true, removedBytes: src.length - out.length };
}
function auxSyntaxGate(src, type) {
  const args = type === 'module' ? ['--input-type=module', '--check'] : ['--input-type=commonjs', '--check'];
  const r = spawnSync(process.execPath, args, { input: src, encoding: 'utf8' });
  return r.status === 0 ? null : String(r.stderr).slice(0, 300);
}
function applyAux(rel, snippet, type) {
  let src;
  try { src = fs.readFileSync(auxPath(rel), 'utf8'); } catch (e) { fail(2, 'aux read failed: ' + rel + ': ' + e.message); }
  const i = src.indexOf(AUX_MARK);
  const base = i >= 0 ? src.slice(0, i) : src;
  const out = base + snippet;
  const err = auxSyntaxGate(out, type);
  if (err) fail(2, 'aux syntax gate failed: ' + rel + '\n' + err);
  if (!dryRun) { try { fs.writeFileSync(auxPath(rel), out); } catch (e) { fail(3, 'aux write failed: ' + rel + ': ' + e.message); } }
  return { rel, injected: true, appendedBytes: out.length - base.length };
}

// ---- 4. 逆转旧注入(兼容历代注入形状) ----
function revertInjections(src) {
  let rounds = 0;
  while (src.includes(MARKER)) {
    if (++rounds > 4) fail(2, 'revert: too many accumulated injections');
    // 最早出现的注入块起点(错误边界类或组件定义)
    const starts = [];
    for (const m of src.matchAll(/(?:function|class) (zQuotaBadge\w*|zPq9)(?:\(| extends)/g)) starts.push({ i: m.index, name: m[1] });
    if (!starts.length) fail(2, 'revert: marker present but injected block not found');
    starts.sort((a, b) => a.i - b.i);
    const first = starts[0];
    const defIdx = src.indexOf(defAnchor, first.i);
    if (defIdx < 0 || defIdx <= first.i) fail(2, 'revert: defAnchor not found after injected block start');
    const block = src.slice(first.i, defIdx);
    // 正确性信号:块内必须含补丁标记(数据-testid 模板字面量)——边界类+组件合块时内部含 function 属正常
    if (!block.includes(MARKER))
      fail(2, 'revert: injected block lacks marker', { blockHead: block.slice(0, 120) });
    let next = src.slice(0, first.i) + src.slice(defIdx);
    // JSX 调用点用的是组件名(可能是 zQuotaBadge1 等),与块起点名(可能是 Err 类)不同,全局匹配
    const callReAll = /\(0,[A-Za-z_$][\w$]*\.(?:jsx|jsxs)\)\((?:zQuotaBadge\w*|zPq9),\{config:[A-Za-z_$][\w$]*[^}]*\}\),/g;
    const calls = next.match(callReAll) || [];
    if (calls.length !== 1) fail(2, 'revert: injected call not found exactly once (found ' + calls.length + ')');
    next = next.replace(callReAll, '');
    src = next;
  }
  return src;
}

if (wasPatched) {
  s = revertInjections(s);
  // ⚡ 回合末尾注入逆转(独立于 MARKER 块,按注入字面量正则移除)
  const spdRe = /,\(0,[A-Za-z_$][\w$]*\.jsx\)\(zSpdX\w*,\{tg:e\}\)/g;
  const spdHits = s.match(spdRe) || [];
  if (spdHits.length > 1) fail(2, 'revert: multiple turn-speed injections (found ' + spdHits.length + ')');
  if (spdHits.length) s = s.replace(spdRe, '');
  if (s.includes(MARKER)) fail(2, 'revert: marker still present after revert');
  if (revertOnly) {
    const aux = [revertAux(MAIN_REL), revertAux(PRELOAD_REL)];
    if (!dryRun) { try { fs.writeFileSync(path.join(assetsDir, file), s); } catch (e) { fail(3, 'write failed: ' + e.message); } }
    console.log(JSON.stringify({ ok: true, reverted: true, dryRun, file, removedBytes: target.s.length - s.length, aux }, null, 2));
    process.exit(0);
  }
}

// ---- 5. 唯一组件名(边界类名 = 组件名 + Err,逆转时一并移除) ----
let name = 'zQuotaBadge', n = 0;
while (s.includes(name)) name = 'zQuotaBadge' + (++n);
const errName = name + 'Err';
let sname = 'zSpdX', sn = 0; // ⚡ 回合末尾速度行组件名,同样保证唯一
while (s.includes(sname)) sname = 'zSpdX' + (++sn);

// ---- 6. 生成注入代码(标识符全部来自本次发现) ----
// 刷新通道(P0 加固后):徽章 pointerEnter(局部)/ window focus / visibilitychange /
// 60s 强制兜底(回退链 onEntitlementRefresh→onAccess→start.onAccess);全局 pointermove
// 已移除(P0 头号嫌疑,DL-037)。25s 自节流;effect 依赖=回调存在性布尔 p(DL-021)。
// 碰撞降档 v2(2026-08-31):v1 只扫 el.parentElement 的直接孩子——composer 底行里
// 徽章的 parentElement 是 GROUP(span.flex.min-w-0.shrink),而"完全访问/变更确认"触发器
// 在左侧 leading-actions(flex-1 basis-0)内、其 shrink-0 内容行向右溢出 16~28px 盖住
// 徽章头部,该触发器不在 GROUP 孩子里 → worst 恒 0,推让永不触发(实测截图)。
// v2:① 从 el 起 4 级祖先、每级兄弟矩形+向下探一层做几何相交(溢出源往往是 0 宽
// 占位盒的子元素,必须下探);② 推让(margin-left)后 150ms 复查一次,仍有残留重叠
// → 降紧凑档(GROUP 的 shrink 链会把 margin 吃成 el 收缩,纯推让清不掉小重叠);
// ③ ck 不再直接降隐藏档——隐藏会卸载 el,而 RO effect 依赖 [],卸载后 RO 永久失联,
// 档位从此冻结(即 5353 版"徽章整体消失"的机制,本轮静态定位确认);隐藏只留给
// RO 的宽度阈值(紧凑内容 ~150px > 120px 阈值,正常不会触发);④ RO 同时观察
// el.parentElement(GROUP):窗口缩放时 el 自身宽度不变,不观察父级就永远不复查;
// RO 回调末尾追加 ck。触发:挂载后 80ms、RO、刷新节流通过时。全部 try/catch 包裹。
// ZCode MCP = visibleSnapshot.mcpQuota.aggregate(独立字段,勿用 TIME_LIMIT,5,1);
// 体验套餐 = startPlanBalance 通道回退;API 方式两通道皆空 → 隐藏(正确)。
// 分色(按剩余%):≥60 绿 success / ≥30 蓝 blue-500 / ≥10 橙 warning / <10 红 destructive。
const REFRESH_INTERVAL_MS = 6e4;
const REFRESH_MIN_GAP_MS = 25e3;
// 诊断行构建期开关:work/DEBUG 存在 → 注入悬停诊断;否则干净构建
const DBG = fs.existsSync(path.join(__dirname, '..', 'work', 'DEBUG'));
const def =
'class ' + errName + ' extends ' + react + '.Component{constructor(s){super(s);this.state={e:!1}}' +
'static getDerivedStateFromError(){return{e:!0}}componentDidCatch(){}render(){return this.state.e?null:this.props.c}}' +
'function ' + name + '({config:e,start:y,intl:t,locale:n}){' +
'try{' +
'let r=(0,' + react + '.useMemo)(()=>{try{return e?' + resolver + '(e):null}catch(_){return null}},[e]);' +
'let d=(0,' + react + '.useRef)(null),j=(0,' + react + '.useRef)(null),w=(0,' + react + '.useRef)(null),ck=(0,' + react + '.useRef)(null);d.current=e;j.current=y;' +
'let p=!!(e?.onAccess||e?.onEntitlementRefresh||y?.onAccess);' +
'(0,' + react + '.useEffect)(()=>{if(!p)return;' +
'let m=0,u=k=>{let l=Date.now();if(l-m<' + REFRESH_MIN_GAP_MS + ')return;m=l;' +
'try{let c=d.current,f=k?(c?.onEntitlementRefresh??c?.onAccess??j.current?.onAccess):(c?.onAccess??j.current?.onAccess);f&&f()}catch(_){}' +
'try{ck.current&&ck.current()}catch(_){}};' +
'u(!1);w.current=u;' +
'let iv=setInterval(()=>u(!0),' + REFRESH_INTERVAL_MS + '),f2=()=>u(!1),' +
'v=()=>{document.visibilityState===`visible`&&u(!1)};' +
'window.addEventListener(`focus`,f2);document.addEventListener(`visibilitychange`,v);' +
'return()=>{clearInterval(iv);window.removeEventListener(`focus`,f2);document.removeEventListener(`visibilitychange`,v)}},[p]);' +
'let[g1,g2]=(0,' + react + '.useState)(2),gr=(0,' + react + '.useRef)(null);' +
'(0,' + react + '.useEffect)(()=>{let el=gr.current;if(!el||typeof ResizeObserver===`undefined`)return;' +
// v2.2:RO 不再按宽度降档(切换对话/挂载动画的瞬态宽度曾把徽章打到隐藏档,
// 探测恢复要 2 分钟——用户实测"切一下对话就消失")。降档统一走 ck 双确认,
// 升档走 ck 实测空间;RO 只做 0→1 安全复活 + 触发 ck。
// v2.3:窗口拉宽时多余空间全被左侧 flex-1 容器吸收,el 与其父盒尺寸不变——只观察
// el+父级时 RO 永不触发,升档实测没机会跑(用户实测"宽窗口卡在紧凑档")。改为向上
// 观察 4 级祖先(覆盖到 composer 整行);RO 回调 150ms 去重节流,防拖动窗口时测量风暴。
'let ro=new ResizeObserver(es=>{try{g2(t=>t===2?t:1)}catch(_){}' +
'try{if(!ck.t){ck.t=1;setTimeout(()=>{ck.t=0;try{ck.current&&ck.current()}catch(_){}},150)}}catch(_){}});' +
'try{ro.observe(el)}catch(_){}try{let p=el.parentElement;for(let i=0;p&&i<4;i++){ro.observe(p);p=p.parentElement}}catch(_){}' +
'return()=>{try{ro.disconnect()}catch(_){}}},[g1]);' +
// MutationObserver(2026-08-31,已回滚):模式标签变宽等 DOM 变化 150ms 复查
// —— 5353 版引入后徽章整体消失,退回纯碰撞推让版(见 auto-repatch.log 00:47)。
// 5353 机制(2026-09-01 定位):g1→0 卸载 el + RO effect 依赖 [] → RO 永久失联,
// 档位冻结在 0。v2.1(2026-09-01):①g1=0 不再卸载——wrapper 挂 hidden class,
// el/RO 保持存活,探测恢复才真正可达(v2.0 的探测写在 `if(!el)return` 之后,
// 而卸载使 el=null,探测是死代码——沙盒曾把隐藏模拟成 display:none 没暴露此路径);
// ②降档需 250ms 内两次连续测量确认(arm/confirm),切换动画/瞬时布局不再误降;
// ③推让清掉头部且无尾部裁剪(scrollWidth<=clientWidth+2)时保留完整标签;
// ④v2.2(2026-09-01 晚):RO 按宽度降档全数移除(切换对话瞬态宽度→隐藏档→2 分钟
// 探测 = 用户实测"切对话就消失");升档改纯实测:tier2 时缓存全标签内容宽
// scrollWidth(被裁剪也含溢出全宽),tier1 干净时"左侧净空 ≥ 全宽-紧凑宽+6"立即
// 升回全标签——满足用户需求"放得下就全显,放不下就百分比",无闪烁无等待。
'(0,' + react + '.useEffect)(()=>{let id=setTimeout(()=>{try{ck.current&&ck.current()}catch(_){}},80);return()=>clearTimeout(id)},[g1,r,y]);' +
'ck.current=()=>{let el=gr.current;if(!el)return;' +
// g1=0 已无任何设置路径;此分支纯防御,立即复活。
'if(g1===0){g2(1);return}' +
// scan=纯测量(el 矩形→多级祖先扫描→裁剪),无副作用;ck 主体与 probe 复用。
'let scan=()=>{try{let bb=el.getBoundingClientRect();if(!bb)return null;' +
'let cur=parseFloat(el.style.marginLeft)||0,base=bb.left-cur,worst=0,gd=0,mxR=0,mxs=``,ws=``;' +
// ok=有效左邻判定:垂直带重叠 + 位于 el 左侧 + 右缘不越过 el 右缘(越过的是整行级
// 包装/遮罩)。cR=内容右缘(子内容优先)——flex-1 盒子右缘紧贴徽章,盒子不算内容。
// v2.5 真机诊断:mx 仍被污染至紧贴(gap=0,724px 净空被吃光)——净空推算不可全信,
// 升档主路径改为"隐形试探"(渲染实测),gap 只作快速充分条件(只会保守不会误升)。
'let ok=r=>{try{return !!(r&&r.width&&r.top<bb.bottom-2&&r.bottom>bb.top+2&&r.left<bb.left&&r.right<=bb.right+2)}catch(_){return !1}};' +
// vis=视觉可见性过滤:opacity≈0/visibility:hidden 的结构性元素(隐形原生 select、
// 无障碍占位)不参与碰撞与净空——v2.6 真机诊断 mxs=SELECT. gap0:隐形 select 恰好
// 紧贴徽章左缘,试探升档被它误判碰撞(2026-09-01 用户截图+诊断)。
'let vis=sb=>{try{let cs=getComputedStyle(sb);return parseFloat(cs.opacity)>0.05&&cs.visibility===`visible`}catch(_){return !0}};' +
'let desc=sb=>{try{return sb.tagName+`.`+String(sb.className).split(` `).slice(0,2).join(`.`)}catch(_){return `?`}};' +
'let hit=(r,d)=>{try{if(ok(r)&&r.right>base){let ov=r.right-base;if(ov>worst){worst=ov;ws=d}}}catch(_){}};' +
'let cR=(sb,d)=>{let best=0;try{if(gd>200)return 0;let ks=sb.children;' +
'for(let c of ks){if(c===el)continue;if(!vis(c))continue;let cc=null;try{cc=c.getBoundingClientRect()}catch(_){cc=null}' +
'if(!ok(cc))continue;gd++;let v=d>0&&c.children.length?cR(c,d-1):cc.right;if(v>best)best=v}}catch(_){}return best};' +
'let walk=(node,d)=>{try{if(!node||d<0||gd>200)return;let ks=node.children;' +
'for(let sb of ks){if(sb===el)continue;let an=false;try{an=sb.contains(el)}catch(_){an=false}if(an)continue;' +
'if(!vis(sb))continue;gd++;let rr=null;try{rr=sb.getBoundingClientRect()}catch(_){rr=null}hit(rr,desc(sb));' +
'if(ok(rr)){let v=cR(sb,2)||rr.right;if(v>mxR){mxR=v;mxs=desc(sb)}}' +
'if(d>0)walk(sb,d-1)}}catch(_){}};' +
'let anc=el.parentElement;' +
'for(let L=0;anc&&L<6;L++){walk(anc,2);try{anc=anc.parentElement}catch(_){anc=null}}' +
'let cl=false;try{cl=el.scrollWidth>el.clientWidth+2}catch(_){cl=false}' +
'return{b:bb,w:worst,cl:cl,mx:mxR,mxs:mxs,ws:ws,sw:el.scrollWidth}}catch(_){return null}};' +
'let r=scan();if(!r)return;' +
'let cur=parseFloat(el.style.marginLeft)||0;' +
'let ml=r.w>0?Math.min(320,r.w+6):0;' +
'if(Math.abs(ml-cur)>1){try{el.style.marginLeft=ml?ml+`px`:``}catch(_){}}' +
// 全标签内容宽缓存:tier2 时 scrollWidth 即全宽(被裁剪也含溢出部分)。
'if(g1===2){try{ck.fw=r.sw}catch(_){}}' +
// 降档需确认:第一次测到(或被裁剪)只推让+250ms 后复查;复查仍重叠/裁剪才降紧凑。
'if(r.w>1||r.cl){' +
'if(ck.arm){ck.arm=0;if(r.w-cur>1||r.cl)g2(t=>Math.min(t,1))}' +
'else{ck.arm=1;if(!ck.pend){ck.pend=1;setTimeout(()=>{ck.pend=0;try{ck.current&&ck.current()}catch(_){}},250)}}' +
'}else{ck.arm=0;' +
// 升档:①快速充分条件——净空实测充足(gap≥need)直接升;②隐形试探——gap 不足或
// 不可信时,visibility:hidden 下渲染全标签,rAF×2 后判定。v2.8 判定改为渲染级:
// 成功 = 无裁剪 AND 碰撞带采样点无可见占用者(elementsFromPoint 层叠链中第一个
// "有效可见"元素是 el 祖先容器=空白;是别人=真碰撞)。隐形元素无论何种形态
// (自身透明/祖先透明/被裁剪/pointer-events:none 不参与 hit-test)都不在可见链上,
// 天然排除——v2.7 真机实证:vis() 只查自身样式,挡不住"祖先透明"的 select
// (mxs=SELECT. pf3);所有残余误判方向均为保守(保持紧凑),不会产生可见缺陷。
'if(g1===1&&r.w<=1&&!r.cl){let need=ck.fw?ck.fw-r.sw+6:0,clear=r.b.left-r.mx;' +
'if(ck.fw&&clear>=need){g2(2)}' +
'else if(!ck.pb&&Date.now()-(ck.pt||0)>Math.min(12e4,8e3*(1<<(ck.pf||0)))){' +
'ck.pb=1;ck.pt=Date.now();' +
'let fin=()=>{try{el.style.visibility=``}catch(_){}ck.pb=0};' +
'try{el.style.visibility=`hidden`}catch(_){}' +
'g2(2);' +
// vd=有效可见(自身+祖先链透明度/visibility);anc=n 是否 el 祖先
'let vd=n=>{try{let m=n;for(let i=0;m&&i<24;i++){let cs=getComputedStyle(m);if(!cs)return!0;if(cs.visibility!==`visible`)return!1;let op=parseFloat(cs.opacity);if(Number.isFinite(op)&&op<=0.05)return!1;m=m.parentElement}return!0}catch(_){return!0}};' +
'let anc=n=>{try{let a=el.parentElement;while(a){if(a===n)return!0;a=a.parentElement}return!1}catch(_){return!1}};' +
'let step=()=>{try{let q=scan();let bad=!q||q.cl;' +
'if(!bad){let bs=q.b;' +
'let pts=[[bs.left-3,(bs.top+bs.bottom)/2],[bs.left-1,bs.top+(bs.bottom-bs.top)*0.25],[bs.left-1,bs.bottom-(bs.bottom-bs.top)*0.25]];' +
'for(let i2=0;i2<pts.length&&!bad;i2++){let ch=null;' +
'try{ch=document.elementsFromPoint(pts[i2][0],pts[i2][1])}catch(_){ch=null}' +
'if(!ch||!ch.length)continue;' +
'let fv=null;' +
'for(let e2 of ch){if(e2===el||el.contains(e2))continue;if(vd(e2)){fv=e2;break}}' +
'if(fv&&!anc(fv)){bad=!0}}}' +
'if(!bad){ck.pf=0;try{ck.fw=el.scrollWidth}catch(_){}}' +
'else{ck.pf=(ck.pf||0)+1;g2(t=>Math.min(t,1))}}catch(_){ck.pf=(ck.pf||0)+1;g2(t=>Math.min(t,1))}fin()};' +
'try{requestAnimationFrame(()=>requestAnimationFrame(step))}catch(_){try{step()}catch(_){}}}}' +
'}' +
// 诊断(v2.8):构建期开关——`<skillRoot>/work/DEBUG` 存在才注入诊断代码(悬停任一
// 枚徽章尾部附 ‹zb› 行,含净空污染源 mxs/试探退避 pf;window.__zb 同值)。默认关闭,
// 界面干净;排查时创建文件+FORCE 重打即可。
(DBG ? ('try{ck.dbg=`t`+g1+` w`+Math.round(r.w)+(r.cl?`+clip`:``)+` gap`+Math.round(r.b.left-r.mx)+` sw`+Math.round(r.sw)+` mx`+Math.round(r.mx)+(r.mxs?` mxs=`+r.mxs:``)+` need`+(ck.fw?Math.round(ck.fw-r.sw+6):`-`)+` fw`+Math.round(ck.fw||0)+(ck.arm?` arm`:``)+(ck.pend?` pend`:``)+(ck.pb?` probe`:``)+((ck.pf||0)?` pf`+ck.pf:``)+(r.ws?` src=`+r.ws:``)+(window.__zspd?` spd=`+JSON.stringify(window.__zspd):``);el.title=`zbadge `+ck.dbg;' +
'let kc=el.children;for(let i=0;i<kc.length;i++){try{let tt=kc[i].getAttribute(`title`)||``;let jz=tt.indexOf(` ‹zb›`);if(jz>=0)tt=tt.slice(0,jz);kc[i].setAttribute(`title`,tt+` ‹zb› `+ck.dbg)}catch(_){}}}catch(_){}try{window.__zb=ck.dbg}catch(_){}') : '') +'};' +
// 分色(2026-09-01 用户定稿"更早警示"):剩余≥60 绿 / ≥50 蓝 / ≥30 橙 / <30 红。
'let C2=v=>v==null?null:v>=60?`var(--color-success)`:v>=50?`var(--color-blue-500)`:v>=30?`var(--color-warning)`:`var(--color-destructive)`;' +
'let s=[];' +
'if(!r||!r.visibleSnapshot){' +
'let q=((y?.snapshot?.quota?.limits??[])).filter(v=>(((v.number??v.unit)??0)>0)||((v.remaining??0)>0));' +
's=q.map(v=>{let T=((v.number??v.unit)??0);if(!(T>0))return null;let R=Math.max(0,Math.min(1,(v.remaining??0)/T)),P=100*R;' +
'return{color:C2(P)||`var(--color-usage-chart-4)`,key:`start`,label:`体验`,' +
'text:new Intl.NumberFormat(n,{maximumFractionDigits:0,style:`percent`}).format(R),' +
'tip:`体验套餐 `+new Intl.NumberFormat(n,{maximumFractionDigits:0,style:`percent`}).format(R)+(Number.isFinite(v.nextResetTime)?` · `+new Intl.DateTimeFormat(n,{month:`short`,day:`numeric`}).format(new Date(v.nextResetTime)):``)}}).filter(e=>e!==null);' +
'}else{' +
'let i=r.visibleSnapshot?.quota?.limits??[],a=' + finder + '(i,`TOKENS_LIMIT`,3,5),o=' + finder + '(i,`TOKENS_LIMIT`,6),g=r.visibleSnapshot?.mcpQuota?.aggregate??null,' +
'c=o&&Number.isFinite(o.nextResetTime)?new Intl.DateTimeFormat(n,{month:`short`,day:`numeric`}).format(new Date(o.nextResetTime)):void 0,' +
'w2=g&&Number.isFinite(g.nextResetTime)?new Intl.DateTimeFormat(n,{month:`short`,day:`numeric`}).format(new Date(g.nextResetTime)):void 0;' +
's=[a?{color:C2(' + mFmt[1] + '(a))||`var(--color-usage-chart-1)`,key:`fiveHour`,label:t.formatMessage({id:`sidebar.usage.plan.fiveHour`}),limit:a}:null,' +
'o?{color:C2(' + mFmt[1] + '(o))||`var(--color-usage-chart-2)`,key:`weekly`,label:t.formatMessage({id:`sidebar.usage.plan.weekly`}),limit:o,reset:c}:null,' +
'g?{color:C2(' + mFmt[1] + '(g))||`var(--color-usage-chart-5)`,key:`mcp`,label:t.formatMessage({id:`sidebar.usage.plan.mcp`}),limit:g,reset:w2}:null].filter(e=>e!==null)}' +
// g1=0 不卸载(wrapper 挂 hidden class)——el/RO 保持存活,探测恢复可达,档位不会冻结
'if(s.length===0)return null;' +
// ⚡ 速度展示已移至回合末尾(zSpdX,tnt 注入);工具栏不再渲染速度徽章。
'return(0,' + jsx + '.jsx)(' + errName + ',{c:(0,' + jsx + '.jsx)(' + jsx + '.Fragment,{children:[(0,' + jsx + '.jsx)(`span`,{ref:gr,className:g1===0?`hidden`:`inline-flex min-w-0 items-center overflow-hidden`,"data-testid":`chat-toolbar-plan-quota-group`,children:s.map(e=>(0,' + jsx + '.jsxs)(`span`,' +
'{className:`inline-flex h-7 shrink-0 cursor-default items-center gap-1 whitespace-nowrap px-1 text-ui-sm text-foreground-subtle`,' +
'onPointerEnter:()=>{w.current&&w.current(!1)},' +
'"data-testid":`chat-toolbar-plan-quota-`+e.key,title:e.tip??(e.label+` `+' + fmt + '(n,e.limit)+(e.reset?` · `+e.reset:``)),children:[' +
'(0,' + jsx + '.jsx)(`span`,{className:`inline-block shrink-0 rounded-full`,style:{backgroundColor:e.color,height:`6px`,width:`6px`}}),' +
'(0,' + jsx + '.jsx)(`span`,{className:g1===2?`inline`:`hidden`,children:e.label}),' +
'(0,' + jsx + '.jsx)(`span`,{className:`font-mono text-ui-sm tabular-nums`,children:e.text??' + fmt + '(n,e.limit)})]},e.key))})]})})' +
'}catch(_){return null}}' +
// ---- ⚡ 回合末尾速度行(zSpdX,注入 tnt 的回合 section children) ----
// 三行(v3.2,2026-09-05 用户逐字定稿):
//   ⚡ 本轮加权速度 28 tokens/s [16,886 tokens ÷ 608 秒]
//   ⏱ 单次均 46.8 秒 [608 秒 ÷ 13 次调用] = 首字 2.3 秒 + 生成 44.5 秒
//   🤖 GLM-5.3-Flash · 思考最高
// 数据:model-speed 钩子(Stop 主/UserPromptSubmit 兜底)写 last-speed.json,经
// 主进程 ipcMain.handle('zbadge:read-speed') → preload contextBridge → window.zbadgeSpeed。
// ttftSum/ttftN 来自应用 db.sqlite 的 model_usage 表(time_to_first_token_ms,按
// turnId 关联、输出tokens+耗时贪心配对,钩子侧完成);ttftN=0/旧格式 → 第二行退化为
// 仅均耗+次数。归因(真机诊断修订):tg.isLastTurn + 回合完成 + s4.ts≥startedAt。
// 读取:挂载即读+2s/6s 追读(Stop 写盘竞态)+30s 轮询+focus 刷新;全 try/catch,
// 根节点套错误边界类(errName)。
'function ' + sname + '({tg}){try{' +
'let[s4,S4]=(0,' + react + '.useState)(null);' +
'let RF=(0,' + react + '.useRef)(null),RT=(0,' + react + '.useRef)(0);' +
// 诊断(常驻,零 UI 成本):window.__zspd 记录桥/门控/读取时序,工具栏 DEBUG 悬停行回显
'let D;try{D=window.__zspd=window.__zspd||{};D.n=(D.n||0)+1;D.br=!!window.zbadgeSpeed;' +
'D.tg=tg?{id:tg.turnId,to:!!tg.timelineOnly,st:tg.latestAssistantTextRow?tg.latestAssistantTextRow.state:null,il:tg.isLastTurn===!0,sa:tg.startedAt||tg.header&&tg.header.startedAt||0}:null;' +
'D.h=Array.isArray(s4)?s4.length:-1;D.rs=`render`}catch(_){}' +
'(0,' + react + '.useEffect)(()=>{' +
'let t1,t2,iv;' +
'let f=()=>{try{let b=window.zbadgeSpeed;if(!b||typeof b.read!==`function`){try{D=window.__zspd=window.__zspd||{};D.rd=`nobridge`}catch(_){}return}let pr=b.read();if(pr&&pr.then)pr.then(j=>{try{if(Array.isArray(j)&&j.length){S4(j);try{D=window.__zspd=window.__zspd||{};D.rd=Date.now();D.hn=j.length}catch(_){}}}catch(_){}}).catch(()=>{try{window.__zspd&&(window.__zspd.rd=`rej`)}catch(_){}})}catch(_){}};' +
'let f2=()=>f();' +
'try{RF.current=f;f();t1=setTimeout(f,2e3);t2=setTimeout(f,6e3);iv=setInterval(f,3e4);window.addEventListener(`focus`,f2)}catch(_){}' +
'return()=>{try{RF.current=null;clearTimeout(t1);clearTimeout(t2);clearInterval(iv);window.removeEventListener(`focus`,f2)}catch(_){}}},[]);' +
'let st0=tg?tg.startedAt||tg.header&&tg.header.startedAt||0:0;' +
'if(!tg||tg.timelineOnly||!tg.latestAssistantTextRow||tg.latestAssistantTextRow.state!==`complete`){try{window.__zspd&&(window.__zspd.rs=`gate1:`+(tg?tg.timelineOnly?`to`:(tg.latestAssistantTextRow?tg.latestAssistantTextRow.state:`norow`):`notg`))}catch(_){}return null}' +
// 每轮保留(v3.3):s4=速度历史数组;按回合起点时间窗(±5s)匹配本轮回合的数据条目
// (渲染层 turnId 是 msg_ 域,与历史条目的 turn_ 运行时域不同源——DL-049,禁跨 ID 匹配);
// 单元无起点时间时退回 isLastTurn+最新条目。无匹配→节流追读(Stop/回填可能未写盘)。
'let H=Array.isArray(s4)?s4:null,e=null;' +
'if(H&&H.length){if(st0){e=H.find(x=>x&&Number.isFinite(x.startedAt)&&Math.abs(x.startedAt-st0)<=5000)||null}else if(tg.isLastTurn===!0){e=H[H.length-1]||null}}' +
'if(!e){try{if(Date.now()-RT.current>2500){RT.current=Date.now();setTimeout(()=>{try{RF.current&&RF.current()}catch(_){}},1200)}}catch(_){}try{window.__zspd&&(window.__zspd.rs=`gate2:nomatch`)}catch(_){}return null}' +
'try{window.__zspd&&(window.__zspd.rs=`shown`)}catch(_){}' +
'let VM={low:`低`,medium:`中`,high:`高`,max:`最高`};' +
'let totS=Math.round((e.ms||0)/1000),nc=e.calls??0,avgS=nc?(e.ms||0)/nc/1000:0;' +
'let c1=[(0,' + jsx + '.jsx)(`span`,{children:`⚡`}),(0,' + jsx + '.jsx)(`span`,{children:`本轮加权速度 `}),(0,' + jsx + '.jsx)(`span`,{className:`font-mono tabular-nums`,children:Math.round(e.weighted)}),(0,' + jsx + '.jsx)(`span`,{children:` tokens/s [`+(e.tokens||0).toLocaleString()+` tokens ÷ `+totS+` 秒]`})];' +
'let c2=[(0,' + jsx + '.jsx)(`span`,{children:`⏱`}),(0,' + jsx + '.jsx)(`span`,{children:` 单次均 `}),(0,' + jsx + '.jsx)(`span`,{className:`font-mono tabular-nums`,children:avgS.toFixed(1)}),(0,' + jsx + '.jsx)(`span`,{children:` 秒 [`+totS+` 秒 ÷ `+nc+` 次调用]`})];' +
'if(e.ttftN&&Number.isFinite(e.ttftSum)&&avgS>0){let a=e.ttftSum/e.ttftN/1000,b=Math.max(0.1,avgS-a);' +
'c2.push((0,' + jsx + '.jsx)(`span`,{children:` = 首字 `}),(0,' + jsx + '.jsx)(`span`,{className:`font-mono tabular-nums`,children:a.toFixed(1)}),(0,' + jsx + '.jsx)(`span`,{children:` 秒 + 生成 `}),(0,' + jsx + '.jsx)(`span`,{className:`font-mono tabular-nums`,children:b.toFixed(1)}),(0,' + jsx + '.jsx)(`span`,{children:` 秒`}))}' +
'let c3=[(0,' + jsx + '.jsx)(`span`,{children:`🤖`}),(0,' + jsx + '.jsx)(`span`,{children:` `+(e.model||`未知模型`)})];' +
'if(e.variant)c3.push((0,' + jsx + '.jsx)(`span`,{children:` · 思考`+(VM[e.variant]||e.variant)}));' +
'return(0,' + jsx + '.jsx)(' + errName + ',{c:(0,' + jsx + '.jsxs)(' + jsx + '.Fragment,{children:[' +
'(0,' + jsx + '.jsxs)(`span`,{className:`inline-flex select-none items-center gap-1 text-ui-sm text-foreground-subtlest`,"data-testid":`zbadge-turn-speed`,' +
'title:`本轮加权 TPS(Σ输出token÷Σ推理耗时) · `+(e.model||`未知模型`)+(e.variant?` · 思考`+(VM[e.variant]||e.variant):``)+` · `+new Date(e.ts).toLocaleString(),children:c1}),' +
'(0,' + jsx + '.jsxs)(`span`,{className:`inline-flex select-none items-center gap-1 text-ui-sm text-foreground-subtlest`,children:c2}),' +
'(0,' + jsx + '.jsxs)(`span`,{className:`inline-flex select-none items-center gap-1 text-ui-sm text-foreground-subtlest`,children:c3})]})})}' +
'catch(_){try{window.__zspd&&(window.__zspd.rs=`err`)}catch(_){}return null}}';

const call =
  '(0,' + jsx + '.jsx)(' + name + ',{config:' + mCfg[1] + (mStart ? ',start:' + mStart[1] : '') + ',intl:' + mIntl[1] + ',locale:' + mLocale[1] + '}),' + callSite;

if (s.split(defAnchor).length - 1 !== 1) fail(2, 'def anchor not unique: ' + defAnchor);
if (s.split(callSite).length - 1 !== 1) fail(2, 'call anchor not unique: ' + callSite);

const report = {
  ok: true, dryRun, file, component: name, i18nOk, i18nFile, upgradedFrom: wasPatched,
  discovered: { comp, jsx, react, resolver, finder, percentFn: mFmt[1], fmt, configVar: mCfg[1], intlVar: mIntl[1], localeVar: mLocale[1], startVar: mStart ? mStart[1] : null },
};

if (dryRun) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

// ---- 7. 写入 ----
let out = s.replace(defAnchor, def + defAnchor);
out = out.replace(callSite, call);
// ---- 7.5 回合末尾 ⚡ 注入(对话末尾,tnt section children 尾部) ----
// 自包含完整元素插入(DL-043:零括号塔)。锚点优先全文件唯一,否则限定
// group/assistant-turn 区域内唯一;仍不唯一即 fail(禁止盲打)。
const TAILROWS = ',e.assistantTailRows.length>0?';
const spdCall = ',(0,' + jsx + '.jsx)(' + sname + ',{tg:e})';
function countOf(str, needle) { let n = 0, i = 0; while ((i = str.indexOf(needle, i)) >= 0) { n++; i += needle.length; } return n; }
let tntScoped = false, tntAt = -1;
const trGlobal = countOf(out, TAILROWS);
if (trGlobal === 1) tntAt = out.indexOf(TAILROWS);
else {
  const gi = out.indexOf('`group/assistant-turn');
  if (gi >= 0 && countOf(out.slice(gi, gi + 40000), TAILROWS) === 1) { tntScoped = true; tntAt = out.indexOf(TAILROWS, gi); }
}
if (tntAt < 0) fail(2, 'turn tail anchor not unique (global count ' + trGlobal + '): ' + TAILROWS);
out = out.slice(0, tntAt) + spdCall + out.slice(tntAt);
report.tnt = { injected: true, scoped: tntScoped, anchorCount: trGlobal };
// 主进程/preload 注入(带整文件语法门,任一失败即中止——不产生半成品树)
report.aux = [applyAux(MAIN_REL, MAIN_SNIPPET, 'module'), applyAux(PRELOAD_REL, PRELOAD_SNIPPET, 'commonjs')];
try { fs.writeFileSync(path.join(assetsDir, file), out); } catch (e) { fail(3, 'write failed: ' + e.message); }
report.patchedBytes = out.length - s.length;
console.log(JSON.stringify(report, null, 2));
