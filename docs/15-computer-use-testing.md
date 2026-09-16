# 15 · AI 自测驾驶器（真机测试 · computer-use 混合路线）

> 决策入口：[ADR-009](adr/adr-009-ai-self-driver.md) · 状态：**设计稿（草稿）**，POC 见 §10 · 关联：[`05-host-plugins.md`](05-host-plugins.md)、[`14-implementation-map.md`](14-implementation-map.md)、[`08-security.md`](08-security.md)
>
> 一句话：**让 agent（本会话）自己完成真机测试闭环**——改代码 → 重建 → 拉起真实应用实例 → 语义快照驱动 UI → 断言 → 截图留证。
> 明确不做像素级 computer use 仿照（那是黑盒应用的解法）；自有 Electron 应用走「**双实例分离 + 零端口命名管道 + CDP/AX 混合**」，更快、更稳、更省 token、断言可结构化。

---

## 1. 目标与非目标

| 维度 | 内容 |
| --- | --- |
| 目标 | agent 修改代码后，自主完成：`npm run build` → 拉起隔离的被测实例 → `desktop_test_*` 工具驱动 UI → 断言修复/新功能符合预期 → 截图留证 → 汇报用户 |
| 目标 | 把项目既有 Dogfood（`dogfood-issues.md`，M3-b4 启动的日常使用）自动化：**对 Forge 自身的真机测试 = dogfood 自动化** |
| 非目标 | 不做「全屏截图 + 视觉模型 + OS 坐标点击」的黑盒 computer-use 主线（仅保留 OS 输入兜底） |
| 非目标 | 不替代单测/组件测试/Playwright e2e（回归脚本仍用它们，§9） |
| 范围 | 仅桌面端：被测 = Forge 自身或用户带入的其他 Electron 应用（移动真机 ADB/scrcpy 分支**不在**本期范围） |

## 2. 为什么混合路线优于「仿照 computer use」

computer use = 感知 + 决策 + 执行三件套；决策都交给 LLM，差异在感知与执行：

| 环节 | 像素级仿照（Codex/Claude 式） | 本方案 |
| --- | --- | --- |
| 感知 | 全屏截图，视觉模型读像素 | CDP `Accessibility.getFullAXTree` + 精简 DOM → 紧凑 JSON（角色/名称/值/几何/可点性） |
| 执行 | OS 坐标注入（`SendInput`），猜坐标 | CDP `Input.dispatchMouseEvent/KeyEvent` 按快照坐标命中；OS 注入仅兜底应用外 |
| 断言 | 靠人眼看截图 / 图片 diff | agent 直接读快照 DOM/AX 状态（错误 toast 是否出现等），可结构化 |
| 成本 | 每步一张图进视觉模型 | 快照为文本 token，截图仅在证据性节点生成 |
| 适用 | 黑盒/他人应用 | 自有应用——**正是我们的场景** |

## 3. 总体架构（双实例分离，硬约束）

```
┌─ 驱动者（当前 Forge · 装 DSH 会话 = agent）──────────────────────┐
│ src/forge-host/forge-testdrv.ts                                  │
│   ├─ 生命周期：build → spawn 被测 → 连接 → relaunch/reload → stop │
│   ├─ 连接：net.connect('\\\\.\\pipe\\forge-test-<uid>')          │
│   ├─ 驱动：CDP 请求/事件经管道转发（webContents.debugger 代理）    │
│   ├─ 感知：AX 快照序列化 → 紧凑 JSON                               │
│   ├─ 执行：CDP Input（主）+ koffi→user32 SendInput（兜底）        │
│   └─ 挂接：bridge 方法族 desktop.test.* + 工具 desktop_test_*     │
│        动作 → desktop/action 审计 · 敏感动作 → approval            │
└───────────────┬──────────────────────────────────────────────────┘
                │ 命名管道（零 TCP 端口）
┌───────────────┴──────────────────────────────────────────────────┐
│ 被测实例（独立 Electron 进程 · 临时隔离 userData）                  │
│   main：--forge-test-driver=<pipeName> 解析 → net 管道 host        │
│         → 本窗口 webContents.debugger.attach('1.3') → 消息代理     │
│   renderer：官方 UI / 被测业务 UI（AX 树来源）                      │
└──────────────────────────────────────────────────────────────────┘
```

**为什么必须分离**：被测实例随时可能被重建重启（main 改动）或整新拉起——驱动者如果就是被测者，`app.relaunch()` 等于自尽。此外被测用临时 userData + 最小 test profile，绝不污染用户真实会话数据。

**防自毁/防误连**：testdrv 拒绝以当前宿主进程为目标；被测实例必须携带 `--forge-test-driver` 标识才开放管道；驱动连接前校验对方 `process.pid`/启动时间戳指纹。

## 4. 连接层：零端口命名管道 + CDP 代理

### 4.1 主选：命名管道（零端口，零新依赖）

- 被测实例 main 进程（`forge-shell/main.ts` 增加测试模式解析，或独立 `test-harness.ts`）：
  ```ts
  const pipeName = `\\\\.\\pipe\\forge-test-${crypto.randomUUID()}`
  net.createServer((sock) => proxyCdp(sock, webContents))   // webContents.debugger 消息双向转发
       .listen(pipeName)
  ```
- `proxyCdp`：驱动者发来的 `{id, method, params}` → `debugger.sendCommand`；`debugger.on('message')` → 回写 `{id, method, params|result, error}`。
- 驱动者 `net.connect(pipeName)` 即获得等价 CDP 会话（`Runtime.evaluate` / `Accessibility.getFullAXTree` / `Input.*` / `Page.captureScreenshot` / `Page.reload`）。

### 4.2 备选（dev 备用，需豁免登记）

- `--remote-debugging-port=0`：解析 stderr 的 `DevTools listening on ws://127.0.0.1:PORT/...`。少写代理代码，但占 loopback TCP 端口，**仅在 settings 显式开 dev 模式时可用，用后即关**，登记到零端口红线豁免表。
- Electron `--remote-debugging-pipe`：Chromium 原生管道，零端口；但 Electron 支持不稳，**不作为主选**；若 POC 证明可用可升级。

### 4.3 极简替代（POC 对照）

非 CDP 的轻量注入：被测 main 暴露 `executeJavaScript` 型 API（同样的管道），驱动者直接调 `webContents.executeJavaScript('selectors → 快照/点击')`。实现更少，但能力面窄（无 Input 域/网络域语义）。POC 与 4.1 对照后定稿。

## 5. 感知层：AX 快照为主，截图做证据

- **主通道**：`Accessibility.getFullAXTree`（必要时先 `Accessibility.enable`；若 Electron 需 AT 客户端才生成 AX 树，追加 `--force-renderer-accessibility` 启动开关——**POC 关键验证点**）。
- 序列化规则（契约见 §7）：展平为紧凑 JSON，仅保留 `{id, role, name, value, rect, clickable}`，丢弃重复/未命名节点，控制单帧 < ~4KB（可配置裁剪）。
- **DOM 兜底**：AX 覆盖不全时（如自定义 canvas），`DOM.getDocument` + 精简 `outerHTML` 或按 selector 定位。
- **证据**：`Page.captureScreenshot` 仅在最终验证、bug 复现、动作失败时生成，随汇报带给用户。

## 6. 执行层：CDP Input 为主，OS 注入兜底

| 场景 | 手段 |
| --- | --- |
| 应用内点击/输入/滚轮/快捷键 | CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent`（按快照 `rect` 中心或坐标） |
| 页面级操作 | CDP `Page.reload`（renderer 改动后的热重载路径，秒级反馈） |
| 应用外（托盘菜单、系统弹窗、别的窗口） | OS 兜底：koffi（已在依赖）→ `user32.dll` `SendInput`/`SetCursorPos`/`GetCursorPos` |
| 文本输入 | `Input.insertText`（先 `dispatchKeyEvent` 聚焦目标） |

## 7. 工具契约与集成（实现期在 `src/types/` 定稿）

### 7.1 工具面（agent 实际调用，命名空间 `desktop_test_*`）

```
desktop_test_start      # 构建+拉起被测实例（含 rebuild 选项）
desktop_test_relaunch   # 重建并重启被测（main 侧改动后）
desktop_test_reload     # 页面热重载（renderer 侧改动后）
desktop_test_snapshot   # 返回 AX 紧凑快照（agent 决策依据）
desktop_test_click      # 按 nodeId/selector/坐标点击
desktop_test_type       # 输入文本
desktop_test_key        # 按键（Enter/Escape/Tab/…）
desktop_test_scroll
desktop_test_wait
desktop_test_screenshot # 证据截图(png) → 可插入会话轨迹
desktop_test_assert     # 可选：结构断言（快照中是否存在 role+name/文本）
desktop_test_status     # 运行状态、连接、窗口、最近动作
desktop_test_stop
```

- 默认**不注入提示词**（settings 开关显式启用，沿用 `05-host-plugins.md` §6 克制原则）。
- 工具全部经由既有 `dsh-tools` 守卫执行管道；写类/销毁类动作走 approval。

### 7.2 bridge 方法族（renderer/外部可调，unary methodTable）

`desktop.test.start|stop|relaunch|reload|snapshot|action|screenshot|status|listTargets`（入 `src/types/channels.ts` 与 preload 白名单，受 `bridge.ts` zod 校验约束）。zod schema 草案（`src/types/testdrv.ts`）：

```ts
const TestTargetSpec = z.object({
  userDataDir: z.string(),                 // 临时隔离 profile
  entry: z.string().default('electron .'),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
})
const SnapshotNode = z.object({
  id: z.number(), role: z.string(), name: z.string(),
  value: z.string().optional(),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  clickable: z.boolean(),
})
const TestAction = z.discriminatedUnion('op', [
  z.object({ op: z.literal('click'), target: z.string(), x: z.number().optional(), y: z.number().optional() }),
  z.object({ op: z.literal('type'), text: z.string() }),
  z.object({ op: z.literal('key'), key: z.string() }),
  z.object({ op: z.literal('scroll'), dx: z.number(), dy: z.number() }),
  z.object({ op: z.literal('wait'), ms: z.number() }),
])
```

### 7.3 审计与错误

- 动作 → `desktop/action` 事件，action 名 `testdrv.start|stop|click|type|screenshot|…`（含会话 id 关联）；审计落盘复用 `forge-api.ts` 的 `userData/audit.jsonl`。
- 错误码入 `src/types/errors.ts` **5xxx 桌面段**（现 5000/5010 为快捷键/剪贴板，testdrv 从 **5020** 起）：`TESTDRV_NOT_ENABLED` / `TESTDRV_TARGET_MISMATCH`（防自毁）/ `TESTDRV_PIPE_CONNECT_FAILED` / `TESTDRV_CDP_DETACHED` / `TESTDRV_NO_WINDOW` / `TESTDRV_BUILD_FAILED`。
- 设置项：`desktop.testdrv.enabled`（默认**关**）、`desktop.testdrv.defaultProfile`（临时 userData 根）、`desktop.testdrv.devDebugPort`（§4.2 备用开关，默认关）。

## 8. 生命周期与迭代闭环

```
agent 改代码
 ├─ renderer/dist 侧改动 → npm run build → desktop_test_reload    （秒级）
 └─ main/主进程改动     → npm run build → desktop_test_relaunch    （重建+重启）
→ desktop_test_snapshot → 决策 → 动作 → snapshot 断言
→ 通过：desktop_test_screenshot 留证 + 审计收尾 → 汇报
→ 未过：继续修 → 循环（同一被测实例或 relaunch）
```

- **测试 profile 隔离**：被测实例 userData 用临时目录（`os.tmpdir()`/`desktop.testdrv.defaultProfile` 下按测试会话命名），与用户真实 userData 零交集；其 Cordis 配置只装最小 test 集（被测为 Forge 自身时指"test bundle"）。
- 与既有崩溃自愈互不冲突：被测实例不启用宿主侧的 relaunch 熔断（避免测试中重启被计数为崩溃）；驱动者侧保留。

## 9. 与现有测试体系的关系（互补，不替代）

| 层 | 载体 | 用途 |
| --- | --- | --- |
| 单测 | `node --test`（forge-api/bridge） | 契约与纯逻辑 |
| 组件 | client 插件 `?fixture` | renderer 注入面 |
| 脚本化 e2e | Playwright + Electron（roadmap 持续任务） | **回归**：agent 写完改完代码顺手跑脚本冒烟 |
| **真机探索 + dogfood 自动化** | **本设计（testdrv）** | agent 自主验收、探索式验证、日常使用自动化 |

推荐协作模式：**回归用 Playwright 脚本（快、便宜），探索/验收用 desktop_test_*（灵活、可断言）**；两者可共用同一"被测实例启动"基建（Playwright 不传 `--forge-test-driver` 即可）。

## 10. 里程碑与 POC（最小闭环验证清单）

规划并入 **M5「桌面工具 desktop_*（默认关）」**，作为该条目的第一个落地载体，不阻塞 M4 分发。

**POC（建议 2–3 天）**：验证最小闭环
1. spawn 被测实例：`--user-data-dir=<临时>` `--forge-test-driver=<pipe>`；
2. 命名管道连接 + `webContents.debugger` CDP 代理打通；
3. `Accessibility.getFullAXTree` 快照可用（含是否需要 `--force-renderer-accessibility` 的结论）；
4. `Input.dispatchMouseEvent` 点击后快照产生对应变化；
5. `Page.captureScreenshot` 留证。
**POC 成败标准**：上述 5 步全绿 + 单动作延迟 < 200ms + 无 TCP 端口。

**任务拆解（M5 并入后）**：
- T1 `forge-testdrv.ts` 模块：lifecycle + pipe 连接 + CDP 代理
- T2 感知序列化 + 快照裁剪 → `desktop_test_snapshot`
- T3 动作执行（CDP Input 主 + koffi 兜底）→ `desktop_test_*` 工具族
- T4 审计/审批/设置/错误码接入（§7）
- T5 renderer 热重载路径（`desktop_test_reload`）与 relaunch 路径
- T6 门禁：agent 完成一次真实闭环「改一行 bug → 自查 → 修复 → 截图留证」；与被测 Forge 自身 dogfood 合并验证
- T7（M5 包化）转 `@lansi-ai/dsh-forge-testdrv` 独立插件包

## 11. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 零端口红线被 remote-debugging-port 突破 | 主选命名管道；备用开关默认关 + 127.0.0.1 + 用后即关 + 豁免登记 |
| 驱动者误连/自驱动 | 实例指纹校验 + `TESTDRV_TARGET_MISMATCH` |
| AX 树覆盖不全（canvas/自绘 UI） | DOM 兜底 + OS 注入兜底 + 截图人工复核 |
| 双实例内存/CPU 开销 | 计入 R9（M5 性能实测表）；被测用完即 stop |
| 视觉/推理 token 成本 | 快照驱动为主，截图仅证据节点 |
| agent 误触破坏性动作 | approval 兜底 + 默认全关 + 审计全量留痕 |
| 被测实例生命周期异常（崩溃/卡死） | `desktop_test_status` 心跳 + 超时 relaunch；不触发宿主自愈熔断 |

## 12. 相关文档

- 决策：[ADR-009](adr/adr-009-ai-self-driver.md)
- 插件模型：[`05-host-plugins.md`](05-host-plugins.md)（§6 工具暴露克制原则）
- 实现地图：[`14-implementation-map.md`](14-implementation-map.md)（§9 桌面能力模块形态、§6 bridge 方法表）
- 安全模型：[`08-security.md`](08-security.md)（审批/审计/白名单）
- 路线图：[`09-roadmap.md`](09-roadmap.md)（M5 桌面工具条目、持续测试任务）