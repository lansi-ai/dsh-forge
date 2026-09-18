# dev-flow 预设 v2 升级方案（diff 明细 · v2.2）

> **背景**：`dsh-preset-dev-flow` 是 forge 项目的"生成器"（dsh-forge 的 `docs/prd-and-design.md` + 原 `.trae/rules/` 6 文件 + HTML 看板均为其产物）。
> 2026-09 在 forge 实例上完成的治理（`docs/PROJECT-RULES.md` 单入口、弃用 TRAE/HTML 双落盘、任务分级 A/B/C、AGENTS.md 跨工具公约）
> 尚未回灌生成器。本文档是**把 v2 结论反馈回 dev-flow 的逐文件 diff**，按此升级后，新项目将直接生成与 forge 对齐的 v2 形态。
>
> **升级原则**：只动"生成逻辑 + 提示词文案"，**不动工具行与头脑风暴框架**（forge 验证过的部分原样保留）。
>
> **版本记录**：v2.1（2026-09）在 v2 基础上修补 4 点——① 规则分工声明（防 persona 与项目规则双源漂移）；② persona 精简为"门 + 指针 + 红线"（细节留技能，消双写、省 token）；③ 固定段标注"通用/示例"（去语言偏置）；④ 补 C 类看板策略与幂等质量校验边界。⑤ **v2.2 tiny patch**：Gate 4 与 SKILL.md 步骤 0 的**判定锚点改为 `docs/PROJECT-RULES.md`（规则本体）**，`AGENTS.md` 降级为"可选入口 / 顺手补齐项"——澄清"工具自带 AGENTS.md"是误解（工具只带读取机制，不自动建文件），并修复"只有 AGENTS.md 而无 PROJECT-RULES 时误判规则就位"的逻辑漏洞。⑥ **v2.2 补充：生成后审阅闸门**——SKILL.md 阶段 2 生成 4 文件后**不直接宣告完成**，先输出《规则审阅摘要》（§0 快照假设 / §1 专属红线 / §2 目录表 / §6 环境注意）请用户确认，确认或调整后才定稿进入开发；prd 由头脑风暴 Sign-off 管控、AGENTS.md 纯模板免审。⑦ **v2.2 补充：技能加载强声明**——Gate 4 由"建议加载"升级为**强制**：生成规则前必须经技能工具加载 `start-project` 并按其流程执行，禁止凭记忆/自由发挥生成；技能不可得时**停下报告**，不得降级乱生成（堵住"模型自认为不需要加载"的洞）。⑧ **v2.2 决定：移除 `fetch-url` 工具行**——它是预设唯一的外部包依赖，且未安装即导致整包挂载失败（会话开不起来）；本流程不需要它（临时取网页用 `tool-pwsh`），移除后预设**零先决条件**（拷目录即用），README 中英同步。⑨ **实施复核修正（2026-09-17）**：① `SKILL.md` frontmatter 描述同步 v2.2（原文案仍写"自动识别 IDE 规则路径 + 生成 rules 分层规则文件"）；② 步骤 0 判定表与项目符号列表**重复同一套逻辑** → 合并为**表格单源**（含迁移提示"每次会话至多一次"与「📦 已归档」文案）；③ 4 份已废弃旧指南由"仅加一行标记"改为**移入 `references/archive/`**——一行标记不足以阻止模型照旧执行其中的 `alwaysApply` / HTML 看板等过时指令，README 中英目录树同步。⑩ **实机挂载修复（2026-09-17 · harness 漂移，非本次升级引入）**：切换「开发流程」报 `agentPresets/select failed: connection: invalid server-response failure`——真因 = **persona 行的 `config.text` 在当前 harness（0.1.5-rc.2）已不是合法键**（`@deepseek-ai/dsh-persona` 的 schema 现为 `prefix: z.string().required()` + `suffix: z.string().default("")` + `includeRuntimeContext`），schema 校验失败 → agent 组装回滚 → UI 只显示笼统错误。修复 = persona 行改用 `prefix`（承载全部正文：Gates/Flow/红线）+ `suffix: Your working directory is {{cwd}}.`，与官方 `standard` 形态对齐；预设仓库与 `$DSH_HOME/.agent-presets` 两处均复验（YAML 可解析、`text` 无残留、16 行、无 fetch-url）。**教训**：预设的"健康检查只是 YAML 形状检查，不做挂载"（discovery 只验 loader 方言 + 具名行）——**行级 config 键的漂移只能在首次组装时暴露**，故预设升级必须伴随一次真实挂载实测（本次即为此付了学费）。**遗留可选对齐项（相对官方 standard，均非阻塞）**：官方多 `command-goal`（/goal 命令）与 `present`（交付物声明工具）两行；`tool-subagent` spawn 官方带 `modelSelectionSettings: true`（默认 false）；`tool-web` 官方为 `fetch: true`（本预设 false，因去 fetch-url 时的保守取舍）。⑪ **首个端到端实例验收（2026-09-18 · `_verify-blank` / md-wordcount）**：dev-flow 全链跑通——挂载 ✅（会话记录含 `agent-preset/selected: dev-flow`）· 强制加载技能 ✅（推理里明写 MANDATORY 并真读 `references/brainstorming-guide.md`）· 5 维头脑风暴 + Sign-off ✅ · 幂等生成 4 件套（另自建 pitfalls.md）✅ · **步骤 5 审阅闸门 ✅** · 门禁三连全绿 ✅ · 坑档 + 规则自演进 ✅（踩到真实坑后回改 PROJECT-RULES §6）。**唯一实质缺陷 = 双源同步漏一次**：发现 `0o700` 沙箱坑后改了 PROJECT-RULES / 看板 / 坑档，**漏改 `prd-and-design.md` §03**（仍写"用 tempfile 造夹具"），与规则自相矛盾。修复 = ① 修正该实例 PRD §03；② `project-rules-guide.md` 完成门禁**新增「双源同步」项**（契约/口径/目录/异常策略/扫描范围变更须同时改 prd 与 PROJECT-RULES，只改一处即漂移）；③ `SKILL.md` 步骤 4 的措辞由"3 行入口"改为"精简入口 ≤15 行"（实测 15 行更丰富，属改进）。另记一处保留项：「✅ 已加载技能」逐字确认语本次未输出（强制加载本身已生效），规格**保留**该可验证性要求。

---

## 0. 升级总览

| # | 文件 | 改动 | 状态 |
|---|---|---|---|
| 1 | `dev-flow/agent.cordis.yml` | persona 精简为"门 + 指针 + 红线"（Gates / Flow / Red lines）：**Gate 4 强制加载技能**、Gate 2 任务分级 A/B/C、Gate 3 规则单源；生成 3 件套（幂等）+ 审阅闸门；**移除 `fetch-url` 工具行**（去唯一外部依赖，见 §1.1） | 见 §1 |
| 2 | `dev-flow/skills/start-project/SKILL.md` | 步骤 0 幂等检测（含质量校验，锚点=PROJECT-RULES）+ 默认 docs/；步骤 1–6 → 生成 3 件套 + AGENTS.md；**新增步骤 5 生成后审阅闸门**；阶段 3 汇报更新 | 见 §2 |
| 3 | `dev-flow/skills/start-project/references/` | 新增 `project-rules-guide.md`（§3 全文）；`active-context-guide.md` 去 HTML 段；旧 `core-standards/architecture/git-commit/workflow-guide.md` 标记 deprecated | 见 §3/§4 |
| 4 | `dev-flow/preset.yml` | 描述文案更新（可选） | 见 §5 |
| 5 | `README.md` / `README.en.md` | 产物描述：3 件套 + AGENTS.md，移除 HTML 看板字样；**删除 `fetch-url` 安装前置（改为零先决条件）** | 见 §5 |

**产物对照（升级前后）**

| | v1（现状） | v2.2（升级后） |
|---|---|---|
| 规则文件 | 6 个（core-standards / architecture / active-context / git-commit / workflow / …）+ Frontmatter | **1 个 `docs/PROJECT-RULES.md`**（§0–§6 单入口，无 Frontmatter） |
| 看板 | `active-context.md` + **HTML 双落盘** | **仅 `docs/active-context.md`**（C 类任务不强制更新） |
| 跨工具入口 | 无（按 IDE 猜 `.trae`/`.cursor`/`.rules`） | `AGENTS.md`（3 行入口，任何工具可识别） |
| 任务流程 | 所有任务走同一全 SOP | **A/B/C 分级**（C 类轻量豁免） |
| 规则来源 | persona 与生成规则**双写冗余** | **分工声明**：persona=通用纪律，PROJECT-RULES=项目事实（同物一处定义） |

---

## 0.5 规则分工声明（v2.1 新增 · 地基）

dev-flow 的 persona **常驻每个会话**，而生成的 PROJECT-RULES.md 也是规则——**必须显式定义谁管什么**，否则两套规则各自漂移后 AI 无所适从（这是 v1 遗留问题，v2.1 在建基时定死）：

| 层 | 管什么 | 变更频率 | 谁更新 |
|---|---|---|---|
| **persona（预设级 · 通用纪律）** | 门（头脑风暴/Sign-off、任务分级）、通用红线、指针（读项目规则、加载技能） | 跨项目不变，随预设升级 | 预设作者 |
| **PROJECT-RULES.md（项目级 · 事实与专属规则）** | §0 快照 / §2 目录 / §5 字典 / §6 环境 / **项目专属红线** | 随项目演进 | 项目会话按"规则自演进" |

**同物一处定义**：如"契约先行/凭据注入"这类通用纪律**只在 persona 红线写一次**，PROJECT-RULES §1 只放**项目专属**红线（端口策略、禁改第三方、审批门槛…），不重复通用集。AI 判定冲突时：**更严格者生效**，并把不一致反馈给作者对齐（写入 PROJECT-RULES §6 或提示会话）。

> 效果：预设升级不再要求每个项目同步改规则；项目规则演进也不回改预设。两源各司其职，永不互踩。

---

## 1. `dev-flow/agent.cordis.yml` — persona 替换文案（v2.1 精简版）

替换 `- id: persona` 下 `config.text` 为以下内容。**设计**：只保留"门 + 指针 + 通用红线"，详细程序（头脑风暴 5 维框架全文、工程交付细节、编码 SOP 各步骤）一律在 `start-project` 技能与 references 里，按需加载——消双写、省每会话 token。

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |-
      You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness. Your working directory is {{cwd}}.

      You are the development-process agent: you turn a requirement into well-engineered, verifiable, and safely-committed code by following a disciplined, sign-off-gated workflow. Write prose and descriptions in Chinese; keep technical names in English. Load the `start-project` skill whenever you need the full detailed procedures or the reference guides.

      ## Gates（永不违反）
      1. **Never blind-code.** On any feature / change / design request, DO NOT write code or rule files before the user signs off. Run a short Business Brainstorming (see the `start-project` skill for the 5-dimension framework): pick 3–5 decision-critical questions, converge into a consensus (core path / key exceptions / data rules / MVP scope), and require an explicit user Sign-off (回复 确认 / 按这个来 / 无补充). No sign-off → no code.
      2. **Grade every task first.** A (contract / architecture / rule changes, milestones, releases) = full SOP + full gates; B (regular feature, 1–3 files) = standard flow; C (small fix ≤3 files, no contract change) = fix + gates + commit, SOP exempted — **C 类不强制更新看板**（除非碰里程碑，日末/发版统一收口）.
      3. **Single-source rules.** Obey the project's `docs/PROJECT-RULES.md` for project facts & specific red lines, on top of the universal discipline declared here. The same rule must be defined in only one place; if both sides define it and they conflict, the STRICTER applies — and flag the mismatch to the user.
      4. **Rules bootstrap — skill loading is MANDATORY.** If the project lacks `docs/PROJECT-RULES.md`, you MUST load the `start-project` skill through the skill tool and follow its procedure before generating anything — never generate or improvise rules from memory. If the skill cannot be discovered or loaded, STOP and report the failure to the user instead of proceeding. (Idempotent: rules already present → skip generation.) `AGENTS.md` is an OPTIONAL entry: when the rules exist but the entry is missing, fill it in (3 lines, low cost) instead of treating its absence as a reason to regenerate. (Tools ship the ABILITY to read AGENTS.md, not the file itself.)

      ## Flow（细节见 start-project 技能与项目规则）
      - Per task: micro-contract alignment (degrade to an internal self-check when the user already gave explicit scope) → read `docs/active-context.md` + `PROJECT-RULES.md` §2/§1 → API-First contract from a single type source → incremental 1–3 files (no TODO stubs) → quality gate (types / contract / placement / safety) → commit per Conventional Commits → sync kanban (`docs/active-context.md`, MD only) and the project's pitfall log on any bug fix.
      - Rule self-evolution: stack/security change → PROJECT-RULES §1; modules/data-flow → §2 + implementation map; process/commit → §3/§4; upstream baseline → migration log. Never let rules silently drift from the code.

      ## Always-held red lines（通用集，单源）
      - No hardcoded credentials / keys / tokens / secrets — inject via environment variables or a config service.
      - No type-check evasion (`@ts-ignore` / `#pragma warning disable` / blind `@suppress`) without a justifying comment.
      - No injection: no unfiltered string-built HTML/UI (XSS); no raw string-concatenated SQL — always a parameterized query / ORM.
      - Structured error handling & logging: network / I/O / DB / external calls in `try-catch` or an explicit error check; structured error type (Code / Message / Details); no secrets in logs.
      - Schema-validate all external inputs before business logic; debounce/throttle high-frequency UI events; auto-release resources (`using` / `defer` / `try-finally`).
```

### 1.1 移除 `fetch-url` 工具行（v2.2 决定 · 去唯一外部依赖）

**理由**：`fetch-url` 引用的 `@lansi-ai/dsh-fetch-url` 是预设**唯一的外部包依赖**，未安装时整个预设**挂载失败**（会话都创建不了）；而本流程的实际需要（本地开发、读项目文件、头脑风暴澄清）都不依赖它——临时取网页用 `tool-pwsh`（`Invoke-WebRequest`）即可。移除后预设**零先决条件**：拷目录即用。

```diff
-# ── fetch-url (user plugin, scoped to this preset) ──────────────────────────
-
-# Registers the model-callable `fetch_url` tool for agents joined to THIS preset
-# only. It references the `@lansi-ai/dsh-fetch-url` package BY NAME, so that
-# package must be installed on this deployment before the preset can mount.
-# Install it from its source (no plugin-code change, and the preset row never
-# installs or downloads anything — it only composes the installed package):
-#   pnpm add https://github.com/lansi-ai/dsh-fetch-url
-- id: fetch-url
-  name: '@lansi-ai/dsh-fetch-url'
```

**影响面**：`README.md` / `README.en.md` 同步删除 fetch-url 相关内容（见 §5.2）。`tool-web` 行保持不动（搜索能力由 host 组合提供，与预设依赖无关）。

**diff 要点（相对 v2）**：Phase 0–3 的完整程序从 persona 移入技能（persona 只剩 Gates/Flow/Red lines 三层薄壳）；新增 Gate 3（单源规则）与 Gate 4（规则引导 · 强制加载）；Phase 2 分级保留并补"C 类不强制看板"；红线标注"通用集，单源"（与 PROJECT-RULES §1 不重复）；删除 `fetch-url` 工具行。

---

## 2. `dev-flow/skills/start-project/SKILL.md` — 阶段 2 重写

保留 Frontmatter（name/description）与阶段 1（头脑风暴 + Sign-off 分支）原样；替换**阶段 2 与阶段 3**如下：

````markdown
## 阶段 2：自动化工程交付 (Auto-Engineering Phase)

**触发条件**：当用户在阶段 1 完成 Sign-off 确认后，**自动无缝进入本阶段，无需用户输入额外指令**。

### 步骤 0：幂等检查与规则路径决策 (Idempotency & Rules Location)
**判定锚点 = `docs/PROJECT-RULES.md`（规则本体）；`AGENTS.md` 只是可选入口，不参与"是否生成"的判定。**
写入前首先检查项目根目录：
- 若存在 `docs/PROJECT-RULES.md` ➔ **做完整性校验**：是否包含 §3 工作流核心（任务分级表 + 完成门禁）？
  - 包含 → **规则已就位：跳过生成**，直接汇报"项目已有规则，进入开发模式"；若此时缺 `AGENTS.md` → **顺手补 3 行入口**（低成本，不视为生成理由）。
  - 缺失/为空 → 提示"规则文件不完整（缺 §3 工作流核心），建议补齐或重建"，由用户决定。
- 若**只有 `AGENTS.md`**（如从模板克隆）、无 `docs/PROJECT-RULES.md` → **视为缺规则：正常生成 `PROJECT-RULES.md`**（保留现有 AGENTS.md 并在其上补指向）。
- 若发现旧 v1 形态（`.trae/rules/` 或 `.rules/` 下的 core-standards/workflow 等 6 文件）➔ 提示用户执行迁移：生成 `docs/PROJECT-RULES.md` + `docs/active-context.md` + `AGENTS.md`，并在旧文件头部标注「📦 已归档，以 docs/PROJECT-RULES.md 为准」。**迁移提示每次开会话至多出现一次**（用户拒绝后不再复述）。
- 否则（两者都无）➔ 默认写入 **`docs/`**（工具无关位置，不按 IDE 猜路径）；若用户显式指定 IDE 规则目录（如 `.cursor/rules/`），才写入那里，并同时生成 `AGENTS.md` 入口。

### 步骤 1：落盘产品与设计草案 `docs/prd-and-design.md`
将阶段 1 头脑风暴讨论的所有结论完整汇总落盘至 `docs/prd-and-design.md`。

### 步骤 2：生成规则单入口 `docs/PROJECT-RULES.md`
- **操作指令**：读取 `references/project-rules-guide.md`。
- **结合依据**：结合 PRD 中的技术选型、模块划分、安全/性能约束；**扫描项目真实结构**（构建清单、目录树、现有文档）填写项目专属部分——并注意**语言适配**（guide 示例为 TS/web，按项目实际语言改写等价物）。
- **产物结构**（§0–§6 单入口，**无 Frontmatter**——规则是文档，不是 IDE 注入配置）：
  - §0 项目快照：定位、技术栈、基线版本、当前主线
  - §1 硬约束红线：**仅项目专属**（端口策略/禁改第三方/审批门槛…）；通用红线**不在此重复**（已在 persona 单源定义）
  - §2 目录放置：项目目录表（扫代码生成）
  - §3 工作流：任务分级 A/B/C（含 C 类不强制看板）+ 开工流程 + 完成门禁 + 特殊场景
  - §4 提交规范：Conventional Commits + 项目 scope 表
  - §5 字典索引：项目的文档/台账（pitfalls 等如有）
  - §6 环境注意：构建/沙箱/常见坑

### 步骤 3：生成激活上下文看板 `docs/active-context.md`
- **操作指令**：读取 `references/active-context-guide.md`。
- **落盘路径**：`docs/active-context.md`（滚动窗口 ≤100 行，**仅 MD，不再生成 HTML**；维护协议注明 C 类任务不强制更新）。

### 步骤 4：生成跨工具入口 `AGENTS.md`（项目根）
3 行入口：指向 `docs/PROJECT-RULES.md` + `docs/active-context.md` + 一句话定位（模板见 §4）。

### 步骤 5：生成后审阅闸门（Sign-off 精神延伸到规则文件）
**不直接宣告"完成"**，先输出《规则审阅摘要》，请用户确认后再定稿：
- **§0 快照的假设**：技术栈 / 基线版本 / 当前主线 —— 请确认（可能有抄错或推断）
- **§1 已定的项目专属红线** —— 请确认或增删
- **§2 目录表识别到的模块** —— 请确认有无遗漏
- **§6 环境注意**（构建命令 / 坑）—— 请确认
审阅方式：AI 以列表呈现"生成了什么 + 关键假设"，用户回复确认或修改意见；**确认后才进入阶段 3**。
审阅优先级：`PROJECT-RULES.md` **高**（它是后续所有会话的宪法）· `prd` 已在阶段 1 Sign-off · `active-context` 低（一眼扫过）· `AGENTS.md` 免审（纯模板）。

## 阶段 3：收官与工作流闭环 (Completion)

**前提**：步骤 5 的《规则审阅摘要》已获用户确认（审阅不通过则回步骤 2/3 修改后重新确认）。
当上述文件全部自动生成并落盘且审阅确认后，输出最终总结汇报（列出实际写入的真实路径）：

> 🎉 **项目初始化与规则治理体系构建完成！**
>
> 📄 **人类可读文档 (`docs/`)**：`docs/prd-and-design.md` · `docs/PROJECT-RULES.md` · `docs/active-context.md`
> 🔗 **跨工具入口**：`AGENTS.md`（任何 AI 工具开工即识别）
>
> **准备好开工了吗？** 随时告诉我："**按照 active-context.md 中的下一步，开始写代码吧！**"
````

### 补充：技能加载确认（加在 SKILL.md 阶段 1 之前）
加载本技能后、开始追问之前，**先向用户输出一行确认**（让"已加载"可验证、可追责）：
> ✅ 已加载 `start-project` 技能；将按流程执行：阶段 1 头脑风暴 → Sign-off → 阶段 2 规则生成 → 步骤 5 审阅闸门 → 阶段 3 收官。
若无法加载（技能不可得）→ **不进入流程，直接报告用户**，禁止凭记忆生成规则。

**diff 要点（相对 v2）**：步骤 0 幂等检查加"完整性校验 + 迁移提示限一次"；步骤 2 标注语言适配；步骤 3 看板注明 C 类不强制更新；§1 改为"仅项目专属红线（不重复通用集）"；另加"技能加载确认"入口声明。

---

## 3. 新增 `references/project-rules-guide.md`（全文 · v2.1）

> 角色：AI 生成 `docs/PROJECT-RULES.md` 时读取的**结构指南**。通用纪律固定、项目专属部分按占位引导，**示例均为 TS/web 世界观，生成时按项目语言替换等价物**。

````markdown
# PROJECT-RULES.md 生成指南（project-rules-guide）

> 用途：指导 AI 为新项目生成 `docs/PROJECT-RULES.md`（单入口规则文件）。固定段直接采用，项目专属段扫描实际代码后填写。
> 真实范例：`lansi-ai/dsh-forge` 的 `docs/PROJECT-RULES.md`（v2 形态参考）。
> ⚠️ **语言偏置说明**：本文示例均为 TS/web 世界观（typecheck / ApiResponse<T> / strict / zod…）；生成时按项目实际语言改写等价物（Go→`go test`、Rust→`cargo test`、Python→`pytest`，类型方案同理）。"通用纪律"语言无关，照抄。

## §0 项目快照（项目专属 · 扫描填写）
```markdown
## 0. 项目快照（开工必知）
- **产品**：{{ONE_LINE_POSITIONING}}（一句话定位，取自 prd-and-design 阶段 1 Sign-off）
- **技术栈**：{{TECH_STACK}}　·　基线版本：{{BASE_VERSION}}
- **当前主线**：{{CURRENT_MAINLINE}}
- **命名**：{{SCOPES / PRODUCT_NAME}}
- **架构**：{{ARCH_DOC_POINTER}}（如有实现地图，指向它）
```

## §1 硬约束红线（**仅项目专属** · 通用集在 persona 已单源定义，不重复）
```markdown
## 1. 硬约束红线（项目专属 · 永不违反）
- 🚫 {{PORT_RED_LINE}}（如"默认零端口"——按项目实际写；无则删该条）
- 🚫 {{APPROVAL_GATED_OPS}}（如剪贴板写/文件删除/外链跳转——按项目写）
- 🚫 {{XSS/EXPOSURE_RULES}}（renderer/入口安全——无则删）
- 🚫 {{VENDOR_RED_LINE}}（如"禁改上游/第三方源码"——按项目写）
- ✅ {{PROJECT_SPECIFIC_POSITIVE_RULES}}（按项目追加）
```
> 说明：凭据注入、类型安全、契约先行、错误结构化、资源释放等**通用纪律不在本节重复**（persona 红线已含，单源原则）。

## §2 目录放置（项目专属 · 扫目录树生成）
```markdown
## 2. 目录放置（{{LANG}} 项目 · 扫真实目录后填写）
| 你要创建的文件 | 放这里 |
|---|---|
| {{TYPES}} | {{TYPES_DIR}} |
| {{CORE_MODULE}} | {{CORE_DIR}} |
| ...（逐模块） |
- 规则：{{PLACEMENT_RULES}}（如"renderer 只消费白名单""业务不入入口文件"）
```

## §3 工作流（固定 · 照抄，任务分级为 v2 核心）
```markdown
## 3. 工作流（任务分级）
### 任务分级
| 分级 | 适用范围 | 必须执行的流程 |
|---|---|---|
| A | 契约/架构/规则变更（`!`）、里程碑、发版、上游升级 | 契约确认 → 全链门禁 → 台账登记 → 看板更新 → 汇报勾选 |
| B | 常规功能开发（1–3 文件） | 契约确认（或已明确则降级内部自检）→ 编码 → 门禁 → 看板一行收口 |
| C | 小修 ≤3 文件、无契约/架构变更 | 直接修 → 门禁 → 提交；**不强制更新看板**（除非碰里程碑，日末/发版统一收口）；坑档可当日批次末统一写 |

### 开工流程（A/B 类）
1. 读 `docs/active-context.md` → 确认与「当前焦点/下一步」一致。
2. 契约确认：一句话总结 Input/Output、异常边界、MVP 边界；用户已明确授权 → 降级内部自检。
3. 编码：契约先行 → 实现 → 测试；单任务 1–3 文件；禁留 TODO。

### 完成门禁（必过）
- [ ] {{VERIFY_COMMANDS}} 全绿（typecheck/lint/test/build 等，按项目写）
- [ ] 涉及派生视图（{{DERIVED_DOCS}}）时同步更新
- [ ] 看板更新：`docs/active-context.md` 一行收口 + 更新「下一步」（仅 MD；C 类豁免）
- [ ] bug 修复必写坑档（{{PITFALLS_DOC}}，四段式，编号顺延）
- [ ] 给最终汇报：变更清单 + commit 指令

### 特殊场景
- 上游新版本：{{UPSTREAM_FLOW}}（判据/登记表路径）
- 规则演进：技术栈/目录/流程变化 → 同步更新本文件对应节
- 看板膨胀：`active-context.md` 超 100 行 → 立即瘦身
```

## §4 提交规范（固定 · 照抄 + 项目 scope）
```markdown
## 4. 提交规范
- 格式：`<type>(<scope>): <summary>` ≤50 字符；契约破坏性变更 type 后加 `!`。
- type：feat / fix / docs / refactor / style / chore / test / build。
- scope：{{PROJECT_SCOPES}}（按模块列，如 shell/host/carrier/…）。
- 原子提交：完成看板一个节点（1–3 文件）即 commit；禁混提。
- 多窗口并行（如多 IDE）：一条功能线 = 分支 + worktree 独立目录；并行 ≤3 线；共享契约文件只在基线改。
```

## §5 字典索引（项目专属 · 扫文档生成）
```markdown
## 5. 字典索引（按需检索 · grep 勿整读）
| 文档 | 用途 |
|---|---|
| docs/active-context.md | 当前看板（开工第一读） |
| {{PITFALLS_DOC}} | 排障坑档（grep 坑号） |
| {{OTHER_LOGS}} | ...按项目实际列出 |
```

## §6 环境注意（项目专属 · 从构建/踩坑提炼）
```markdown
## 6. 环境注意（从坑档提炼）
- {{ENV_NOTES}}（构建命令/沙箱限制/常见伪失败，按项目写）
```

## 生成纪律
1. **固定段不裁剪**：§3 任务分级、§4 提交规范、门禁清单为跨项目通用，照抄（可增不可删）。
2. **§1 只放项目专属**：通用红线不重复写（单源原则，见 v2.1 §0.5 分工声明）。
3. **项目段不臆造**：§0/§2/§5/§6 必须基于对实际仓库的扫描（构建清单、目录树、现有文档），禁止按模板猜。
4. **语言适配**：固定段示例为 TS/web 世界观（`typecheck`、`ApiResponse<T>`、`strict`…），生成时按项目实际语言改写等价物；"通用纪律"语言无关照抄。
5. **长度**：目标 ≤10KB，单入口；禁止拆分回 6 文件。
````

---

## 4. 配套小文件

### 4.1 `references/active-context-guide.md` 改动
删除其中的 HTML 看板同步要求（若存在），改为：
```diff
-- 看板需同步重绘 HTML 版本
+- 看板形态：仅 MD（`docs/active-context.md`）；不生成/不维护 HTML 副本
+- C 类小任务不强制更新看板（除非碰里程碑），日末/发版统一收口
```

### 4.2 旧 references 指南的处理
`core-standards-guide.md` / `architecture-guide.md` / `git-commit-guide.md` / `workflow-guide.md` → 顶部加一行标记：
```markdown
> **📦 已并入 `project-rules-guide.md`（v2.1）**——新项目按单入口生成，本文仅作历史参考。
```
（`brainstorming-guide.md` 原样保留，阶段 1 依赖它。）

### 4.3 `AGENTS.md` 生成模板（SKILL.md 步骤 4 引用）
```markdown
# {{PROJECT_NAME}} — Agent 协作入口

> 本文件让任何 AI 工具（DSH / Claude Code / Codex / Cursor …）开工即可定位项目规则。

## 开工必读
1. `docs/PROJECT-RULES.md` — 权威规则（目录放置 / 工作流分级 / 提交规范 / 字典索引 / 项目专属红线）
2. `docs/active-context.md` — 当前任务看板（滚动窗口，最新进度与下一步）

## 一句话定位（start-project 阶段 1 Sign-off 后回填）
{{ONE_LINE_POSITIONING}}

## 快速事实
- 技术栈：{{TECH_STACK}} 　·　基线：{{BASE_VERSION}}
- 验收命令：{{VERIFY_COMMANDS}}
```

---

## 5. 其他文件

### 5.1 `dev-flow/preset.yml`
`description` 可更新为：
```yaml
description: 先澄清（5 维头脑风暴 + Sign-off）再动手；自动生成 docs/PROJECT-RULES.md + active-context.md + AGENTS.md；任务分级 A/B/C；通用纪律在 persona、项目专属在 PROJECT-RULES（单源）
```

### 5.2 `README.md` / `README.en.md`（中英同步）
- 产出描述"6 份规则文件 + HTML 看板" → "`docs/PROJECT-RULES.md` 单入口 + `docs/active-context.md`（仅 MD）+ `AGENTS.md` 跨工具入口"
- 核心流程枚举同步：去掉"HTML 看板"字样，加"任务分级 A/B/C"与"规则单源分工"
- **删除 `fetch-url` 的全部内容**：先决条件里的 `@lansi-ai/dsh-fetch-url`、安装第 1 步（`pnpm add`）、验证里的 `fetch_url` 检查、"说明"里"预设行只引用、不安装"那一节
- 新增一句：**"零先决条件：把 `dev-flow` 拷进 `$DSH_HOME/.agent-presets/` 即可，无需安装任何额外包。"**

---

## 6. 兼容与迁移矩阵（v2.1）

| 场景 | v2.1 行为 |
|---|---|
| 全新项目 | 头脑风暴 → Sign-off → 生成 3 件套 + AGENTS.md（无 HTML/Frontmatter；§1 仅项目专属） |
| 已有 v2 项目（如 forge 现状） | 检测到 `docs/PROJECT-RULES.md` 且含 §3 工作流核心 → **跳过生成**，直接开发（幂等；缺 AGENTS.md 则顺手补入口） |
| 已有但规则不完整 | 完整性校验不过 → 提示"补齐或重建"，由用户决定，不静默跳过 |
| 只有 `AGENTS.md`、无 `PROJECT-RULES.md` | 视为缺规则 → 生成 `docs/PROJECT-RULES.md`（现有 AGENTS.md 保留并补指向） |
| 旧 v1 项目（`.trae/rules/` 6 文件） | 提示迁移（每次会话至多一次）：生成 3 件套 + 旧文件标注归档 |
| 其他 IDE / 其他语言项目 | AGENTS.md 跨工具识别；固定段按语言改写（见 guide 语言适配纪律） |

## 7. 验收标准（升级后自测）

1. **全新项目路径**：开会话选「开发流程」→ 阶段 1 追问 → Sign-off 后自动生成 —— `docs/prd-and-design.md` + `docs/PROJECT-RULES.md`（§0–§6、≤10KB、无 Frontmatter、§1 仅项目专属）+ `docs/active-context.md`（仅 MD）+ `AGENTS.md`；**产物中无 `active-context.html`、无 `alwaysApply`**。
2. **幂等路径**：对 forge 项目（已有 docs/PROJECT-RULES.md）开会话 → 汇报"规则已就位，进入开发模式"，不重复生成。
3. **完整性校验**：把规则文件删掉 §3 再开会话 → 提示"规则不完整（缺 §3 工作流核心）"，而非静默跳过。
4. **分级生效**：给一个 C 类小请求（如改文案）→ AI 走轻量流程（不自问 2–3 问、**不更新看板**，除非碰里程碑）。
5. **单源生效**：让 AI 复述"通用纪律在哪定义、项目红线在哪定义"→ 能答出"通用在 persona、专属在 PROJECT-RULES §1"，且两处无重复条目。
6. **旧形态绝迹**：新项目产物 grep 无 `globs: "*"`、无 `.trae/`、无 HTML 看板。
7. **入口补齐**：对"有 PROJECT-RULES 但缺 AGENTS.md"的项目开会话 → 不重复生成规则，但顺手补 `AGENTS.md` 入口（grep 确认其 3 行指向 PROJECT-RULES + active-context）；对"只有 AGENTS.md 无 PROJECT-RULES"的项目 → 正常生成 PROJECT-RULES.md，而非误判已就位。
8. **审阅闸门生效**：全新项目流程中，4 文件生成后 AI **不直接宣告完成**，而是先输出《规则审阅摘要》（§0/§1/§2/§6 关键假设列表）；用户确认或修改后才定稿进入"开始开发"提示；未确认前不得进入阶段 3 收官汇报。
9. **加载强声明生效**：进入全新项目流程时，AI **先输出"已加载 start-project 技能 + 流程阶段清单"**（可验证已加载）；把技能目录移走（模拟不可得）后开会话 → AI **停下并报告"技能不可得"**，而不是凭记忆生成规则。
10. **零依赖挂载**：不安装任何额外包，直接把 `dev-flow` 拷进 `$DSH_HOME/.agent-presets/` → 新会话选「开发流程」**能正常创建**（工具列表无 `fetch_url` 也不报错）；grep 仓库确认不再出现 `fetch-url` / `dsh-fetch-url`（本方案文档等历史记录除外）。