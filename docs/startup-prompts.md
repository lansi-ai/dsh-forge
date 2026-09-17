# 启动咒语 Preset（新会话复制即用）

> **用途**：开新 AI 会话时，复制下面对应版本发送，即可激活项目规则约束（对话模式无自动注入，靠本条咒语注入）。
> **依赖**：[`docs/PROJECT-RULES.md`](PROJECT-RULES.md)（权威规则）+ [`docs/active-context.md`](active-context.md)（当前看板）——均已就位。
> 发送后可要求 AI 先复述：① 当前看板焦点 ② 本任务分级（A/B/C）③ 完成时必更新看板 + 给 commit 指令，作为契约确认。

---

## 标准版（新开发任务）

> 开始开发。先读 docs/PROJECT-RULES.md 和 docs/active-context.md，严格按其中 workflow 执行；
> 先确认本任务分级（A/B/C），完成时更新看板（docs/active-context.md，仅 MD）并给 commit 指令。

## 轻量版（小修小补 ≤3 文件 / dogfood bug）

> 修复问题。先读 docs/active-context.md 与 docs/dogfood-issues.md（或 docs/pitfalls.md 对应坑号），
> 按 C 类轻量流程执行，完成后登记坑档（当日批次末可合并）并给提交指令。

## 续接版（接上次进度）

> 继续上次进度。先读 docs/active-context.md 看板接续，再读 docs/PROJECT-RULES.md 确认约束，
> 按看板「下一步即时行动」推进，完成时更新看板并给 commit 指令。

## 排障版（处理报错 / 崩溃）

> 排查问题。先读 docs/active-context.md 与 docs/pitfalls.md（grep 坑号），按 docs/PROJECT-RULES.md §5 字典索引定位；
> 修完按场景 E 沉淀坑档（docs/pitfalls.md，四段式）并更新看板，最后给 commit 指令。

## 上游升级版（跟进 @deepseek-ai 新版本）

> 执行上游升级检查。按 docs/PROJECT-RULES.md §3「上游新版本」与 docs/upstream-migrations.md 的 SOP 执行；
> 判据源 = GitHub releases，破坏性变更禁自动升级；完成后登记迁移台账并按 [TODO] 清单人工同步。

---

*维护：随规则演进同步更新（PROJECT-RULES.md §3「规则演进」）。*