# ADR-009 · AI 自测驾驶器：真机测试走「双实例 + 零端口管道 + CDP/AX 混合」而非像素级 computer-use

状态：**提议**（2026-09 · 草稿，待评审）· 关联：[`15-computer-use-testing.md`](../15-computer-use-testing.md)、[`05-host-plugins.md`](../05-host-plugins.md)、[`14-implementation-map.md`](../14-implementation-map.md)

## 背景

agent 每改一个 bug / 新功能，都需用户手动启动项目自测，反馈环长。目标是让 agent 自己完成「改代码 → 重建 → 拉起真实应用 → 驱动 UI → 断言 → 截图留证」的**真机测试闭环**。Codex/Claude 的 computer use 是「全屏截图 + 视觉模型 + OS 坐标注入」，能否仿照 / 有无更优路线。

## 决策

1. **不做像素级 computer use 仿照，做混合路线**：以应用内部语义（CDP `Accessibility.getFullAXTree` + 精简 DOM 快照）为**主感知**，CDP `Input` 域为**主执行**，截图仅作**证据**，OS 级输入（koffi → `user32.SendInput`）仅作**应用外兜底**。
2. **驱动者与被测实例硬分离**：testdrv 插件运行在宿主 Forge 实例（装载 DSH 会话侧），被测对象必须是**另一个独立 Electron 实例**（临时隔离 userData + `--forge-test-driver=<pipe>` 标识），杜绝「改代码 relaunch 自杀」与驱动者/被测同进程互相污染。
3. **零 TCP 端口连接**：被测实例 main 进程以 Windows 命名管道（`\\.\pipe\forge-test-<uid>`）暴露自身 `webContents.debugger`（CDP 1.3）代理；驱动者 `net.connect` 即可全量驱动，守住本项目「零端口」红线。`--remote-debugging-port=0` 仅作 dev 备用开关（127.0.0.1、用后即关、需豁免登记）。
4. **落地形态与现有桌面能力一致**：先以 `src/forge-host/forge-testdrv.ts` 项目内模块实现（与 tray/clipboard 等同构），经 bridge unary 方法族 `desktop.test.*` + 工具 `desktop_test_*` 暴露；M5 插件包化时转 `@lansi-ai/dsh-forge-testdrv`。
5. **权限与审计默认收紧**：`desktop.testdrv.enabled` 默认关；拉起点、销毁类动作走 approval；全部动作进 `desktop/action` 审计（命名空间 `testdrv`）；错误码入 `src/types/errors.ts` 5xxx 桌面段（5020 起）。

## 理由

1. computer use 的脆弱性全部来自「像素理解 + 坐标点击」；自有应用可直接读语义树，确定性、速度、token 成本全面优于截屏视觉，且**断言**（bug 是否修好）天然可结构化。
2. 双实例分离是自驱动的硬前提：被测代码随时可被重建/重启（main 改动）或热重载（renderer 改动），驱动侧必须存活且不影响用户真实数据。
3. 命名管道 + CDP 代理零端口、零新依赖（`net` 内置、CDP 内置、koffi 已在依赖），符合「一包零外部依赖」与 R-03 零端口要求。
4. 插件化形态继承已有治理：可 patch 增删、可审计、可审批、可被模型工具调用（与 `05-host-plugins.md` §6 的克制原则一致，默认不注入提示词）。

## 后果

- 新增能力面：bridge 方法族 `desktop.test.*`、工具 `desktop_test_*`、设置项 `desktop.testdrv.*`、审计命名空间 `testdrv`、错误码 5020+——需同步 `src/types/`（contract/channels/desktop/errors）。
- 被测实例侧新增「测试驱动模式」：main 启动参数解析 `--forge-test-driver`、命名管道 host、CDP 代理——需与崩溃自愈（relaunch.ts）、单实例锁互不冲突。
- 测试成本上升：双实例常驻内存需计入 R9（M5 性能实测表）。
- 与既有测试体系互补：单测/组件/Playwright e2e 保持；testdrv 管「探索式真机验收 + dogfood 自动化」，且为 M5「桌面工具 desktop_*（默认关）」提供了第一个正式载体。

## 备选否决

- **像素级 computer use 仿照**（截图 + 视觉 + OS 坐标）：仅适合黑盒/他人应用；自有应用下成本高、不稳定、断言难。
- **Chromium `--remote-debugging-pipe`**：Electron 支持不稳（历次 issue），不作为主选；如 POC 证明可用，可升级为更优解（同为零端口）。
- **`--remote-debugging-port=0` 为主选**：占一个 loopback TCP 端口，违零端口红线，降级为 dev 备用。
- **纯脚本化 E2E（Playwright）替代**：回归价值高，但非探索式；与 testdrv 互补而非替代（详见 15 文档 §9）。

## 复查触发

- Electron CDP 对 `Accessibility.getFullAXTree` 在无 AT 客户端时的可用性（POC 关键验证点，必要时 `Accessibility.enable` / `--force-renderer-accessibility`）。
- 上游 harness 版本升级时，`webContents.debugger` 协议版本（1.3）与窗口生命周期语义是否变化。
- M5 插件包化时，是否正确转为可独立安装/卸载的 `@lansi-ai/dsh-forge-testdrv` 并保持审计/审批不变。