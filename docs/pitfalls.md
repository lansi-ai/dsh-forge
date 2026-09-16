# 实战踩坑记录（Pitfalls · 2026-08-26 攻坚第 2 批）

> 本文件记录 M1 攻坚「官方 UI 完成日常对话全流程」过程中实际踩到的坑与解法。
> 目的：**可复用的排障手册**，避免后续会话重复踩坑。
> 每个坑都标注：现象 → 根因 → 修复 → 复盘要点。

## 坑 0 · TRAE 沙箱拦截 Electron 启动（环境，非代码）

- **现象**：`npm run dev` 启动即报
  `TRAE Sandbox Error: Not allow operate files: ...\SogouPY\LOG\IME\electron_*.log`，且 `Start-Process` 拉独立 PowerShell 报 `0x800700e8 (ERROR_NO_TOKEN)`。
  同类实例（2026-09-01，版本号显示任务验证启动时）：报 `Not allow operate files: ...\Tencent\WeType\MM_TIP_*.xlog, ...\spool\drivers\color\sRGB Color Space Profile.icm`——**微信输入法（WeType）写自家 `.xlog` + Chromium 读系统色彩配置也各自触发同一拦截**。第三形态（2026-09-09，见坑 42）：拦**运行时数据目录** `E:\Projects\DSHPath` 的 `.credentials.yaml.lock` / `search-query.sqlite-shm`，表现为主进程先打印完装配日志再退出、报 `loader entries failed to apply`——**错误头像代码坑，根因在输出尾部**。
- **根因**：搜狗/微信输入法注入到 Electron 进程，启动时写自家 IME 日志，被 TRAE 沙箱拦截；Chromium 渲染时读取 Windows 系统色彩配置（`sRGB Color Space Profile.icm`）同样被拦（非输入法场景也可能触发）；沙箱内 `Start-Process` 无创建新 GUI 进程的 Windows 令牌。
- **解法**：Electron 是 GUI 应用，必须在**系统 PowerShell（沙箱外）**运行 `npm run dev`；日志经终端输出或重定向 `npm run dev *> app.log 2>&1` 后读取。构建/编译（`npm run build`）在沙箱内正常，仅**运行时**被拦。
- **复盘**：沙箱内无法代跑 Electron GUI，只能让用户外部运行并贴日志；诊断数据靠加临时日志 + 用户回传。拦截文件可能来自多套输入法（搜狗/微信）或系统色彩配置，任一触发即启动退出——先看报错尾部第一个被拦路径判定来源。

## 坑 1 · 官方驱动「全量激活图谱条目」导致 client-connection 抢占 connection

- **现象**：`404 dsh-ui://app/api/host.describe` + `[web-runtime] connection lost, retry #2 (dsh-client-connection/client.js)`。
- **根因**：官方 web boot 驱动（`index-*.js` 的 BootRunner）对图谱**每个条目**执行 `loader.create()` 全量激活；`immediately` 仅控制 prefetch 时机，**与激活无关**。所以「client-connection 入图但不置 immediately 即可不激活」是**伪命题**——入图必被激活，其 apply 抢先提供 Web 传输 connection。
- **解法**：`@deepseek-ai/dsh-client-connection` **不入图谱**，改为图谱外**预载注册**（`PRELOAD_ONLY_IDS` + `registerPreloadOnly`，注入脚本带出 preload script），仅注册 factory 供 `ipc-connection` require 继承基类；connection 服务由 `@lansi-ai/dsh-ipc-connection` 独占。
- **复盘**：官方 `dsh.client` 的 inject 是**模块加载依赖**（完整包名），与 Cordis 插件 apply 内的**服务注入**（服务名）是两层，不能混为一谈；剔除图谱前必须确认官方驱动激活语义。

## 坑 2 · host `apiProxy` 没有 `.handleRpc`（RPC 入口接错）

- **现象**：`[dsh-bridge] 收到 RPC 请求: host.describe` 后无任何成功/失败日志，UI 卡 loading。
- **根因**：官方 host-apiproxy 的 `ctx.apiProxy`（`ApiProxyService`）只暴露业务 domain（`.sessions/.host/.events/.respond`），**没有 `.handleRpc`**。main.ts 原代码调不存在的 `.handleRpc` → undefined → 静默走 fallback 抛错，且 bridge 的 `makeRpcError` 不打印。
- **解法**：host 侧正确的 RPC 入口是官方 **`toFetchHandler(api)`**。把 client-request envelope 经 `/api/<method>` 虚拟路由（不真正走网络）分发给 `api[domain][method]`，解包 `server-response` 的 `result.value`。
- **复盘**：接河上游服务前先读它的真实接口，不要凭名字猜 `.handleRpc`；host 侧复用官方 `toFetchHandler` 是协议对齐的关键。

## 坑 3 · `new Request('/api/...')` 相对 URL 抛错

- **现象**：`host.describe` 无应答 → 沙箱内实证 `Request FAIL: Failed to parse URL from /api/host.describe`。
- **根因**：官方 `toFetchHandler` 内部 `new URL(req.url)` 需要绝对 URL；相对路径构造 `Request` 直接抛错，promise reject 被 bridge catch 静默。
- **解法**：用虚拟 base `new Request('http://local/api/...')`，官方只读 `pathname`（`slice(5)` → `method`），虚拟 host 不影响路由匹配。
- **复盘**：跨层调用官方工具时，其内部对 URL 的绝对性假设要提前排查。

## 坑 4 · `rpcIdSchema` 用 `.uuid()` 过严拦截

- **现象**：bridge 收到请求但卡住，`校验通过` 阶段日志缺失（早期未加日志时）。
- **根因**：`rpcIdSchema = z.string().uuid()`，而 renderer 端 `ipc-connection` 的 `randomUuid()` 回退分支产出 `` `${Date.now()}-${Math.random()}` `` —— 非 UUID 格式，被 schema 拒绝。
- **解法**：放宽 `rpcIdSchema` 为 `z.string().min(1)`。官方 `RpcId` 本就是 branded string，不强制 UUID 格式。
- **复盘**：zod 边界校验别比上游契约更严，否则合法但非标准的值会被误拦。

## 坑 5 · 图谱缺 client UI 插件 → `mountApp` 永远等待（空白）

- **现象**：所有 RPC 全通、`connection.start` 被调用、`host.describe` 就绪判定成立，但 UI **纯 loading/空白**。
- **根因**：官方 web boot 的 `mountApp(ctx)` 依赖 `ctx.inject(["uiRenderer"])`；若图谱未装 client UI 插件，`uiRenderer` 服务不存在，`mountApp` **永远 await**（无激活报错，只是不下发）。我们最小激活集只含连接/API 面（6 个），缺全部 `ui-*`（约 33 个）。
- **解法**：**自动扫描方案** —— boot-graph 复刻官方 `ClientModuleRegistry`（`scanClientPackages`/`orderByModuleGraph`），从 `node_modules/@deepseek-ai` 自动发现全部 `dsh.client.platform==='web'` 包（42 个，含 33 个 ui-*），带官方 inject/external/immediately + 拓扑排序，替代手拼。
- **复盘**：官方 UI 渲染依赖完整 client roster，不是「最小连接集」；手拼 33 个条目极易漏，**复用官方扫描内核**是最稳路径。

## 坑 6 · host `pickDirectory` 崩溃（koffi 在 Electron 不兼容）

- **现象**：选择工作区后报 `FATAL ERROR: Error::New napi_get_last_error_info`（native 栈 trace），进程崩溃。
- **根因链**：
  - 基础包 `@deepseek-ai/dsh-host-directory-picker` 是**抽象基类**（无 `capability()` 实现），直接用会抛 `handler failure`。
  - 官方 `-auto` 版 `dsh-host-directory-picker-auto` 依赖 `webServer`+`loader`（零端口禁用了 webserver），无法激活。
  - `-native` 版用 koffi（Win32 FFI），在 Electron 主进程读取对话框路径时 `napi_fatal_error`，原生崩溃。
- **解法**：prepare 钩子里定义本地 **`ElectronDirectoryPicker extends DirectoryPicker`**（基类构造 `super(ctx)` 即 `ctx.provide('directoryPicker')`，是**真正的 Service 注册**），`capability()` 返回 `kind:'native'`，`pick(signal)` 用 **Electron 原生 `dialog.showOpenDialog`** 返回 `string|null`（对齐官方契约），稳定无 koffi。
- **复盘**：
  - `hostCtx['x'] = obj` 这种普通对象赋值**不满足 Cordis 服务注册**（inject 需真实 Service 实例），必须 `extends Service`。
  - 官方 `pick(signal)` 契约返回 `string|null`，不是 `{path}`；外层 host-apiproxy 再包 `{path: ...}`。
  - 同类「受宿主环境限制」的官方插件（依赖 webServer/native 库），优先用 Electron 原生能力替代。

## 坑 7 · `ui-onboarding` settings namespace 未注册拦截进入

- **现象**：点击内测声明「继续」报 `Error: settings namespace "ui-onboarding" is not registered`，被拦截进不去。
- **根因**：注册 `ui-onboarding` namespace 的插件是 `@deepseek-ai/dsh-client-ui-settings-general` 的** host 面**（`lib/index.js` 的 apply，`settings.register("ui-onboarding", schema)`），而 host 补丁未装配该条目；client 面经 `settings.mutate` 打到 host settings，找不到 namespace 报错。
- **解法**：host 补丁新增 `{ id: 'ui-settings-general', name: '@deepseek-ai/dsh-client-ui-settings-general' }`。
- **复盘**：双面插件（`dsh.client`）的 **node 面注册服务**、**client 面渲染 UI** 是两条独立装配路径；host 补丁缺 node 面会导致 client 经 remote 调用 host 服务时缺依赖。

## 坑 8 · 非 2xx 的 `unpackServerResponse` 直接 `res.json()` 会抛 `SyntaxError`

- **现象**：`dynamicCordisRunner/inventory` 等返回 `404 "not found"` 时，报 `Unexpected token 'o', "not found" is not valid JSON`。
- **根因**：`handleUnary` 对未命中路由返回纯文本 `not found`（status 404）；解包函数未判断 `res.ok` 就 `res.json()`，对非 JSON 文本抛 `SyntaxError`。
- **解法**：解包前先 `if (!res.ok) throw new Error(...)`，避免对错误响应做 JSON 解析。
- **复盘**：任何跨层解包先判 HTTP 状态；「not found」纯文本不能被当 JSON。

## 坑 9 · Cordis Service 子类构造器未转发 ctx → `Cannot read properties of undefined (reading 'reflect')`

- **现象**：启动报 `[dsh-desktop] ctx.desktop 聚合服务注入失败: TypeError: ... (reading 'reflect')`，栈指向 cordis 库 `new Service`（基类 constructor 内 `self.ctx.reflect.provide(name, self, ...)`）；而同为 prepare 阶段注入的 `compat-webserver` 却正常。
- **根因**：`desktop-api.ts` 实例化写成了
  `new (DesktopCoreService as any)(options?.auditLogPath)(ctx, 'desktop')`
  —— JS 实际解析为 `(new DesktopCoreService(auditLogPath))(ctx, 'desktop')`：子类只收到自定义参数，以**无参 `super()`** 调基类；Cordis `Service` 基类 `constructor(ctx, name)` 中 `this.ctx === undefined`，执行 `this.ctx.reflect.provide` 立即抛 TypeError。尾部 `(ctx, 'desktop')` 是对返回实例的误调用，毫无注册效果。
- **解法**：子类构造器签名对齐基类并把 ctx/name 显式转发：
  `constructor(ctx, name?, auditLogPath?) { super(ctx, name); ... }`，
  调用点改为 `new (DesktopCoreService as any)(ctx, 'desktop', options?.auditLogPath)`（与 compat-webserver.ts 已验证模式一致）。
- **复盘**：
  - Cordis `Service` 的注册动作发生在**基类构造内**（`ctx.reflect.provide`），`extends Service` 的子类**必须**把 `(ctx, name)` 作为前两个参数转发给 `super`；自定义参数一律排在之后。"先 new 再对实例补调用"是错误范式。
  - `(expr)(argsA)(argsB)` 两段实参拼起来"看起来像"正确签名，再叠加 `as any` 绕过类型检查，极具迷惑性；凡是 `extends Service` 的调用点，先确认 `super()` 是否真拿到了 ctx。
  - 排障捷径：在同一代码库搜同构用法（本次即 diff compat-webserver.ts 与 desktop-api.ts 的实例化行），最快锁定差异。

## 坑 10 · 插件列表不显示：inventory 等价面缺 `pluginInventory/list` + 第三方清单两线不同源

- **现象**：官方 UI 设置页「插件列表」Tab（`dsh-client-ui-settings-plugin-inventory`）读不到插件，主进程日志 `[dsh-bridge] RPC 未命中 unary 表，fallback apiProxy: pluginInventory/list`（随后 apiProxy 404）；且即使 `dynamicCordisRunner/inventory` 有数据，第三方插件也不在列表。
- **根因**（两层问题叠加）：
  1. **registerMethod 只覆盖了一个 remote endpoint**：`cordis-inventory.ts` 只注册了 `dynamicCordisRunner/inventory`（ui-cordis 插件面板用），而设置页「插件列表」Tab 走的是另一个官方 remote `pluginInventory/list`（`dsh-host-plugin-inventory` 包的 descriptor），未注册 → fallback apiProxy → apiProxy 无该 domain → 404 → 面板报「暂时无法读取插件」。评判"等价面是否齐"要看**消费方调用的每个 endpoint**，不能只看自己注册了哪个。
  2. **第三方清单两线不同源**：HTML 注入线（`dsh-ui-protocol.ts` 私有 `THIRD_PARTY_BUNDLES`）与 inventory 线（`buildCordisInventory()` 调 `generateBootGraph()` 未传 extraBundles）各持一份；即使 endpoint 命中，inventory 行也不含第三方插件。
- **解法**：
  - 收敛第三方清单为唯一源码：`boot-graph.ts` 导出 `THIRD_PARTY_CLIENT_IDS` + 安全解析 `buildThirdPartyBundles()`（单包解析失败 try-catch 跳过，不拖垮启动），`dsh-ui-protocol.ts` 与 `cordis-inventory.ts` 共用；`buildCordisInventory()` 改调 `generateBootGraph(undefined, buildThirdPartyBundles())`。
  - 补齐 `pluginInventory/list` 等价面：新增 `buildPluginInventorySnapshot()`（对齐官方 `PluginInventorySnapshot.entries` 契约：`entryId/moduleName/enabled/fiberPhase`，`fiberPhase: 'active'`），在 `registerCordisInventoryCompat()` 一并注册。
  - 实机验证通过：设置页「插件列表」显示 44 个插件（含 `@lnyanhongyan/dsh-opencode-usage`）。
- **复盘**：
  - 排障从 renderer 的**实际日志**定位 endpoint（本例 `pluginInventory/list`），不要停留在"我以为的入口"（`dynamicCordisRunner/inventory`）。
  - 官方 typert remote 每个包的 descriptor 是权威契约来源（`dsh-api-remotes/lib/client.js` 的 `TYPERT_REMOTE*` 表），实现等价面前先查它确认结果 schema（`{entries:[...]}` 而非数组）。
  - "能加载 ≠ 在清单里"：装载与清单两条路径必须共用同一配置来源。
  - pitfalls 落档时机 = **实机验证通过后**，仅"数据正确"而未确认 UI 闭环不得提前记录（教训：首轮只修到 inventory 数据就写字，被实机打回）。

## 坑 11 · 冷会话在清单中但未挂载：点「新会话」无反应（blank 复用跳过 session.create）

- **现象**（M3-b4 dogfood 发现）：点击「新会话」无任何反应，无网络请求；进入旧会话后 `skill.list` 报 `session "session-xxx" not found (not attached)`；`session.list` 正常返回含该会话。
- **根因**：上游 `session.list` 会把持久化冷会话列入清单（`summarizeCold`），客户端 `connectWorkspace`（dsh-client-runtime client.js:9857）**优先复用清单中的 blank session 直接返回，跳过 `session.create`**；但冷会话在 Host 侧无 live agent，仅 `agentFor` 解析器路径（session.prompt 等）会懒恢复，`ctx.agents.get()` 直读的方法（skill.list/cancel 等）全部 `not attached`。死锁点：客户端以为会话可用（在清单里），Host 认为不存在（没挂载），且**没有任何一方会主动触发重挂载**。
- **解法**：Host 启动后主动预热——`session-rewarm.ts` 遍历 `session.list`，对每个带 cwd 的非 subagent 会话调 `session.create { sessionId, cwd }`（走上游 `ensureSession → checkPersistedIdentity → agents.resume` 官方重挂载语义）；单会话失败仅告警不阻断启动。main.ts 抽取统一 `callApi` 入口供桥 fallback 与预热共用。
- **复盘**：
  - 「清单可见 ≠ 可交互」：冷/热会话双态是上游显式设计，桌面端零端口载体必须补上「启动期重挂载」这一环（上游 HTTP 部署同样存在此窗口，但其 web-startup 可能有预热，桌面 profile 自装配需自行兜底）。
  - 排障判据：`[dsh-bridge] 未命中 unary 表 fallback apiProxy: session.create` 日志**该出现而未出现** = 请求根本没离开 renderer，从客户端运行时（fixture/复用/守卫分支）找断点，而不是查主进程。

## 坑 12 · Typert remote 端点 404：apiProxy 不认领 `commands/list`（零端口缺 gateway 拦截链）

- **现象**：新会话可创建，但输入 `/` 无命令列表，终端 `[dsh-bridge] RPC 失败 (commands/list): api 调用失败: HTTP 404`。
- **根因**：`commands/list`、`commands/execute`、`fileReferences/list`、`goals/*`、`dynamicCordisRunner/*` 等是 **Typert remote** 端点（`@deepseek-ai/dsh-commands` 等），不走 apiProxy 的 domain 方法表；上游 HTTP 部署由 `typert-gateway`（`TypertGatewayService`）经 `connection.rpc.intercept('/api', ...)` 认领分发。桌面零端口下客户端 connection 被替换为 IPC 载波，`ctx.connection` 这条拦截链不存在，apiProxy 对这些端点返回 404。
- **解法**：main.ts `callApi` 在 apiProxy 返回 404 时 fallback 到 `hostCtx.get('typertGateway').invokeRpc(method, params)`（协议逐字对齐上游：payload 为 `{args}`、返回 `{ok, value|error}`）。
- **复盘**：
  - **Cordis service 注册名 ≠ cordis 条目 id**：`TypertGatewayService` 构造器 `super(ctx, "typertGateway")`（camelCase 服务名），而 boot-graph 里条目 id 是 `typert-gateway`（kebab-case）——`ctx.get()` 必须用服务名；首轮用错名拿到 undefined，fallback 静默失效，二轮才定位。
  - 上游分发有三条通道：apiProxy domain 方法（session.*）、Typert gateway（commands/*、goals/*）、connection 直拦截——等价面必须逐条核对 `dsh-api-remotes/lib/client.js` 的 descriptor 表确认归属，不能假设全走 `/api` 一种语义。
  - `dsh-cordis-host-runner`（`dynamicCordisRunner/*` 的宿主）依赖 `tools` 服务链，桌面 MVP 未装载，其 404→service-unavailable 属已知限制，登记后续补。

## 坑 16 · overlay 补丁不带 insert 键 = 静默 no-op：dsh-agent-presets 从未装载（设置页 Agent 预设纯空白）

- **现象**（M3-b4 dogfood 发现）：设置页「Agent 预设」导航入口可见，点进去内容区**纯空白**——无报错、无 loading、无任何文案；终端无 `[dsh-bridge]` 相关 RPC 失败日志（请求成功返回了空数据面或组件直接 return null）。
- **根因**：cordis-plugin-include 的 `applyEntryPatches`（lib/index.js）对**非 insert 补丁**（`{id, name, config}` 形态）只做「按 id 覆盖已存在条目」；条目不存在时 `warn("patch: entry %C not found")` 后**静默跳过**，绝不插入新条目。桌面根配置是空 `[]`（所有条目全靠 insert 进树），boot.ts §4 的 `agent-presets` 条目（携带 name/config 但**不带 insert 键**）因此从 desktop-patch.yml 迁移起就是 no-op——`dsh-agent-presets` 插件从未装载，`ctx.get('agentPresets')` 为 undefined。而官方 UI 侧（dsh-client-ui-agent-preset）对「空 roster」与「服务未装载」两种态**均渲染 null 不报错**（空 roster 是上游认定的合法部署态），把装配层断点完全吞掉。apiProxy 的 agentPret handler 虽会报 "this deployment composes no agent presets"，但只在显式调用时触发，页面空态先短路。
- **解法**：
  - 把 `agent-presets` 条目并入 §4 的 `insert` 数组（与 storage 三件套同列），经 insert 真正进插件树；
  - main.ts bootstrap 加启动期诊断探针（第 3.5 步）：Host 就绪后 `ctx.get('agentPresets')`（camelCase 服务名）实扫一次 `list()`，服务缺失 / 扫描为空 / 抛错三种异常 `console.error` 必显——空白类问题以后终端即第一现场。
- **复盘**：
  - **「补 name 即装载」是伪心智模型**：include 补丁的 id-覆盖与 insert 是两条不相交路径，空根配置下非 insert 补丁 100% 无效；写补丁时先问「这个条目经哪条路径进树」。R8 当年「agent 预设点验通过」实系误判（很可能只验了页面可进未验内容）。
  - **页面「合法空态」是装配 bug 的最佳掩体**：上游把「无预设」设计为合法部署（return null），桌面端任何装配断点都会被折叠成同一种纯空白；对这类静默空态面，必须在宿主侧加「扫描结果必显」探针对冲。
  - 排障判据：**服务装载类断点不要从 renderer 找**——空 roster / 未装载 / 渲染异常三者在页面侧同形，直接在主进程 `ctx.get(服务名)` 一测即分叉。

## 坑 17 · 注入脚本模板字符串嵌套反引号 = TS 编译错误（titlebar 自绘注入面）

- **现象**：`src/desktop-host/titlebar.ts` 的注入脚本（`executeJavaScript` 字符串）内使用模板字符串内插（如 `${BORDER}`）且脚本体里再写反引号，`tsc` 直接报语法错误，编译失败。
- **根因**：注入脚本是「字符串里的代码」，存在两层解析——外层 TS 模板字符串的 `` ` ``/`${}` 先被主进程编译器消费；脚本体内再出现反引号或 `${` 会被当成外层模板的终止符/内插表达式，产生嵌套冲突。写入的是 renderer 侧代码，但解析错误发生在主进程编译期。
- **解法**：注入脚本内的常量（颜色、尺寸等）不使用内插，直接写字面量（如 `rgba(0,0,0,0.10)`）拼进脚本字符串；确需内插时外层改普通字符串拼接或对 `${` 转义（`\${`）。
- **复盘**：「字符串即代码」的注入面（`executeJavaScript` / `insertCSS` / bundle factory 源码）写模板字符串前先问**两层解析归属**——哪些 `${}` 归主进程编译期、哪些归 renderer 运行期；编译期报错是最好的保险，同理推断：若嵌套冲突侥幸过编，错误会延迟到 renderer 运行期才炸，更难定位。

## 坑 18 · 同文件多处编辑并发覆盖：CLIENT_EXCLUDE_IDS 排除项静默丢失（实机双注册冲突）

- **现象**：M6-P3 侧栏壳实机验证报 `failed to apply loader entry (@deepseek-ai/dsh-client-ui-sidebar): single slot "sidebar" already has a registration (registered by B5)`——官方 ui-sidebar 未被排除仍激活，与新壳双注册冲突。dist 产物反查：`boot-graph.js` 有 desktop-sidebar 注册但 **CLIENT_EXCLUDE_IDS 无 ui-sidebar**，而源码当时的两次编辑都「报告成功」。
- **根因**：对**同一文件**的多处 SearchReplace 编辑在同一批次并发执行时相互覆盖——各编辑基于同一初始快照独立写回，后写者覆盖先写者，且先写者的「成功」报告是假象。本会话累计发生 5 次（active-context.html ×3、active-context.md ×1、boot-graph.ts ×1），全部为静默失败：typecheck/lint 不报（语法合法），仅运行期或产物核验才暴露。
- **解法**：同一文件的多处编辑**严格串行执行**，每处编辑后立即 Read 复核目标区域；多编辑任务收尾用构建产物（dist）grep 反查源码状态（产物有/没有某符号 = 源码编辑是否真落盘）。
- **复盘**：编辑工具的并发写覆盖是「静默失败」类别——所有常规质量门禁（typecheck/lint/测试）都测的是「代码逻辑对不对」，测不出「编辑是否真的落盘」；**落盘核验（Read 反查 + 产物 grep）是独立且必须的第三类自检**。批量编辑任务的时间收益远低于一次静默丢失的排查成本。

## 坑 19 · 官方运行时动态样式覆盖同特异性规则：#root 内缩「规则在却不生效」（右底边距失效 + 底部溢出 32px）

- **现象**（M3-c3/M6-P3 实机验证）：主区右/底 15px 边距完全失效，底部设置行与输入框被窗口裁切（溢出量 ≈32px）；而 `#root{position:fixed;top:32px;...}` 在插件 CSS 与 HTML 骨架**两处都存在**且注入顺序占优，却「不生效」。
- **根因**：官方 UI **运行时动态注入**的样式表（JS append 到 head 末尾，晚于插件 style 与 head 内骨架 `<style>`）以**同特异性**覆盖 `#root` 的 position → fixed 被改为 relative/默认。指纹特征：`top:32px` 在 relative 下作为偏移仍「生效」（内容整体下移 32px，疑似标题栏让位正常），但 `bottom/right` 失效 → 内容 = 100% 高 + 32px 偏移 = 底部恰好溢出约 32px。截图里「内容下移 + 底部截断」组合就是该指纹。
- **解法**：规则强化为 `html body>#root{position:fixed!important;top:32px!important;...width:auto!important;height:auto!important}`（后代前缀提特异性 + important 双保险）；插件 `injectStyles()` 与 `LAYOUT_SKELETON_CSS` 两处同步。
- **复盘**：①**「规则存在 ≠ 规则生效」**——CSS 层叠胜负 = 注入时机 × 特异性 × important，宿主页面的官方样式要假定会以动态 style 随时追加，自绘样式一律 important 化或提特异性；②截图证据要精读：「内容整体下移 + 底部恰好溢出等量」是 position 被降级的指纹，不是「边距没写」。

## 坑 20 · 不要用 CSS 覆盖官方 #root 的定位/缩放（破坏官方案例自适应，窗口放大布局不变）

- **现象**（M3-c5 实机）：窗口放大后布局**不跟随**，内容被压缩在左上、右侧/下缘大片空白；DevTools 实测 `#root` 尺寸锁死（876×960，不随窗口）+ 布局 frame 宽度 `frameW=0`（ResizeObserver 读不到真实宽 → 永不重算列宽）。
- **根因**：官方 `html,body,#root{height:100%}` 让 `#root` **原生自适应窗口缩放**（这是官方案例设计好的）。早期为做「托盘边距/圆角」，用 `position:fixed`+`inset` 强制定位 `#root`，反而**覆盖掉了它官方的 `height:100%` 自适应逻辑** → `#root` 尺寸不再随窗口重算 → 布局 frame 收不到新宽度 → 放大不变。后续又试「`#dsh-root` 套壳 B-0」（再包一层接管缩放）——**过度**，用户纠正「官方根容器没问题，不需要动」。
- **解法**：**回归官方 `#root` 原生自适应**——不碰它的定位，只做视觉垫层：`html body>#root{box-sizing:border-box!important;padding:calc(var(--dsd-titlebar-h) + 8px) var(--dsd-frame-gap) var(--dsd-frame-gap) var(--dsd-frame-gap)!important;margin:0!important}` + 内层卡片 `#root>div:first-child{border-radius:12px;overflow:hidden}`。托盘边距用 `padding`（不改变文档流/定位），圆角用内层选择器——**官方 `#root` 照常缩放，布局跟随**。
- **复盘**：
  - **官方「挂载骨架」是提前设计好的自适应机制，不要用 CSS 强制定位去覆盖它**——尤其 `position/fixed/height`。要加边距/圆角这类视觉，优先用 `padding`/内层选择器/`box-sizing`，**不改变官方容器的定位与尺寸逻辑**。
  - **「放大布局不跟随」的判据**：`#root` 尺寸恒定（不随窗口重算）+ 内容被压左上 + 四周空白 = 官方 `#root` 的自适应被我们覆盖破坏了；应回退到「官方自适应 + 视觉垫层」，而非再包一层。
  - **「适配器/不改官方」不等于「不能碰官方元素」**——可以给官方 `#root` 加视觉（padding/圆角），但**不能改它的定位/缩放/结构**；改定位=破坏它设计好的行为，改结构=侵入。边界是「只加不破坏」。

## 坑 21 · 外观服务注入无单位 CSS 变量：`var(--dsd-*)` 解析非法 → 高度退化 auto（标题栏/按钮变小）

- **现象**（2026-08-28 布局/titlebar 调整）：把 `--dsd-titlebar-h` 设为 50 后，标题栏与窗控三钮反而**比原来还小**（`height` 变成内容高）；且窗口放大时 titlebar 变大、侧栏/对话区高度不变。
- **根因**：`desktop-appearance.ts` 的 `resolveVars()` 用 `String(cfg.titlebarH ?? 50)` 注入，`--dsd-titlebar-h` 被写成 **`50`（无单位）**。CSS 里 `height: var(--dsd-titlebar-h, 50px)`：var 已定义（值为非法的 `50`），所以 **`50px` 兜底不会触发**；`height: 50` 是非法长度 → 属性回退初始值 `auto`（按内容高）→ 标题栏/按钮被内容高度撑小。同理 `--dsd-card-radius`（`12` 无单位 → 圆角失效）、`--dsd-frame-gap`（`15` 无单位 → 边距失效）。骨架 `:root` 的 `50px` 被外观 `html:root{--dsd-titlebar-h:50}`（无单位、特异性更高）覆盖。
- **解法**：`resolveVars()` 对长度类变量加单位——`const px = (v) => typeof v === 'number' ? `${v}px` : String(v)`，`cardRadius/frameGap/titlebarH` 一律走 `px()`（产出 `50px`/`12px`/`15px`）。
- **复盘**：① **`var(--x, fallback)` 的 fallback 只在变量「未定义」时生效；变量「已定义但值非法」（如无单位长度）时 fallback 不触发**，属性直接取非法值 → 回退初始值。排查"CSS 变量长度不生效"先检查注入的变量值**是否带单位**。② "窗口放大后 titlebar 变大 / 内容区不伸缩"直观像 grid 布局问题，根因常是某个 `height: var()` 解析失败退回 auto；**先用 DevTools 看 computed height** 再改布局结构，避免误判（本会话先怀疑 grid 排列，实为变量无单位）。

## 坑 22 · `apiProxy` 整体对象 vs `apiProxy.events` 传参混淆致 `TypeError: options.events.mux is not a function`

- **现象**：应用启动即崩溃，终端报 `TypeError: options.events.mux is not a function`，堆栈指向 `theme-sync.js:79 installThemeSync`。
- **根因**：`main.ts` 调用 `installThemeSync` 时传 `events: apiProxy as unknown as DownlinkEventStream['events']`——把完整 `apiProxy` 对象（结构 `{ events: { mux, host }, ... }`）直接强转成 `events` 参数。`theme-sync.ts` 内部调 `options.events.mux(...)` 实际变成 `apiProxy.mux(...)`，而 `apiProxy.mux` 是 undefined（正确路径为 `apiProxy.events.mux`）。强转 `as unknown as` 绕过了 TS 类型检查，编译不报但运行时炸。
- **解法**：`main.ts` 改为 `events: apiProxy.events`，直接传递 `{ mux, host }` 结构；去掉 `as unknown as` 强转（TypeScript 能自动校验结构匹配）。
- **复盘**：① 跨模块传递嵌套结构时，**先在脑中（或写在注释里）确认「我传的是哪一层」**——`apiProxy.events`（层 1）vs `apiProxy`（层 0），差一层就全错。② `as unknown as T` 双强转 = 把类型系统当瞎子用；如果必须用，先写清楚目标类型 `T` 和源类型 `S` 的结构差异，确认字段存在。③ 主题同步（`theme-sync.ts`）从单路订阅改为双路（`mux + host`），因为 `settings/document-updated` 是 Host 级事件，可能通过 `host` 流传递而非 `mux` 流。排查事件"不触发"时，检查事件在哪条流（`carrier-relay.ts` 有明确注释：`mux = 会话事件流，host = 宿主流`）。

## 坑 23 · 标题栏跨槽位渲染品牌崩溃：`renderSlot('sidebar.brand.*')` 违反槽位所有权（左上角 DeepSeek 品牌消失）

- **现象**（M6-P2 自绘 titlebar）：把品牌区（logo + 品牌名）从 sidebar 迁到自绘标题栏后，**左上角 DeepSeek 鲸鱼 logo + harness 字样消失/空白**；标题栏其余部分（窗控/折叠）正常。
- **根因**：初版 titlebar 用 `renderSlot('sidebar.brand.mark', ...)` / `renderSlot('sidebar.brand.name', ...)` 渲染品牌——但 `renderSlot` 的 `SlotOwnershipError` 检查规定：**一个槽位组件只能渲染它自己在 children 声明里声明的子槽位**。`titlebar` 槽 children 未声明 `sidebar.brand.mark/name`（那是被排除的官方 `ui-sidebar` 声明的子槽位），跨槽位调用直接抛 `SlotOwnershipError` 崩溃 → 品牌区不渲染。品牌在「哪个槽位可用」由槽位所有权决定，与品牌组件是否已注册无关。
- **解法**：不再经槽位，改为**直接 require 官方品牌组件渲染**——`getOfficialBrand()` 内 `require('@deepseek-ai/dsh-client-ui-primitives')` 取 `FishLogo`（鲸鱼 logo）+ `BrandWordmark`（DeepSeek 字标），渲染到标题栏品牌区；`BrandWordmark` 用 `includeMark:false`（mark 已单独渲染，避免重复）。该模块必被 loader 注册（被激活的官方 `dsh-client-ui-brand-official` bundle 引用它），`require` 即可解析。解析失败回退内置占位（深色圆角块 + 品牌名），不崩标题栏。
- **复盘**：① **自有插件接管某槽位后，若想展示不属于自己 children 声明的官方子槽位内容，应「直接集成官方组件」，不要用 `renderSlot` 跨槽位**——槽位所有权是渲染面红线，`renderSlot` 只能渲染本槽自己声明的子槽位（坑 23）。② 官方品牌组件来自 `@deepseek-ai/dsh-client-ui-primitives`（被 `ui-brand-official` 消费，注册 `sidebar.brand.*` / `conversation.hero.brand.mark` 三个槽位，见其 `client.js`），跨槽位/跨插件复用官方品牌元素直接 require 该包最省事。③ 排查自绘插件渲染空白：先看是否有 `SlotOwnershipError`/`StaleAuthorizationError` 被 catch 吞掉——跨槽位调用常以「组件崩溃 → 区域空白」呈现，非报错红字。

## 坑 24 · 启动期 unary 报 404 / arguments-invalid：自研调用未对齐官方 /api wire 契约（非启动时序）

- **现象**（0.1.2 升级后，自研启动 unary——theme-sync 读 settings、session-rewarm 重挂载冷会话）：按顺序冒出三段不同错误——① `api 调用失败: HTTP 404`（settings.describe / session.create）；修掉后变 ② `Remote payload must contain exactly one plain-object args field`；再修掉后变 ③ `args fields do not match the descriptor: missing "_request"`。**每改一处就推进到下一段报错→说明是 wire 契约多层不对齐，不是启动时序竞态**；renderer 官方 client 天生满足全部三层，所以桌面 UI 正常、仅自研启动调用全挂。
- **根因**（三层，按现象①→③对应）：
  1. **端点分隔符**：官方 `dsh-api-gateway` 的 `/api` interceptor 认领判定 `claimsEndpoint(endpoint)` 只认**斜杠两段 `domain/method`**（`settings/describe`）；点分单段 `settings.describe` `split("/")` 长度 1 → 判 false → HTTP 404。
  2. **payload 信封**：认领通过后，typert `remoteRequest` 要求 payload **恰好一个 plain-object `args` 字段**（`{ args: {...} }`）；裸 `params` 传过去（0 字段）被拒 → `Remote payload must contain exactly one plain-object args field`。
  3. **签名参数名**：`args` 内字段名必须匹配端点签名参数（如 `session.list(request=_request)`、`session.create(request)`）；缺 `_request` → `missing "_request"`。
- **解法**：main.ts `callApi` 统一入口做两层 wire 规范化——① 点分→斜杠（`method.includes('/') ? method : method.replace(/\./g, '/')`）；② 裸 `params` 幂等补包为 `{ args: params }`（renderer 已发 args 包则放行）。端点签名参数名在各调用方对齐：session-rewarm 改 `session.list → { _request: {} }`、`session.create → { request: { sessionId, cwd } }`。theme-sync 的 `settings.describe` 参数可选、裸 `{}` 即可。
- **复盘**：① 自研 hand-rolled 调用走官方传输，**必须刻对齐官方 wire 契约**（端点分隔符 + payload 信封 + 签名参数名），不能假设"升级前能用=升级后一样"——0.1.2 是破坏性重构。② **持续 404 ⟺ 时序竞态的归因是陷阱**：时序竞态应是「间歇性、窗口加载后自愈」；**必然、持续、逐层推进的报错通常是 wire 形态不对**，优先查分隔符/信封/参数名三层，而不是加盲目重试掩盖。③ 统一入口（callApi）承载分隔符+信封规范化，调用方只对齐签名参数名，责权清晰。

## 坑 25 · Web 端专用 client 半点名入渲染图谱：宿主已禁用对端仍产生 404 噪音（/plugins/events + dynamicCordisRunner/syncInspectManifest）

- **现象**（0.1.2 升级后，`npm run start` 启动即刷 4 类噪音）：
  ```
  [dsh-ui-protocol] 404 dsh-ui://app/plugins/events (ENOENT: ...plugins/events)
  [dsh-bridge] RPC 失败 (dynamicCordisRunner/syncInspectManifest): api 调用失败: HTTP 404
  [renderer-ERROR] [cordis-client-runner] syncing inspect providers failed: ... HTTP 404
  (electron) 'console-message' arguments are deprecated ...
  [renderer-WARN] Electron Security Warning (Insecure Content-Security-Policy) ...
  ```
- **根因**：桌面**宿主侧**（boot.ts §3）已禁用 `client-hmr`/`cordis-client-runner`/`cordis-host-runner`，但**渲染侧图谱**（boot-graph.ts `scanClientPackages` 自动扫描全部 `dsh.client.platform==='web'` 包）仍把它们收进 entries 并激活——
  ① `dsh-client-hmr` 客户端 apply 订阅 dev SSE `/plugins/events`（`EVENTS_ENDPOINT`），桌面零端口无该宿主服务 → 经 dsh-ui:// 协议落到 `resolveRelative` 读不存在的文件 → ENOENT 404（且可能重连轮询反复刷）；
  ② `dsh-cordis-client-runner` 激活即 `ctx.remote.dynamicCordisRunner.syncInspectManifest(providers)`，对端 host runner 禁用 → 404 → `throw` → renderer `[cordis-client-runner] syncing inspect providers failed`。
  ③ `console-message` 旧多参回调是 Electron 已标 deprecated 的 API 签名。
  ④ CSP 警告 = 官方 dist `index.html` 无 `Content-Security-Policy` meta，Electron dev 下提示（打包后不出现）。
- **解法**：
  - boot-graph.ts `CLIENT_EXCLUDE_IDS` 加入 `@deepseek-ai/dsh-client-hmr`、`@deepseek-ai/dsh-cordis-client-runner`、`@deepseek-ai/dsh-client-ui-cordis`（面板依赖 runner 的 `dynamicCordisRunner` 面服务，排除 runner 要连面板一起，否则 `ctx.dynamicCordisRunner` 为 undefined 崩 `runner.getSnapshot()`）。插件清单仍经 `cordis-inventory.ts` 兼容面（`pluginInventory/list`）在设置页查看，不受影响。
  - main.ts + window-manager.ts 的 `webContents.on('console-message')` 改现代单对象签名 `(event) => { event.level/message/lineNumber/sourceId }`（旧多参回调 deprecated）。
  - 转发层按 `event.message.includes('Electron Security Warning')` 滤掉 CSP 已知无害警告（dev-only）。
- **复盘**：
  - **「宿主已禁用 ≠ 渲染端不会跑」**：零端口/桌面 profile 里，host 补丁禁用某 Web 基础设施，**必须同时把它的 client 半点从渲染图谱的自动扫描中排除**，否则对端缺席的客户端激活会持续 404 刷屏。宿主禁用与 CLIENT_EXCLUDE_IDS 是**两条正交装配线**，都要关这扇门。
  - **排除一个注入型插件要连其消费方一起**：若某插件被其他插件的 `dsh.client.inject` 当服务依赖（如 ui-cordis 用 runner 的 `dynamicCordisRunner` 面），单独排除提供方会崩消费方；判断标准=对方 `apply()` 是否**直接 `ctx[服务]` / `ctx.get()` 该服务**（`inject` 仅是拓扑顺序提示，不等于服务存在）。
  - **官方 dist 无 CSP 的 Security Warning**：Electron 明确「打包后不出现」，属 dev 专属提示；不要在官方 dist 上硬加 CSP 破坏动态模块系统（需 unsafe-eval），转发层过滤该已知消息即可。

## 坑 26 · ui-* 双面包装配不全：host 半漏装（settings namespace 未注册）+ theme/change 消费者丢失（切外观无效果/深色显示错误）

- **现象**（0.1.2 升级后链式三连，2026-09-01）：
  ① 设置页切外观报 `settings namespace "ui-theme" is not registered`（`[dsh-bridge] RPC 失败 (settings/mutate)`）；
  ② 补装后不再报错，但点击切换界面零变化；
  ③ 再补后主卡（官方 UI）正常切深，titlebar 行 + 侧栏列仍是浅色（侧栏会话文字发灰难读）。
- **根因**（三层独立缺口，逐层暴露）：
  ① `ui-theme` namespace 由官方 `dsh-client-ui-theme` 的 **host 半** `apply()` 注册（`settings.register('ui-theme', ThemeSettingsSchema)`）。boot.ts §1 只补了 `ui-settings-general`（ui-onboarding），漏装同类 4 个双面包 host 半：`ui-theme`/`locale`/`ui-chat`/`ui-conversation`（官方 web-app cordis.patch.yml L177-199 全有）。client 半经 settings.mutate 写偏好 → host `dsh-settings` 注册表查无此 ns → 拒绝。
  ② 官方 theme 链路是**发布/应用分离**：`ui-theme` client 半只做 settings 读写 + 发布 `theme/change` 事件；把主题应用到 DOM（根 `color-scheme`、body `data-ds-dark-theme`、`--dsh-content-font-size`、token 变量、theme-color meta）的是**官方 `ui-layout` 的 ThemePresenter**（订阅 `theme/change`）。M6-P1 自研布局接管 root 槽位排除 `dsh-client-ui-layout` 时，ThemePresenter 被连带丢掉 → 事件发布后无消费者。
  ③ titlebar 行/侧栏列本身透明，透出宿主托盘底色 `--dsd-tray-bg`（硬编码浅色）；自绘 CSS 另有多处硬编码黑色系 + 侧栏根声明 `color-scheme: light dark`（改随 OS 偏好而非应用主题）。
- **解法**：
  ① boot.ts §1 补装 4 个 host 半条目（`ui-theme`/`locale`/`ui-chat`/`ui-conversation`；排查口径=全库 grep `settings.register(`）。
  ② `desktop-layout-client.js` 增设等价 `ThemePresenter`（初始 `ctx.theme.getTheme()` + `ctx.on('theme/change')` 实时应用 + dispose 回撤），`inject: ['slots','theme']` 原已声明。
  ③ 托盘底色与自绘硬编码色全改 CSS `light-dark()` 双值（`--dsd-tray-bg: light-dark(rgb(242 243 245),rgb(28 28 30))`，boot-graph 骨架 + desktop-appearance 两处同源；titlebar/sidebar hover/边框/标签色同步）；删除侧栏根 `color-scheme: light dark` 声明，继承 presenter 写在根元素的主题方案。
- **复盘**：
  - **「双面包」插件两条装配线都要点名**：官方 ui-* 多为 node+client 双半；client 半由渲染图谱自动扫描，**host 半必须在 boot.ts 显式 insert**——升级/迁移时对照官方 cordis.patch.yml 的 insert 段逐行核对，不能只补报错的那一个（同口径一次性补齐同类）。
  - **排除官方插件 = 排除它的全部职责**：接管 root 槽位排除 ui-layout 前，要盘点它承载的所有 effect（root 注册 + ThemePresenter + …），被排除的职责须在自研件中等价补齐；「事件有人发」不等于「有人消费」。
  - **壳层配色不要硬编码单值**：自绘 CSS 一律用 `light-dark()` 双值或官方 token；并避免元素级 `color-scheme` 声明劫持主题跟随（会改随 OS 偏好）。

## 坑 27 · 自绘设置 section 硬编码深色 + grid 子项 min-content 撑破（外观页浅色不可读 + 卡片横向溢出面板）

- **现象**（2026-09-04，用户截图）：设置页「外观」在浅色配色主题下标题/说明/卡片边框几乎不可见（发白）；图标包卡片不落在 640px 容器内，图标排成一长条冲出面板右边界，包内图标越多（上传的 custom 包）溢出越严重。无任何控制台报错——纯渲染问题。
- **根因**（三处独立）：
  ① 样式全部**内联硬编码深色值**（`color:#f8fafc`、`rgba(255,255,255,0.08)`、`rgba(0,0,0,0.25)`），未取官方 token，明暗主题完全不跟随。
  ② **grid 子项默认 `min-width:auto` = min-content**：外层 `repeat(auto-fill,minmax(180px,1fr))` 的卡片未设 `min-width:0`，而卡片内层是 `repeat(4,1fr)` 预览网格、每格带 `white-space:nowrap` 的文件名标签（`maxWidth:72px`）→ 卡片 min-content ≈338px 反顶轨道宽度，3 条轨道合计 ≈1034px 撑破 ≈564px 的内容区（`auto-fill` 只保证「轨道不小于 min」，不封顶）。
  ③ section 自带 `padding:16px 24px` + `maxWidth:640px`，与自研设置外壳 `.dss-options` 已有的 `padding:0 24px 24px` 叠加 → 双重缩进、与其它 section 不一致。
- **解法**（`desktop-theme-client.js` V2 重构）：
  ① 样式改为注入式 `<style data-plugin="@lansi-ai/dsh-desktop-theme">` + 官方 token 取色（`--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-border-l2/l3/l4`、`--dsw-alias-bg-layer-1`、`--dsw-alias-fill-tsp-secondary`、`--dsw-alias-brand-primary`、`--dsw-alias-bg-multi-select`、`--dsw-alias-state-success/error-primary`），明暗自动。
  ② 三层防溢出：卡片 `min-width:0`、内层预览网格 `repeat(4,minmax(0,1fr))`、预览格固定 24×24 **不带文本标签**（文件名移到 `title` 悬浮）；版式同时精简为「代表图标 4 枚 + 包名 + 图标数 + 选中态」。
  ③ 删除 section 自带 padding/maxWidth，宽度约束交回外壳（根节点 `width:100%;min-width:0`）。
- **复盘**：
  - **自绘 UI 禁内联硬编码色值**：一律注入带 `data-plugin` 的样式表 + 官方 `--dsw-*` token（或 `light-dark()` 双值），否则浅色主题必不可读；这与坑 26 的「壳层配色不硬编码单值」同源，但 section 内容层同样适用。
  - **内容宽度不可控的 grid/flex 卡片必须显式 `min-width:0`**：`minmax(180px,1fr)` 不封顶，子项 min-content 会反向撑破轨道；`nowrap` 文本标签是撑破的头号来源——缩略图类网格应固定单元格尺寸 + 文本进 `title`。
  - **section 不重复承担外壳的间距职责**：设置外壳 `.dss-options` 已提供内边距与滚动容器，section 根节点只做自身布局。

## 坑 28 · 主题图标清单无单一真源：设置页退化成文件罗列，且 app/tray 槽位根本无法经上传补齐

- **现象**（2026-09-04，用户澄清需求）：「图标引用清单」只列激活包里**已有**的文件名，用户看不出系统/插件**需要**哪些图标、该叫什么、放哪；顶部「上传图标」恒把文件写进 `custom/icons/`，而 app/tray 四件套的约定位置是**包根**——上传永远补不齐应用/托盘图标。
- **根因**（两层）：
  ① 槽位知识分散在三处消费方源码（host `ICON_FILES` 包根约定、settings-shell 的 `settings-nav-<id>.svg`/`settings-trigger.svg`、titlebar 的 `titlebar-logo.svg`），设置页手上只有「包目录扫描结果」，语义天然错位——文件系统能回答「有什么」，回答不了「该有什么」。
  ② 上传 API 无参数（`upload()` 恒 `icons/<sanitize(原文件名)>`），既不知道目标槽位也不知道目标目录，格式/尺寸/回退更无从校验。
- **解法**：host 新增 `ICON_SLOTS` 注册表（**单一真源**：`id/label/group/file/format/size/fallback`，13 位 = 包根 app/tray × 明暗 4 + `icons/` UI 位 9）；`desktop.iconTheme.list` 下发 `slots`（`provided` 相对激活包 `existsSync` 判定）+ `uploadDir`；`desktop.iconTheme.upload({slotId})` 改槽位驱动：对话框按槽位格式单选 → 以规范名 `join(custom 包, slot.file)` 落盘（`mkdir(dirname(target))` 自动建子目录）→ **重扫主题表**（首传的 custom 包必须进表，否则协议层 `resolveThemeDir` 查不到 → 404）→ custom 正激活时 `onThemeChanged()`（宿主窗口/托盘）+ 下行 `theme.icon-change`（各窗口 UI）双刷新。设置页只渲染 host 下发的清单，不再自行派生文件名。
- **复盘**：
  - **「清单类」UI 的数据源必须是需求注册表，不是文件系统扫描**：有回退链的槽位（缺了也能跑）尤其危险——静默回退会把缺口永久藏住，用户以为生效了。
  - **新增图标消费点必须同处登记 `ICON_SLOTS`**（宿主侧契约，注释已写明），否则设置页看不见该需求；同坑 26「排除即承接全部职责」一个味道：加消费点就要加台账。
  - **上传类 API 要携带语义目标**：无参 `upload()` 只能猜目录与命名；参数化到槽位后，命名/目录/格式校验/生效刷新收敛到 host 一处，renderer 零规则。
  - **上传目标应是用户正在操作的对象，不是硬编码兜底包**：恒落 `custom` 让「基于现有包换一两个图标」变成重搭整套资产。内置包 asar 只读的约束用「**同名克隆到用户目录**」化解——扫描时用户包覆盖内置，激活 ID 不变、内容就地可替换，用户视角仍是「传进了这个包」（回执 `cloned` 说明发生了什么）。
  - **新建即激活**：`create` 后直接 `activate(id)`，「建自己的包 → 往里传图标」是一条连续路径，不必回头再点一次卡片。
  - **清单类信息默认折叠 + 计数当展开信号**（`缺 N 项` / `全部已提供`）：次要细节不该挤占主路径，但要让用户一眼判断是否需要展开。
  - **分组标题要承载「归谁」，不是当装饰**：多个消费方的同类条目混在一张清单里，12px 灰字分组名压不住层次。正解=分组做成容器（边框+底色分层）+ 组头带**机器可读的归属标识**（插件 id chip，故注册表要有 `plugin` 字段而非把插件名塞进中文组名）+ 组内自身计数；且行首要放**条目实际渲染结果**的缩略图——描述「哪个图标位」不如直接让他看见那个位现在长什么样（未提供用虚线空格占位，缺口可视化）。
  - **相邻卡片边框的间距要大于线宽的视觉厚度**：两张 1px 描边卡只隔 6px 时，两条线会被读成"一条变粗的线"（用户原话「边框重合变粗」）。组间留白给到 16px 量级即可解；不建议用 `margin-top:-1px` 叠边合并——省了高度但引入与 gap 的耦合，改间距就破。

## 坑 29 · 主题图标两个隐形坑：0 字节占位被判「已提供」+ 图标库画布留白差异致视觉尺寸不一

- **现象**（2026-09-04 用户实机点验）：设置页导航「外观」显示的是**官方原生图标**而不是用户包里的图标，并且它比其它行的自定义图标明显大一档。全程无任何报错。
- **根因**（两件独立的事）：
  ① 内置 default 包 `icons/settings-nav-appearance.svg` 是 **0 字节空占位**（git 里由 `settings-nav-theme.svg` 重命名而来，本来就是空的）→ 协议层照样 200 → renderer 解析不出 `<svg>` → 按设计静默回退官方图标；而需求清单的 `provided` 只判 `existsSync` → 空文件被标成「已提供」，缺口完全被藏住。
  ② 尺寸差 = **画布留白规范不同**：官方 primitives 是 16 网格、字形近乎满幅（≈87%）、描边约 1px；用户上传的是 Material Symbols 24 网格（`viewBox="0 -960 960 960"`），字形只占画布约 79%、描边按比例缩到 ≈0.8px。两者都被 `renderSvg(url, 16)` 强制成同一个 16px 盒子 → 自定义图标看着「小一圈、更细」。
- **解法**：
  ① `provided` 判定改「存在**且** `statSync().size > 0`」；删掉内置空占位（顺带清 dist 里的陈旧空文件——`copy-web` 只覆盖不删除，删源资源不会自动从 dist 消失）。
  ② `renderSvg` 内联前做**光学归一**：离屏 `getBBox()` 测字形真实包围盒 → 把 viewBox 重设为「最长边 + 每侧 1/16 内边距」的正方形并居中（1/16 即官方 16 网格图标的留白比例）；测不到包围盒则保持原 viewBox 不裁切。结果进 `svgCache`，每个图标只测一次。
- **复盘**：
  - **文件存在 ≠ 内容有效**：任何「是否已提供」的判定都要带最小有效性检查（尺寸 > 0 / 能否解析）。有静默回退链的地方，缺口不会报错，只会以「看起来是别的东西」的形式出现——坑 28 藏的是「需要哪些」，这次藏的是「传了个空文件」。
  - **替换 UI 字形必须做光学归一**：不同图标库的画布留白是各家私事，**强制同盒子尺寸 ≠ 同视觉尺寸**；正解是按内容包围盒重设 viewBox（离屏 `getBBox()`），而不是给某个图标库调经验放大系数。
  - **构建产物只增量覆盖**：删源资源不会从 `dist/` 消失，验证资源类改动必须看 dist 的实际文件清单（坑 18「落盘反查」的资源侧变体）。

## 坑 30 · 图标槽位三条口径纪律：清单=启用条件、状态对成对启用、异步内联不能空帧

- **背景**（2026-09-04，用户问「窗控三钮不能设置吗」）：标题栏窗控与侧栏折叠图标是硬编码内联 path，主题包覆盖不到。接入 6 个新槽位（`titlebar-minimize/-maximize/-restore/-close/-collapse-left/-collapse-right`）时，同域三处会咬人的口径问题一起暴露。
- **三条**：
  ① **清单说「已提供」、界面却不生效**：`useThemeLogo` 的启用条件是 `current !== 'default'`，而需求清单 `provided` 只看激活包里有没有那个文件——把 default 克隆到本地定制 logo 时，清单显示已提供、界面上仍是官方鲸鱼。→ 统一为「**激活包含该文件就用**」。
  ② **状态对图标只给一半**：maximize↔restore、collapse-left↔collapse-right 是同一按钮的两枚状态图，各自独立判定会出现「点一下换风格、再点一下回内置」。→ 消费方按 pair **成对启用**，缺一整套回退内置。
  ③ **异步内联 SVG 用在首帧就要正确的控件上**：`renderSvg` 是 fetch+parse 的 Promise，窗控按钮空一帧非常显眼。→ 初值走 `peekSvg` 同步取缓存，未命中**先画内置图形**、后台加载完再换（永不空帧）；跨主题切换的破缓存用**模块级 `controlBust`** 而不是每次 `Date.now()`，否则同会话内缓存永不命中。
- **复盘**：
  - **一份需求清单只能有一个真源，且启用条件必须同口径**：`ICON_SLOTS` 既管清单展示又管上传落盘，消费方的启用判断若另加条件（如「非 default 才生效」），清单就成了假信号——这是坑 29「存在≠有效」的反向版本（**有效≠被启用**）。
  - **成对/成组资源在消费方判齐**：「哪两枚属于同一个按钮」是用图插件的知识，注册表只声明单槽；判齐放在消费方，`fallback` 文案负责告知用户「需成对提供」。
  - **hover 反色规则要按渲染方式分流**：`svg path { stroke:#fff }` 会连主题内联稿一起强加白描边（填充型/彩色图标在红底上糊成一团）。内置=svg 自带类名、主题=span 包 svg，用 `svg.dsh-desktop-titlebar-icon` 收窄旧规则 + hover 改 `color:#fff` 走 `currentColor`。

## 坑 31 · 上游新版判据拿错源：npm dist-tags 滞后于 GitHub release，auto 静默漏检 3 天

- **现象**（2026-09-07，用户实查打脸）：`npm run upstream:auto` 报「无新版本（0.1.2-rc.1 已是最新）」，但上游 GitHub 已发布 `dsh-v0.1.3-alpha.1`（2026-09-04 19:34 北京时间）。每日 02:00 定时任务已连续 3 天静默漏检，工作区零改动、零报告。
- **根因**（两层）：
  1. `cmdCheck` 的新版判据取 `registry.npmjs.org/-/package/@deepseek-ai/dsh/dist-tags`（alpha/latest/next 三条），而上游发布顺序是**先打 GitHub tag/release、后发 npm**；`0.1.3-alpha.1` 在 npm `versions` 里根本不存在（`npm view @deepseek-ai/dsh@0.1.3-alpha.1` → E404），三条 tag 全指 0.1.2 系列，`compareVersions` 自然判不出更新。
  2. 连带缺口：`assess` 的 roster 存在性是 `aligned.has(p) ? packageExistsAt(p, ver) : packageExistsAny(p)`，而 roster 清单（取自 `boot.ts` + `desktop-patch.yml`）**不含主包 `@deepseek-ai/dsh`**，独立版本线包只查「包在不在」。结果目标版本整体未发行也能报「92 包全部存在」，判成 `review` 而非 `blocked`——把「根本装不了」误报成「可人工适配升级」。
- **解法**：权威源换成 GitHub releases（`/releases?per_page=30` → 过滤 `dsh-v*` 前缀得版本号 → `compareVersions` 降序），npm **降级为「是否可安装」的发行校验**（`packageExistsAt('@deepseek-ai/dsh', v)`）。check 输出三态：无新版 / 可安装候选 / **pending**（上游已 release、npm 未发行）。`cmdAuto` 遇 pending 显式停止（不改文件、不登记台账、打印 release notes 链接）；`cmdUpgrade` 加同口径前置校验，堵住手工 `upgrade <未发行版>`；`--tag alpha|latest|next` 随判据源作废删除。
- **复盘要点**：
  - **「上游出了新版」与「我能不能装」是两个正交问题**，判据源不能混用：git tag/release 是版本真源，registry 只是分发渠道（会滞后、会被镜像缓存掩盖）。
  - **存在性检查必须区分「包存在」与「该版本存在」，且要覆盖主版本包**，否则「目标版整体未发行」这种最严重的阻断也能全绿通过。
  - **自动化的「无变化」结论只能由权威源保证**，不能建立在下游代理指标上——代理指标缺数据时的表现恰好是「看起来一切正常」。

### 坑 32 · 自绘侧栏「新会话」崩：把 UI service 方法当 domain service 方法调

- **现象**：点侧栏「新会话」（宽列按钮 / rail 加号）触发 `Uncaught TypeError: ctx.workspaces.startSession is not a function`，报错路径 `dsh-ui://app/assets/index-*.b.js`。
- **根因**：自研 sidebar 壳 `src/desktop-shell/web/desktop-sidebar-client.js` 的 `sidebar` 槽位 `inject` 里写 `ctx.workspaces.startSession(...)`。`ctx.workspaces` 是 framework 的 **workspace domain service**（只挂 `list` viewer、`insertSessionBefore` 等数据方法），**没有** `startSession`；`startSession` 属官方 **UiWorkspaceService** 的 UI 动作（`connectWorkspace` + `sessions.open` 的「复用-or-新建」语义），官方 ui-sidebar 用 `ctx.get("uiWorkspace")` 取它再调用。
- **解法**：inject 回调改 `const workspaceNavigation = ctx.get('uiWorkspace'); return { startSession: (id) => workspaceNavigation.startSession(id), toggleSidebar: () => ctx.layout.toggleSidebar() }`；`exports.inject` 由 `['slots','layout','workspaces']` → `['slots','layout','uiWorkspace']`。
- **复盘要点**：
  - `ctx.get()` 的 key 是**服务注册名**（camelCase），不同 service 域方法集迥异——domain service（workspaces 管数据）与 UI service（uiWorkspace 管动作）别混着取方法。
  - 报错栈在压缩 bundle `index-*.b.js` 是**宿主把自研壳消息打进官方主 bundle 的行号**，不代表失败发生在官方源码。

## 通用排障方法论

1. **沙箱无法代跑 GUI** → 让用户外部跑，**加精确断点日志** + 用户回传，避免盲试。
2. **每次只加一行能区分分支的日志**（handler=set/null、校验通过、fetch status/body），用日志组合定位停点。
3. **接上游服务先读真实接口**（`.handleRpc`、`new URL` 绝对性、`pick` 返回 string 等），别凭命名猜。
4. **zod 边界别比上游契约更严**（rpcId 示例）。
5. **Cordis 服务注入必须 `extends Service`**，普通对象赋值无效。
6. **官方双面插件要分清 node 面（注册服务）与 client 面（渲染）**，装配两条线都要覆盖。
7. **高频日志走 verbose 门控**（`DSH_VERBOSE=1`），失败必显——刷屏的成功日志会淹没唯一重要的那条错误。
8. **`ctx.get()` 用 service 注册名（camelCase）**，不是 cordis 条目 id（kebab-case），两者常差一个命名风格。
9. **「清单可见 ≠ 可交互」**：冷会话需显式重挂载（session.create 带 sessionId），清单项不保证 live agent。
10. **overlay 补丁写法先问路径**：非 insert 补丁只覆盖已存在条目，空根配置下必是 no-op；新条目必须走 insert（坑 16）。
11. **上游「合法空态」= 装配断点掩体**：页面把空数据当正常态静默渲染 null 时，宿主侧要加「扫描结果必显」探针对冲（坑 16）。
12. **注入脚本先分两层解析归属**：`executeJavaScript`/bundle 源码里的模板字符串，主进程编译期消费一层、renderer 运行期消费一层；嵌套反引号/`${}` 必炸编译，常量直接写字面量（坑 17）。
13. **同文件多处编辑必须串行 + 落盘反查**：并发编辑同一文件会相互覆盖且「成功」报告不可信；每处编辑后 Read 复核，收尾用 dist 产物 grep 反查源码状态——typecheck/lint 测不出「编辑未落盘」（坑 18）。
14. **自绘样式对宿主页一律 important 化/提特异性**：官方 UI 运行时会动态追加样式表覆盖同特异性规则；「规则存在 ≠ 生效」，内容整体下移 N px + 底部等量溢出 = position 被降级的指纹（坑 19）。
15. **`renderSlot` 只能渲染本槽声明的子槽位（槽位所有权）**：跨槽位渲染官方子槽位直接抛 `SlotOwnershipError` 崩溃；要展示非本槽 children 里的官方元素（如品牌 logo），**直接 require 官方组件渲染**，不用 `renderSlot` 走槽位（坑 23）。
16. **官方传输的 wire 契约要逐层对齐**：走官方 connection/typert 时，端点须用「斜杠 `domain/method`」、payload 须是「恰好一个 plain-object `args` 字段 `{args}`」、`args` 内字段名须匹配端点签名参数（`_request`/`request` 等）；持续 404 / `arguments-invalid` 优先查这三层 wire 形态，**不要先归因「启动时序」加盲目重试**（坑 24）。
17. **宿主禁用 ≠ 渲染端不会跑（两条正交装配线）**：host 补丁禁用的 Web 基础设施（如 client-hmr / cordis-runner），其 client 半点仍会被渲染图谱自动扫描激活，对端缺席 → 持续 404 噪音；必须同时把它加进 `CLIENT_EXCLUDE_IDS`。排除一个被他人当服务依赖的插件要连消费方一起排除（判断=对方是否 `ctx.get` 该服务，`inject` 只是顺序提示）（坑 25）。
18. **双面包插件两条装配线都要点名 + 排除即承接全部职责**：官方 ui-* 的 host 半须在 boot.ts 显式 insert（对照官方 cordis.patch.yml 逐行核对，同口径一次补齐）；排除官方插件（如 ui-layout）前盘点其全部 effect，被排除职责（如 ThemePresenter）须在自研件中等价补齐——「事件有人发 ≠ 有人消费」。壳层配色用 `light-dark()` 双值/官方 token，不硬编码单值（坑 26）。
19. **自绘界面两层纪律（配色 + 尺寸）**：颜色一律官方 `--dsw-*` token 或 `light-dark()`，禁止内联硬编码单值（浅色主题必不可读）；内容宽度不可控的 grid/flex 子项必须显式 `min-width:0` + 内层轨道 `minmax(0,1fr)`，`minmax(Npx,1fr)` 不封顶、子项 min-content 会反向撑破容器（`nowrap` 文本标签是头号元凶）（坑 27）。
20. **「清单/概览」类 UI 的数据源必须是需求注册表，不是文件系统或目录扫描**：扫描只回答「有什么」，答不出「该有什么」；带静默回退链的槽位（缺了也能跑）缺口会被永久藏住。清单、上传、校验三处共用同一份注册表（真源一处，renderer 只渲染），新增消费点即新增登记项（坑 28）。
21. **「有没有」判定要带最小有效性检查，替换字形要做光学归一**：`existsSync` 不等于可用——0 字节/解析不出的文件在静默回退链下表现为「显示成了别的东西」而非报错；跨来源的图标必须按内容包围盒（离屏 `getBBox()`）重设 viewBox 才能视觉等大，同盒子尺寸不等于同视觉尺寸。资源类改动收尾看 `dist/` 实际文件清单（copy 只覆盖不删除）（坑 29）。
22. **清单展示、上传落盘、消费方启用三处必须同一口径同一真源**：注册表说「已提供」而界面不生效=假信号（消费方别自己加 `!== 'default'` 这类条件）；成组/成对的资源在消费方判齐再启用，注册表只声明单槽；首帧就要正确的控件不许用异步渲染填空——先画兜底图形、缓存命中走同步 peek（坑 30）。
23. **版本跟踪先定权威源，再定发行校验**：判「上游有没有新版」用 git tag/release（版本真源），判「我能不能装」用 registry 该版本是否存在（分发渠道会滞后）；两者混用会让「渠道还没发」表现为「上游没发」这种最坏形态的静默漏检。「无新版」结论要能用第二源交叉对账（release 清单 vs registry versions）（坑 31）。
24. **压缩后源码的方法名不可 grep，用原文对账**：官方 node_modules `lib/*.js` 发布时方法名被压缩（如 `startSession` 显示为 `ln`），grep 可读结果会骗你又骗日志栈；读时用 Read/原文，方法名以 source map / 调用链上下文为准。`ctx.get()` 的 key 是 service 注册名，**domain service（workspaces 管数据）与 UI service（uiWorkspace 管动作）方法集不同**，UI 动作必须从 `uiWorkspace` 取，别在 domain 上硬调（坑 32）。
25. **依赖安装「退出码 0」不等于环境就绪**：靠 postinstall 拉二进制的包（electron / playwright / esbuild / better-sqlite3 等）npm 会吞掉其失败，缺口延后到运行期由 CLI 自愈补装才暴露——报错点与失败点分离。install 后先 `Test-Path` 落地物（`electron/dist/electron.exe`、`path.txt`）再谈运行；多 worktree 同 commit 时优先复用主工作区重资产（拷 `dist` 或 junction `node_modules`），不要默认全量重来（坑 34）。
26. **分阶段替换 UI 的「可后置」判据 = 是否唯一交互入口，不是视觉复杂度**：把某个槽位实现成 `return null` 是合法渲染、静态门禁全绿，却可能锁死整条下游链（本例 picker ⇒ 无 session ⇒ 官方输入框判 `inert` 置灰）。唯一入口类控件必须与服务接管同批落地；验收要顺依赖链看到最终用户动作，别只看本槽位是否渲染（坑 35）。
27. **用 `vm` 沙箱单测浏览器 bundle 时，`deepStrictEqual` 对跨 realm 对象必误报**：`node:assert/strict` 的 `deepEqual` 会把 vm realm 的对象与宿主 realm 的字面量判「same structure but not reference-equal」，连空数组 `[]` 都不放过（Array/对象原型主 realm 不同）。解法：断言别用 deepEqual 比较跨 realm 数组/对象——改投影为基本值逐字段 `assert.equal(arr.length, n)` + `arr[i].field === x`。仅当 bundle 导出的是**基本值**时方可整体深比（W2 派生层单测教训，`test/workspace-tree.test.cjs`）。
28. **沙箱内跑 Electron（启动/打包）先看输出尾部，不要先看错误头**：拦截是环境坑但会以业务错误形态出现（`loader entries failed to apply` / 打包中途卡死），真正的根因永远在最后一行 `TRAE Sandbox Error: hit restricted` 的「被拒路径」里。被拒路径落在工作区外（数据目录 `$DSH_HOME`、IME 日志、系统色彩配置、`AppData` 缓存）→ 直接授权沙箱外运行或加白名单放行，**改代码是空转**（坑 0 / 38 / 42）。
29. **判断「某个 agent 预设实际看到什么」要按注册表作用域推，不能按预设声明推**：`dsh-tools` / `dsh-system-prompt` 一律「全局层（宿主平面 root 注册）+ scope 链（预设/子 agent）」**并集**解析，预设自有声明只能影子遮蔽**同名项**，全局层里的**其它**项照样进请求；宿主 roster 抄官方时必须连官方 profile 的 `disabled` 关停表一起抄（坑 53）。计量证据双读：本地 `contextBreakdown`（system/tools/message 估算）+ 模型侧真实 `tokenUsage`（uncached + cacheRead），两者差一个量级就是泄漏信号；`$DSH_HOME/storages/session_projcache/sessions/*.json` 是免解压的第一现场。
30. **「用户可自定义的资源目录」必须能区分「随包资源」与「用户自己的」**：只按 `existsSync` 跳过已存在文件的"迁移"其实是一次性种子，随包资源更新永远到不了存量安装；解法 = 修订号 + 写入哈希（一致才覆盖，改过就保留），并明确「内置资源 vs 激活包」的真源归属（坑 54）。验证资源类改动是否生效，直接读**运行期真源目录**（如 `$DSH_HOME/icons`）的文件与哈希，不要只看仓库里的资源文件已更新。
31. **服务缺席要查「有没有 insert 行」，不是「有没有 disabled 行」**：非 insert 补丁只按 id 覆盖已存在条目，`{ id, disabled: true }` 写在一条从未插入的行上是**空操作**（坑 55）。诊断顺序 = 报错里的服务名 → `rg -uu` 找提供它的官方包（看 `static inject` / `provide`）→ 回本仓 roster 核对 **insert** 清单 + 客户端图谱排除表；agent 预设/list 类 `inject` 是硬契约，缺一个服务即整块挂不上（`N row(s) did not activate`），恢复时「宿主提供行 + 客户端半 + 宿主 UI 槽位」必须同批回填。
32. **`git status` 显示 `M` 而 `git diff` 为空 = 索引 stat 缓存尺寸失配（行尾变化是常见诱因，不是判据）**：判别三查——`git hash-object <path>` 与 `git rev-parse HEAD:<path>` 相等（**内容零差异**，这是决定性证据）、`git ls-files --debug <path>` 的 `size` 与实际字节数不符、`git ls-files --eol`（仅辅助）；修复用 **`git add <path>`** 刷新 stat（内容相同即不产生暂存变更）。实测无效：`git update-index --refresh`、`Remove-Item` + `git checkout`（编辑器把行尾再归一化即复发）。此类假改动会卡住 `git merge --ff-only` 与 `scripts/release.cjs` 预检，且报错伪装成真实冲突（坑 56）。
33. **「装了哪些插件」这类清单，先分清「数据面」与「界面面」再找源**：官方把二者拆成两个包（host 出清单 / client 渲染），窗口里能搜到条目只说明**界面面**在跑，清单内容由**数据面**决定。诊断顺序 = 页面上有没有显式错误态（有 → 链路断，查 unary/apiProxy；没有 → 链路通、返回内容不对，查数据面取数口径）；再确认数据面取数真源是「装配条目」还是「文件/目录派生」——只有前者能反映宿主侧插件（坑 57）。
34. **自研件顶替官方包后，服务面的差分要「按当前安装版本」逐方法做**：`inject` 数组 + `super(ctx, 'x')` 那个类的方法名清单，与自研件对比；官方加方法不会报错、不会告警，**只等你点到那条路径**。报错文案常常指向别的领域（如「无法打开文件夹」），**认异常正文里的 `xxx is not a function` 属性名**才是真线索（坑 62）。
35. **「宿主进程有没有控制台」是 Windows 工具链的隐性前提**：GUI 子系统宿主（Electron）不会继承控制台，而多数 Windows 进程原语按「共享宿主控制台」设计——宿主缺控制台时，控制台类子进程会被系统**新建窗口**（闪框），受限令牌下还会死在 DLL 初始化（`0xC0000142`）。排查顺序 = 先量**创建者**的 `GetConsoleWindow` / `GetConsoleProcessList`，再量目标的（子进程 `count===1` + `visible===1` 就是「新建了独立控制台」的指纹）；`windowsHide` 对 GUI 应用无效，别当捷径（坑 63）。
36. **幂等脚本的「已存在」判定必须只看生效内容**：注释、示例、模板都是假阳性高发区（本例脚本拿 `includes('id: x')` 判定，被自己写出的模板注释骗到）。推论两条：① **装完要复核结果文件**，不能只信脚本打印的"完成"；② 优先用**官方校验脚本**交叉验证（如 `verify:profile-plugins`），而不是肉眼（坑 64）。
37. **Agent 沙箱拒绝写 `.git/objects/**` → 一切 git 写操作必须交用户执行**：`git init` 能建目录、`git add` 落首个 blob 就 `Permission denied`（工作区内外的仓库**都一样**），且**申请授权（approval）不解除**。所以 `add/commit/tag/push` 在 Agent 侧一律做不到——**别反复重试，也别以为换个目录就行**；正确做法 = Agent 把命令/幂等脚本（含"node_modules 零泄漏"这类断言）准备好放在工作区，由用户在终端跑，再用 `ls-remote` 回验（坑 65）。
38. **发布/更新类故障按「产物清单 → CI 运行 → 客户端解析」三层取证**：先看 Release 资产名（缺哪个描述符一目了然——本次"只有 10 个、全是 mac"一步指向 CI），再看各 step 的 `conclusion`（失败步 + 后续全 skipped = 产物没上传），最后读客户端 provider 源码确认它**真正请求的文件名**（`rc.yml` → 404 后回退 `latest.yml`，**从不是 `latest-rc.yml`**）。**别从错误文案反推需求**；修完 CI 的补跑必须用 `workflow_dispatch`（`Re-run failed jobs` 固定旧 commit 的 YAML，`run_attempt` +1 可判别）（坑 66）。

## 结论

攻坚第 2 批（官方 UI 完成日常对话全流程）在剔除 client-connection 抢占 connection、修 RPC 入口、扩自动扫描图谱、换 Electron 目录选择器、补 settings 注册后**实机验收通过**：官方 UI 成功渲染 + 工作区选择 + 日常对话全流程打通。

---

## 坑 33：启动闪屏首帧主题不跟随应用（深色系统 + 应用浅色 → 裸屏黑色）

- **现象**：应用内设为浅色主题、系统为深色时，启动闪屏（裸屏启动页）仍是黑色，与主窗口/应用主题不一致。
- **根因**：闪屏 `createStartupSplash()` 在主进程早期（main.ts 0.6 步）创建，此时 `nativeTheme.themeSource` 仍是默认 `'system'`（跟随 OS），闪屏 HTML 按 `nativeTheme.shouldUseDarkColors`（系统明暗）渲染。应用主题偏好 `ui-theme.preference` 由 `src/desktop-host/theme-sync.ts` 等 host 装配后经 `settings.describe`（RPC）才同步到 `themeSource`；其 `ready` 语义只保证「建**主**窗口」前同步，不覆盖更早创建的闪屏。且闪屏是静态 data-URL HTML，晚同步到达前视图早已渲染，后续不重绘。
- **解法**：
  1. `src/desktop-shell/theme-pref-init.ts`（新增 `applyPersistedThemeSource`）：闪屏创建前用 Node fs + `yaml` 同步读 `$DSH_HOME/settings.yaml` 的 `ui-theme.preference`，提前设 `nativeTheme.themeSource`；ENOENT / 非法值静默回退默认。
  2. `main.ts` 0.55 步：`ensureDataHome()`（已设 DSH_HOME）之后、`createStartupSplash()` 之前调用。
  3. 兜底：`splash.ts` 配色改 `:root` CSS 变量承载 + 监听 `nativeTheme 'updated'` 实时重绘（OS 切换、主题运行中变更时刷新）。
- **复盘要点**：判定「跟随主题」必须区分两类信号——「建主窗口首帧前才同步」（theme-sync ready）与「host 装配前就渲染的极早期视图」（闪屏）。数据早于 host 装配、且项目已有 `yaml` runtime 依赖时，直接同步读持久化文件最可靠，勿依赖晚同步 + RPC 的反馈链路。

---

## 坑 34：worktree 里 `npm install` 报成功但 electron 二进制缺失，`npm start` 才触发 365 MB 补装

- **现象**：新建 worktree（`desktop/dsh-workspaces`，`feat/workspaces`）后执行 `npm install`，输出 `added 967 packages in 1m` **无报错**；随后 `npm run dev` 在 `[build] 已复制 22 个静态文件…` 之后突然打印 `Downloading Electron binary...`。检查发现 `node_modules/electron/` 下**没有 `dist/`**、`path.txt` 为空文件，而主工作区同版本（44.0.0）两者齐备。
- **根因**：两层叠加。
  1. electron 的二进制**不经 npm 分发**——包体只含 `install.js`，实际 `dist/` + `path.txt` 由 `postinstall` 经 `@electron/get` 落地。本次 install 的 postinstall 未成功完成（沙箱环境下对受限路径的写入会被拦），而 npm 对 postinstall 异常仍可整体返回成功 → **「install 成功」≠「环境就绪」**。
  2. `electron/cli.js` 启动时若发现 `path.txt` 不存在，会**自动拉起 `install.js` 补装**并打印那行 `Downloading Electron binary...`。这条自愈链把安装期的缺口一路延后到运行期才暴露，表现为「凭空多出一趟大文件拉取」，且日志与真正的失败点（早先的 postinstall）完全脱节。
- **解法**：**不重下，复用主工作区现成产物**（两树同 commit、`package.json`/`package-lock.json` 逐字一致、electron 版本同为 44.0.0，复用无风险）：

  ```powershell
  robocopy '<主>/node_modules/electron/dist' '<worktree>/node_modules/electron/dist' /E /NFL /NDL /NJH /NJS /NP
  Set-Content '<worktree>/node_modules/electron/path.txt' -Value 'electron.exe' -Encoding ASCII -NoNewline
  node node_modules\electron\cli.js --version   # → v44.0.0，不再触发补装
  ```

  拷后**双向核对规模**（73 文件 / 365.9 MB，文件数与总字节数均一致）再验证运行。
- **复盘要点**：
  1. 凡「二进制不走 npm 分发、靠 postinstall 拉取」的依赖（electron / playwright / puppeteer / esbuild / better-sqlite3 / node-gyp 系），install 后必须**显式 `Test-Path` 落地物**，不能只看 npm 退出码与 `added N packages`。
  2. 多 worktree 同 commit 时应**优先复用重资产**：轻则拷单个 `dist`，重则整体 junction `node_modules` 到主工作区（省 GB 级重复）；别默认全量重来。分支一旦改依赖，junction 需退回独立安装。
  3. 这类缺口的**报错点在运行期、不在安装期**——见到运行期才出现的「正在下载/正在编译」，先回查安装期是否静默降级，而非就地等它下完。
  4. 本地其实已有 `electron-v44.0.0-win32-x64.zip` 缓存（`%LOCALAPPDATA%\electron\Cache`），说明这趟即便走原路也只是解压 365 MB；**缓存存在不是理由，直接拷现成 `dist` 更快且零副作用**。

---

## 坑 35：W1「空壳」把应用整体锁死——picker 是唯一交互入口，不属可后置的视觉件

- **现象**：`feat/workspaces` 装载后**全应用不可用**：侧栏只有「工作区 / 暂无会话」两行；对话区「选择工作区 ▾」点了无反应；输入框占位「选择一个工作区开始」且**敲不进任何字符**；「新会话」按钮点击无效果。同版本基线的 `main` 分支一切正常 ⇒ 坐实为 W1 引入的回归。**全程无任何报错**，typecheck / lint / build 全绿。
- **根因**：W1 把 `WorkspacePicker` 按「可后置的视觉件」实现成 `return null`，但它其实是选/加工作区的**唯一入口**，锁死一条三级连锁：
  1. 无入口 ⇒ 无法创建/选中工作区 ⇒ 无 `current session`；
  2. 官方 `ui-conversation` 据此判 `const inert = sessionId === void 0 || hero && chipTitle === void 0`（`lib/client.js:14436`）⇒ 输入框 `disabled: true` + 占位 `placeholder.workspace`——**这正是"打不进字"的直接出处**，而非输入框自身有 bug；
  3. 「新会话」走 `uiWorkspace.startSession()`，其 target 解析链（显式 id → 当前会话所属 → 最近活跃）全部落空 ⇒ 只能 `sessions.clear()` 空转。
  官方源码里「添加工作区只有一条路」+「`addIsTheOnlyEntry` 时 open 即直接抬系统目录选择器」这两条设计约束，本已明示该槽位的承重性质。
- **解法**：按官方 `WorkspacePickFlow` 等价实现**共享内核**（`Menu`/`Modal`/`Button`/图标直接 `require` 官方 primitives），Browser 与 Picker 两壳仅以 `addOnly` / `side` / `onPick` 分化——侧栏 `addOnly + startSession(workspaceId)`，对话区完整菜单 + `onPick` 交回 owner。语义收在一处防两壳漂移。补 21 项行为断言锁死该链（菜单抑制条件、工作区列表、`::add-workspace` 固定项、收养 create→onPick、失败弹层两出口、**无占洞者时不得出现假「添加」入口**、侧栏 addOnly）。
- **复盘要点**：
  1. 分阶段自绘（「先换壳不换内容」）的**可后置判据不是"视觉复杂度高低"，而是"是否承载唯一交互路径"**。凡某条业务链的唯一入口，必须与服务接管同批落地，否则整链锁死。
  2. 排除官方 UI 件后，验收要看**下游依赖链是否仍成立**（本例输入框 disabled 由 `sessionId` 决定，而 `sessionId` 由被排除件的 picker 决定），只看"本槽位渲染成功"会得出完全错误的结论。
  3. `return null` 是**合法渲染结果**，静态门禁一律放过——这类静默锁死只有实机或行为级测试能发现。空壳阶段尤其需要行为断言兜底。
  4. 定位手法：症状在 A（输入框）、病因在 B（picker）、判据在 C（`inert` 表达式）。读官方源码里把控件置灰的那个布尔表达式，比在症状组件里翻找快得多。

## 坑 36：部署器把 session-query 索引设为 `openAt "never"` → 内容搜索每次按键都打 `RPC 失败 (session/search)`

- **现象**：接入 W4 内容搜索后，搜索框每敲一个词，主机侧日志就抛一条 `RPC 失败 (session/search): ...SessionQueryError: session search is disabled: this deployment configures the session-query index with openAt "never"`（栈落在 `unpackServerResponse → callApi → bridge.js`）。输入仍出本地名匹配且弹「内容搜索暂不可用」警告——功能降级本身对，但每次按键都重发注定失败的 RPC，噪声持续刷屏。
- **根因**：宿主按部署配置把会话内容检索索引关闭（`openAt "never"`），`session.search` 一经调用必失败。渲染侧 `searchSessions` 的 `.catch` 已把它当作「不可用」降级，但**失败发生在 RPC 载波层**（主机侧在拒绝时自行打日志），早于组件 catch——依赖「每次失败 → catch 设 error」就必然每个输入事件都触发一次主机侧报错。
- **解法**：给 `searchSessions` 加**探测即锁定**：首次调用捕获到 `/disabled|openAt/` 类错误后置 `remoteSearchDisabled = true`，后续调用直接短路抛同义错误、**不再向 Host 发 RPC**。本地名称命中与「不可用」警告的降级路径原样保留（`SearchResults` 对 error 态只消费本地 items）。锁定值放 `apply()` 作用域（装载一次、跨重挂载持久）。build 后 `dist/` 同步生效。
- **复盘要点**：
  1. 命令行/桥接层自带的失败日志与组件级降级是**两条独立路径**：组件 catch 只止住「未捕获异常」，止不住 infra 层的 per-request 打印。要消除噪声须**少发请求**，而非多 catch。
  2. 「被功能开关关闭的能力」是**稳定的持续状态**，应在首次探测后 latch，不要每次用户操作都去重复试探；判据用错误文案匹配是当前唯一可用信号，锁定态宁可误锁（少发请求）不可漏锁（刷屏）。
  3. 该部署下内容搜索**本就不该可用**，正确结局=本地名匹配 + 明确「仅名称匹配」提示，而不是假调用或持久报错。可后置判据再次验证：连「花哨能力」的失败也要有体面出口。

## 坑 37：纯 Node 环境下 require `boot.js` 因 `electron.app` 为 undefined 而崩；verify 脚本与 `CliOptions`/载波行失配（均既有缺陷，开启搜索索引时暴露）

- **现象**：改动 `src/desktop-host/boot.ts` 后跑 `node scripts/verify-serve-mode.cjs`，报 `TypeError: Cannot read properties of undefined (reading 'isPackaged') at runtimeRoot (dist/desktop-host/boot.js)`，模块加载即失败。
- **根因**：`boot.ts` 顶层 `const RUNTIME_ROOT = app.isPackaged ? …` 在**纯 Node**（verify 脚本 `require('dist/desktop-host/boot.js')`，无 Electron 运行时）下 `electron.app` 为 `undefined`。M4-a1 引入该常量后 verify-serve-mode 一直失配、从未通过——是**既有测试基建缺陷**，与本轮开启搜索索引无关，但改 boot.ts 会触发。
- **解法**：
  1. `RUNTIME_ROOT` 改为惰性 `runtimeRoot()`，且在 `app === undefined` 时回退开发路径（Electron 运行时 `app.isPackaged` 恒可用）。
  2. 修复 verify 脚本与现状的两处失配：① `parseArgv` 在 M4 新增 `--hidden/--select-data-dir` 后恒返回四字段 `{ serve, servePort, hidden, selectDataDir }`，旧断言只期望两字段；② 0.1.2 升级后传输层行已变——`connection`→`host-connection`（激活，IPC 载波背板，不再 disabled）、`client-runtime` 已删、`client-hmr/cordis-client-runner/cordis-host-runner` 仍 disabled。
- **复盘要点**：
  1. 顶层 `import { app } from 'electron'` 的对象只在 Electron 主进程才有值；**可被纯 Node require 的模块**（尤其被 `scripts/*.cjs` 测试/校验脚本加载的）不能在建模块时触碰 `app`/`BrowserWindow` 等 Electron 专属 API，须惰性取或判空。
  2. 校验脚本的期望值要**随契约源头同步**：`parseArgv` 返回结构变了，`verify-serve-mode.cjs` 的 `deepEqual` 断言也要跟着改，否则每次 CI/冒烟都误报。
  3. 这类「既有但从未跑过」的脚本，凡改动其依赖模块就会把潜伏失配引爆——改 boot.ts 前先跑一次该脚本探底，比事后逐一修快。

## 坑 38：TRAE 沙箱拦截 electron-builder 图标工具——打包卡死在 icon 转换（环境坑，非代码坑）

- **现象**：worktree 内 `npm run dist` 编译全过（tsc ✅、electron zip 下载解压 ✅），卡在图标转换报 `TRAE Sandbox Error: hit restricted`，被拒路径 `AppData\...\Windows\Recent\CustomDestinations\*.temp` 与 `AppData\Local\electron-builder\Cache\icons@1.1.0`。
- **根因**：electron-builder 转 PNG→.ico 的内置工具要写 AppData 下两个系统路径（Recent\CustomDestinations 临时文件 + electron-builder 图标缓存），TRAE 沙箱默认只放行工作区。与坑 0（沙箱拦 Electron 启动）同族：**GUI/工具链进程天然要碰工作区外文件**。
- **解法**：Settings → Permission & Approval → Custom Configuration 放行 `C:\Users\Administrator\AppData\Local\electron-builder\`（缓存目录，放行后后续打包全免拦）；或当次授权「沙箱外运行」。
- **复盘要点**：打包类命令（electron-builder/electron 均如此）在沙箱内首次跑失败时，先看报错是否 `TRAE Sandbox Error`——环境坑不用改代码，改配置即可；配置一次全项目受益。

## 坑 39：`installer.nsh` 带**双 BOM** 潜伏一个里程碑——NSIS 报 `Invalid command: "?;"` 才引爆

- **现象**：NSIS 打包报 `Invalid command: "?;"  !include: error in script: "build/installer.nsh" on line 1`，第 1 行明明是注释。
- **根因**：文件头字节 `EF BB BF EF BB BF`——**双 BOM**。NSIS 吃掉第一个 BOM 当文件标记，第二个成了第 1 行正文，报「非法命令」。该双 BOM 自 M4-a4 提交（086c4c2）起就存在，但那次提交后**再没执行过 dist**，潜伏到今天。
- **解法**：读全文去首个 U+FEFF 后以「UTF-8 with BOM」单 BOM 重写（NSIS 对中文 .nsh 恰恰**要求**保留 BOM，见 electron-builder.yml 注释——坑在「双」不在「有」）。
- **复盘要点**：
  1. `.nsh/.ps1` 等 Windows 工具链消费的文件，BOM 是正确性而非风格问题；提交前可 `Format-Hex` 抽查头部。
  2. **提交≠验证过**：M4-a4 只验了运行时行为（卸载询问），没跑过完整 dist——「改了打包配置但没打包」的提交就是定时炸弹；凡动 `build/`、`electron-builder.yml`，收尾必须跑一次 `npm run dist`。

## 坑 40：worktree 里打包——`.git` 是指针文件，electron-builder 探测不到仓库致 latest.yml 生成崩溃

- **现象**：主工作区打包历来成功；在 worktree（`dsh-updater`）里 dist，安装包/便携包/签名全部产出后**最后一步崩**：`⨯ Cannot read properties of null (reading 'provider')` at `updateInfoBuilder.ts`，且前置警告 `Cannot detect repository by .git/config` × 3。
- **根因**：electron-builder 生成 `latest.yml` 时从 git 仓库探测 GitHub owner/repo；worktree 的 `.git` 是**文件**（指向主仓库的指针）而非目录，探测失败 → publish 配置解析为 null → 崩溃。配置里 `publish: provider: github` 未写 owner/repo，全靠 git 探测兜底，在 worktree 里断链。
- **解法**：`electron-builder.yml` 的 publish 段**显式写死** `owner: lansi-ai` / `repo: dsh-desktop`——两处环境（主区/worktree）都能打，不再依赖探测。
- **复盘要点**：「同一份代码换个目录结果不同」时，先 diff 环境差异（此处 `.git` 形态）；隐式探测（git/registry/env）类配置，发布产物要走通就得显式钉死，探测只配兜底。

## 坑 41：CI 用 `--publish never` + `gh release upload` 发布，`latest.yml` 的 path（连字符）与 GitHub 资产名（点号）脱节 → 自动更新 404

- **现象**：v0.1.1-alpha.4 经 CI（release-win/win-mac）上传到 GitHub Releases 后，Release 资产名形如 `DSH.Forge-0.1.1-alpha.4-setup.exe`（**点号**），而 `latest.yml`/`latest-mac.yml` 的 `path` 字段是 `DSH-Forge-0.1.1-alpha.4-setup.exe`（**连字符**）。electron-updater 按 `path` 拼下载 URL，命中的资产名不匹配 → 更新下载 404，M4-b 三通道自动更新静默失效。
- **根因**：electron-builder 磁盘产物由 `nsis.artifactName: ${productName}-${version}-setup.${ext}` 生成，`productName="DSH Forge"`（含空格）；它**自己 publish** 时会做空格的规范化（空→`-`）并保证 `latest.yml` 的 path 与上传资产名一致。但 CI 用了 `--publish never` + `gh release upload` 绕过这套协调：`gh upload` 按磁盘字面名上传，GitHub 把文件名里空格规范成**点号**存储，于是 path（连字符）与资产名（点号）错位。
- **解法**：本轮已对已发布 Release 用 `PATCH /repos/{o}/{r}/releases/assets/{id}` 逐资产把 `DSH.Forge-` 改成 `DSH-Forge-`，与 `latest.yml` 的 path 对齐（blockmap 一并改），并匿名 `HEAD` 验证 `releases/download/{tag}/DSH-Forge-*.setup.exe` 及其 `.blockmap` 返回 200。**根治**：今后 release workflow 在上传步骤加一步——读 `latest.yml` 的 `path` 字段，把待上传产物重命名为与该 path 完全一致的落盘名再 `gh release upload`。**已落地（2026-09-09）**：新增 `scripts/align-release-assets.cjs`（读 `latest*.yml` 的 path/url 声明，把磁盘产物与同名 `.blockmap` 改为逐字一致名，并兜底去掉未声明产物如便携包的空格），win/mac 两个 workflow 上传前各插一步调用；本地发版 `npm run release -- <version> --local` 亦复用该步。
- **复盘要点**：
  1. 凡 CI 手动上传 electron-builder 产物（非 `--publish always`），必须核对 `latest.yml` 的 `path` 与实际上传资产名逐字节一致，否则平台自动更新是"假功能"。
  2. 验证手段：下载 `latest.yml` 读 `path`，再匿名 `HEAD https://github.com/{o}/{r}/releases/download/{tag}/{path}` 应 200；**验证不可带 Authorization header**（公开下载端点带 token 反被 401，曾误判）。
  3. artifactName 里的 `${productName}` 含空格，是这场错位的源头——要么 workflow 显式重命名对齐 path，要么后续把 artifactName 改为无歧义 `${name}-...`（等于 package.json name）。

## 坑 42：沙箱拦「数据目录」写入 → 宿主报 `loader entries failed to apply`（环境坑，伪装成代码坑）

- **现象**：沙箱内 `npm start` 启动，闪屏与插件清单日志全部正常打印（52 个插件、Host 就绪、载波/窗口装配一路 ✔），随后进程退出码 1，报
  `AggregateError: loader entries failed to apply`（`at EntryGroup.update ... cordis-plugin-loader`，`[errors]: [Array]` 细节被 console 折叠成 Array 不可读）；**只有翻到输出最末尾**才看到真正的根因
  `TRAE Sandbox Error: hit restricted / Not allow operate files: C:\Users\Administrator\AppData\LocalLow\Tencent\WeType\MM_TIP_*.xlog, C:\Windows\system32\spool\drivers\color\sRGB Color Space Profile.icm, E:\Projects\DSHPath\.credentials.yaml.lock, E:\Projects\DSHPath\search\session-query.sqlite-shm`。
- **根因**：沙箱默认只放行工作区（`E:\Projects\DSH\desktop`），而**运行时数据目录在工作区外**（`E:\Projects\DSHPath` = `$DSH_HOME`）：`desktop-credentials` 的 watch 要写 `.credentials.yaml.lock`、session-query 搜索索引要写 `*.sqlite-shm`，双双被拒 → 对应 host 插件 `apply` 抛错 → Cordis loader 聚合为 `loader entries failed to apply`。即「业务错误壳（loader 装载失败）包着环境错误（沙箱拦截）」，与坑 0（拦 IME 日志/系统色彩配置）、坑 38（拦 electron-builder 缓存）同族。
- **解法**：改为**沙箱外运行**（命令授权「在沙箱外运行」）后同一份代码零改动即正常启动（窗口 2 就绪、`dsh-ui://app/index.html` 加载完成、会话预热 13/13）；长期方案 = Settings → Permission & Approval → Custom Configuration 放行数据目录 `E:\Projects\DSHPath\`（一次放行，凭据 watch 与搜索索引都不再被拦）。启动命令口径：`dist/` 已是最新 → `npm start`；源码有改动 → `npm run dev`（build + electron）。
- **复盘要点**：
  1. **报错分层看**：Cordis 的 `loader entries failed to apply` / `AggregateError` 是**聚合错误壳**，细节被折叠，直接据此查插件代码必空转；先看进程输出**尾部**是否 `TRAE Sandbox Error`，被拒路径决定「环境坑 or 代码坑」。
  2. **数据目录在工作区外 = 沙箱内必失败**：凭据 watch（`.lock`）、sqlite 索引（`-shm`）这类运行期落盘是启动必经路径，凡涉及它们一律沙箱外跑，别改代码。
  3. 启动日志里「前半段全绿、后半段退出」的形态，往往是启动链路后段某个插件 apply 失败被聚合，**不要按「启动时序」猜测**，优先定位第一个真实异常。

## 坑 43：同一文件并发编辑互相覆盖（工具使用坑，伪装成「代码没生效」）

- **现象**：一轮里对**同一个文件**发起多条编辑，工具回执全部显示成功（还带 diff），但 `tsc` 报 `Cannot find name 'resolveUserDataRoot'`、`Property 'dataDir' does not exist on type 'CliOptions'`、`'migrateLegacyUserDataSync' is declared but its value is never read` 这类「导入缺失 / 字段不存在 / 声明未使用」错误；回读文件发现只有**部分**改动落地。
- **根因**：编辑工具是「读快照 → 替换 → 写回」。同一文件的两条编辑并发执行时，第二条拿到的快照不含第一条的结果，写回即把第一条回滚掉。
- **解法**：**同一文件的多个改动串行执行**（一条消息只发该文件的一条编辑），不同文件可并行；改完以 `typecheck` 与 grep 复核为准，**不以工具回执的 diff 为准**。
- **复盘要点**：
  1. 回执 diff 只证明「这次替换算出了结果」，不证明「文件最终态包含它」——同文件并发写会互相吞。
  2. 批量改代码后先跑 `typecheck`；错误集中在「导入缺失 / 字段不存在」时，优先怀疑编辑被覆盖，而不是类型真写错了。
  3. 改名/跨文件重构（import + 使用点 + 配置三处齐动）最容易踩：一文件一消息，改完 grep 关键符号复核。

## 坑 44：沙箱拦 git 凭据库 → push 报 fatal 但实际已成功（环境坑，伪失败）

- **现象**：沙箱内 `git push` 退出码 1，输出 `fatal: unable to write credential store: Permission denied` + `Everything up-to-date` + `TRAE Sandbox Error: hit restricted / Not allow operate files: C:\Users\Administrator\.git-credentials.lock`；而 `rtk git status` 显示 `main...origin/main` 且**无 ahead 计数**，看起来像「没推上去」。
- **根因**：推送本身用已缓存凭据成功完成，随后 git 想把凭据写回 `~/.git-credentials`（需 `~/.git-credentials.lock`）被沙箱拦截——**失败发生在数据传输之后**，只影响「下次是否还要输凭据」，不影响本次推送。
- **解法**：不要据 fatal 判定失败，用远端真值核对：`git rev-parse main` 与 `git ls-remote origin refs/heads/main` 的 SHA 一致即成功（本例两边均为 `f1d6aa2d…`）。要消除报错则放行 `C:\Users\Administrator\.git-credentials.lock`（或整个 `~/.git-credentials*`）。
- **复盘要点**：
  1. 「fatal + 退出码非 0」不等于操作未发生——**先看失败发生在哪一步**（凭据持久化 vs 数据传输）。
  2. 远端状态用 `git ls-remote` 判，别信本地 remote-tracking ref（它可能已被本地更新）。
  3. 与坑 42 同族：沙箱拦的是工作区外的运行期写入，这类报错一律先看输出尾部 `TRAE Sandbox Error` 指向哪个路径。

## 坑 45：打包版根锚点 cordis.yml 落在 userData → agent-presets 健康检查向上找不到 node_modules，安装版无法聊天（dev/start 正常）

- **现象**：安装版（v0.1.1-alpha.5）发消息即失败，`npm run dev` / `npm run start` 一切正常。CLI/日志报 `agent-presets: preset 'standard' failed to mount: 23 rows name plugins that cannot be resolved`（23 行插件全部"无法解析"），客户端侧表现为 `session/prompt failed: connection: invalid server-response failure (gateway/internal)`。asar 内 26 个关键插件包经 `@electron/asar.listPackage` 验证**全部存在**——不是打包丢文件。
- **根因**：三层链条叠加：
  1. `dsh-app-boot` 的 `boot()` 将 `ctx.baseUrl` 设为 **configPath 所在目录**（`lib/index.js:1495`）；Cordis `Include` constructor 同样改写 `ctx.baseUrl = dirname(配置文件)`（`cordis-plugin-include/lib/index.js:138`）。
  2. `dsh-agent-presets` 的健康检查 `packageInstalled(name, base)`（`lib/invariant.js:247`）从 `harnessBase`（= `ctx.baseUrl`）**逐级向上查找 `node_modules/<pkg>/package.json`**，任一级命中即通过——纯磁盘 `existsSync`，与 import 解析无关。
  3. dsh-desktop 的根锚点 `createRootConfig()` 写在 `runtimeRoot()/cordis.yml`：开发模式 = 项目内 `.runtime\`（向上一级命中项目 `node_modules` ✓）；**打包模式 = `userData\.runtime\`（AppData 下，向上到盘符都没有 node_modules ✗）** → 23 行全部判死 → 预设 mount 失败 → 会话无法建立。`bareModuleBaseUrl`（指向 asar 内 node_modules）只救 `Include` 的 `internal.import` 裸包名解析——所以安装版宿主装配、插件 import 全部成功，唯独这个磁盘检查挂掉，极具迷惑性。
- **解法**：根锚点必须位于 asar 内——构建期由 `scripts/copy-web.cjs` 生成 `dist/cordis.yml`（内容 `[]`，随既有 `files: dist/**/*` 进 asar）；`boot.ts` 的 `createRootConfig()` 打包分支改用 `join(app.getAppPath(), 'dist', 'cordis.yml')`。此时 `ctx.baseUrl = <app.asar>/dist/`，向上第一级命中 `<app.asar>/node_modules`（Electron 主进程 fs 对 asar 路径的 `existsSync` 生效）。asar 只读无碍：`Include` 对已存在文件只读不写（`checkAccess` 失败仅标记 readonly）；`_writeFile` 只在编辑 API 被调用时触发。开发模式行为不变。
- **复盘要点**：
  1. 「同一份代码 dev 正常、打包版挂」的路径类差异，先画**每个 base/anchor 的解析链**（`ctx.baseUrl`、`__dirname`、`cwd`、`DSH_HOME`）在两种模式下的值，再对差异点。
  2. 上游包的"健康检查/不变量"用的是**字面磁盘查找**而非 import 解析——两条链路（import vs existsSync）可能基于不同 base，修好一条不代表另一条通。
  3. `userData`（AppData）是**孤岛目录**：任何依赖"向上找 node_modules"的上游逻辑都不能以它为锚；asar 内路径反而是 Electron patched fs 下合法的查找起点。

## 坑 46：自研布局接管 root 槽位漏补官方 `panelInfo` root hook → rightbar 槽位条目崩溃（`usePanelInfo is not a function`）

- **现象**：启动后 renderer 连续报 `TypeError: usePanelInfo is not a function (line 56, dsh-ui://app/assets/index-CIp0YSTs.js)`，紧接 `slot entry crashed in 'rightbar': TypeError: usePanelInfo is not a function (line 526, .../dsh-client-ui-renderer/client.js)`（SlotErrorBoundary 捕获并打印）；同一批次还伴随 agent-preset 的 `cannot get required service "sessions" in inactive context` 刷屏（后者为伴生噪音，见 dogfood #17）。全部 60 个 entry 均 ACTIVE、无任何 `pending/import failed` 报告，极具迷惑性。
- **根因**：0.1.5 上游引入 rightbar 契约——新包 `dsh-client-ui-sidebar-right`（`inject = ["slots","layout","locale","resources"]`）的 `RightbarRoot({ usePanelInfo, SessionProvider, renderSlot, ... })` 把 `usePanelInfo` 当**槽位 binding 注入的 props** 消费，其唯一来源是官方 `dsh-client-ui-layout` 的 `ctx.slots.provideRoot({ hooks: { panelInfo: { getSnapshot, subscribe } } })`（`ui-layout/lib/client.js:519`，与 `ctx.reflect.provide("layout", layout)` 是**同一次 apply 内的两件独立事**）。M6-P1 起自研 `@lansi-ai/dsh-desktop-layout` 接管 root 槽位并排除了官方 ui-layout，但只等价复刻了 `layout` 服务与槽位声明（titlebar/sidebar/conversation/rightbar/shell.overlay），**漏了 panelInfo root hook** → 消费端解构到 `undefined` → 调用即 TypeError → rightbar 条目崩溃。
- **解法**：自研 layout 的 `apply` 内补齐 `ctx.slots.provideRoot({ hooks: { panelInfo: { getSnapshot: () => panelInfoSnapshot, subscribe: () => () => {} } } })`，快照 `{ activePanelId: null }`（桌面直渲染 `conversation` 槽位、无官方 main keyed 面板机制，恒 null 语义 = 无面板占用会话区），并在 fiber disposer 里调用其返回值。
- **复盘要点**：
  1. 「接管官方插件」= 接管其**全部**导出面（服务 + root hooks + 槽位声明）。只做服务等价映射是漏项高发区——本次即"服务在了、hook 没在"。
  2. `assertEntriesActive` 只校验 **entry 级 fiber**：全部 active 也可能业务崩。别把"启动报告全绿"当成没问题，要结合 `unhandledrejection` 全文栈与槽位错误边界日志交叉定位。
  3. 排除上游旧包前，先扫**新引入包**的 `use*` props 来源（谁 provideRoot）——上游迭代常让新包消费旧包的 root hook，排除面需同步扩张。

## 坑 47：`dsh-ui://app/index.html` 无缓存头 → Chromium 启发式缓存致注入图谱陈旧（新增插件条目永不生效）

- **现象**：图谱结构发生变化（新增/移除 client 插件包）后重启，新条目**永不生效**：renderer 从不请求其 `client.js`，而 host 侧插件清单（cordis-inventory）已包含它。本次以临时诊断插件（图谱第 62 条）暴露——该 bundle 零请求、apply 零执行，一度误判为"插件代码有问题"。
- **根因**：`dsh-ui-protocol.ts` 的 index.html 响应只设了 `content-type`、**没有任何缓存头**，而入口 URL `dsh-ui://app/index.html` 恒定 → Chromium 对自定义协议在无缓存头时按启发式规则缓存该响应 → 页面反复使用首次生成的 `__DSH_BOOT__` 图谱。bundle 自身以 `?rev=<内容 hash>` 破缓存，所以**资源内容**总是最新、**图谱条目集合**却卡在旧版，两者错位极具迷惑性。
- **解法**：① index.html 响应补 `cache-control: no-store, must-revalidate`；② 入口 URL 携启动版本 query —— `main.ts` 与 `window-manager.ts` 的 `loadURL` 改为 `dsh-ui://app/index.html?v=${Date.now()}`（多窗口各自取新值），两条双保险。
- **复盘要点**：
  1. 自定义协议 + 运行时注入内容 ⇒ **必须显式声明缓存策略**，不要依赖协议默认行为。
  2. 「资源内容是最新的」与「清单/图谱是最新的」是两件事：带 hash 的 URL 只保证前者。
  3. 图谱类问题的首选排查动作是做**实际请求清单 vs 当前图谱条目**差集——一眼区分"没请求"（装载/缓存）与"请求了没生效"（代码）。

## 坑 48：自研布局只声明 `conversation` 而漏官方语义的 `main` 槽位 → 上游插件的注册被隐式降为 `session-maybe`，启动期 `sessions in inactive context` 刷屏

- **现象**：升级到 `dsh-v0.1.5-alpha.2` 后，启动期 renderer 连续抛 `Uncaught (in promise) Error: cannot get required service "sessions" in inactive context`（约 30 次，栈头恒为 `ui-agent-preset` client.js:1371 → `AgentPresetSeatController.apply` → `scope.sessions.list.subscribe` 回调）；同一批次还伴随 `usePanelInfo is not a function`（已单独修为坑 46）。**官方 web 版（`dsh web`，同一 `node_modules`、同一 Cordis 4.0.2）console 完全干净**——这一步直接证明问题出在桌面侧集成，而不是上游。
- **根因**：自研 `@lansi-ai/dsh-desktop-layout` 接管 root 槽位时，按桌面三列布局声明了 `conversation`（`single` + `session-maybe`），**却未声明官方语义的 `main`（keyed + root）**。而上游 `dsh-client-ui-conversation` 是这么切入的（`ui-conversation/lib/client.js:16823-16836`）：
  ```js
  slots.inject("main", function* () {
    yield slots.register({ name: "main", key: "conversation",
      children: { "main.conversation": { kind: "single", scope: "session-maybe" } } }, ConversationPanel);
    ...
  });
  ```
  缺少 layout 的 `main` 声明后，该槽位由这次注册隐式建立并带上 `session-maybe` scope → **未选中会话时槽位条目被卸载** → 其中 `ui-agent-preset` 注册的 hero chip / session header action 随会话状态反复卸载重建、其 `ctx.effect` 随之重跑 → 重跑落在 Cordis 的 fiber 激活窗口内，`scope.sessions` 解析即抛 `inactive context`。Cordis 侧机制：`_getImpl(name, strict)` 要求提供者 fiber `state === 2` 才认服务可用（`cordis/lib/index.js:765`），而 effect 清理是异步的，故窗口内访问必炸。
- **解法**：自研 layout 的 `slots.register({ name: 'root', children })` 补上 `'main': { kind: 'keyed', scope: 'root' }`，并把 AppFrame 中心列由 `renderSlot('conversation', {})` 改为 `renderSlot('main', {}, { entryKey: 'conversation' })`——与官方 ui-layout 的 MainPanel 语义一致。修复后启动日志只剩清单与「页面加载完成」，零报错。
- **定位手法（可迁移）**：
  1. 先跑 **官方 web 版**（`node --input-type=module -e "process.argv=[process.argv[0],'dsh','web'];const m=await import('./node_modules/@deepseek-ai/dsh/lib/bin.js');await m.runCli()"`，Node 22.16 下 `import.meta.main` 为 undefined 会静默不执行，必须显式调 `runCli()`）——确立"上游是否同样出错"的基线。
  2. 再做**单变量对照**：临时把某个自研件换回对应官方件，看报错是否消失。本次换回官方 `ui-layout` 后报错**完全消失**（换 `ui-workspace` / `ui-sidebar` 均无变化），一步锁定到 layout 的槽位声明。
- **连带症状（同一根因）**：`dsh-client-ui-sidebar-documentpreview`（0.1.5 的 `textpreview` 换代包）的 apply 也曾失败，报 `cannot get property "documentPreviews" without inject`——其 apply 内 `provide("documentPreviews")` 的异步 effect（Cordis 的 provide 本身即 effect）未落地即被同函数体同步访问。排查期曾据此把它临时排除，但补齐 `main` 槽位后该包**自行恢复**（槽位抖动消失，其 fiber 不再被扰动）。**结论：该包不入 `CLIENT_EXCLUDE_IDS`**（2026-09-10 复测：59 个插件装载、零报错）。
- **复盘要点**：
  1. 「接管官方插件的槽位」不止要对齐**服务**与 **root hooks**，还必须对齐**槽位名 + kind + scope**。上游插件用 `slots.inject(<槽位名>)` 等待父槽位，缺声明会让它**自建槽位并继承错误的 scope**，症状出现在下游而非本插件，极难反查。
  2. **scope 决定条目生命周期**：`session-maybe` 会在未选中会话时卸载条目，任何在其中注册 effect 的插件都会被反复重建；`root` 才是常驻。槽位 kind 同理（`single` 会被替换，`keyed` 按 key 常驻）。
  3. 别把结论推给上游——**先跑官方同版本做对照**。本次若不跑 `dsh web`，极易误判为"Cordis 固有竞态"而放弃。

## 坑 49：发版/提交命令的 stdout 与实际结果不符（命令疑似执行两遍，报错但操作已成功）

- **现象**：执行 `npm run release -- 0.1.1-alpha.7 --push`，输出**只有一行**错误 `✗ 目标版本 0.1.1-alpha.7 必须高于当前版本 0.1.1-alpha.7`，看起来彻底失败；但实际发版**完整成功**——`git log` 有 `chore(release): 版本号升至 0.1.1-alpha.7`、本地与远程 tag 均指向该 commit、远程 `main` 已同步、CI 双平台 workflow 已触发。同批次还出现：`git add … ; git commit …` 输出 `nothing to commit, working tree clean`，而该提交实际已存在。
- **根因**：现象与「**同一条命令被执行了两遍**」完全吻合——第一遍真正完成了 bump/commit/tag/push；第二遍读到的已是 bump 后的版本，于是 preflight 报"版本必须高于当前"。成因未定位（怀疑与命令包装层 `rtk` 代理或 PowerShell 管道组合有关），**注意这不是脚本 dry-run 的问题**：`scripts/release.cjs` 的 `--dry-run` 分支均有 `return`，经实测复核语义正确（零写入，版本与工作区均不变）。
- **解法（应对方式，非根因修复）**：发版、提交、推送这类关键操作**不要以 stdout / 退出码为准**，一律改用客观状态回验，例如：
  ```powershell
  git log --oneline -3
  git rev-parse v<version>            # 本地 tag 指向
  git ls-remote origin refs/heads/main # 远程 main 指向
  git status --porcelain               # 工作区是否干净
  ```
  本次即靠这组命令确认"报错但已成功"，避免了重复发版（重复发版会撞"版本必须高于当前"或产生空提交）。
- **复盘要点**：
  1. 与本仓坑 44（`git push` 报凭据错但推送已成功）**同族**：沙箱与命令包装层会篡改命令的**表面结果**，退出码与 stdout 都不可作为唯一判据。
  2. 关键操作后**先回验状态、再决定是否重试**；盲目重试可能造成空提交、版本号跳号或 tag 冲突。
  3. 报错信息要结合上下文读：`目标版本 X 必须高于当前版本 X`（两者相同）本身就是"已被前一遍改过"的强信号。

## 坑 50：安装版「检查更新」失败原因完全不可见 —— 渠道名不匹配 × github.com 不可达 × 零诊断面三因叠加

- **现象**：v0.1.1-alpha.6 安装版点设置 → 关于 → 「检查更新」提示「检查更新失败，请稍后重试」，且**无论切「正式」还是「预发布」都一样失败**。安装版从资源管理器启动无控制台，终端日志取不到；界面只显示硬编码文案，`status.error` 原文仅在 DevTools 可见 —— 排查耗了两轮对话才定位。
- **根因**（三个独立问题叠加，不是单一"网络不通"）：
  1. **渠道名与 tag 命名段不匹配（预发布渠道必然失败）**：`CHANNEL_FEED.rc = 'rc'` 原样传给 electron-updater；GitHub provider 判定某条 release 属哪个渠道是**从版本号的预发布段取名**（`v0.1.1-alpha.7` → `alpha`），与 GitHub 页面的 pre-release 复选框无关。仓库全部 tag 都是 `-alpha.N`、无 `-rc.N` → 匹配循环走完 `tag` 仍为 null → **在请求任何 yml 之前**即抛 `No published versions on GitHub`（`electron-updater/out/providers/GitHubProvider.js:110-112`）。「正式」传 null，退化为用**当前安装版本自身**的预发布段（`alpha`）匹配，命中 alpha.7 后走 `alpha.yml` 404 → 回退 `latest.yml` 的兜底链成功 —— 即「正式」能用属**歪打正着**。
  2. **本机到 `github.com` 不可达（本次真正主因，也是两渠道共同失败的原因）**：实测 `github.com:443` TCP 连接失败、`releases.atom` / `raw.githubusercontent.com` / `release-assets.githubusercontent.com` 全部超时，而 `api.github.com`（3s）与 `lansi-ai.github.io`（1s）正常 —— 属 **IP 级选择性阻断**。GitHub provider 第一步就取 `{repo}/releases.atom`（上游注释明确"不用 API 是为绕开限流"），此域不通则渠道匹配与 yml 请求都没机会执行。
  3. **失败原因零留痕（诊断面缺失）**：`auto-updater.ts` 的 error 分支只调 `log.error`（stdout/stderr），安装版无控制台即丢失；错误原文虽在 `state.error` 并经 `app-update:status` 下行，但 `desktop-about-client.js` 在 `phase === 'error'` 时只渲染硬编码文案，从不显示 `status.error`；且状态变更走 `sendDesktopEvent` 不落审计，`audit.jsonl` 里只有 `config.write` 的渠道切换记录。
  - 附带发现一处状态缺陷：`error` 字段**从不重置**（`checking` / `not-available` 均不清），一旦 UI 开始显示原文就会显示上一次的陈旧原因。
- **解法**（本次仅修第 3 条；第 1、2 条待决策）：
  - `setState` 增审计落盘：`AUDIT_PHASES` 白名单（checking / available / not-available / downloaded / error）+ 相位变化判定（`error` 每次必写），`downloading` 进度帧被拦截 —— 否则一次 138MB 下载会往 `audit.jsonl` 灌上百条。载荷含 `phase / currentVersion / channel / newVersion / error / errorStack`，文本字段按 2000 字符截断（`truncateForAudit`，防 `ERR_UPDATER_INVALID_RELEASE_FEED` 整段 `feedXml` 撑爆单条 JSONL）。**零 schema 变更**：`desktopEventSchema.payload` 与 `desktopActionEventSchema.payload` 本就是 `z.unknown().optional()`，未碰 `src/types/`。
  - 错误堆栈经局部变量 `lastErrorStack` 捕获、仅在 error 相位写入审计，**不进 `UpdaterState`**（不扩大下行状态面）。
  - 关于页 error 相位补一行等宽小字显示 `status.error` 原文（可见 200 字符 / `title` 上限 2000 字符），主文案保留不动（长错误串会破坏行布局）。
  - `checking` 事件顺手清 `error` 与堆栈，消除陈旧原因。
  - **未修**：① 渠道命名（方案 A 把 `rc` 映射为 `alpha`；方案 B 让发布真正产出 `-rc.N` tag + `rc.yml`）；② 更新源去 `github.com` 依赖。Gitee 侧已实测：`releases/download/{tag}/…` 匿名可读（302 → `foruda.gitee.com` 签名直链，1.4MB/s），但**无 `releases.atom`**（404）故必须改用 generic provider，且 generic **无 `alpha.yml`→`latest.yml` 兜底**；raw 小文件匿名可读、可作 `latest.yml` 固定宿主（免 Gitee Pages 实名）；单文件上限 100MB（另有 300MB 之说）与 132MB 产物**踩线**，是上传前的 go/no-go。
- **验证（2026-09-10 实机 · win-unpacked）**：审计精确落盘 `checking` / `error` 各 3 条（含 `channel`，**零 `downloading`**）；真因捕获为 **`net::ERR_CONNECTION_RESET`**，栈含 `SimpleURLLoaderWrapper`（实证走 Chromium 网络栈 → 系统代理生效，同时反证早期"开系统代理没用"的判断有误）；关于页成功显示该原文；`checking` 记录中无 `error` 字段（证明重置生效）。附带发现：阻断环境下手动检查**挂起约 24 秒**（12:49:33 → 12:49:57）期间 UI 仅「检查中…」，属独立 UX 缺口，已登记待办。本地打包验证另踩坑 51（`--dir` 不生成 `app-update.yml`）。
- **复盘要点**：
  1. 「同一个 UI 动作失败」要**分渠道维度与网络维度分别取证** —— 本次「两个渠道都失败」正是把它俩区分开的关键信号，别把独立故障当一个。
  2. electron-updater 的「渠道」是**从版本号预发布段推出的字符串**，不是 GitHub 的 pre-release 复选框；自建渠道体系必须让 **tag 命名 / `CHANNEL_FEED` / 发布产物文件名三者同源**。
  3. 打包应用的**终端日志等于没有日志**。面向用户的失败路径必须同时具备「可展示 + 可落盘」两条出口，否则诊断成本会外化成多轮往返。
  4. 加"显示错误原文"这类可观测性改动时，要顺手检查**错误字段本身是否会被重置** —— 陈旧值会被新 UI 放大成误导。
  5. 排障先测**分层可达性**（DNS → TCP → 具体端点）再看业务代码；本次判据是 `github.com:443` 不通而 `api.github.com` 通，一步排除"网络全断"误判。

## 坑 51：`electron-builder --dir` 不生成 `app-update.yml` —— 本地打包验证时 updater 必然 ENOENT

- **现象**：为验证"更新失败诊断面"，用 `npm run build ; npx electron-builder --win --dir` 只产 `release/win-unpacked` 目录（刻意避开 `npm run dist` 的同版本号旧包陷阱），启动后点「检查更新」（或等 20s 静默检查）即报：
  ```
  [dsh-updater] Error: ENOENT: no such file or directory,
    open 'E:\Projects\DSH\desktop\release\win-unpacked\resources\app-update.yml'
  ```
  同一份代码 `npm run dist` 打出的安装版内该文件存在、链路正常。
- **根因**：`app-update.yml` 不是"打包就有"的产物，而是 **`PublishManager` 在 `onAfterPack` 钩子里按 target 类型条件写入**的：
  - `app-builder-lib/out/publish/PublishManager.js` 的 `packager.onAfterPack` 中，Windows 分支有一道守卫：
    ```js
    else if (packager.platform === Platform.WINDOWS) {
      if (!event.targets.some(it => isSuitableWindowsTarget(it))) return
    }
    ```
  - 同文件 `isSuitableWindowsTarget(target)` **仅认 `nsis` / `nsis-*`**（以及开启 `electronUpdaterAware` 的 `appx`）。`--dir` 模式不含任何这类 target → `some(...)` 为 false → 提前 `return`，`app-update.yml` 从不写入。
  - 而 `electron-updater` 的 `AppUpdater` 在 `app.isPackaged` 为真时**首次检查必读该文件**，缺件即 `ENOENT`。注意这是"已打包但缺件"的新分支：`auto-updater.ts` 的 `isDisabled()` 守卫只覆盖 `!app.isPackaged`，不覆盖此情形（该守卫的注释本意正是"避免读取缺失的 app-update.yml 抛错"，覆盖面有缺口）。
- **解法**（不需重新打包）：
  ```powershell
  Copy-Item "$env:LOCALAPPDATA\Programs\dsh-forge\resources\app-update.yml" `
            'release\win-unpacked\resources\app-update.yml'
  ```
  文件内容即 publish 段序列化：
  ```yaml
  owner: lansi-ai
  repo: dsh-forge
  provider: github
  updaterCacheDirName: dsh-forge-updater
  ```
  ⚠️ **补完必须重启 app**：`AppUpdater` 对该文件的读取是 memoize 的，首次失败的读取会被缓存，不重启不会重读。
  选型取舍：`--dir` 只产 unpacked 目录（无安装包、不覆写 `release/SHA256SUMS`、不与 CI 已发布的同版本号包混淆，即 M4-a3「新旧混放同版本号」陷阱）；`npm run dist` 能顺带生成 `app-update.yml`，代价是产出同名安装包并覆写校验文件。本地验证推荐 **`--dir` + 手工补 yml** 的组合。
- **复盘要点**：
  1. `app.isPackaged === true` **不等于**自动更新可用：还需 `resources/app-update.yml` 存在，而它的生成取决于"发布配置 + 特定 target"，与"打包"本身无关。
  2. 用裁剪参数（`--dir` / 指定单一 target）做本地验证时，要主动核对 electron-builder 因 **target 守卫而跳过的全部产物**，别默认"打包成功 = 产物齐全"。
  3. 这类"环境缺件"失败**不是静默降级而是每次检查都抛错**，若无诊断面极易被误判成代码 bug —— 本次能一眼定位，正是因为坑 50 的审计与 UI 显示刚落地（P0 的直接收益）。

## 坑 51 附记：`isDisabled()` 的覆盖面缺口（未修，登记待决策）

`auto-updater.ts` 的禁用判据 `isDisabled() = !app.isPackaged || channel === 'off'` 未覆盖「已打包但 `app-update.yml` 缺失/损坏」这一态：真实安装版由 CI 的 nsis 构建保证该文件存在，但 `--dir` 构建、安装损坏、或将来改用 `--dir` 分发便携版时会稳定踩到。可选加固（本次未做）：初始化前探测 `resources/app-update.yml` 是否存在，缺件则降级为禁用句柄并在关于页/审计给出可读提示，而非让每次检查都抛 `ENOENT`。

## 坑 52：手动「检查更新」的结果没有任何用户可见反馈 —— 托盘入口更是全程无感

- **现象**：从**托盘菜单**点「检查更新…」，托盘项只显示「正在检查更新…」，随后**静默恢复**成「检查更新…」，客户端任何位置都不出现结果；用户在 15 秒内连点 3 次（以为没生效）。终端与审计其实都正常：`[dsh-updater] 正在检查更新…` → `[dsh-updater] 已是最新版本 (v0.1.1-alpha.7)`，审计 `app-update:status` 落 `checking` / `not-available` 各 3 条 —— **主进程链路健康，缺口全在用户可见面**。关于页开着时也只有底部状态行文案变成「已是最新版本」。
- **根因**（三处叠加）：
  1. `auto-updater.ts` 的 `notify()` **只在 `update-downloaded` 一个 handler 里被调用**；`update-not-available` 与 `error` 全程静默，不产生任何用户可见反馈。
  2. `desktop-tray.ts` 的更新菜单项只有「检查更新…」/「正在检查更新…」两态，**没有结果态**，检查结束即恢复原样。
  3. 主进程**不区分「手动检查」与「静默自检」**：`check()` 与 `initialize()` 的延迟自检走同一条路径，因此即便想补反馈也无法只对前者生效（而启动自检每次都弹提示会很吵）。
- **解法**：
  - `check()` 拆为 `checkInternal(manual)`：用户入口（关于页按钮 / 托盘菜单）走 `manual=true`；启动延迟自检、渠道切换联动、自动检查开关联动一律 `manual=false`。用 `lastCheckManual` 记录本次检查来源。
  - 手动检查的终态补可见反馈：`update-not-available` / `error` 经 `notifyResult()` 发系统通知，**仅当主窗口未聚焦**（窗口在前台时页内提示已足够，再弹是重复打扰）；通知体取错误**首行摘要**（≤160 字符），完整原文仍在关于页与 `audit.jsonl`。
  - `manual` 随 `app-update:status` 事件下行（payload 契约本就是 `z.unknown().optional()`，**无破坏性变更**）；关于页据此只对用户手动发起的检查弹一条 **6 秒结果提示**（成功绿 / 失败琥珀），定时器由 `useEffect` 清理。
  - 托盘菜单仍不加瞬态结果项（系统通知已覆盖该场景），保持菜单刷新逻辑简单。
  - 审计载荷同步补 `manual` 字段，事后可区分「用户点的」与「自动跑的」。
- **复盘要点**：
  1. **用户主动触发的操作，结果必须落在用户看得见的地方**。把结果只写进"下次打开某个页面才可能看到"的状态，等于没反馈。
  2. 一个服务方法被多种来源共用（页面按钮 / 托盘菜单 / 定时器）时，必须携带**来源语义**，否则"该出声的"与"该安静的"无法分流。
  3. 通知策略要按**焦点状态**去重：窗口在前台时页内提示已足够，再弹系统通知就是噪音；窗口在后台时通知才是唯一出口。
  4. 排查"没有反馈"类问题，先列 **入口 × 可见面** 矩阵 —— 缺口往往落在组合的交叉格里（本次是「托盘入口 × 未打开关于页」）。

## 坑 53：宿主平面 roster 未对齐官方 web profile 的关停表 → 极简模式照样带着整套工具目录，每轮白烧数千 token

- **现象**：同一台机器、同一个 `$DSH_HOME`、同一个模型（`deepseek-official/deepseek-v4-flash`），官方客户端极简模式一轮「本轮用量」≈ 400 tok，DSH Forge 桌面客户端极简模式一轮却报 **6,264 tok**（未缓存 240 + 缓存读取 6,016 + 输出 8，缓存命中 96.2%）。用户体感"都是极简模式，为什么我的客户端这么贵"。归档证据：`$DSH_HOME/storages/session_projcache/sessions/*.json` 里 `agentPreset = minimal` 而 `contextBreakdown.toolsTokens` 与真实 `tokenUsage` 相差一个量级；同一批会话中 `standard` 的 `toolsTokens = 6905`，而官方极简应为**一个持久 shell 工具（约 195 tok）**。
- **根因**（五层叠加）：
  1. `@deepseek-ai/dsh-base/cordis.patch.yml` 是**宿主平面**官方 roster，把模型可见能力全部注册在 root context：`tool-pwsh` / `tool-fs` / `tool-fs-search` / `tool-jobs` / `tool-skill` / `skill-filesystem` / `tool-goal` / `tool-todo` / `tool-ralph` / `tool-web` / `tool-subagent`(×4) / `tool-workflow` / `workflow-worker-thread` / `agent-instructions` / `plan-mode` / `compaction-basic` / `command-compact` / `tool-result-pruner`。
  2. 官方 web profile（`@deepseek-ai/dsh-web-app/cordis.patch.yml`）**逐行 `disabled: true` 把它们摘掉**，改由 agent 预设的 `agent.cordis.yml` 各自声明（四个 shipped 预设 standard / ptc / cordis / minimal 都自带完整工具行）。桌面 `boot.ts` + `desktop-patch.yml` 当初只对齐了 web **传输层**（webserver / web-runtime / modules / client-* ),这 23 行**一条没关**。
  3. 语义依据：`dsh-tools` 的 `view(scope)` = **全局层 + scope 链**（`ScopedLayers.chainLayers` + `this.layers.global.tools.entries()`）。预设注册只能影子遮蔽**同名**工具，**挡不住全局层里的其它工具**；全局层不带 scope，对所有 agent（含极简）可见。
  4. 极简预设把 persona 标 `complete: true` **只裁「提示词文本段落」**——`dsh-system-prompt` 里 `sections` 塌缩成 `[completeSection]`，但 `assembly.tools` 照旧 `orderTools()` 收集 → 工具目录不受 `complete` 影响，这正是它能穿透"极简"的机制缝隙。
  5. 同理 `agent-instructions`（`maxBytes: 65536`）也是全局注入，极简模式本不该带工作区指令文件。
- **解法**：
  - `boot.ts` 新增 **§3b**（`desktop-patch.yml` 同步为参考文档）：照官方 web profile 的关停表逐行 `{ id, disabled: true }`，共 24 行 = 官方 23 行 + 桌面遗留 `tool-str-replace-editor`（官方 base / web / 四个 shipped 预设均无此工具，属 rc.x 时代残留）。四个预设自带工具行，故能力零损失。
  - 删除仓库自带的裁剪预设 `resources/agent-presets/standard/`：`includeShippedRoot` 默认 `true`、shipped 根排在 `config.roots` **之前**、且「同名 id 前一个根赢」→ 这份与官方同名的副本**从未生效**（运行时一直是官方 standard），只会制造"以为在跑自有预设"的错觉。预设来源从此 = shipped 根 + `$DSH_HOME/.agent-presets`（用户根），与官方一致；桌面自有扩展根（`dist/resources/agent-presets`，默认空目录）保留，`scanRoot` ENOENT → `[]` 属官方合法部署态。
  - `main.ts` 3.5 步「扫描为空」报错文案由 `dist/resources/agent-presets` 改指 shipped 根，避免误导排查方向。
  - 新增 §7.3 拴合面行：上游升级时必须重跑官方两份 patch 的 diff，同步增删本清单（漏对齐不报错、只烧 token）。
- **复盘要点**：
  1. **抄官方 roster 必须连它所在 profile 的关停表一起抄**：官方结构是「base insert + 本 profile 的 disabled 覆盖」；只抄 insert 等于把官方已下线的能力全留在宿主平面。
  2. **注册表类服务的作用域可见性是「并集」不是「覆盖」**：预设声明只管自己，判"某预设实际看到什么"要按 `view(scope) = global + 链` 推，不能按"预设声明了哪些"推。
  3. **判据要双读**：本地 `contextBreakdown`（估算）vs 模型侧 `tokenUsage`（真实），差一个量级即泄漏信号；缓存命中率高只代表"便宜"，不代表"小"。
  4. **同名资源 id 的遮蔽是静默的**：`dsh-agent-presets` root 顺序（shipped → config.roots → user）+ "前一个根赢"会让仓库自带同名副本变死代码——"改了没生效"先查优先级，再查代码。
- **实机验证**：2026-09-10 用户确认通过（极简模式「本轮用量」回落、标准模式能力不回归）。

## 坑 54：全局图标目录「只增不改」——随包品牌资源（应用/托盘图标）更新永远到不了存量安装

- **现象**：应用图标与托盘图标由「透明底金标」改为「黑底圆角实底 + 金标」（用户指定），脚本、资源、宿主代码全部改完且 `npm run build` 通过，**本机启动后图标照旧**。运行期真源 `$DSH_HOME/icons`（本例 `E:\Projects\DSHPath\icons`）里 4 个文件仍在，ready 阶段的 `migratePackIconsToGlobal()` 只做「全局缺失才从包根复制」，已有文件一律跳过 → 新图标永远进不来。哈希对照更进一步：运行期这 4 个文件与 `HEAD` 里的随包资源**也不相同**（早期本地生成与提交时机错位），即「存量的来源已不可追溯」。
- **根因**：`migratePackIconsToGlobal()` 的唯一判据是 `existsSync`。全局目录被当成"用户真源"（动机正确：用户自己上传的图标不能被覆盖），但代码里**没有任何手段区分「随包资源」与「用户自定义」** → 任何随包品牌变更都被收敛成"第一次装上以后永不更新"。附带问题：该函数的源顺序是「激活包优先、其余包次之」，而品牌其实与激活包无关（D-23 之后全局图标与图标包解耦），非 default 包残留的历史 app/tray PNG 会被误当品牌源。
- **解法**：引入**品牌资产修订号**——`BRAND_REVISION`（形态每次变化递增）+ 全局目录内 `.brand-revision.json`（记录修订号 + 各文件写入时的 sha256）；`syncGlobalBrandAssets()` 取代 `migratePackIconsToGlobal()`：
  - 修订号一致 → 直接返回（常规启动零额外 IO）；
  - 修订号变化 → 逐文件判定：全局缺失，**或**内容等于上次随包写入的哈希（含无标记的存量安装）→ 覆盖为新版；内容已被用户改过 → 保留并在日志列出被保留的文件名；
  - 真源由「激活包根」改为**内置 web 目录**（`resolveDefaultIconPath` → `dist/desktop-shell/web/`），品牌与激活包彻底解耦；写入完成后落盘新修订号 + 哈希表（落盘失败只告警，下次启动重试）。
- **复盘要点**：
  1. **「用户可自定义的目录」+「随产品迭代的资源」共存时，必须有来源标记**（修订号 / 内容哈希），否则只能在"永不更新"与"每次覆盖用户自定义"两个坏选项里二选一。
  2. 判据只有 `existsSync` 的"迁移"函数，其真实语义是**一次性种子**，不能当"同步"用；文件名里写 migrate 也别信。
  3. **存量安装的现状文件可能不等于任何一次随包资源**（本地生成/提交时机错位）→ 设计刷新策略时按「未知来源 = 可刷新」处理，但要把刷新/保留的数量与文件名写进日志，事后可追溯。
  4. 资源类改动验效要**读运行期真源目录**（`$DSH_HOME/icons` 的文件 + 哈希），只看仓库里资源已更新等于没验证。
  5. 品牌类资源改动的效力边界要分清：任务栏/窗口/托盘/Dock 图标运行时读全局目录（重启即变），**桌面快捷方式与安装包图标**取自 electron-builder 的 `icon:` 源图（需重新打包/安装）。

## 坑 55：agent 预设的「静态 inject」是宿主 roster 的硬门禁 —— `cordis-host-runner` 从未插入，创造模式必然挂载失败

- **现象**：切到「创造模式」（agent 预设 `cordis`）报
  `preset "cordis" failed to mount: 1 row(s) did not activate: tool-cordis (@deepseek-ai/dsh-tool-cordis): waiting for dynamicCordisRunner, cordisInspect`，
  预设整块挂不上（该模式不可用），而 `standard`/`minimal` 等预设正常。
- **根因**（两层）：
  1. 预设最后一行 `tool-cordis` 静态 `inject: [dynamicCordisRunner, cordisInspect]`；这两个服务由官方 `@deepseek-ai/dsh-cordis-host-runner` 提供，而桌面 `boot.ts` **从未 insert 这一行** —— 记录的只有 §3 里一条 `{ id: 'cordis-host-runner', disabled: true }`。该条目其实是**空操作**：dsh-base 的 roster 里根本没有这一行（对照 `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`，`rg 'cordis-host-runner'` 零命中），非 insert 补丁只按 id 覆盖已存在条目。
  2. 配套的浏览器两半（`dsh-cordis-client-runner`、`dsh-client-ui-cordis`）被列入 `CLIENT_EXCLUDE_IDS`（2026-09-01 因宿主半缺席致 `syncInspectManifest` 404 刷屏而清噪）→ 即使宿主半回来，没有面板也无人能审批带浏览器半的包。
- **解法**（对齐官方 web profile：`dsh-web-app/cordis.patch.yml` 第 122 行 host insert + 客户端两半在 browser roster）：
  - `boot.ts` §1 insert `cordis-host-runner`（它自身只 `inject: ['tools']`，而 `tools` 服务行早已在 §1）；§3 删掉两条空操作禁用项。
  - `boot-graph.ts` 回填两个 client 半；`cordis-inventory.ts` 退役 `dynamicCordisRunner/inventory` 兼容注册（unary 表优先于 apiProxy，继续注册会遮蔽官方实现），只留自研设置页用的 `pluginInventory/list`。
  - 自绘侧栏补声明并渲染 `sidebar.footer.action`（`list`/`root`，官方 ui-sidebar 同款）→ ui-cordis 的面板入口有落点（缺声明会走「上游自建槽位」路径，坑 48 同款）。
  - 安全口径登记 `docs/08-security.md` §4：动态包 ≈ bash 访问，`node:vm` 非安全边界，带浏览器半的包需页面审批。
- **复盘要点**：
  1. **「禁用一条不存在的行」是空操作**：非 insert 补丁（`{ id, disabled }`）只覆盖已存在条目，若服务的**提供行从未插入**，写多少条 `disabled: true` 都只是文档；判「某服务为什么缺席」的正确顺序 = 报错里的服务名 → 找提供它的官方包 → 回 roster 查**有没有 insert 行**（不是查有没有 disabled 行）。
  2. **agent 预设的 `inject` 是宿主平面的硬契约**：预设行声明了服务就要求宿主提供，缺一个服务 = 整个预设 mount 失败（`N row(s) did not activate`），报错行点名「等待的服务」是最直接的定位线索；新增/裁剪宿主 roster 时要按「官方 profile 提供了什么」做全集对账（坑 53 的姊妹规则：那边是「多抄了会渗进所有预设」，这边是「少抄了预设挂不上」）。
  3. **清噪式的排除会留下运行期债**：当年为消 404 把 client 半整体移出图谱是对的（当时宿主半确实不存在），但必须把「谁依赖谁、恢复条件是什么」写进台账——本次即靠这条线索一次性把三处（host insert / client 回填 / 面板槽位）配齐；恢复时**三处必须同批**，只回填一半会出现「工具能跑但审批页不存在，带浏览器半的包永久挂起」这种更难查的态。
  4. **历史理由要复核**：文档里「零端口架构冲突」的说法经复核不成立（runner 是进程内 vm，不监听端口）。判断一条架构性禁用理由是否仍有效，看**该行实际占用了什么外部资源**（端口/路径/全局单例），不要只看当年的结论词。

## 坑 56 · `git status` 报 `M` 而 `git diff` 为空：索引 stat 缓存尺寸失配（旧版把它误判成「行尾不同」，见复盘要点 1）

- **现象**：合并/发版被拦住，但差异根本不存在——报错伪装成「你真的改了代码」：
  ```
  $ git merge --ff-only trae/renameplugin
  error: Your local changes to the following files would be overwritten by merge:
          docs/adr/adr-002-inprocess-host.md
  Aborting

  $ git diff --numstat            # 空输出（零内容差异）
  $ git status --short
   M docs/adr/adr-002-inprocess-host.md
  warning: in the working copy of 'docs/adr/adr-002-inprocess-host.md',
           LF will be replaced by CRLF the next time Git touches it
  ```
  同一形态也会让 `npm run release` 预检失败（`工作区不干净，请先提交或暂存以下改动`）、CI 门禁中止。

- **根因**（实测证据，非推断）：
  1. **索引里的 stat 缓存 `size` 与实际不符**：`git ls-files --debug <path>` 读出的 `size: 1558`，而工作区文件实际 **1532 字节**；差额 26 恰是 26 行的 CRLF 膨胀量 → 索引记录的是「CRLF 版尺寸」，工作区已是 LF 版。
  2. 工作区行尾变成 LF 之后（工具写入落 LF，或 git 写出 CRLF 后被编辑器/工具归一化为 LF），**索引 stat 未同步**。`git diff` 会走 clean filter 规范化后再比较 → 内容一致 → **输出为空**；`git status` 先比 stat → 尺寸不符 → **报 M**。两者结论相反，就是本坑的指纹。
  3. 决定性判别 = **内容哈希完全相同**：
     ```
     $ git rev-parse HEAD:docs/adr/adr-002-inprocess-host.md
     9633746aa1193743290a3e33b10c36238af50d39
     $ git hash-object docs/adr/adr-002-inprocess-host.md
     9633746aa1193743290a3e33b10c36238af50d39    # 相等 → 纯 stat 失配，零内容差异
     ```
  4. 附带现象：`--ff-only` 合并时 git 判定「目标内容与工作区一致」→ **跳过重写文件** → 失配被原样保留，报错在后续每次操作里反复出现。

- **解法**：
  ```powershell
  # ① 判别：确认是纯 stat 失配（两个哈希相等），而不是真的改了内容
  git hash-object <path>                              # 工作区字节哈希
  git rev-parse HEAD:<path>                           # 库内 blob 哈希
  git ls-files --debug <path> | Select-String size    # 索引 stat 尺寸 vs 实际字节数
  git ls-files --eol <path>                           # 行尾（辅助信息，非判据）

  # ② 修复：重新 add 一次刷新 stat —— 内容相同则不会产生任何暂存变更
  git add <path>
  git status --short                                  # 该文件应从列表消失
  ```

- **复盘要点**：
  1. **`git diff` 空 + `git status` 报 `M` 的第一嫌疑是「索引 stat 尺寸失配」，不是「行尾不同」**——后者只是最常见的触发方式。本坑最初被误判成行尾问题，写出了一版「删文件 + `git checkout`」的错解法，靠哈希比对才纠正。判别顺序固定：`git hash-object` vs `git rev-parse HEAD:`（内容）→ `git ls-files --debug`（stat 尺寸）→ `git ls-files --eol`（行尾，仅辅助）。
  2. **`git add <path>` 才是正解**：内容一致时它只刷新 stat、不产生暂存变更。实测**无效**的两种写法：`git update-index --refresh`（不修此类失配，`M` 依旧）、`Remove-Item` + `git checkout -- <path>`（把工作区写回 CRLF——若是 LF 与 CRLF 尺寸差导致的失配，此时会「暂时」变干净；但只要编辑器/工具随后把行尾再归一化为 LF，失配立刻复发。本次就这样反复了两次，一度以为已修好）。
  3. **别被 `--ff-only` 的报错文案带偏**：`Your local changes ... would be overwritten` / `工作区不干净` 都把矛头指向「本地改动」，而本例一个字节都没改。判断口诀：**报错说你有本地改动、但你确信没碰过代码 → 先跑 `git hash-object` 与 `git rev-parse HEAD:<path>` 对哈希**，相等就不要再找代码差异了。
  4. **别据此去改全局行尾策略**：实测全仓有 39 个文件是 `w/lf`（`.gitignore`、`tsconfig.json`、`website/**`、多数 `docs/adr/*` 等）却长期「干净」→ 在 `core.autocrlf=true` 下 LF 工作区**并不必然**报 `M`，真正触发的是「索引 stat 尺寸与实际字节数不符」的那一个文件。顺手去改 `core.autocrlf` 或加 `.gitattributes` 只会把问题转移到另一批文件上。

## 坑 57：插件列表数据面取错真源 —— 官方「插件列表」读 Loader 真实插件树，forge 只读客户端图谱 → 宿主侧插件（`tool-pwsh` 等）在列表与搜索中完全缺失

- **现象**：同一台机器、同一个「设置 → 插件 → 插件列表」窗口，官方网页版与 forge 结论相反：
  - 官方搜 `pwsh` → 命中 4 项：会话插件 `terminal-bash` / `tool-pwsh-persistent`（「其他预设中还有 3 个匹配」），全局插件 `pwsh-sandbox` / `tool-pwsh`（`tool-pwsh` 带「预设中启用」标记）。
  - forge 搜 `pwsh` → 「没有匹配的插件。」+「全局插件 · 系统与所有会话共用 · **0 个**」，且**整个「会话插件」分组不渲染**、无任何「预设中启用」标记。
  注意 forge 页面**没有**出现读取失败的错误态（该 Tab 有显式 error 态 + 「重试」按钮）——说明 `pluginInventory.list` 链路是通的，只是**返回内容里就没有这些插件**。

- **根因**（两处叠加，任一处都足以让 `tool-pwsh` 消失）：
  1. **「插件列表」是两个包分工，forge 只换了数据面那一个**：
     - 数据面 `@deepseek-ai/dsh-host-plugin-inventory`（host）→ `ctx.loader.entries()` 的**真实 Cordis Loader 插件树**，再经 `ctx.get('agentPresets').compositionInventory()` 追加每个预设的组成行；
     - 界面面 `@deepseek-ai/dsh-client-ui-settings-plugin-inventory`（client）→ 注册 `settings.plugins.tab`（`id:'all'`）渲染 Tab。
     forge 的界面面一直是官方的，而数据面被自研 [cordis-inventory.ts](file:///e:/Projects/DSH/desktop/src/forge-host/cordis-inventory.ts) 顶替。
  2. **自研数据面在 boot 之前注册，只能从「客户端资源图谱」派生**：`registerCordisInventoryCompat()` 在 [main.ts](file:///e:/Projects/DSH/desktop/src/forge-shell/main.ts#L373-L374) 的 step 2.5 调用（此时还没有 `hostCtx`），于是取数走 `generateBootGraph()`。而图谱的扫描条件是 `dsh.client.platform === 'web'`（[boot-graph.ts](file:///e:/Projects/DSH/desktop/src/forge-host/boot-graph.ts#L243-L262)）——**只含界面半**，宿主侧插件（`tool-pwsh` / `pwsh-sandbox` / `terminal-bash` 等）根本不在其中。
  3. **快照缺 `agentPresets` 字段** → 页面 `const presets = snapshot?.agentPresets ?? []` 得空数组 → 「会话插件」分组不渲染、`enabledIn` 反查表为空 → 「预设中启用」标记永不出现。（forge 其实**已装载** `agent-presets` 服务，只是没人去读它。）
  4. 附带的架构性事实：**bridge 的 unary 表分发优先于 apiProxy**（[bridge.ts](file:///e:/Projects/DSH/desktop/src/forge-host/bridge.ts#L195-L213)），自研注册 `pluginInventory/list` 即等于接管该端点 —— 官方 host 半即使装上也会被遮蔽，两者只能二选一。

- **解法**（数据面 + 界面面同批自研，2026-09-10；**实机验证通过 2026-09-11 · 用户确认：极简模式列出 6 行、预设切换器与两级分组均正确**）：
  - 数据面三源合并：`ctx.loader.entries()`（主进程半，跳过 group 条目）+ boot-graph 的 client bundle（界面半）+ `agentPresets.compositionInventory()`（预设组成），按模块名归并，同名两侧 → `half:'both'`；`enabled` / `fiberPhase` 取 Loader 真实值（`FiberState` 0..5 → `pending/loading/active/failed/null/unloading`）。
  - **绑定挪到 boot 之后**：新增 `bindCordisInventoryHost(hostCtx)`，在 `bootDesktopHost()` 返回后调用；handler 仍在 boot 前注册（UI 打开时才被调用，故不构成竞态），未绑定时降级为「仅客户端图谱」并显式告警。
  - 界面面自研 `@lansi-ai/dsh-forge-plugin-inventory` 接管 `settings.plugins.tab`（`id:'all'`），官方同名 Tab 包进 `CLIENT_EXCLUDE_IDS`（否则同一 list 槽位出现两个 `id:'all'`）；「插件」section 外壳（含「插件配置」Tab）仍用官方 `ui-settings-plugins`。
  - 展示口径演进：v1 = 「桌面定制单列表 + 半身/来源/状态徽标」（80+ 项平铺无层次、徽标堆叠、预设名只在 hover 上＝不可见）；v2 = **两级分组 + 筛选 chips + 精简两行 + 点行展开详情**；v3 = 分组②改为「预设组成」并加**预设切换器**（见复盘要点 6：曾按预设名平铺会给 4 个 shipped 预设铺出 **92 行**且大量重复）。预设名升为行内可见文案，且仅在「全局停用、靠预设启用」时出现（避免与状态文案重复）；搜索仅匹配模块名与条目 id（对齐官方口径）。

- **复盘要点**：
  1. **「列表为空/搜不到」第一步是分辨「链路断」还是「数据不对」**：显式错误态是免费的分水岭——没有错误态 = `list()` 成功返回，此时去查返回内容，别去查网络/时序。
  2. **看「有没有」的清单，真源必须是装配树，不能是文件系统/资源图谱**（通用方法论第 20 条同源）：图谱回答「哪些资源会被加载」，`loader.entries()` 回答「哪些插件真的在跑」，两者对宿主侧插件差一个全集。
  3. **需要宿主服务的数据面，注册与取数是两个时机**：handler 可以在 boot 前注册（懒调用），但**读 loader / agentPresets 必须等 boot 完成**；把「注册」写成模块级静态数据构造，就会永久锁死在 boot 前的可见信息量上。
  4. **unary 表优先于 apiProxy 是一条双向契约**：自研要补位就补位（官方端点不存在时），但要清醒地知道「补位即接管」；官方 host 半装载后必须撤掉同名自研注册，否则官方实现静默失效（坑 55 同款陷阱）。
  5. **官方给的数据字段别自作主张省掉**：`agentPresets` 不是「可有可无的附加信息」，它是页面渲染「会话插件」分组与「预设中启用」标记的**唯一依据**，省掉等于删功能。
  6. **「列出某个预设挂了哪些行」时，三条聚合纪律缺一即少行**（本次一次踩满）：① **主键用 entryId 而非模块名**——`minimal` 的 `terminal-bash`（bash）与 `terminal-pwsh`（pwsh）同名同为 `@deepseek-ai/dsh-terminal-bash`，仅 entryId 不同，按模块名去重直接吞掉一行；② **停用行照列**——`disabled: !!js process.platform === 'win32'` 的 bash 栈在 win32 就是「已停用」，过滤掉等于删掉「本机为何没有 bash」这个答案（官方会话插件分组同口径，标签为 已启用/已停用/条件启用）；③ **不并进全局平面**——同名模块若在全局平面已有行，预设行被吸收后就永远看不见。另外：**4 个 shipped 预设合计 92 行且彼此大量重复**（standard 28 / ptc 29 / cordis 29 / minimal 6），必须用**切换器**一次看一个，平铺即灾难；验证数据口径的最快路径是直接读 `node_modules/@deepseek-ai/dsh-agent-presets/presets/<preset>/agent.cordis.yml`（组行 `group: true` 递归展开、跳过组行本身），比反复猜 API 返回快得多。

## 坑 58：外部插件以**裸包名**声明时在 dsh-forge 里永远解析不到 —— `boot()` 不读 profile + `bareModuleBaseUrl` 把裸名钉死在应用自己的 node_modules

- **现象**：按上游 profile 约定把插件行写成裸包名（`name: dsh-llm-app-credentials`，包放 `$DSH_HOME/profiles/node_modules/`），官方 dsh CLI 装载正常；dsh-forge 里**插件毫无反应**——没有报错、没有日志，设置页也不出现新 section。反向线索：把同一行改成**绝对路径** `name: E:/.../lib/index.js` 就立刻生效。

- **根因**（两层，第一层让配置整层不存在，第二层让裸名即使被读到也解析不到）：
  1. **`boot()` 本身不读 profile**。[boot](file:///e:/Projects/DSH/desktop/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js#L1525-L1547) 的入参只有 `absoluteConfigPath` + `patches` + `prepare` + `bareModuleBaseUrl`；`loadProfile` / `loadProfileDirectory` 是**调用方**的职责（`dsh-app-boot` 只在它自己的 CLI 里接）。而 forge 的 [bootDesktopHost](file:///e:/Projects/DSH/desktop/src/forge-host/boot.ts#L493-L629) 一直直传自写的空 `cordis.yml` + 硬编码 `DESKTOP_OVERLAY_PATCHES` → `$DSH_HOME/profiles/dsh-forge/cordis.patch.yml` 这层**从头到尾没被消费过**（不是读错，是没读）。
  2. **裸名被 `bareModuleBaseUrl` 钉死**。[mountRootInclude](file:///e:/Projects/DSH/desktop/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js#L1322-L1333) 在给了 `bareModuleBaseUrl` 时，把**所有既不绝对也不相对**的 specifier 交给 `internal.import(specifier, bareModuleBaseUrl)`；forge 在 dev 传 `desktop/node_modules`、打包传 asar 内 node_modules —— 两处都**永远够不到** `$DSH_HOME/profiles/node_modules`。同一段代码里恰好写了出路：`isAbsolute(name) ? pathToFileURL(name).href : name` —— **绝对路径是上游原生支持的**。

- **解法**（2026-09-11；`npm run verify:profile-plugins` 8/8 + typecheck/lint/build/30 单测全绿，插件已实机装载）：
  - **新增装载层**：[profile-plugins.ts](file:///e:/Projects/DSH/desktop/src/forge-host/profile-plugins.ts)（解析/初始化 `$DSH_HOME/profiles/dsh-forge`，收集各 bundle 层 + 用户层的补丁文件，**把插入行的裸名改写成入口绝对路径**，导出体检通过的外部包）+ [plugin-package.ts](file:///e:/Projects/DSH/desktop/src/forge-host/plugin-package.ts)（包解析 + **peer 可解析性体检** + `dsh.client` 浏览器半声明）。
  - **补丁语义不另起一套**：解析仍走官方 `loadOverlayPatches`（`!!js` 求值、相对路径锚定逐字一致）；本层只做「加一层 + 改写名字」。
  - **发现与作用分离**：`boot-graph.ts` 的图谱生成是**同步**的，所以发现扫描用 `yaml.parse({ logLevel:'silent' })` 只读行（实测 `!!js` 标签只告警不抛错），而补丁的**求值**留在 async 的 `boot.ts`。
  - **只改写 `insert[]` 里的 name**：`{ id, name, config }` 形式的覆盖补丁里 `name` 是**匹配条件**，改写它会让该补丁静默失效。
  - **零回归**：`$DSH_HOME/profiles/dsh-forge` 不存在且没装外部插件时，补丁栈与改动前完全相同（profile 目录由本层按需初始化，模板写 `[]`）。

- **复盘要点**：
  1. **「配置写在文件里」≠「配置被读」**：这类故障全程静默、无日志、无报错。排查「某层配置不生效」的第一问必须是**谁在消费它**——本次的答案是「没人」：`boot()` 只吃 `patches`，profile 是调用方的活。
  2. **解析基址（`bareModuleBaseUrl`）是全局开关**：一旦固定，**所有**裸名都被钉死在那一棵 node_modules 上，外部安装路径只能退化为绝对路径。看到「上游支持某写法但这里不行」时，先去看解析基址，而不是先去怀疑插件本身。
  3. **`internal.import` 同段代码里的 `isAbsolute` 分支就是官方给的答案**：绝对路径被转成 file URL 直取，与 base 无关——上游设计里已经预留了「外挂」这一格，只是 forge 过去没有走到。
  4. **ESM 模块身份是硬约束，不能用 `npm install` 解决**：外部插件要复用宿主的 `LlmAdapter` / `LlmError` / `Service` 基类，就必须解析到**同一实例**。手段是在插件目录内建指向宿主 `node_modules` 的 **junction**（Windows junction 免管理员权限；symlink 需要），Node 走 realpath 后命中同一模块记录。装第二份副本 → 注册与错误分类都会以最难查的方式失败。
  5. **要「装坏不影响主程序」就必须自己做插入前体检**：`assertEntriesActivated` 对**任一**未激活条目抛错并回滚整棵树（fail-closed），所以一个 peer 链坏掉的插件足以让应用起不来。本层在插入前逐个 `resolve` 声明的 peer，不通过就**跳过 + 响亮告警**（给出可操作修复语句），而不是把 Loader 的报错留给用户。
  6. **外部插件的「发现」发生在进程启动**，新装/卸载需重启应用；这与「图谱在页面加载时重建」不矛盾——后者只是对**已发现**的包重算 bundle rev。别把两者混为一谈而误以为「刷新页面即可装载新插件」。

## 坑 59：外部 LLM 适配器不声明推理档位 → 存量 `reasoningEffort` 在**任何网络 I/O 之前**就把请求拒掉

- **现象**：把 `agent-default-model.provider` 切到新装的外部适配器路由后，第一次请求就失败，报 `provider "…" model "…" does not support reasoning effort "off"`（`UNSUPPORTED_REASONING_EFFORT`）；终端里**没有任何出网迹象**（连接都不曾建立），容易误判为「上游连不上」。

- **根因**：
  1. `dsh-llm` 的档位校验是**拒绝式**的。[resolveCallWithInfo](file:///e:/Projects/DSH/desktop/node_modules/@deepseek-ai/dsh-llm/lib/index.js#L2110-L2125) 里 `reasoning === void 0`（模型未声明档位）且 caller 传了 `requested` → 直接抛；且它在 provider I/O **之前**执行。
  2. **`reasoningEffort` 是「存量常在」的**。`dsh-agent-default-model` 的设置分节带这个字段（README 明确「它属于设置层、不是配置字段」），`selection()` 把存储值原样投影进 `currentSelection()` → 只要用户曾经存过一次，它就一直跟着请求走。
  3. harness **没有** `off` 哨兵：`dsh-llm` 全 lib grep `'off'` 零命中。所以「关闭」也必须由**适配器自己声明**，否则连「什么都不发」这个诉求都表达不了。

- **解法**（插件侧，2026-09-11）：`resolveModel` 恒返回 `reasoning` —— 「关闭」(`off`) 恒在且为 `defaultEffort`（发不出任何 `reasoning_effort`），其余档位由每路由 `reasoningEfforts` 配置（默认 `[low, medium, high]`，置 `[]` 即只开放「关闭」）；序列化端把 `off` 直接丢掉。验证：直接实例化适配器断言 6 项（off 不进 body / high 进 body / 未指定不进 body / 必有 off 档 / 默认档为 off / `[]` 时只剩 off）全绿。

- **复盘要点**：
  1. **写适配器时，「可选能力」的元数据往往是必填项**：不声明 ≠ 不支持，而是「一律拒绝」。`resolveModel` 上那些可选字段（`reasoning` / `context` / `defaultMaxTokens`）都要先问一句「不声明时 harness 会怎么对待」，再决定省不省。
  2. **官方 UI 会顺手清脏值，手改配置文件不会**：`agent-default-model.saveSelection()` 走 `settings.replace(ns, {provider, model})` —— **缺键即清**，所以官方「模型」页切换 provider 时会自动清掉旧档位；而手写 `settings.yaml` 保留 `reasoningEffort: off` 就会踩坑。排障先分辨用户走的是「UI 路径」还是「手改路径」。
  3. **「无值」语义必须由声明者定义**：harness 只认「声明集里的 id」，不存在通用哨兵。把 `off` 做成「声明集首项 + defaultEffort」，既过校验又准确表达「什么都不发」。

## 坑 60：schemastery 可选嵌套对象的内层 `.required()` 必然报错 —— 且抛在 `ctx.inject` 回调里会被 Cordis **隔离**，表现为「设置页静默 unavailable」

- **现象**：外部插件的设置页**正常出现**（UI 半、槽位注册都对），但页面上命名空间是 `unavailable`、`0 条路由`；**终端没有任何报错**。反证：同一个插件的适配器路由其实注册成功了（`ctx.llm.listProviders()` 能看到）——即「host 半活着，但设置命名空间不存在」。

- **根因**（三层叠加，缺一层都不会这么难查）：
  1. **schemastery 的可选嵌套对象会先materialize 成 `{}`**，再跑内层 schema。所以「外层可选 + 内层 `.required()`」这个组合**不可表达**：只要某条 profile 省略了 `attribution`，校验就报 `$.providers.<route>.attribution.product missing required value`。
  2. **异常抛在 `ctx.inject(['settings'], cb)` 的回调里** —— 该回调在条目**激活之后**才执行，抛错被 Cordis 隔离，`assertEntriesActivated` 早已通过，于是 boot 照常成功、窗口照常打开，故障退化为**纯粹静默的功能缺失**。
  3. **`unavailable` 的官方语义**正是「该命名空间未暴露给此客户端」，所以症状把注意力引向「客户端 / 权限 / 连接」，而真因在 host 侧的 schema 校验。

- **解法**（插件侧，2026-09-11）：内层字段去掉 `.required()`，完整性改在**用点**判定（`completeIdentity()`：三项缺一即退回插件身份，绝不发一个 product 为空的 `User-Agent`）；并把 `installSection` 整段包 `try/catch` + `logger.error`——**注册失败必须响亮**。验证：用真实 `boot()` 在纯 Node 起最小树，断言「适配器路由已注册 / 命名空间已注册 / base 含两条探测路由 / schema 默认已materialize / 必有 off 档且默认 off / off 不上线 / high 上线」共 **7 项全绿**。

- **复盘要点**：
  1. **schemastery 里「可选对象 + 内层必填」不可表达**：内层 `.required()` 只在「外层一定存在」时成立——外层自己也 `.required()`，或它处在数组元素里。想表达「给了就必须给全」，只能写进 `validate` 回调，或在**用点**兜底。
  2. **`ctx.inject` 回调是「已激活之后」的代码，抛错会被隔离**：凡写在这里的初始化（注册命名空间、注册目录、订阅服务）都必须自带 `try/catch` + 明确日志，否则故障一律表现为「功能静默缺失」，而不是「启动失败」。
  3. **「一半功能在、一半不在」先怀疑注入回调**：本次「适配器路由有（`apply` 顶层成功）＋ 命名空间没有（inject 回调内失败）」这个组合，把范围一步压到 inject 回调内部，比盲查客户端快得多。
  4. **纯 Node 复现宿主装配是可行且高效的**：给最小 patch 集 + 真实 `boot()`，就能在沙箱内验证条目的激活与命名空间注册，不必反复启 Electron。**注意** `bareModuleBaseUrl` 必须传 **file URL**（`pathToFileURL(dir).href + '/'`），传文件路径会以 `Invalid URL` 报错并把你带偏——那是探针的坑，不是插件的。

## 坑 61：Electron 宿主里**所有走 `ctx.subprocess` 的工具都会卡死** —— 上游 runner 用 `process.execPath` 拉起，而那是 GUI 子系统的 `electron.exe`

- **现象**：在 DSH Forge 里让模型调用 `pwsh` / `grep` 工具 → 工具调用**卡住不返回，点停止也没反应**；**官方 web 端同一批插件完全正常**；**与路径无关**（`Downloads`、新建的 `E:\test`、`plugins` 目录都卡）；机器与文件系统健康（实测插件 `src` 遍历 1ms、系统 CPU 22%、无环路、无残留进程）。

- **根因**（三层，第 3 层解释了「为什么恰好是这两个工具」）：
  1. **上游用 `process.execPath` 拉起 Node 版 runner**：`dsh-subprocess-local/lib/index.js` 的 `launchWindowsJob` 执行
     `(internals.spawn ?? spawn)(process.execPath, [runnerEntry, "--", ...targetArgv], { env: runnerEnvironment(...), stdio: runnerStdio(spec, true, ...) })`，
     随后 `await child.on('message')` 取结果（Windows 下 runner 经 **IPC** 回报；Node 的 IPC 在 Windows 上正是**命名管道**，这解释了工具文档里那句「confined 模式下不能开命名管道」）。而 `spawnRunnerInvocation()` 返回的正是 `[process.execPath, <runner 入口>]`。
  2. **Electron 里 `process.execPath` 是 `electron.exe`（GUI 子系统）**：官方 web 端 `process.execPath = node.exe` → 43ms 拿到 stdout + IPC（实测）；forge 里以 `electron.exe` 启动同一脚本 → **30ms 返回空 stdout，之后 5 秒内无 IPC、无 exit** → 父进程 `await` 永不结算 → **卡死，且停止键打断的是原生等待**。
  3. **沙箱侧同一模式**：`dsh-sandbox-local/lib/index.js` 的 `confine()` 同样以 `process.execPath` 起 `windows-acl` runner；而 `dsh-tool-fs-search` 文档明写其 spawn 是「unconfined 的普通 `ctx.subprocess` 调用」。于是 **pwsh 与 grep 恰好是 forge 里仅有的两个走子进程的工具**，症状因此高度收敛。

- **解法**（forge 侧适配器，2026-09-11）：新增 `src/forge-host/subprocess-run-as-node.ts`，置于入口**首条 import**，对 `child_process` 模块对象的 `spawn` 打补丁——**仅当 `command === process.execPath`** 时把 `ELECTRON_RUN_AS_NODE=1` 合并进子进程 env。影响面刻意收窄：Chromium 自身子进程不走 `child_process`、`app.relaunch()` 是 Electron API，均不受影响。Electron 内实测（`facadeCapturedPatch: true`）：子进程 `processType=null`（Node 模式）、`envRunAsNode=1`、**IPC 到达、退出码 0、零超时**。**失效自检**：补丁装好后立即比对 ESM facade 的 `spawn`，不一致就 `console.warn` 并写入 `problem`——反例（静态 `import node:child_process` 抢在适配器之前）实测已触发，告警原文为「ESM facade 早于补丁创建，子进程适配未生效（入口须保持 CJS，且本模块须为入口首条 import）」。**因此这个适配器不可能静默失效**。

- **只补外层不够 —— 同一病根的第二个面（2026-09-11 由实机反馈补齐）**：实机判据极简单——**同一条 `echo ok`，`workspace-write` 下转圈、`danger-full-access` 下正常**。原因是受限模式会把目标命令**再包一层**：`confine()` 产出的 argv 是 `[electron.exe, windows-acl runner, …, --, pwsh, -Command, echo ok]`，而这层**目标**由 subprocess runner（`dsh-subprocess-local/lib/runner.js`，引 `@deepseek-ai/dsh-win32-process`）用 koffi `CreateProcess` 拉起 → `child_process` 补丁**盖不到它**，`electron.exe` 又以 GUI 模式启动 → 无输出 → 父进程一直等 → 转圈。而 `danger-full-access` 会「**绝不咨询提供方**」而完全绕过沙箱 runner，于是把「外层已修、内层未修」掩盖成「权限问题」。修法：`installSubprocessHook()` 在 **`ctx.subprocess` 的启动方法**（所有工具的**共享咽喉**）上给每次 spawn 的 `spec.env` 补一项——上游 `targetEnvironment(spec) = childEnv(spec.env)`，而 `childEnv = scrubbedParentEnv() + extra`，故 `spec.env` 一补即达目标进程；**只改 `spec.env`、不动 `process.env`**（后者会让 Chromium 子进程崩溃）。挂载点：`main.ts` boot 之后（与 `bindCordisInventoryHost` 同处，服务经 `hostCtx.get('subprocess')`），失败仅告警不阻断。

- **实机验证（2026-09-11 · 用户确认）**：`grep` 恢复；`pwsh` 在 **`danger-full-access`** 下**全能力清单全通**——`echo` / 版本 / 列目录 / `cmd` 子进程 / **文件写入+读回** / 管道与循环 / **stdout-stderr 分离** / 错误 trace + 退出码。**仍存的边界见 `docs/11-risks.md` R23**：`workspace-write` 下沙箱包裹层子进程启动失败（`0xC0000142`，目标无关），已排除 8 项，仅剩 runner 的 job+inherited-stdio spawn 路径未验证；复现用 `& "<repo>\node_modules\electron\dist\electron.exe" "<repo>\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js" --workspace "E:\test" --temp "$env:TEMP" --mode read-only -- "C:\Windows\System32\cmd.exe" /c "echo hi"`（设 `ELECTRON_RUN_AS_NODE=1`，须在 IDE 外跑——IDE 内的沙箱会污染结果，本轮已出过一次假阳性）。

- **同源现象：测试时「闪出系统 cmd 框」（2026-09-11 补）**：与 `0xC0000142` **同一根因**，且**上游已文档化**——`dsh-sandbox-windows-acl` README §已知限制原文：「控制台隔离不可用。以 `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` 创建的子进程在 DLL 初始化期间以 `STATUS_DLL_INIT_FAILED`（`0xC0000142`）死亡；**子进程共享宿主控制台**」。而 `dsh-subprocess-local` 的 spawn 带 `windowsHide: true`（=`CREATE_NO_WINDOW`）。**⇒ 官方 CLI/web 在终端里跑（父进程有控制台，子进程共享它 → 不闪框不失败）；forge 是 Electron GUI 进程（无控制台可共享 → 要么新建一个（闪框）要么受限令牌下死）**。**⇒ 属上游对 GUI 宿主的不兼容，不是 forge 缺陷，也不是「官方更新未捕捉」**（版本核对：本机 `dsh-app-boot`/`dsh-subprocess-local`/`dsh-sandbox-local`/`dsh-sandbox-windows-acl`/`dsh-pwsh-sandbox`/`dsh-tool-pwsh`/`dsh-base` **全为 `0.1.5-rc.2`** = npm `next`）。

- **实测否决的两条错路（别再走）**：
  1. **全局 `process.env.ELECTRON_RUN_AS_NODE='1'`** → Chromium 的 GPU / 网络服务子进程继承后崩溃：`GPU process exited unexpectedly: exit_code=9`。
  2. **在 ESM facade 创建之后再打补丁** → 无效。facade 是创建时的**一次性快照**，实测「晚加载模块仍拿到原始 `spawn`」；且 `launchWindowsJob` 传入的是**显式构造的 env**，所以全局环境变量对这条 spawn 也无效。

- **复盘要点**：
  1. **Electron 宿主必须处理 `process.execPath` 语义差**：上游凡「用 `process.execPath` 拉起 Node 入口」的包（`dsh-subprocess-local`、`dsh-sandbox-local`、目录选择器 worker、`dsh-web-app` 的 `--serve` 分支）在 Electron 里都会把 GUI 二进制当 Node 用。判据 = `process.versions.electron !== undefined`。
  2. **本项目主进程是 CJS（`"type": "commonjs"`）正是修法成立的前提**：CJS 的 `require` 不创建 ESM facade，所以补丁放在入口首条 import 就能被 boot 期**动态 `import()`** 的上游 ESM 包看到。**⚠️ 若将来把入口改成 ESM**，facade 会在链接期抢先创建，补丁将失效——届时应改为 CJS 引导壳（先 patch，再 `import()` 真正的 ESM 入口）。
  3. **「官方 web 正常、forge 卡」= 先比运行时**：同一批上游包下最稳定的差异就是 Node vs Electron。这类差异优先查 `process.execPath`、`process.versions.electron`，以及 GUI 子系统的 stdout/IPC 行为。
  4. **能归因的实验设计**：同一个 Electron 进程内分别用「补丁后的 `spawn`」与「facade 的原始 `spawn`」各起一次，桩进程回传 `process.type` 与 `process.env.ELECTRON_RUN_AS_NODE`——才能把「IPC 到达」归因到补丁本身，而不是环境巧合（本轮首测就出现过「facade 未捕获补丁却仍收到 IPC」的假阳性，靠这组对照才排除）。
  5. **「完全访问正常 / 受限模式卡」= 先去看受限模式独有的那一层**：`danger-full-access` 会完全绕过沙箱 runner，因此它**天然掩盖**「外层已修、内层未修」的半修状态。判据不需要日志——同一条最简命令（如 `echo ok`）两种模式各跑一次即分。
  6. **补丁要补在「共享咽喉」，不是「第一个现场」**：起先只补 `child_process.spawn`（覆盖外层 runner），但沙箱包裹后的**目标命令**其实由**另一个进程**用 koffi 拉起。凡「某能力的启动被多处包装」时，应找**所有调用都必然经过的那一个点**（本例是 `ctx.subprocess` 的启动方法），否则会得到「修了一半」的假阳性。
  7. **包装对象方法必须保留接收者**（同一处引入、当场被实机抓住）：`Object.assign(service, { method: (...args) => original(...args) })` 会丢掉 `this` —— 上游 `spawn()` 内部大量 `this.selectContainmentMode(...)` 这类私有调用，于是启动即抛 `Cannot read properties of undefined (reading 'selectContainmentMode')`。必须写成 `original.apply(service, args)`。**教训的另一半在测试**：首版探针用的假服务方法**不读 `this`**，所以测不出这个 bug——探针必须复现真实调用形态（刻意读 `this`，断言 `receiverPreserved`），否则只是自我安慰。
  8. **验证要看「能力清单」而不是「单条命令」**：最终实机验证用了完整清单（`echo`/版本/列目录/`cmd` 子进程/**文件写入+读回**/管道与循环/**stdout-stderr 分离**/错误 trace + 退出码）。单条 `echo` 通过曾掩盖过「第二层没生效」；清单式验证才能证明整条链贯通。
  9. **「IDE 内复现」会骗人**：本轮我在 TRAE 沙箱内跑同一份 `AclSandbox` 复现脚本，得到 `0x80000005` 并据此误判「上游 rung 本机不可用」；你在 IDE 外跑同一脚本**成功**，直接推翻。**凡涉及进程/令牌/ACL 的复现，一律在 IDE 外做**。

---

## 坑 62：自研件顶替官方包后**服务面漏方法**，只会在「用户恰好点到那条路径」时爆 —— `workspaceNavigation.openWorkspace is not a function`

- **现象**：forge 里「选择/添加工作区」（对话区 hero 的工作区选择器、或侧栏「添加工作区…」）弹出错误层——标题「无法打开文件夹」、正文 `workspaceNavigation.openWorkspace is not a function`、按钮「取消 / 重新选择」（点重试必然再报）；**官方 web 端同一路径完全正常**。

- **根因**（两层，都是「接管面按当时的官方快照抄，官方后续版本加方法后没人再对齐」）：
  1. **服务面缺方法**：`@lansi-ai/dsh-forge-workspaces` 顶替官方 `@deepseek-ai/dsh-client-ui-workspace`（在 `boot-graph.ts` 的 `CLIENT_EXCLUDE_IDS` 内），必须自己 `super(ctx, 'uiWorkspace')` 补位同名服务（坑 15/48 同源）。本件当时按「官方六方法」实现（`connectWorkspace` / `startSession` / `archiveSession` / `pickDirectory` / `listDirectory` / `createDirectory`），而 0.1.5 官方 `UiWorkspaceService` 还有 **`openSession(sessionId)` / `openWorkspace(workspaceId, beforeOpen)` / `forkSession(sessionId)`** 三个（`node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js:61/65/73`）。
  2. **触发链 + 文案误导**：官方 ui-conversation 的 hero 槽位下发 `selectWorkspace: (workspaceId) => workspaceNavigation.openWorkspace(workspaceId, cb)`（`dsh-client-ui-conversation/lib/client.js:16648`）；本件 hero picker 的 `adoptDirectory` 把这个调用写在 `.then((workspace) => { setFlowOpen(false); onPick(workspace.workspaceId) })` 里，而 `.catch` 兜的是「Host 建工作区失败」→ `onPick` 抛的 TypeError **被同一个 catch 吞成业务失败**，渲染成 folderError 弹层。**⇒ 文案像目录问题，实际与目录、权限、路径全都无关。**
  3. **同源第二处漏项（只补第一个方法会立刻换一个报错）**：`openWorkspace`/`openSession` 内部要 `this.ctx.layout.beginNavigation()` 与 `selectPanel(null)`，而自研 `@lansi-ai/dsh-forge-layout` 的 `LayoutController` 当时只有 `toggleSidebar` / `openRightbar` / `closeRightbar` —— 补上 `openWorkspace` 后会马上变成 `beginNavigation is not a function`。

- **解法**（逐方法对齐官方，2026-09-14）：
  1. `src/forge-shell/web/forge-workspaces-client.js`：补 `openSession(id)`（`sessions.open` + `ctx.layout.selectPanel(null)`）、`openWorkspace(id, beforeOpen)`（`AbortSignal.any([ctx.layout.beginNavigation(), this.lifetime.signal])` → `connectWorkspace` → **未中止才**交回 owner 并 `openSession`）、`forkSession(id)`（`beginNavigation` + `sessions.fork({ sessionId, increaseTitle: true })` → `openSession`）；新增 `lifetime = new AbortController()` 并在 `watchNavigation` 清理时 abort；`startSession` 改为官方形态（无目标时 `selectPanel(null)`，有目标时走 `openWorkspace`）；侧栏 `open` / `forkSession` 两个注入回调改走服务，不再自行 `sessions.open` / `sessions.fork`。
  2. 同件 `exports.inject` 补 **`'layout'`**（官方 ui-workspace 同样声明）；不声明则 `this.ctx.layout` 访问会落 `cannot get property "layout" without inject`（`node_modules/@deepseek-ai/cordis/src/reflect.ts:144`）。
  3. `src/forge-shell/web/forge-layout-client.js`：`LayoutController` 补 `selectPanel(panelId)`（桌面只认 `null` / `'conversation'`，其余按官方语义抛 `layout.selectPanel: main panel "x" is not registered`）+ `beginNavigation()`（新导航 / 有效选择 / 卸载即 abort）+ `dispose()`（apply 清理时调用）。
  4. `eslint.config.mjs`：`BROWSER_GLOBALS` 补 `AbortSignal`（渲染器全局表原本只有 `AbortController`）——否则 `AbortSignal.any` 被 `no-undef` 先拦。

- **质量门禁**：`node --check` 两件浏览器 bundle + `npm run typecheck` + `npm run lint` + `npm test`（30/30）+ `npm run build` 全绿；另加 **vm 探针**（vm 沙箱真实装载两件 bundle + 桩 ctx，端到端而非静态 grep）——5 组全通：① `ctx.layout` 六方法齐 + 三条中止语义（新导航中止上一个 / 有效选择中止 / 卸载作废 / 未注册 key 抛错且不中止）；② `uiWorkspace` 九方法齐 + `lifetime` 存在；③ `openWorkspace` 正常路径 = `create → open → selectPanel(null)`；④ 中止语义 = 已 abort 时**仍创建会话但不切面板**；⑤ `forkSession` → `openSession(childId)` + 卸载 abort `lifetime`。**实机仍待用户点验**（「选已有工作区」与「添加新文件夹」两条路径）。

- **复盘要点**：
  1. **顶替官方包 = 顶替它全部对外服务面，且必须「按当前版本逐方法核对」**：抄的时候对齐了，官方后续版本加方法就会**静默缺**（不报错、不告警，只等到用户点中那条路径）。核对手法：打开 `node_modules/<pkg>/lib/client.js`，找 `super(ctx, 'x')` 的那个类，把方法名逐个列出与自研件对比；**更快的差分判据 = 官方同包的 `inject` 数组**（本例差异恰好多出 `'layout'` 一项）。
  2. **错误文案会误导归因**：`openWorkspace is not a function` 被渲染成「无法打开文件夹 / 重新选择」，看起来像目录或权限问题。**先读弹层正文里的原始异常文本**，再顺着 `属性名` 回查服务面，别被标题带走。
  3. **`.then(...).catch(...)` 会把「回调里的编程错误」吞成业务失败**：本处 `.catch` 本意兜 Host 建工作区失败，却连 `onPick` 的 TypeError 一起吞了。凡 catch 兜业务失败的地方，要么把「回调调用」移出 try 范围，要么按错误类型分流——否则「服务缺方法」会伪装成「目录打不开」。
  4. **补一个方法前先读它的依赖链**：`openWorkspace` → `ctx.layout.beginNavigation`；只补服务方法会在下一个调用点继续炸。**判据 = 把官方同名实现整段读完**（本次正是逐行对齐官方 `UiWorkspaceService` 才拿到 `lifetime` / `selectPanel` / `beginNavigation` 三处依赖）。
  5. **`AbortSignal.any([...])` 在渲染器侧先过 eslint 全局表**：`AbortController` 在、`AbortSignal` 不在，`no-undef` 会先拦下一轮——**门禁顺序上，先补全局表再写代码**可省一次往返。

---

## 坑 63：工具调用时**闪出系统 cmd 黑框** —— 上游按「子进程共享宿主控制台」设计，而 Electron 是没有控制台的 GUI 进程

- **现象**：调 `pwsh` / 终端类工具时，桌面闪出一个系统 cmd 黑框（工具本身正常返回）；**官方 CLI/web 端同款工具不闪**（用户回忆：官方早期版本也闪、后来不闪了，怀疑我们漏了官方更新）。

- **根因**（三层，越往下越接近真因）：
  1. **上游是「共享宿主控制台」的设计**：`@deepseek-ai/dsh-win32-process` 创建目标只用 `CreateProcessW` / `CreateProcessAsUserW` + `CREATE_UNICODE_ENVIRONMENT`（其 `README.zh.md` §Behavior 原文），该包 `lib/types/abi.d.ts` 常量表里**根本没有 `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE`**；下游 `dsh-sandbox-windows-acl` README「已知限制」第 115 行把前提写死：「**子进程共享宿主控制台**」（并注明以 CREATE_NO_WINDOW / CREATE_NEW_CONSOLE 创建的子进程会以 `STATUS_DLL_INIT_FAILED` 死亡）。
  2. **官方 CLI/web 天然满足该前提**：跑在终端里 → subprocess runner 是 `node.exe`（**控制台子系统**）→ 继承终端控制台 → 目标共用 → 不闪。**实测**：终端启动的父进程 `consoleProcessCount=4`，其子进程 `=5`（同一控制台，无新窗口）。
  3. **forge 打破了前提**：主进程与 runner 都是 `electron.exe`（**GUI 子系统，永不继承控制台**）→ 目标（pwsh/cmd 是控制台子系统）由「无控制台的创建者」拉起时，**Windows 会为它新建一个可见控制台窗口**。**实测**：无控制台创建者 `hwnd=0, count=0` → 其子进程 `hwnd=462412, count=1, windowVisible=1`（就是那个闪框）。同一个「新建控制台」动作在**受限令牌**下死在 DLL 初始化，就是 **R23 的 `0xC0000142`** —— 两个现象同一根因，也解释了为什么它们总是成对出现。

- **解法（forge 侧补齐上游假设，2026-09-14）**：让**创建者自己持有控制台**（attach 优先、alloc 兜底并隐藏）：
  1. 新增 `src/forge-host/win32-console.ts`：koffi 绑 kernel32/user32（**懒加载**，不进入口关键路径、原生模块缺失也不拖垮启动），`ensureHostConsole(owner)` = `AttachConsole(ATTACH_PARENT_PROCESS)` → 失败则 `AllocConsole()` + `ShowWindow(SW_HIDE)`；**幂等**，**绝不抛**（预载抛异常会让 runner 起不来、所有工具全挂）；**attach 到别人的控制台时不隐藏**（那可能是用户自己的终端窗口）；ConPTY 托管（`GetConsoleWindow()=0`、hide 不到）时保留控制台并在 `detail` 里说明。
  2. 新增 `src/forge-host/win32-console-preload.ts`：runner 的预载入口（Node 的 `-r` 只认 CJS，本项目 `"type": "commonjs"` 满足）。
  3. `subprocess-run-as-node.ts` **两处注入**：① 外层 `child_process.spawn(process.execPath, …)` 的 argv 前插 `-r <preload>`（**实测 `-r` 被 Node 选项解析消费、不进 `process.argv`**，不扰动 runner 的 `--` 分段与目标 argv）；② `ctx.subprocess` 启动面若 `spec.argv[0] === process.execPath`（= **沙箱 ACL runner**，它才是受限子进程的真正创建者，且由 koffi 创建因此 child_process 补丁盖不到）则 `splice` 同一预载。
  4. `main.ts` 启动早期调用 `ensureHostConsole('main')`，并把结果落日志（`attach` / `alloc` / `failed` + Win32 错误码）。
  5. `package.json` 显式声明 `koffi`（原为上游传递依赖，本适配直接消费）。

- **已实测否决的两条捷径**：① **给 runner 加 `windowsHide`**：`CREATE_NO_WINDOW` 对**非控制台应用被忽略**（MSDN 原文 + 本机实测：`electron.exe` 在 `windowsHide` 真/假下均 `consoleProcessCount=0`）；② **让 runner 改由 cmd/conhost 之类控制台宿主拉起**：GUI 子进程不继承宿主控制台，创建者仍是 GUI → 依旧新建窗口。

- ✅ **已闭环（2026-09-14 · 用户实机确认）**：适配落地后 **`workspace-write` 下 pwsh 恢复可用**（原先恒 `0xC0000142`）——**R23 一并收口**，短期口径（改动前需改用 `danger-full-access`）解除。**一个机制同时解释四个现象**：① 受限令牌 + 需要**自建**控制台 → 自建在 DLL 初始化即死（`0xC0000142`，pwsh 根本没起来，所以无输出无报错文本）；② 普通令牌 + 需要自建 → 自建成功，但那是个**可见**窗口（= 闪框）；③ 宿主本来就有控制台（官方 CLI/web）→ 共享，既不闪也不死；④ 三层各自自备控制台（现在的 forge）→ 受限子进程改走**共享**，两个现象一起消失。⇒ 上一轮「单变量排除 8 项」全都排不出东西，是因为变量从来不在沙箱策略里，而在**宿主进程没有控制台**。取证/复验脚本 `.tmp/verify-console-window.cjs` 保留（IDE 外可复跑）；IDE 内 `AttachConsole`/`AllocConsole` 恒返回 6，故本结论来自用户实机复现而非内验。

- **复盘要点**：
  1. **判「会不会新建控制台」要看子系统，不看 flags**：GUI 子系统（electron.exe）永不继承控制台；控制台子系统（pwsh/cmd/node）在**创建者无控制台**时必然被新建一个。凡「宿主走 Windows 原生进程原语拉控制台类程序」的场景（沙箱、终端工具、任务执行器）先问一句：**创建者有没有控制台**。指纹 = 子进程 `consoleProcessCount===1` 且 `windowVisible===1`。
  2. **官方能跑 ≠ forge 能跑，差异常写在文档的「已知限制」里**：上游那句「子进程共享宿主控制台」不是免责声明而是**设计前提**——宿主换成了没有控制台的环境，该由宿主侧把前提补齐，而不是等上游改（也别急着自研工具层，见上一轮结论）。
  3. **`windowsHide` / `CREATE_NO_WINDOW` 不是万能隐身衣**：对非控制台应用（GUI 子系统）被忽略，用它「顺手修一下闪窗」只会拿到假阴性。
  4. **注入点的选择标准是「谁是创建者」**：本例创建者是**两级**——subprocess runner 用 koffi 创建 ACL runner，ACL runner 再用受限令牌创建 pwsh；所以同一个预载必须同时挂在 `child_process.spawn` 的 argv 与 `spec.argv` 两条路径上，只补一条就是「修了一半」（坑 61 同款教训）。
  5. **预载脚本的第一原则是不抛**：`-r` 的异常会让 runner 直接退出、工具全挂；适配器内部全程 try/catch，失败只告警并**把 Win32 错误码写进日志**——本次正是靠那两个错误码（5=已有控制台 / 6=环境阻拦）把「代码问题」与「环境问题」当场分开，省掉一轮猜测。

---

## 坑 64：外部插件安装脚本的「已装」判定被自己的模板注释骗到 —— 链接建了、插入行没写，插件静默不加载

- **现象**：`node scripts/install-forge.cjs --forge … --home …` 打印「安装完成（重启 dsh-forge 生效）」，但重启后插件**根本没生效**；复核补丁层 `$DSH_HOME/profiles/dsh-forge/cordis.patch.yml`，里面仍是空的 `[]`（而在它之前，`profiles/node_modules/<包名>` 的 junction **已经建好了**——所以"看起来装过"）。

- **根因**：脚本用 `existing.includes(\`id: ${PLUGIN_ID}\`)` 判断"补丁层是否已含本插件的插入行"，而**它自己写出的模板注释里就带一条示例**：
  ```yaml
  # - insert:
  #     - id: llm-app-credentials
  ```
  → 字符串包含判断命中注释里的示例 → 假阳性 → 直接 `return`，**跳过写行那一步**。（同一个模式在"首次安装写模板"的分支里被再次写出，于是每次重跑都稳定复现。）

- **解法**（2026-09-14）：判定只看**生效行**（过滤掉 `#` 开头的行）：
  ```js
  const activeLines = existing.split('\n').filter((line) => !line.trimStart().startsWith('#'))
  if (activeLines.some((line) => line.includes(`id: ${PLUGIN_ID}`))) { /* 真已装 */ }
  ```
  已修改 `plugins/dsh-llm-app-credentials/scripts/install-forge.cjs`（该目录**不是 git 仓库**，故坑档在此留痕）；重跑后插入行正确落在注释之外，且 `npm run verify:profile-plugins` **7 项全 PASS**（含「插入行裸名改写生效」「模块可 import（peer 解析成立）」「图谱 id 与 client bundle 一致」）。

- **复盘要点**：
  1. **幂等脚本的"已存在"判定必须只看生效内容**：注释 / 示例 / 模板是假阳性的高发区；只要脚本自己会写出"含目标字符串"的模板，`includes` 就必然误判。
  2. **装完要复核结果文件**，不能只信脚本打印的"完成"——本次正是靠 `Get-Content` 复核补丁层才发现（脚本输出与真实状态相反）。
  3. **用官方校验脚本交叉验证**：`verify:profile-plugins` 直接检查"裸名改写是否生效 + 模块能否 import"，比肉眼靠谱；装完就跑它。
  4. 安装类脚本的"三步"里，**建链接成功 ≠ 安装成功**：装载点是补丁层的 insert 行，链接只是前置条件——排查「装了不生效」时先看**补丁层有没有生效行**，再看链接。

---

## 坑 65：Agent 沙箱拒绝写 `.git/objects/**` —— git 写操作在沙箱内一律失败（授权也不解除）

- **现象**：在 Agent 沙箱内执行 `git add` 稳定失败（`error: unable to write new index file` / `Permission denied`），路径指向 `E:\Projects\DSH\desktop\.git\objects\…`；换到**工作区外**的插件仓（`E:\Projects\DSH\plugins\dsh-llm-app-credentials\.git\objects\…`）**同样被拒**。关键组合是：`git init` **能成功**（只建目录结构），一旦要落 blob / 写索引就被拦 → 三次尝试都停在同一处，`requires_approval` 提权**无效**。
- **根因**：TRAE 沙箱的文件写入白名单**不覆盖 `.git` 内部对象存储**——且它与「工作区外路径被拒」**不是同一类**（工作区**内**的 `.git` 一样被拒）。定性判据 = 只读 git 命令全部正常（`rev-parse --is-inside-work-tree` / `status` / `log` / `show` 均可），HEAD 与暂存区干净、无残留锁 → **环境硬边界，不是仓库损坏**。
- **解法**（2026-09-14 实测）：Agent 侧只做**只读核查 + 备好幂等脚本**，凡写 `.git` 的动作（commit / amend / tag / push）**交给用户在终端执行**：
  1. 把命令或 `.tmp/*.cjs` 脚本落在**工作区内**（脚本要带断言，如「暂存区出现 `node_modules` 即中止」）；
  2. 用户在自己终端跑；`git push` 退出码不可信（沙箱会伪报 credential store 失败，坑 44）→ 以 **`git ls-remote`** 回验；
  3. 推送成功的**唯一判据** = 远端 `refs/heads/main` 的 SHA 与本地 `git rev-parse HEAD` **逐字符一致**（本次 `2c94152c…` 双侧相同）。
- **复盘要点**：
  1. **环境边界要尽早定性，别连环重试**：`git init` 成功 + `git add` 失败这一个组合就足以判定，继续换目录/换仓库是浪费。（与坑 0 / 38 / 42 同族：先看被拒路径再动手。）
  2. **approval 不等于解除沙箱**：部分限制是硬编码白名单，走授权流程不放行；「改用工作区外目录」这条经验在此**不适用**（内外都试过）。
  3. **交付物形态要顺应边界**：与其空手交回"我做不了"，不如交**幂等脚本 + 断言 + 复核判据**——用户一条命令跑完，且失败点自解释。

---

## 坑 66：Windows 发布任务因「Release 已存在」失败，整个 Win 产物未上传（`gh` + PowerShell `EAP=Stop`）

- **现象**：`v0.1.1-rc.3` 发布后应用内「检查更新」报
  `Cannot find latest.yml in the latest release artifacts (…/releases/download/v0.1.1-rc.3/latest.yml): HttpError: 404`。
  查 Release 资产：**只有 10 个、全是 mac**（`latest-mac.yml` 在，`latest.yml` 与全部 Windows 产物都不在），而 rc.2 / rc.1 / alpha.9 都是 15 个；CI 里 `release-win` = **failure**、`release-mac` = success。
- **根因（两层）**：
  1. **失败步** = `Ensure release exists (idempotent)`：mac 与 win 并发，**mac 先建了 Release**（该 Release 的 `body` 正是 "Created automatically by release-mac workflow."），win 的 `gh release create` 撞「已存在」→ `HTTP 422: Validation Failed` 写 stderr；GitHub 对 `shell: powershell` 的包装把 **`$ErrorActionPreference` 设为 `Stop`**，这条 stderr 遂升级为**终止错误**（日志 `FullyQualifiedErrorId : NativeCommandError`），**连后面的 `; exit 0` 都跑不到** → 该步失败 → 后续「Align / SHA256SUMS / Upload」全部 skipped。对照 mac 同一步用 bash `|| true`，天然容错故成功。
  2. **客户端为何"就缺 latest.yml"**：`GitHubProvider.getLatestVersion()` 先请求 `rc.yml`（channel='rc'），404 后**因 `allowPrerelease` 为真自动回退请求 `latest.yml`**（版本带预发布标识 → electron-updater 自动置 `allowPrerelease=true`）；两者皆无才报错——**真正缺的就是那一份 `latest.yml`**。
- **解法**（2026-09-14，已实机闭环）：`release-win.yml` 该步改为「**显式 `$ErrorActionPreference='Continue'` + 先 `gh release view` 再按需 create + stderr `2>&1 | Out-Null`**」，已存在即跳过 create。补传：推送修复后用 **`workflow_dispatch`** 重跑（UI: Actions → `release-win` → Run workflow → `main`）→ 运行 `34818075936` success、资产 **10 → 15**、`latest.yml` 就位、应用内检查更新恢复（显示"已是最新版本"）。
- **复盘要点**：
  1. **PowerShell 步骤里"吞 stderr"不能只写 `2>$null`**：`shell: powershell` 的包装设了 `$ErrorActionPreference='Stop'`，stderr 会升级为终止错误，`2>$null` 与 `; exit 0` 都救不了。要么显式降级 EAP，要么**先判定再执行**（不产生错误），要么 `cmd /c … 2>nul`。
  2. **并行 workflow 各自"幂等创建"同一资源时，幂等实现必须比并发更狠**：只要有一边把「已存在」当错误就会随机失败（本次 mac(bash) 赢 / win(PS) 输）；可用 Release `body`（"Created automatically by release-X workflow."）反查谁先建。
  3. **「重跑」≠「跑新代码」**：`Re-run failed jobs` 固定用该次运行的 commit 与 YAML（`run_attempt` +1 可判别；本次 attempt=2 仍 422 即是此因）。修 CI 必须走 `workflow_dispatch` 或新 tag。
  4. **更新链排障先读产物清单，再读客户端代码，别从错误文案反推需求**：`GET /releases/tags/<tag>` 的资产名列表一步就能指向"产物没上传"；而 `Cannot find latest.yml` 曾被误读成"缺 `latest-rc.yml`"（**客户端从不请求该名**，坑档更正）。

---

## 坑 67：匿名 GitHub API 限流（**IP 级**）让「一条命令装插件」直接不可用 —— 默认分支查询没有回退

- **现象**：`--install-plugin github:<owner>/<repo>` 在匿名 API 配额耗尽时直接失败，流程终止在「取默认分支」这一步；而 codeload 侧的 tarball 下载本身不受影响（即**限流 ≠ 资源不可达**）。
- **根因**：`src/forge-host/plugin-install.ts` 取默认分支只走 GitHub API（`defaultBranchOf()` → `GET /repos/<owner>/<repo>`），而匿名 API 限流是 **IP 级**的（60 次/小时，共享出口/公司网络会被整片拖下水）——「一条命令装插件」这条体验不该由别人的请求量决定；而真正取包的 codeload **不计入**该限额。
- **解法**（2026-09-14，`src/forge-host/plugin-install.ts`）：新增 `resolveDefaultBranch()` —— 先问 API，失败即 `log.warn`（带 `summarizeError` 原文）并**回退探测** `main` / `master`：HEAD `https://codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/<candidate>`，第一个可达者胜；两者都不通则把**原始错误**抛出（不吞、不替换成"仓库不存在"）。
- **复盘要点**：
  1. **「为拿一个可猜的元数据而调 API」的地方都要备确定性回退**：默认分支只是**参数**，不是资源本体；把参数获取变成单点依赖，等于把别人的配额绑进自己的主流程。
  2. **限流是 IP 级而非账号级**：匿名调用共享出口、不可控；判定看响应体（rate limit）而不是看失败率。
  3. **回退失败要抛原始错误**：否则「被限流」会被误报成「仓库/分支不存在」，把用户引到错误的排查方向（同族教训见坑 66 复盘要点 4）。
  > 本条据上一轮会话产物与代码注释整理（未在本次会话复现限流现场），档案留痕以便发版口径完整。

---

## 坑 68：打包态 `glob`/`grep` 一律报 `ripgrep provider failure` —— 上游解析出的 `rg.exe` 指向 **`app.asar` 内**，Windows 无法启动归档里的文件

- **现象**：**安装版**（win setup；0.1.1-rc.3 / rc.4 均复现）里模型每次调用 `Glob` / `Grep` 都失败，报错原文：
  `Error: glob subprocess failed before reporting an outcome (ripgrep provider failure)`。
  与工作区内容、pattern、**沙箱模式均无关**（空目录与含文件目录、`*` / `**/*` / `**/*.js` 完全一致；**切到 `danger-full-access` 仍然失败**），而 **`npm run dev` 一切正常**；同一会话里 `pwsh` 工具正常。用户侧单变量复核这三条即已把「参数问题 / 沙箱管道问题 / 文件权限问题」全部排掉。

- **根因（两段拼接，缺一段就会误判）**：
  1. **报错语义**：`dsh-tool-fs-search` 有两条启动期错误分支——只有「目标进程**根本没起来**」才会走到 `handle.done` 的拒绝。链路 = `launchWindowsJob` 把启动失败经 IPC 交给 `direct.reject`（`dsh-subprocess-local/lib/index.js:521-541`）→ `bindManagedProcess` 的 `launch.direct.then(settle, fail)`（`lib/runner-launch-COYGu0Dl.js:1090-1101`）→ 句柄 `done` 拒绝 → 工具侧 `catch` 报「provider failure」。**故「报错落在 `handle.done`」不能推出「进程已成功启动」**（这一句曾被写成结论，方向完全反了）。
  2. **真正没起来的命令**：`@vscode/ripgrep` 的 `rgPath` 来自 `require.resolve`（`@vscode/ripgrep/lib/index.js:9-17`），打包后**恒为** `…\resources\app.asar\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe`。electron-builder 的 smartUnpack **确实**把该 exe 解到了 `app.asar.unpacked`，但**解析出的字符串不变**；Electron 的 asar 垫片只覆盖 fs（于是 `existsSync` 返回 true、解析"看似正常"），而 Windows 的 `CreateProcess` 不认识归档 → 启动即 ENOENT。dev 模式 `node_modules` 是真实目录，故**只在打包态暴露**。

- **取证**（在**安装版自己的 asar** 上复刻上游解析 + 启动，Electron Node 模式，避免造场景）：
  ```
  require.resolve('@vscode/ripgrep-win32-x64/bin/rg.exe') → …\resources\app.asar\node_modules\…\bin\rg.exe
  spawnSync(上面这个路径)                                  → status null, ENOENT
  spawnSync(…\app.asar.unpacked\…\bin\rg.exe)              → status 0, "ripgrep 15.0.0 (rev 3a612f88b8)"
  ```
  顺带**证伪另一条流行误判**：上游 `dsh-sandbox-windows-acl` README 那条 EPERM 限制原文限定为「**confined grandchildren** / **受限进程内** `spawn(..., { stdio: 'pipe' })`」，而 app 链路里**创建管道的是无限制的 runner**（主进程 → runner、runner → 目标），受限的只有最终目标进程本身；在受限 pwsh 里再套一层 `node` 去 spawn 才会复现 EPERM —— **那是嵌套探针的自伤，不是 app 的成因**。因此「放宽沙箱以允许命名管道」这条整改方向是错的：放着沙箱改也治不好（`danger-full-access` 下同样失败，已实测）。

- **解法**（2026-09-15，零上游耦合）：在**既有的** `ctx.subprocess` 启动咽喉（`src/forge-host/subprocess-run-as-node.ts`，与 D-29/D-30 同一注入点、不新增注入点）加一层 asar 路径改写：
  - `toUnpackedAsarPath(value, exists = existsSync)`：含 `\app.asar\` 特征段的路径 → `\app.asar.unpacked\` 孪生，**仅当孪生真实存在**时替换（已是 unpacked 的不重复改写）；
  - `withUnpackedAsarSpecArgv(spec)`：遍历 `spec.argv` 全部字符串元素**原地**改写（兼顾 `pwsh -c "<exe>"` 这类把程序写在参数里的形态）；
  - 挂在既有的 `withRunAsNodeSpecEnv` 上（`spec.env` 注入的同一处），未动全局 env、未动上游。
  双条件收窄的收益：runner 自身入口（`app.asar\…\runner.js`）与本模块注入的 asar 内预载脚本（`app.asar\dist\forge-host\win32-console-preload.js`）**都没有 unpacked 孪生** → 保持原样，Electron 读 asar 的能力不受影响（探针实测 `true`）。单测 `test/asar-unpacked-path.test.cjs` 6 例（孪生存在改写 / 孪生缺失原样 / 已 unpacked 不重复 / 非 asar 原样 / 原地语义 + env 合并 / 无 argv 不报错）；typecheck / lint / build / **50 单测**全绿。

- **复盘要点**：
  1. **只要用了 asar，就必须问一句「谁会拿这个路径去 CreateProcess」**：Electron 的 asar 透明层只覆盖 fs 与 `require`，**不覆盖进程创建**；`require.resolve` 返回的字符串永远带 `app.asar`。凡「上游用模块解析拿到可执行文件路径、再交给 subprocess 拉起」的设计（本仓 = ripgrep），打包态必然踩。
  2. **「dev 好用、打包不行」是 asar 类问题的第一指纹**：先用这条分叉，再去怀疑沙箱/权限/参数（本次若先信了管道假设，会一路改到错误的层）。
  3. **判断"进程有没有起来"要读代码路径，不要读错误措辞**：两条错误分支的文案都像"运行失败"，只有一条对应"启动失败"；靠 `direct.reject → handle.done` 这条链才能定性。
  4. **别用嵌套探针给 app 链路定罪**：在受限进程里复刻「受限进程内 spawn」，只证明了那条**已知限制**；跨层复刻要么在同层（无限制进程）做，要么直接把被测链路的输入/输出录下来。
  5. **修在"共用的咽喉"而不是"某个工具"**：改写放在 `ctx.subprocess` 启动面（本仓所有子进程工具都经此），既救 rg，也覆盖未来任何"解析出的可执行文件落在 asar 内"的情形。
  6. **验证要贴着边界**：dev 模式**无法**验证这类修复（没有 asar 层，新代码恒走"不改写"分支），必须用安装版 asar 复刻或装新包实机——否则会拿到"跑通了"的假阳性。

---

## 坑 69：Windows PowerShell 5.1 下「管道喂 stdin 给原生程序」不可靠 —— `git credential fill` 报 `missing protocol field`，发版脚本首步即挂

- **现象**：`powershell -ExecutionPolicy Bypass -File .tmp/release-rc5.ps1` 在取 gh token 那步中止：
  `fatal: refusing to work with credential missing protocol field` → 脚本按 fail-fast 抛「未能从 git 凭据库取到 token」。
  同一段代码在**另一个终端**（PowerShell 7）里跑得好好的——`username=lansi-ai` / `password=ghp_…` 正常返回。
- **根因**：**Windows PowerShell 5.1** 把字符串管道给原生程序时 **stdin 传递不可靠**（两种写法都复现：含 `` `n `` 的单个多行串、以及字符串数组逐行喂）→ git 读不到 `protocol=` 字段，只能报缺字段；而 PS 7 同一写法正常。判据 = 报错文案里的 **`missing protocol field`**（不是"没凭据"，是"没收到输入"）。
- **解法**（2026-09-15，`.tmp/release-rc5.ps1`，一次性发版辅助脚本）：
  1. 改从 git 的 **store 明文库**读：`~/.git-credentials` 里就有 `https://lansi-ai:<PAT>@github.com`，正则取出 → `$env:GH_TOKEN`（跨 PS 版本稳定，且**不落盘、不回显**）；
  2. 补 **gh 的 PATH 兜底**（`%ProgramFiles%\GitHub CLI`，新装场景不在 PATH）；
  3. 脚本保持 **UTF-8 with BOM** —— 中文 PS1 在 5.1 下按 GBK 解码会直接把语法打碎（本仓 `build/installer.nsh` 已是同款坑）；
  4. fail-fast：取不到 token 就 `throw`，不让链路跑到一半（`npm run dist` 之后才失败最贵）。
- **复盘要点**：
  1. **辅助脚本要按「目标 shell 版本」验证**：`powershell`（5.1）与 `pwsh`（7）是两套行为，写 PS1 时先确认用户会用哪个跑（本次我是在 PS7 验的，于是漏了）。`$PSVersionTable.PSVersion` 是第一步就该打的日志。
  2. **别把「管道喂 stdin」当通用手法**：给原生程序传输入优先用「命令行参数 / 临时文件 / 直接读文件」，管道 stdin 在 PS 5.1 下是雷区（`git credential fill` 这类读 stdin 的工具最容易中招）。
  3. **中文 PS1 必须带 BOM**：不带 BOM 时 5.1 按 ANSI/GBK 解码，中文注释就可能编出 `"`、`\`、`` ` `` 字节而报"字符串未终止"这类迷惑语法错。
  4. **凭据获取要有第二条路**：机器上有 `manager`+`store` 双 helper 时，store 明文库是一条确定性的兜底（本次正是靠它救场）；但别把 token 打进日志/脚本。

---

## 坑 70：`gh release create --target main` 会**隐式创建远端 tag** → 触发 tag-push 类 CI → `--clobber` 覆盖本地产物（`--publish-local` 的前提被证伪）

- **现象**：`npm run release -- 0.1.1-rc.5 --publish-local` 全程成功（本地 5 资产上传、资产核对通过、脚本自报 `✓ 本地发布完成`）；但几分钟后同一个 Release 变成 **15 个资产**，且 `setup.exe` 从本地的 `138,352,536` 变成 **`138,352,091`**（`updatedAt` = CI 上传时刻）。Actions 里凭空多出 `release-win`（4m4s）+ `release-mac`（4m18s）两条 **`event=push`、`headBranch=v0.1.1-rc.5`** 的成功运行 —— 而用户**没有手动推过 tag**，脚本也只推了 main（`pushBranchOnly`）。
- **根因**：设计假设「不推 tag 就不会触发 CI」不成立。**GitHub Release 必然绑定一个 tag**：`gh release create --target main` 在远端 tag 不存在时会**自己把 tag 建出来**（指向 `main` 当前提交），而 GitHub 对**单个** tag 创建会发出 `push` 事件（Actions 文档亦注明「一次创建超过 3 个 tag 才不产生事件」）→ 命中本仓 `release-{win,mac}.yml` 的 `on: push: tags: v*` → 双平台重建 → `gh release upload --clobber` 把本地产物换掉。
- **取证**：`git ls-remote origin refs/tags/v0.1.1-rc.5` → `3c978179…`（= main HEAD；该 tag 此前只存在于本地）；两条 tag-push 运行的起始时间与 Release `createdAt` 相差十余秒（workflow 调度延迟）；`gh release view --json assets` 给出的大小/`updatedAt` 与本地产物不同、与 CI 构建一致。
- **现状与影响**：Release 最终是**自洽的 CI 产物**（`latest.yml` 的 `size` 与实际上传资产一致、`SHA256SUMS`/`SHA256SUMS-mac` 由各 CI 现算现传）→ 更新链可用、无功能损失；损失的是「以本地产物为准」这一诉求，以及每次发版白跑一遍双平台 CI（约 5 分钟）。
- **复盘要点**：
  1. **「不推 tag」不等于「没有 tag 事件」**：任何以"绑定 tag"为前提的资源（GitHub Release）创建都会在远端产生 tag；仓库若对 tag 有 CI 触发，就必然被激活。做「绕过 CI 的本地直发」前先确认目标平台是否允许无 tag 的 Release（GitHub：不允许）。
  2. **`--clobber` 是"后到者赢"**：本地 138MB 上传耗时长（数分钟），CI 反而后发先至 → 本地产物必被覆盖。凡「本地/云端双路径写同一资产」的设计，必须显式约定唯一权威来源，否则就是这次的结果。
  3. **验收要看"最终态"而不是"当次成功"**：脚本自报完成 ≠ 资产定型；关键动作后应复查远端最终状态（`gh release view --json assets` 的 `size`/`updatedAt`），别只信退出码——本次正是靠这一步才发现资产被替换。

## 坑 71：`no usable web provider is registered` 的真因是**宿主 roster 抄漏 provider 行**，不是网络/工具故障

- **现象**：`web_fetch` 对**任何** URL 都报 `Error: no usable web provider is registered`（可达站点与被墙站点一视同仁）；同一会话 `web_search` **正常**返回结果 → 极易误判为「网络链路断裂」或「服务不稳定／状态会漂移」（用户首轮实测正是这样记录，且第二轮又"自行恢复"，据此写成"临时故障"）。
- **根因**：抛点在上游 `dsh-web` 的 `resolveProvider()`——`ctx.web.fetch()` 在 **fetch provider 集合为空**（或全部 `available()===false`）时抛 `WEB_PROVIDER_UNAVAILABLE`。forge 的 roster（`src/forge-host/boot.ts` §1 + `forge-patch.yml`）**整行漏抄**官方 `dsh-base` 的 `{ id: 'web-fetch-http', name: '@deepseek-ai/dsh-web-fetch-http' }`，`web` 行少抄 `fetchProvider: 'http'` 键，`tool-web` 还写成 `fetch: false`（官方 base 为 `true`；实际生效值由 agent 预设决定，故工具仍在）= **工具在、provider 不在**。
- **取证**：全仓 grep `web-fetch` 零命中（`boot.ts` / `forge-patch.yml` 均无该行）；对照官方 `dsh-base/cordis.patch.yml` web 段三行俱全；`searchProviders` 与 `fetchProviders` 是**两个独立注册表**（`dsh-web` 源码），故 search 正常而 fetch 恒挂。
- **解法**：三处逐字对齐官方（`web` 行补 `fetchProvider: 'http'`、新增 `web-fetch-http` 行、`tool-web` 改 `fetch: true`），两个 roster 文件同步。同类坑 53/55/62：**宿主 roster 抄官方必须连 insert 行与 config 键一起抄**。
- **复盘要点**：
  1. **「对每个目标都失败」= 确定性缺陷，不是抖动**：变量不随目标变化（可达站点与被墙站点表现完全一致）时先查装配/注册面，别记成"偶发"——本次台账里一条"状态会漂移/临时故障"的结论就是这么来的，已被证伪并更正（dogfood #27）。
  2. **分清「工具的开关」与「工具的 provider」**：`tool-web` 的 `fetch` 只决定工具是否暴露，能不能真抓由 `fetchProviders` 决定；两者都缺时报的是同一个错，只盯工具开关会查反方向。
  3. **「搜得到」不能证明「抓得到」**：搜与抓是两套注册表、两条配置键，任一为空都会以同样的错误串暴露。

## 坑 72：Node/undici 出口「不装策略 = 恒直连」——安装是 **launcher 的职责**，Electron 宿主没人干，于是「工具明明支持代理却抓不到被墙站点」

- **现象**：`web_fetch` 抓境外站点恒 `TypeError: fetch failed`（可达站点正常、非 2xx 正常返回、DNS/重定向类错误文案清晰）；同机系统代理 `127.0.0.1:7890` 在监听、其它工具经它可通（同 URL 换 `curl -x` 即 200，出口 IP 为境外）。用户期望是「**系统代理就该走代理**」。
- **根因**：上游 `@deepseek-ai/dsh-http-proxy` 是 **library 而非插件**（策略"每进程只有一个答案"），`proxyRouteFor(url)` 在**未安装策略**时恒返回 `DIRECT_ROUTE`；而 `dsh-web-fetch-http` 正是**先用 `proxyRouteFor` 选分支**（proxied → `requestVia` 走全局 dispatcher；direct → `requestPinned` 自建 Agent + DNS 钉住），故**没人装策略 = 永远直连**。官方由 **launcher 在首个插件挂载前**调 `installProxyFromEnvironment`；Electron 宿主不是 launcher → 全树没有调用方。
- **取证**：`installProxyFromEnvironment` 在 `node_modules/@deepseek-ai` 内**只有声明、没有调用**（全树 grep）；进程环境变量无 `HTTP(S)_PROXY`；真实 Electron 运行时探针（`npx electron` + `--user-data-dir` 落在工作区内）打印 `resolveProxy("https://example.com") = "PROXY 127.0.0.1:7890"`，安装后 `proxyRouteFor(google).proxied = true`、回环 `false`、`dispose` 后 `false`。
- **解法**：新增 `src/forge-host/forge-node-proxy.ts`，把 Node 出口接到**同一份网络设置**：`direct` = 释放策略；`system` = 取 Chromium 已解析好的**系统代理**（`session.defaultSession.resolveProxy`，与渲染进程同源；解析为 DIRECT 时回落进程环境变量）**镜像**给 undici；`manual` = 用既有手动规则解析出的 `host:port`（SOCKS 上游不支持 → 记 warn 后直连）。挂载点取既有 `applyInternal`（Chromium 侧成功才动它），`package.json` 显式声明依赖。
- **复盘要点**：
  1. **「工具不支持某能力」先怀疑"宿主没做上游假设的准备工作"**：代理库把安装责任留给 launcher，与坑 61（子进程 runtime）、坑 63（控制台前提）同类——**Electron 宿主缺位的是"启动动作"，不是"功能实现"**。
  2. **只设环境变量可能不够**：消费方可能"先用策略选分支、再决定用不用环境变量"，此时必须调**安装 API**，写 `process.env` 不生效。
  3. **系统代理要"镜像"不要"重读"**：Chromium 已经把系统代理解析好了（含 PAC），Electron 侧自己读 WinINET 不现实；代价是 PAC 按 host 变化时属**采样近似**（策略每进程一个答案），且运行期改代理不自动感知（需重新应用设置或重启）。
  4. **网络层错误"信息少"不等于"链子断了"**：undici 把真因放在 `error.cause`，provider 原样重抛（`catch { close(); throw error }`）→ 只能看到 `TypeError: fetch failed`（**open**：按铁律不改官方代码，此 DX 缺口记为上游问题；将来自研 web 工具族时自带解包）。


## 坑 73：**槽位「声明了」不等于「会派发」**——`settings.onboarding` 的派发者原在被排除的官方包里，任何引导步骤注册了都永远不显示

- **现象**：把官方 `dsh-client-ui-settings-models` 纳入互斥排除、由自研件重新注册 `settings.onboarding` 两步（内测声明 + DeepSeek 官方密钥引导）时，注册面完全正常（账本有条目、无报错、无冲突），但**首启一条引导都不弹**。
- **根因**：槽位是**两段契约**——`children` 声明（谁声明）+ `renderSlot` 派发（谁渲染）。forge 的 `@lansi-ai/dsh-forge-settings-shell` 接管 `sidebar.settings` 时**声明了** `'settings.onboarding': { kind: 'list', scope: 'root' }`，但派发实现留在**被排除的官方 `ui-settings-general` 里**（`renderSlot("settings.onboarding", {stepId, complete, openSection}, {only})` + 会话态判定 + 步骤完成集），自研外壳 V1 明确未做（文件头注释写的是「V2 待补」）。于是槽位长期「有声明、无派发、无报错」：官方 models 包的引导在 forge 里**从来就没显示过**，这次自有化只是第一次让人注意到。
- **取证**：`settings.onboarding` 的注册者全仓库只有官方 models 包（`name:"settings.onboarding"` grep 命中 2 条，都在该包）；派发语句只在 `ui-settings-general/lib/client.js:266`；`forge-settings-shell-client.js` 内 `onboarding` 只出现在注释与 children 声明里，零 `renderSlot` 调用。
- **解法**：外壳补齐官方投影语义（1:1）：`settings.onboarding` 账本投影（id/order 升序）+ 会话态判定（`sessions.list` 快照：`phase==='ready'` 且 `current===undefined || byId[current].blank===true`）+ 本会话完成集（退出引导态即清空）+ `renderSlot('settings.onboarding', {stepId, complete, openSection}, {only: stepId})`；`sessions` 服务缺席时用空 store 兜底（引导永不激活，设置面板其余部分照常）。自研件则按官方 order 重新注册两步（`welcome-notice` -100 / `deepseek-official` 0，写 `ui-onboarding.welcomeNoticeVersion`）。
- **复盘要点**：
  1. **排除官方包前，先把「该包提供的派发/服务面」逐条列清**——与坑 15/62（服务面连坐）同源，只是这次连坐的是**渲染派发**而非 ctx 服务：**声明与派发分居两包**，只查声明会漏判。
  2. **「注册成功、无报错」是弱证据**：`slots.register` 只校验声明存在，不校验有人渲染。判定「某槽位真的在工作」的唯一硬证据是**runtime 里有人调 `renderSlot`**（grep 命中，或实机可见）。
  3. **顺带修掉的既有缺口要写进台账**：本次同时补齐了外壳 V2 缺的 onboarding 投影；官方 models 包此前在 forge 里静默失能一事，属于**长期存在的行为差异**，不是本次引入的回归。


## 坑 74：opencode Go 恒 `400 MissingSessionID`——**网关要的自定义头，官方设置页不暴露**（而配置层其实早就支持）

- **现象**：把 opencode Go（`https://opencode.ai/zen/go`）配成模型路由后，每次对话都被上游顶回：
  `400: {"type":"MissingSessionID","message":"Error from provider (Console Go): Request is missing x-opencode-session and cannot be routed efficiently. …"}`。
- **根因**（两段事实叠加）：
  1. **网关侧**：opencode Go 在文档「Where can I use it?」里要求客户端①发普通编码 agent 流量、②用自有 UA、**③每个请求带稳定会话 ID（`x-opencode-session`）**以便路由与提示缓存；同一张表把 **DeepSeek Harness 列为「部分模型路径带会话信息、其余路径缺失」**（discussion #5495）。
  2. **DSH 侧**：原生会话头只有官方 DeepSeek 适配器在发——`dsh-llm-deepseek` 发 `x-deepseek-harness-session-id: options.sessionId`（`lib/index.js:1665-1667`）；**pi-ai 适配器不发**。而 pi-ai 的 profile **本来就支持 `headers` 字典**（`llm-pi-ai` 的 `headers: z.dict(z.string())`，`lib/index.js:994`；校验 `assertValidHeaders` `:1036`；三条发请求路径都带上——`:1873` openai 系、`:2291` anthropic 系、`:2635` 模型探测），**官方设置页（ui-settings-models）却只暴露 API Key/baseURL/模型目录，没有请求头**。于是「网关要求自定义头」在官方 UI 里无路可走：只能手改 `settings.yaml`。
- **取证**：错误原文来自上游 body（非 DSH 文案，全仓库 grep `MissingSessionID`/`Console Go` 零命中于 `@deepseek-ai`）；`dsh-llm-pi-ai` 的 `headers` 字段与传递路径见上列行号；`dsh-llm-deepseek` 的会话头发送点见 `:1665`。
- **解法**（**不动官方代码**，两层一起上，2026-09-15）：
  1. **配置层入口**（自有化设置插件）：`@lansi-ai/dsh-forge-settings-models` 的 provider 编辑器加「请求头」区——按 `llm-pi-ai` 家族（并用 schema `nodeAtPath` 兜底探测）渲染键值行编辑器，写 `providers.<route>.headers`（最小 `settings.mutate` pathOps，空表落成 unset）；命中 opencode 网关（路由 id 以 `opencode` 开头，或 baseURL host 属 `opencode.ai`）且未配会话头时给一行说明。校验口径对齐上游（名称走 RFC 7230 token、值禁 CR/LF/控制字符、重名大小写不敏感），非法时闸住提交。**这一层是通用能力**：任何网关要的自定义头都能配。
  2. **逐会话自动化**（**独立插件包** `dsh-llm-opencode-session`，仓库 `lansi-ai/dsh-llm-opencode-session`，工作区 `E:\Projects\DSH\plugins\dsh-llm-opencode-session\`，经 `--install-plugin github:lansi-ai/dsh-llm-opencode-session[@ref]` 装进 `$DSH_HOME/profiles/dsh-forge/cordis.patch.yml`，由 profile 装载层装配并把裸名改写为**绝对入口路径**；导出 `name`/`inject`/`apply`，与外部插件同形态）：opencode 要的是**每段对话一个稳定 ID**（不是每请求换值），而静态配置表达不了 → `apply` 经 `ctx.effect` 安装出口补丁（卸载即还原）：只对 `opencode.ai` 域生效；请求已带 `x-opencode-session`（用户静态配置或上游将来自己发）**一律不覆盖 → 上游修好即自动 no-op**；会话 ID = `dsh-` + `sha1(model + 首条用户消息)` 前 32 位（同对话稳定、不同对话不同）；无正文（如 `GET /v1/models`）用进程固定 id；只**克隆**读请求体、失败一律原样发送；`apply` 内 try/catch（宿主对未激活条目会回滚整棵树，不该因「不缺头」让应用起不来）。出口选择依据：pi-ai 三种 wire 协议都走 `options?.fetch ?? globalThis.fetch`，而 `dsh-llm-pi-ai` 不注入自定义 fetch；openai/anthropic 两 SDK 的 `getDefaultFetch()` 是**调用时**读全局 `fetch`，故包装全局即可全覆盖。**该能力不进主包**（可选能力走外部插件通路，D-28）：主包内没有副本，删 profile 那一行即卸载。
- **复盘要点**：
  1. **「官方设置页没有这个开关」≠「配置层不支持」**：先读上游 schema（本例 `headers` 一直在），再决定是自有化补 UI 还是真需要动传输层——前者零上游耦合、可回滚；后者才是这次的逐会话补丁（因为静态头**在语义上就做不到**逐会话）。
  2. **先问「上游要的是哪个粒度」再动手**：opencode 的口径是 **per conversation / stable**——每请求换值反而毁掉路由与提示缓存。静态配置能消 400，但把所有对话并成一个会话；要语义正确只能拿到**逐请求**的会话身份，而它只存在于请求里（DSH 的 `options.sessionId` 到 pi-ai 就断了），所以落在 `llm/stream` 之后的传输层。
  3. **补丁要自带退役条件**：本补丁「已带该头就不覆盖」，因此上游 pi-ai 一旦转发会话信息（issue #4847/#4680/#9290），它自动退化为 no-op，可随版本评估删除。
  4. **包装全局 fetch 的纪律**：域白名单 + 只读克隆（不消费原体）+ 任何失败回退原请求 + 退出前还原 + 单测覆盖（含「非目标域零改动」「请求体不被吞」「下游抛错原样冒泡」）。
  5. **同类风险通用**：任何第三方网关的「必须带某头/某 UA」诉求都能用这两条通路解决；UA 一项 DSH 已满足（`dsh-llm` 的 `attributionHeaders()` 发 `deepseek-harness/<version> (+repo)`）。


## 坑 75：预发布更新链「三件套」必须一致——**渠道名 / 描述符文件名 / tag 预发布段**；`rc.yml` 从未随包上传

- **现象**（用户实机，2026-09-16）：已装 **0.1.1 正式版**，点「检查更新」——**正式渠道无更新**（预期：`v0.1.2-alpha.1` 是 pre-release），**预发布渠道直接报错**：
  `Cannot find rc.yml in the latest release artifacts (https://github.com/lansi-ai/dsh-forge/releases/download/v0.1.1/rc.yml): HttpError: 404`。
- **根因**（按 `electron-updater` 源码逐条核对，四件事叠在一起）：
  1. **`allowPrerelease` 由「当前安装的版本」推导**：正式版装机恒为 `false` → provider 走 `/releases/latest`（GitHub 上游天然跳过 pre-release）→ **正式版装机不可能升到预发布版**，且它根本不会去挑预发布 tag（`providers/GitHubProvider.js:51` 的 `if (this.updater.allowPrerelease)` 分支被跳过）。所以「正式渠道没更新」不是故障。
  2. **`rc` 渠道要的文件名是 `rc.yml`**：`Provider.getCustomChannelName(channel) = ${channel}${平台后缀}`（`:44-46`；Windows **无**平台后缀、macOS 为 `-mac` → `rc.yml` / `rc-mac.yml`）。而**两条发布链都没有产出它**——`release-win.yml` 的上传清单只有 `latest.yml`，`--publish-local` 的 `UPLOAD_PATTERNS` 同样只有 `latest.yml`。
  3. **404 的回退带前提**：`GitHubProvider.js:137-144` 的 `catch { if (this.updater.allowPrerelease) rawData = await fetchData(defaultChannel); else throw e }` —— 只有 `allowPrerelease === true`（当前装的就是预发布版）才会回退 `latest.yml`；正式版装机直接抛错，即上面的原文。**我们 `auto-updater.ts` 旧注释称「404 后会自动回退」，漏了这个前提**（本次已修正为逐条实测语义）。
  4. **tag 的预发布段必须等于渠道名**：`:83` 的 `isNextPreRelease = hrefChannel === currentChannel` → `rc` 渠道**只认 `-rc.N`**；`-alpha.1` 段是 `alpha`，`shouldFetchVersion` 对 `rc` 也为假 → **选不中**。历史上 `0.1.1-alpha.N` 能自动升级，是因为当时从**预发布装机**起步且 `channel` 为空 → `currentChannel` 取了当前版本的段 `alpha` 走 Atom 首条路径（`:52-58`）；一旦渠道显式设为 `rc`，alpha 段就再也匹配不上。
- **取证**：`node_modules/electron-updater/out/providers/GitHubProvider.js:51/83/116-145`、`out/providers/Provider.js:41-46`；本地 `src/forge-host/auto-updater.ts` 的渠道映射（`rc → 'rc'`）与旧注释；实机报错原文（URL 指向 `v0.1.1/rc.yml` 正是「`/releases/latest` = v0.1.1 且无 rc.yml」的指纹）。
- **解法**（两条链一起补，2026-09-16）：
  1. `scripts/align-release-assets.cjs` 统一生成**渠道描述符副本**：`latest.yml → rc.yml`、`latest-mac.yml → rc-mac.yml`（逐字节复制，YAML schema 相同仅文件名不同）——该脚本是本地直发与 CI 的公共步骤，一处补齐两条链；
  2. `release-win.yml` 上传清单补 `release/rc.yml`；`release-mac.yml` 在 **align 之后**的那次上传里补 `release/rc-mac.yml`（mac workflow 的上传发生在 align 之前，顺序不能抄错）；
  3. `scripts/release.cjs` 的 `UPLOAD_PATTERNS` 收 `rc(?:-mac)?\.yml`，并新增闸门：win 本地发布缺 `rc.yml` 即中止（与既有 `latest.yml`/`SHA256SUMS` 闸门同级）；
  4. 修正 `auto-updater.ts` 的渠道注释为实测语义（allowPrerelease 前提、tag 段匹配、`rc.yml` 必需）；
  5. 发布命名约束：**预发布用 `-rc.N`**（对齐 `rc` 渠道）；若将来真要 `alpha` 段，必须同时给应用加 `alpha` 渠道映射，否则该版本对应用内更新不可见；
  6. 给**已发布**的 `v0.1.1` 补一个 `rc.yml`（内容即其 `latest.yml`）→ 现存正式版装机的 rc 渠道从「404 报错」变成「无更新」（语义正确：正式版本来就没有可升的预发布）。
- **复盘要点**：
  1. **渠道是三件套**：`设置里的渠道名` ↔ `描述符文件名（含平台后缀）` ↔ `tag 的预发布段`，三者必须一致；任何一环错位，表现都是「上游 404 / 看不到更新」，而不是本地报错。
  2. **「客户端说找不到文件」先读客户端源码，不要读自己的注释**：本次错误注释在仓库里存了数周，把「有条件回退」写成了「自动回退」。
  3. **发布链的产物清单要含渠道描述符**：只传 `latest.yml` 的链在 stable 渠道永远正常、在其它渠道永远坏 —— 这种「只有换渠道才暴露」的缺陷必须在链条层修，而不是每次发版手工补。
  4. **正式版装机 ↔ 预发布渠道是设计上的死路**：要跨过去只能手动装一次预发布包（或发一个正式版）。把这点写进发布说明，省掉用户重复点「检查更新」。



