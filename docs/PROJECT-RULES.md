# 项目规则（PROJECT RULES）· AI 协作唯一权威入口

> **用法**：新会话开工先读本文件 + [`docs/active-context.md`](active-context.md)（当前看板），再按任务分级执行。
> **来源**：2026-09 由原 `.trae/rules/` 六个规则文件（core-standards / architecture / git-commit-guide / rtk-usage / workflow / active-context）精炼合并；
> 原文件归档于 [`docs/rules-archive/`](rules-archive/)，保留历史细节（含已废弃的 TRAE 机制），**以本文件为准**。
> **弃用清单**：TRAE 已弃用 → `rtk-usage` 全文作废；"MD+HTML 看板双落盘"已废弃 → 仅维护 `docs/active-context.md`（MD）。

---

## 0. 项目快照（开工必知）

- **产品**：DSH Forge —— DeepSeek Harness 桌面客户端（**非套壳**：Electron 主进程内嵌 Cordis Host、零 HTTP 端口、桌面能力全部 host 插件化）。
- **上游基线**：`@deepseek-ai/dsh` `0.1.5-rc.2`（2026-09-11 C-7）；升级与拴合面见 `docs/upstream-migrations.md` / `docs/upstream-contracts.md`。
- **当前主线**：M6 全量自绘 UI（D-20 / ADR-006 已启用），逐槽位替换官方 `ui-*`；进度见 `docs/plugin-inventory.md`。
- **命名**：插件 scope `@lansi-ai/dsh-forge-*`；应用名 `DSH Forge`；数据归位 `$DSH_HOME`（ADR-008）。
- **架构**：进程模型/代码位置见 `docs/14-implementation-map.md`（活文档，与代码同步）。

## 1. 硬约束红线（永不违反 · 原 core-standards）

- 🚫 **禁硬编码凭据**：API Key/Token/密码一律经 profile/环境变量注入；`.env` 不提交。
- 🚫 **禁逃逸类型系统**：`strict` 全开、禁 `any`（用 `unknown` + 收窄）；禁 `@ts-ignore` / `as unknown as T`；单文件 ≤200 行（复杂 ≤300）。
- 🚫 **契约先行**：IPC 契约 / zod Schema / DTO / 错误码**只定义于 `src/types/`**（唯一类型源头），preload/桥/测试类型均由推导获得；IPC 入参必过 zod。
- 🚫 **禁绕过载波**：默认**零端口**——禁止非 `--serve` 显式模式监听任何 TCP/HTTP 端口（R-03 红线）。
- 🚫 **禁未授权系统操作**：剪贴板写、文件删除、外链跳转必须过 `approval` 服务。
- 🚫 **renderer 安全**：禁裸 `ipcRenderer` 通传（preload 仅白名单最小面）；禁未过滤字符串动态构建 DOM（防 XSS）；禁任意路径拼接文件操作。
- 🚫 **禁改官方代码**：上游只读，耦合收敛在 3 类文件（装配/bundle patch、IPC 载波、compat）。
- ✅ **错误处理**：IPC/网络/文件/插件装载必 try-catch → 结构化 `AppError{code,message,details}`；错误码集中 `src/types/errno`；日志禁含 Token/凭据。
- ✅ **资源与生命周期**：定时器/订阅随 `ctx.effect`/生命周期清理；`before-quit` 统一释放；崩溃走 relaunch 自愈（带熔断防无限重启）。

## 2. 目录放置（原 architecture 核心表）

| 你要创建的文件 | 放这里 |
|---|---|
| IPC 契约 / zod / DTO / 错误码 | `src/types/` |
| Electron 窗口/协议/生命周期/argv/relaunch | `src/forge-shell/` |
| Host 装配 / IPC 桥 / 载波 / WindowManager / 桌面能力模块（forge-api/tray/notify…） | `src/forge-host/` |
| 旧插件路由等价面 / fetch 拦截 / bundle 服务 | `src/forge-compat/` |
| 桌面能力 **host 插件**（cordis.patch.yml 形态） | `src/forge-plugins/<name>/` |
| renderer 调用白名单 API（contextBridge） | `src/preload/` |
| 外部可独立安装插件（主包不带） | `E:\Projects\DSH\plugins\<name>\`（经 `$DSH_HOME/profiles/dsh-forge` 补丁层装载） |
| 官方站点（VitePress） | `website/`（与 `src/` 零耦合，产物 `website/.vitepress/dist`） |

- 规则：renderer 只消费 `desktopBridge` 白名单；主进程不反向依赖 renderer；**桌面能力一律走插件注册 `ctx.desktop.*`，禁止在 `main.ts` 堆业务代码**；单文件行数上限同上。

## 3. 工作流（原 workflow 精简 + 2026-09 任务分级）

### 任务分级（开工先判定，决定流程深度）

| 分级 | 适用范围 | 必须执行的流程 |
|---|---|---|
| **A 类** | 契约/架构/规则变更（`!` 破坏性）、里程碑、发版、上游升级 | 契约确认 → 全链门禁 → 台账登记 → 看板更新 → 汇报勾选 |
| **B 类** | 常规功能开发（1–3 关联文件） | 契约确认（或已明确则降级为内部自检）→ 编码 → 门禁 → 坑档（若涉 bug）→ 看板一行收口 |
| **C 类** | 小修小补 ≤3 文件、无契约/架构变更、dogfood 小 bug | 直接修 → 门禁 → 提交；坑档可当日批次末统一写（同日志账，不得跨日） |

### 开工流程（A/B 类）
1. **读看板**：`docs/active-context.md` → 确认本任务与「当前焦点/下一步即时行动」一致（L3）。
2. **契约确认**：一句话总结 Input/Output、异常边界、MVP 边界；**用户已明确指令/授权范围时自动降级为内部自检**，不阻塞。
3. **编码**：契约优先（先 `src/types/` zod）→ bridge 宿主端 → preload → renderer → 测试；单 Task 1–3 文件；禁留 TODO 伪代码。

### 完成门禁（必过，缺一不算完成）
- [ ] `npm run typecheck` 零错误 · `npm run lint` 零告警 · `npm test` 全绿 · `npm run build` 成功
- [ ] 涉及派生视图（`plugin-inventory.md` / `14-implementation-map.md` / `upstream-contracts.md`）时同步更新
- [ ] **看板更新**：`docs/active-context.md` 完成项一行收口 + 更新「下一步即时行动」（仅 MD）
- [ ] **bug 修复必写坑档**（场景 E）：`docs/pitfalls.md` 四段式 现象→根因→解法→复盘，编号顺延，一条一坑
- [ ] 给最终汇报：变更文件清单 + 可执行 commit 指令

### 特殊场景（触发即执行）
- **上游新版本**：`npm run upstream:auto`（判据源 = GitHub releases）；迁移登记 `docs/upstream-migrations.md`（脚本自动 C 区 + 人工同步表头/contracts/看板）；破坏性变更禁 auto 硬升，须人工 diff。
- **规则演进**：技术栈/规范 → 改本文件相关节；目录重构 → 改 §2 + `14-implementation-map.md`；流程调整 → 改本文件 §3。禁止"规则与代码脱节"。
- **看板膨胀**：`active-context.md` 超 100 行 → 立即瘦身（历史进 git / 台账），无需提醒。

## 4. 提交规范（原 git-commit-guide）

- **格式**：`<type>(<scope>): <summary>`，summary 动名词、≤50 字符，禁 `update`/`bugfix` 等模糊词。契约破坏性变更 type 后加 `!`。
- **type**：feat / fix / docs / refactor / style / chore / test / build(upstream)。**scope**：shell / host / carrier / compat / plugins / preload / types / protocol / board / upstream。
- **原子提交**：完成看板一个子任务节点（1–3 文件）即 commit；职责单一，禁混提；`docs(board)` 可伴随同节点。
- **多窗口并行**（如多 IDE）：一条功能线 = 一个分支 + `git worktree` 独立目录；并行 ≤3 线；`src/types/` 与看板只在基线改，不进功能分支；合并后回基线收口。
- **沙箱注意**：写 `.git/objects` 的操作（add/commit/tag/push）在 Agent 沙箱内必失败 → **由用户在终端执行**，Agent 只准备命令（坑 65）。

## 5. 字典索引（按需检索 · grep 勿整读）

| 文档 | 用途 |
|---|---|
| `docs/active-context.md` | 当前看板（开工第一读） |
| `docs/pitfalls.md` | 排障坑档（`grep 坑 N`，勿整读 226KB） |
| `docs/dogfood-issues.md` | dogfood 现场台账（按 #N 直取，跨会话移交锚点） |
| `docs/upstream-contracts.md` | 上游拴合面速查（对接/排查 @deepseek-ai 包先查） |
| `docs/upstream-migrations.md` | 上游升级台账（C-1~C-N） |
| `docs/plugin-inventory.md` | 插件清单 + M6 自有化进度（真源 = `src/forge-host/boot.ts`） |
| `docs/14-implementation-map.md` | 实现地图：代码位置/关键链路（与代码同步） |
| `docs/11-risks.md` · `docs/adr/` · `docs/12-references.md` | 风险 / 架构决策 / 参考资料 |

## 6. 环境注意（从坑档提炼）

- Electron GUI 启动（`npm start`/`dev`/`dist`）在沙箱内**必失败**（运行时数据目录/AppData 在工作区外）→ 由用户在**系统终端**运行并贴日志；构建（build）沙箱内正常。
- 排障先看输出**尾部** `TRAE Sandbox Error`（错误头像代码坑，根因在输出尾部）。
- `git push` 报 `unable to write credential store` 属伪失败（推送已完成，坑 44）。
- 当前会话环境若为 DSH harness：工具/文件操作按环境规则执行；git 写操作同沙箱限制。

---

*本文件为滚动规则：随项目演进按 §3「场景：规则演进」同步更新；变更记录走 git 历史。*