---
name: model-speed
description: 测量和分析 ZCode 里各模型的输出速度（tokens/s、首字延迟 TTFT、纯解码速度）。当用户想测模型速度、对比模型快慢、查看 token 吞吐、问"为什么这么慢"、想实时显示每轮对话的耗时统计、或想跑模型输出基准测试时使用本 skill——即使用户只说"测速""这模型多快""每轮显示统计"也要触发。
---

# model-speed — ZCode 模型输出速度测量

三件事,全部基于 ZCode 自身的本地记录(`~/.zcode/cli/rollout/`,每次模型调用一行,含精确 `durationMs` 与 token 用量),不靠墙钟计时、不消耗额外模型 token:

1. **历史统计** — 一条命令出全量报告
2. **受控基准** — 标准化 prompt 横向对比模型
3. **每轮加权 TPS → zbadge 对话末尾 ⚡ 速度行** — 测速钩子在**回合结束时**(Stop 钩子,主)静默计算**刚完成的这一轮**加权 TPS,写入 `~/.zcode/zbadge/last-speed.json`(带 `turnId`);UserPromptSubmit 钩子为兜底(同值幂等重写,覆盖中断等 Stop 未触发场景)。由 zbadge 注入的**最新完成回合末尾**的 ⚡ 小行按 `turnId` 精确归因展示(不进入对话、模型零参与、零上下文开销)

环境要求:Node ≥ 18(`node --version` 确认)。脚本都在本 skill 目录的 `scripts/` 下,用绝对路径调用。

## 1. 安装每轮 TPS 统计(每台机器一次)

```bash
node <skill目录>/scripts/install.mjs            # 幂等安装 Stop + UserPromptSubmit 钩子
node <skill目录>/scripts/install.mjs --status   # 查看状态
node <skill目录>/scripts/install.mjs --uninstall # 移除
```

安装后需**完全退出并重启 ZCode 应用**才生效(桌面端 app-server 常驻,钩子配置仅进程启动时加载;headless `zcode -p` 每次新进程不受影响)。

- 钩子行为(静默版,v3.3):**Stop(回合结束)时读取 rollout 尾部,计算刚完成的这一轮**的加权 TPS,写入 `~/.zcode/zbadge/last-speed.json`(原子替换,带 `turnId`);UserPromptSubmit 时最后一组仍是刚完成轮,同值幂等重写。无任何对话内输出
- **为何 v3.1 改用 Stop**:渲染侧展示位置在"回合末尾",数值必须归属**刚完成的当前轮**——Stop 时刻尾部最后一个 turnId 组就是它;旧版"Stop 会把正文挤进折叠区"的顾虑只针对 v2 注入式设计,静默写文件后已失效
- 展示由 zbadge 技能的回合末尾 ⚡ 三行小卡完成(**每轮保留**,历史各轮各自显示);卸载 zbadge 不影响本钩子继续写状态,反之亦然
- **速度历史**:每次同时写 `~/.zcode/zbadge/speed-history.json`(数组,≤50 轮/7 天窗)——当前轮 upsert(turnId 或起点 ±3s 判同轮)+ 从 db 回填历史缺失轮;渲染侧按回合起点时间窗匹配,实现跨轮对比
- **按轮聚合用 `turnId`**:rollout 每条记录带 `turnId`,同轮完全一致;老记录缺 turnId 时退回"最后一条用户文本尾部指纹"法(此时 state 的 `turnId` 为 null)
- **TTFT(首字延迟)来自 db.sqlite**:rollout 记录没有 TTFT 字段;应用把每次调用的 `time_to_first_token_ms` 入库到 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表(`turn_id` 与 rollout 的 turnId 同源)。钩子只读打开该库,按 turnId 取本轮回合的行,与 rollout 可用调用按"输出 tokens 相等 + 耗时最接近(≤3s)"贪心配对——两端 `duration_ms` 计时口径差 ~40-70ms(db 恒偏大),精确相等永不命中。库打不开/无匹配 → `ttftSum/ttftN` 为 null,展示优雅降级

## 加权 TPS 定义(写入徽章 title 与本文档)

> **加权 TPS = 该轮全部 main 角色模型调用的输出 token 总和 ÷ 这些调用的推理耗时总和**
> 即 `Σ outputTokens ÷ Σ durationMs × 1000`(单位 tokens/s)。

- **统计口径**:仅计 role=main 的模型调用,且单调用输出 ≥50 tokens(过滤探活/标题生成等微调用)
- **"加权"的含义**:按 token 量权衡——长调用对结果贡献大、短调用贡献小;区别于"各调用 TPS 的算术平均"
- **单调用 TPS** = 该调用 `outputTokens ÷ (durationMs/1000)`,含首字等待(TTFT);纯解码速度需扣除 `timeToFirstContentMs`,本徽章不含
- **数据源**:rollout(`model-io-<sessionId>.jsonl`,加权 TPS/tokens/耗时)+ db.sqlite `model_usage`(TTFT;`reasoning_tokens` 字段亦可查但暂未展示)
- **展示**:state 键——`weighted`(加权 TPS)、`tokens`/`ms`/`calls`(Σ输出÷Σ耗时÷次数)、`ttftSum`/`ttftN`(Σ首字延迟/配对数,首字均=ttftSum÷ttftN,生成均=均耗−首字均)、`model`(主导调用 `modelId`——注意新 schema 字段名是 modelId 不是 id,取错会拿到思考档位)、`variant`(思考档位 low/medium/high/max)、`ts`、`turnId`
- **四个数字的关系**:`单次均耗 = 首字均 + 生成均`;`Σ耗时 = 单次均耗 × 次数`(中位数≠均值,长调用拉高总和);`首字 = 排队+网络+预填充(读全部上下文),不产出 token;GLM 思考档位的思考时间也计入首字(动笔前想)`
- **两份 SKILL.md 同步约束**:本节口径与 zbadge SKILL.md 的 ⚡ 三行展示口径互为镜像,修改任一方须同步另一方

## 2. 历史统计

```bash
node <skill目录>/scripts/zcode-speed.mjs report
```

输出按模型分组：中位 tok/s、加权均值、P90、纯解码速度、TTFT 中位。只统计 role=main 且输出≥50 token 的调用（剔除标题生成等杂项）。

## 3. 受控基准（横向对比模型用）

```bash
node <skill目录>/scripts/zcode-speed.mjs bench            # 生成带唯一标记的 prompt
node <skill目录>/scripts/zcode-speed.mjs bench --collect  # 用户跑完后收集统计
```

流程：`bench` 打印 prompt → 用户在 ZCode 新会话选好模型粘贴运行（每模型 3~5 次）→ 全部跑完 `--collect` 出对比表。标记通过"最后一条用户消息含标记"识别，同会话连跑、历史残留标记都能正确处理。

## 指标含义（向用户解释时用）

核心公式：**单次总耗时 ≈ TTFT + 输出 token 数 ÷ 纯解码速度**

| 指标 | 含义 | 适用场景 |
|---|---|---|
| 模型耗时（N 次调用） | 该轮全部模型调用时长之和（思考+生成），不含工具执行与等待，故与界面"已工作"的墙钟时间不同属正常 | 一眼看出速度口径；调用次数多时与墙钟差距大 |
| 中位 tok/s | 典型单次调用的端到端速度（含 TTFT） | 反映日常短调用的体感 |
| 加权 tok/s | Σtokens ÷ Σ时间，长调用权重大 | 长期有效吞吐，agent 场景最贴近 |
| 纯解码 tok/s | 扣除 TTFT 后的流式速率 | 长文生成的稳态速度；模型对比最公平 |
| TTFT | 首字延迟（含 prefill、排队） | 交互体感、短调用密集的 agent 循环 |

两个常见解释要点：

- 中位明显低于纯解码是正常的：短调用里 TTFT 占比大，不是模型"变慢"。
- 思考档位（low/high/max）不改解码速率，只影响动笔前想多久：预算越高 TTFT 和总耗时越长（GLM-5.3 实测 high→16k、max→32k 思考 token）。简单任务用低档更快更省，复杂推理再用高档。
