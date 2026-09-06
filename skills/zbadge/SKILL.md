---
name: zbadge
description: 在 ZCode 桌面应用的聊天工具栏中、上下文容量环左边,常驻显示"5 小时 Prompt 池"、"每周额度"、"ZCode MCP"三个剩余百分比徽章(自动刷新、按剩余量分色、空间不足自动降档);并在最新完成回合的回复末尾显示"⚡ 本轮加权 TPS"速度小行(Stop 时机计算、turnId 精确归因)。带计划任务自动恢复。触发时机:用户提到额度徽章/速度徽章/恢复/ZCode 更新后徽章消失,或 /skill zbadge。
---

# zbadge(P0 加固重建版,2026-08-30)

> ⚠️ 本技能向 ZCode 唯一渲染进程注入代码。上一代曾因一个语法错误导致整个应用白屏循环假死(P0,DL-037)。重建版全部隔离措施见下,**修改注入代码前必读本文件"安全架构"**。

## 安全架构(P0 复盘产物,不可省略)

1. **错误边界**:注入块以错误边界类 `zQuotaBadgeErr extends react.Component` 开头,包住全部徽章输出——组件任何渲染/副作用异常只损失徽章,应用主体不受影响。
2. **渲染体全 try/catch**:组件 render 体整体 try/catch,异常返回 null;所有 effect 内逻辑分别 try/catch。
3. **无全局监听滥用**:全局 pointermove 已移除(P0 头号嫌疑);仅保留徽章局部 pointerEnter、window focus、visibilitychange、60s interval。
4. **杀开关**:`<skillRoot>/DISABLED` 文件存在 = 全线停用(auto-repatch 直接退出、trampoline 不跑、用户侧还原用 rollback)。**紧急停止 = 创建此文件 + 重启 ZCode**;彻底卸载 = rollback.ps1 还原 asar + 删任务。
5. **自动化自注销**:计划任务入口 trampoline.vbs 放在 `~/.zcode/zbadge/`(独立于技能目录)——技能目录被删时,trampoline 自动注销任务,静默退出,**不会产生弹窗**(上一代 P0 的弹窗风暴即源于此)。
6. **回滚快照**:每次打补丁前,`work/app.asar.unpatched` 都从"当前版本干净树"重新打包刷新;`rollback.ps1` 一键还原。
7. **交付验证链**:语法校验(node --check)不过 → 不打包;verify-pack(文件数/unpacked 清单/包内标记)不过 → 不安装;安装后 check.js 复核哈希;`stale-process` 状态提示"关窗重开≠重启"(DL-023)。

## 组件行为

```
● 5小时 87%  ● 每周 90%  ● ZCode MCP 100%   ◍  [模型] ...      ← 工具栏(3 徽章)
    …助手回复正文…
    ⚡ 42 tokens/s                                          ← 最新完成回合末尾
```

- **⚡ 回合末尾速度行(v3.3,2026-09-05 三行定稿+每轮保留)**:展示位置在**最新完成回合的回复末尾**(回合 section children 尾部、操作栏 PJ 之后的独立小卡),**不在工具栏**(v3.0 工具栏第 4 徽章形态已废弃)。三行(用户逐字定稿):
```
⚡ 本轮加权速度 28 tokens/s [16,886 tokens ÷ 608 秒]
⏱ 单次均 46.8 秒 [608 秒 ÷ 13 次调用] = 首字 2.3 秒 + 生成 44.5 秒
🤖 GLM-5.3-Flash · 思考最高
```
  **加权 TPS 口径以 model-speed SKILL.md 为唯一权威**。`ttftSum/ttftN` 由钩子从应用 db.sqlite 的 model_usage 表按 turnId 采集(time_to_first_token_ms,与 rollout 可用调用按"输出tokens相等+耗时最接近≤3s"贪心配对——两端计时口径差 ~40-70ms,精确相等永不命中),`ttftN=0` → 第二行退化为仅均耗+次数;`variant`→思考强度中文映射(low 低/medium 中/high 高/max 最高,未知原样)。**每轮保留(v3.3)**:数据源改为 speed-history.json(数组,≤50 轮/7 天窗),zSpdX 按**回合起点时间窗 ±5s** 匹配本轮回合条目(渲染层回合 turnId 是 msg_ 消息域 ID,与条目的 turn_ 运行时域不同源,禁止跨 ID 匹配——DL-049);单元无起点时间时退回 isLastTurn+最新条目;无匹配→节流追读(Stop/回填可能未写盘)。读取经 **IPC 兜底链**:渲染进程实测无 fs(nodeIntegration:false+contextIsolation+sandbox:true),补丁三个注入点——①渲染块(工具栏组件+回合末尾 zSpdX);②out/main/index.js 尾追加 ipcMain.handle('zbadge:read-speed') 只读通道(ESM 动态 import,64KB 上限);③out/preload/index.cjs 尾追加 contextBridge 暴露 window.zbadgeSpeed。②③以 `;/*zbadge-patch*/` 标记追加/截断逆转,各过整文件语法门(module/commonjs)。**注入点**:tnt 内锚点 `,e.assistantTailRows.length>0?`(全文件唯一计数断言,不唯一即 fail 拒打),插入自包含完整元素 `,(0,$.jsx)(zSpdX,{tg:e})`——零括号塔拼接(DL-043);逆转按注入字面量正则移除。修改 turn-stats 口径与展示口径须两份 SKILL.md 同步。

- **数据源**:个人/团队套餐走 `codingPlanUsageRemaining` 通道(5 小时=`TOKENS_LIMIT,unit3`、每周=`unit6`、ZCode MCP=快照独立字段 `visibleSnapshot.mcpQuota.aggregate`,勿用 TIME_LIMIT,5,1);体验套餐回退 `startPlanBalance` 通道(单枚"体验"徽章,`remaining/(number??unit)`,chart-4 色);API 方式两通道皆空 → 隐藏(正确行为)。
- **自动刷新多通道**:徽章 pointerEnter / window focus / visibilitychange → 礼貌 onAccess(应用自身 60s TTL);每 60s 强制兜底(回退链 onEntitlementRefresh→onAccess→start.onAccess);25s 自节流;effect 依赖=回调存在性布尔 p(DL-021,不能 [])。全局 pointermove 已移除(P0 嫌疑)。
- **圆点分色**(2026-09-01 用户定稿"更早警示",按剩余%):≥60 绿 success / ≥50 蓝 blue-500 / ≥30 橙 warning / <30 红 destructive;null 回退 chart-1/2/5/4。
- **排布自适应**:徽章行 wrapper `min-w-0 overflow-hidden`(可收缩);ResizeObserver 实测宽度三档降级(≥340 全显 / 紧凑圆点+百分比 / <120 隐藏,滞回 60px);**碰撞检测 v2**(2026-08-31 深夜定稿,沙盒 9 断言全过):composer 底行里徽章 parentElement 是 GROUP(`span.flex.min-w-0.shrink.overflow-hidden`),v1 只扫 GROUP 直接孩子,而欢迎页的"完全访问/变更确认"触发器在左侧容器内**向右溢出**盖住徽章头部(实测 24px)——不在 GROUP 孩子里,v1 的 worst 恒 0 永不触发。v2 改为:从 el 起 **6 级祖先、每级兄弟矩形+向下探 2 层**做几何相交(溢出源常是窄/0 宽盒的子元素,必须下探;**必须带垂直带检查** `r.top<b.bottom-2&&r.bottom>b.top+2`,否则文档上下其它行会误报,实测把 margin 推到 320 上限);>60px 直接降紧凑;小重叠先 `margin-left=重叠+6`(上限 320)推让并 150ms 后复查一次,残留 >1px 再降紧凑(推让会被 GROUP 的 shrink 链吃掉,纯推让清不掉小重叠,紧凑档三枚百分比全保留、无遮挡无截断)。
- **碰撞复查时机(v2.8,2026-09-01,真实 RO 沙盒 21 断言全过)**:`ck.current`(25s 节流共享)在挂载后 80ms、**真实 ResizeObserver(观察 el + 向上 4 级祖先,150ms 去重节流)**、刷新节流通过时执行。RO 绝不按宽度降档;降档只走 ck 双确认(arm→250ms 复查)。**升档主路径=隐形试探+渲染级判定(v2.8 终版)**:tier1 干净且净空快速条件不满足时,`visibility:hidden` 渲染全标签→rAF×2 后,成功判定=**无裁剪 AND 碰撞带采样点无可见占用者**——在徽章左缘外 3 点调 `document.elementsFromPoint`,层叠链中第一个"有效可见"元素(自身+祖先链透明度/visibility,vd)若是 el 祖先容器=空白,是别人才算放不下。隐形元素无论何种形态(自身透明/祖先透明——v2.7 真机实证 vis() 只查自身挡不住祖先透明的 select、被裁剪、pointer-events:none)都不在可见命中链上,天然排除;所有残余误判方向均为保守(保持紧凑)。试探失败指数退避(8s×2^失败,上限 120s)。**悬停诊断=构建期开关**:`work/DEBUG` 文件存在才注入(每枚徽章 title 尾部 `‹zb› t/w+clip/gap/sw/mx/mxs/need/fw/arm/pend/probe/pf/src`,window.__zb 同值),默认干净;排查时创建文件+FORCE 重打。隐藏档无设置路径;MutationObserver 禁止;改动前先跑 `zbadge-harness.html`(10 场景,含祖先透明 select)。

## 首次安装(全新机器)

假设技能已位于 ~/.agents/skills/zbadge(仓库 install.ps1 或手动复制)。让用户对 ZCode 说「安装 zbadge」,然后按序执行:
1. `node scripts/auto-repatch.js`——全流程:提取 asar→动态锚点发现→注入→语法门→verify-pack→应用(非管理员会经 run-elevated.ps1 弹一次 UAC)。安装目录非默认位置时先设环境变量 ZCODE_INSTALL_DIR。
2. 提权运行 `scripts/install-autopatch-task.ps1`(管理员 PowerShell)——自动生成 ~/.zcode/zbadge/trampoline.vbs 并注册 10 分钟自愈任务 ZbadgeAutoPatch。
3. 提醒用户彻底重启 ZCode(含托盘)加载补丁;随后 model-speed 的钩子也会随重启生效。

## 常规运维

- 状态:`node scripts/check.js`;立即恢复:`MSYS_NO_PATHCONV=1 schtasks /Run /TN ZbadgeAutoPatch`;日志:`work/auto-repatch.log`
- **强制重打(免 UAC)**:任务 RunLevel=Highest 但无法传参——创建 `work/FORCE` 文件(内容任意)后 `schtasks /Run`,auto-repatch 视同 `--force`,成功应用后自动删除该文件;失败则保留,下个 10 分钟周期自动重试
- 紧急停止:`echo. > <skillRoot>/DISABLED` + 重启 ZCode(徽章消失但应用正常)
- 彻底卸载:提权跑 `rollback.ps1` 还原 asar → 删任务 `schtasks /Delete /TN ZbadgeAutoPatch /F` → 从 `~/.zcode/cli/config.json` 的 `hooks.events.SessionStart` 里**仅移除 zbadge 自己的 hook 条目(hook-session-start.js)**,**不要清空整个 hooks 配置**——UserPromptSubmit 下的 model-speed 钩子是第三方技能的,删了会连带废掉 ⚡ 速度徽章的数据源;可删技能目录(trampoline 会自动注销任务,无弹窗)
- 重装任务:提权跑 `install-autopatch-task.ps1`(任务入口指向 `~/.zcode/zbadge/trampoline.vbs`,独立于技能目录)
- 逻辑改动先做**本地窗口验证**:`~/.zcode/workspace/default/zbadge-harness.html`(1:1 复刻 composer 底行,内置新旧碰撞逻辑对比 + 60px 缺口/极端/恢复/宽屏四场景断言,浏览器打开即跑)

## 关键约束(历史血泪,详见 DEBUG-LESSONS DL-013/021/022/023/037)

- patch.js 不硬编码 minified 标识符/文件名;注入块起点=错误边界类,终点=defAnchor,逆转按最早匹配移除
- asar extract 不写 unpacked 二进制,重打包前必须合并安装目录 `app.asar.unpacked/`
- 回滚基线只作 rollback,构建源永远是当前已安装 asar
- 提权/跨 shell 操作用 -File 脚本 + done-marker 验证,不用内联命令
- 已打过补丁的安装升级功能:走 `--force`(或 revert→re-inject)
