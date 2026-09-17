# 新窗口交接单：dev-flow v2.2 升级实施

> 用途：把 `docs/dev-flow-v2-upgrade.md`（方案）落实到 `E:\Projects\DSH\preset\dsh-preset-dev-flow`（本地已有仓库，main 分支，干净）。
> 主线会话（forge）只产出方案；**实施在新窗口里做**，按本单执行。

---

## 一、开新窗口前的 2 条准备命令（你自己跑，1 分钟）

### 1）把方案文档复制进目标仓库（否则新窗口读不到跨工作区文件）

```powershell
$repo = "E:\Projects\DSH\preset\dsh-preset-dev-flow"
New-Item -ItemType Directory -Force "$repo\docs" | Out-Null
Copy-Item "E:\Projects\DSH\desktop\docs\dev-flow-v2-upgrade.md" "$repo\docs\v2-upgrade-plan.md"
```

> 说明：`docs/v2-upgrade-plan.md` 建议随本次升级一并提交，作为升级记录（也可先不提交，自行决定）。

### 2）（可选，用于实测）把预设装到 DSH_HOME

```powershell
New-Item -ItemType Directory -Force "$env:DSH_HOME\.agent-presets" | Out-Null
Copy-Item -Recurse -Force "$repo\dev-flow" "$env:DSH_HOME\.agent-presets\"
```

> ✅ **v2.2 已移除 `fetch-url` 工具行**——预设不再有任何外部包依赖，**拷目录即可挂载**，无需 `pnpm add` 任何东西。
> （这也是移除它的原因：原先未安装 `@lansi-ai/dsh-fetch-url` 会导致整包挂载失败、会话都开不起来。）

---

## 二、新窗口怎么开

| 项 | 取值 |
|---|---|
| 工作目录（workspace） | `E:\Projects\DSH\preset\dsh-preset-dev-flow` |
| 预设 | **不要选 `dev-flow`**（它是 v1；在本仓库会触发 Gate 4 生成旧格式规则）——用默认 / standard |
| 首条消息 | 粘贴下面【启动咒语】 |

> 为什么不选 dev-flow 自己：v1 的 persona 会让 AI 在本仓库"识别到缺规则 → 生成 6 文件 + HTML 看板"，正好生成我们要淘汰的形态。**改生成器时不要用它自己。**

---

## 三、启动咒语（整段复制粘贴）

```text
读 docs/v2-upgrade-plan.md（dev-flow 预设 v2.2 升级方案），严格按其中 §1–§5 的文件级 diff 修改本仓库。

【任务性质】A 级（规则/契约变更）：先给出 file-by-file 改动计划（改哪个文件、改哪几处、为什么）等我确认，再动手。

【范围】只允许改这些文件：
1. dev-flow/agent.cordis.yml —— ① 仅替换 `- id: persona` 的 config.text（按方案 §1 成品文案；保持 YAML 缩进与 `|-` 块标量，其余行不动）；② 按方案 §1.1 删除 `- id: fetch-url` 行及其上方注释块（移除唯一外部依赖）
2. dev-flow/skills/start-project/SKILL.md —— 保留 name/description frontmatter 与「阶段 1」原样；替换「阶段 2」并更新「阶段 3」（按方案 §2），含步骤 0 幂等判定表、步骤 5 审阅闸门、技能加载确认
3. dev-flow/skills/start-project/references/project-rules-guide.md —— 新建（方案 §3 全文）
4. dev-flow/skills/start-project/references/active-context-guide.md —— 去 HTML 段、补 C 类不强制看板（方案 §4.1）
5. references 下 core-standards-guide.md / architecture-guide.md / git-commit-guide.md / workflow-guide.md —— 顶部加「📦 已并入 project-rules-guide.md（v2.2）」标记（方案 §4.2）；brainstorming-guide.md 原样保留、不改内容
6. dev-flow/preset.yml —— description 更新（方案 §5.1）
7. README.md 与 README.en.md —— 产物描述更新 + 删除 fetch-url 全部内容 + 补"零先决条件"（方案 §5.2，中英同步）

【禁止】
- 不改工具行（standard 全套工具、skills 注册、tool-web 等）；**唯一例外是按方案 §1.1 删除 fetch-url 行**
- 不改 brainstorming-guide.md 的内容
- 不做与本任务无关的重构/格式化/重排
- 不引入绝对路径（预设必须保持可移植，skills 用相对解析）
- 不删除任何历史文件（旧 guide 只加标记）

【自检（必须做并把结果贴出来）】
- agent.cordis.yml 与 preset.yml 的 YAML 可被解析（node/python 的 yaml 库，或 DSH 预设加载器）
- grep 全仓库确认：不再出现 fetch-url / dsh-fetch-url、active-context.html、alwaysApply、globs: "*"、.trae/（历史标记行与方案文档除外）
- grep 确认关键新增落地：persona 含 "MANDATORY"；SKILL.md 含「步骤 5：生成后审阅闸门」与「技能加载确认」

【交付物】
1. 改动文件清单表（文件 / 改了什么 / 为什么）
2. 关键片段 before → after（persona Gate 4、SKILL.md 步骤 0 与步骤 5、fetch-url 行删除 必贴）
3. commit 指令（Conventional Commits；按原子提交拆 2–3 个，例如 docs(persona)/docs(skill)/docs(readme)）
4. 实测步骤：如何安装到 $DSH_HOME\.agent-presets（无需任何额外包）并用一个全新空项目端到端验证方案 §7 的验收项

【git】不要执行 git add/commit/push（沙箱可能拒绝写 .git）；只给命令，我自己在终端跑。
```

---

## 四、新窗口里的预期节奏 & 你的动作

```
① AI 给 file-by-file 计划            → 你确认（或调整范围）
② AI 改 5 类文件                     → 你不用管
③ AI 自检（YAML 解析 + grep）        → 看它贴出的自检结果
④ AI 汇报 diff + commit 指令          → 你抽查 persona / SKILL.md 关键片段
⑤ 你在终端执行 commit（+ 可选 push）  → 沙箱通常拦 git 写操作
⑥ AI 给实测步骤                       → 你按步骤开一个新会话选「开发流程」实测
```

## 五、实测（端到端验收，建议至少做这 3 条）

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 拷 `dev-flow` 到 `$DSH_HOME\.agent-presets\`（**不装任何额外包**）→ 新建**空目录**作项目 → 新会话选「开发流程」 | 会话正常创建、无挂载报错；出现"✅ 已加载 start-project 技能"；按 5 维追问 |
| 2 | 回答追问并 Sign-off | 自动生成 `docs/prd-and-design.md` + `docs/PROJECT-RULES.md`（§0–§6、无 Frontmatter）+ `docs/active-context.md`（仅 MD）+ `AGENTS.md`；**无 HTML、无 alwaysApply**；随后输出《规则审阅摘要》等你确认 |
| 3 | 打开 forge 项目（已有 `docs/PROJECT-RULES.md`）开会话 | 汇报"规则已就位，进入开发模式"，**不重复生成**；若缺 AGENTS.md 则顺手补齐 |

## 六、风险与注意

| 风险 | 说明 |
|---|---|
| git 沙箱限制 | DSH 沙箱可能拒绝写 `.git`（历史坑 65）→ commit/push 由你在终端执行 |
| 不要用 dev-flow 改 dev-flow | 见 §二注意：v1 persona 会在本仓库生成旧格式规则 |
| 跨工作区读取 | 方案文档必须先复制进仓库（§一第 1 步），否则新窗口可能读不到 |
| 外部依赖 | ✅ 已消除（v2.2 移除 `fetch-url`），预设零先决条件 |
