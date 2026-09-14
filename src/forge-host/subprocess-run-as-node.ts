/**
 * Electron 宿主下的子进程运行时适配器（M6 · 2026-09-11）。
 *
 * 背景：上游 `@deepseek-ai/dsh-subprocess-local` 用 `[process.execPath, <runner 入口>]`
 * 拉起 Node 版 runner，并在 spawn 后 `await child.on('message')`（Windows 下 runner
 * 经 IPC 回报结果，见 `launchWindowsJob`）。官方 web 端运行时是 Node，
 * `process.execPath = node.exe`，一切正常；forge 是 Electron 主进程，
 * `process.execPath = electron.exe`（GUI 子系统）——既不执行该脚本，也没有可用的 IPC
 * 通道，父进程永远等不到那条 message，于是 pwsh / grep 这类走子进程的工具**卡死**。
 *
 * 解法（两层互补，均不改全局 `process.env`——那会让 Chromium 子进程崩溃）：
 *   1. `child_process.spawn` 补丁：覆盖**外层** subprocess runner 自身的启动；
 *   2. `installSubprocessHook()` 包裹 `ctx.subprocess` 启动方法，给每次 spawn 的 `spec.env`
 *      补一项：覆盖**目标命令**——`workspace-write` 下沙箱会把 argv 包成
 *      `[electron.exe, windows-acl runner, …, --, <真命令>]`，这一层由 subprocess runner 用
 *      koffi `CreateProcess` 拉起，`child_process` 补丁盖不到，但它的环境来自 `spec.env`。
 * 影响面刻意收窄：
 *   - Chromium 自身的子进程（renderer/GPU/utility）不走这两条路，不受影响；
 *   - `app.relaunch()` 是 Electron API，不经 `child_process`，不受影响；
 *   - 不改全局 `process.env`（实测会让 Chromium 子进程继承后崩溃）。
 *
 * ⚠️ 打补丁必须早于 ESM 命名导出 facade 的创建：facade 是创建时的一次性快照，
 * 之后再改模块对象的属性对它无效（已实测）。本项目主进程为 CJS，facade 只会在 boot 期
 * 上游 ESM 包被动态 import() 时创建，故本模块置于入口首条 import 即可稳定生效；末尾自检兜底。
 *
 * 附：同一对注入点还承担**控制台预载**（`-r <win32-console-preload>`）——runner 是 GUI 子系统，
 * 不持有控制台时它创建的控制台类目标（pwsh / cmd）会被 Windows 新建一个可见窗口（闪框）
 * 甚至死在 DLL 初始化（0xC0000142）。见 `./win32-console.ts`。
 *
 * @module forge-host/subprocess-run-as-node
 */
import nodeChildProcess from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { consolePreloadPath } from './win32-console.js'

const RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE'

// 本项目主进程是 CJS（package.json "type": "commonjs"，tsc 输出 require），因此本模块的
// 静态导入走 require、**不会创建 ESM facade**：facade 要等上游 ESM 包（如
// dsh-subprocess-local）在 boot 期被动态 import() 时才创建，届时补丁已就位。

/** 适配状态，供入口在 Logger 就绪后上报；`problem` 由自检异步写入并即时告警。 */
export const subprocessRunAsNode: { patched: boolean; problem: string | undefined } = {
  patched: false,
  problem: undefined,
}

const originalSpawn = nodeChildProcess.spawn

/**
 * 在 Node 模式 runner 的 argv 前插入控制台预载（`-r <shim>`）。
 *
 * `-r` 由 Node 自身的选项解析消费，**不会进入 `process.argv`**（已实测：runner 的
 * `--` 分段与目标 argv 保持原样），因此对上游 runner 无副作用。幂等：已注入则不重复。
 *
 * @param args - 原始 argv。
 * @returns 注入后的 argv（新数组）。
 */
function withConsolePreload(args: string[]): string[] {
  const preload = consolePreloadPath()
  if (args.includes(preload)) return args
  return ['-r', preload, ...args]
}

/**
 * 与原始 `spawn` 同形的包装：仅在可执行文件是 `process.execPath` 时补上运行期环境变量与控制台预载。
 *
 * @param command - 可执行文件路径。
 * @param args - 参数向量。
 * @param options - spawn 选项；其中的 `env` 会被合并而非替换。
 * @returns 子进程句柄。
 */
function spawnWithRunAsNode(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  if (command !== process.execPath) return originalSpawn(command, [...args], options)
  return originalSpawn(command, withConsolePreload([...args]), {
    ...options,
    env: { ...(options.env ?? process.env), [RUN_AS_NODE_ENV]: '1' },
  })
}

/**
 * 安装补丁：非 Electron 宿主或已处于 Node 模式时无需适配。
 */
function install(): void {
  if (process.versions.electron === undefined) return
  if (process.env[RUN_AS_NODE_ENV] === '1') return
  // Object.assign 不做属性类型校验，是改写模块对象而又不触碰类型断言的最短路径。
  Object.assign(nodeChildProcess, { spawn: spawnWithRunAsNode })
  subprocessRunAsNode.patched = true
}

/**
 * 自检：确认 ESM 命名导出 facade 捕获到的是补丁后的 `spawn`。
 *
 * 这是本适配器**唯一的失效路径**——若 facade 早于补丁创建（入口被改成 ESM 等），
 * 上游 ESM 包会拿到原始 `spawn`，工具将重新卡死且**没有任何报错**。故此处必须响亮告警。
 * `await import()` 在 CJS 产物中被 tsc 保留（boot 期上游 ESM 包同样靠它加载），
 * 因此本自检创建/读取的就是 harness 稍后会用的那个 facade。
 * 用 console.warn 而非统一 Logger：本模块刻意零依赖，以保证在入口首条 import 求值。
 */
async function verifyFacade(): Promise<void> {
  const patchedSpawn: unknown = spawnWithRunAsNode
  try {
    const facade = await import('node:child_process')
    if (facade.spawn === patchedSpawn) return
    subprocessRunAsNode.problem =
      'ESM facade 早于补丁创建，子进程适配未生效（入口须保持 CJS，且本模块须为入口首条 import）'
  } catch (error) {
    subprocessRunAsNode.problem = `facade 自检异常：${String(error)}`
  }
  console.warn(`[dsh-subprocess-adapter] ${subprocessRunAsNode.problem}`)
}

install()
if (subprocessRunAsNode.patched) void verifyFacade()

/**
 * 纯函数：把运行期环境变量补进一次 spawn 请求的 `spec.env`，并给「目标自身即 Node 模式 runner」
 * 的 argv 补上控制台预载（见 `withRunAsNodeSpecArgv`）。
 *
 * 上游 `targetEnvironment(spec)` = `childEnv(spec.env)`，而 `childEnv` = 「父进程环境 + extra」，
 * 因此给 `spec.env` 补一项，就能让**目标命令**（例如 `workspace-write` 下被沙箱包成
 * `[electron.exe, windows-acl runner, …]` 的那条命令）以 Node 模式启动。
 * 只改 `spec.env`、不动 `process.env`：全局设置会波及 Chromium 子进程（已实测崩溃）。
 *
 * @param spec - 形如 `{ argv, cwd, env? }` 的一次性 spawn 请求。
 * @returns 补好环境变量与预载的同一对象（原地修改，保持上游引用语义）。
 */
export function withRunAsNodeSpecEnv<T extends { argv?: unknown[]; env?: NodeJS.ProcessEnv }>(spec: T): T {
  spec.env = { ...(spec.env ?? {}), [RUN_AS_NODE_ENV]: '1' }
  withRunAsNodeSpecArgv(spec)
  return spec
}

/**
 * 目标自身就是 `process.execPath`（Node 模式 runner）时，给它的 argv 补上控制台预载。
 *
 * 这条路径覆盖的是**沙箱 ACL runner**：`workspace-write` 下 `ctx.sandbox.confine()` 把 argv 包成
 * `[electron.exe, windows-acl runner, …, --, <真命令>]`，该 argv 成为 subprocess runner 的**目标**，
 * 由 koffi `CreateProcessAsUserW` 拉起——`child_process` 补丁盖不到它，而**它才是受限子进程
 * （pwsh）真正的创建者**：不持有控制台时，受限子进程会去新建可见控制台（闪框）或死在
 * DLL 初始化（`0xC0000142`）。故这条路径也必须补 `-r`。
 *
 * 判定刻意收窄到 `argv[0] === process.execPath`（上游
 * `windowsAclRunnerInvocation()` 正是返回 `[process.execPath, <acl runner 入口>]`）：
 * 普通目标（`pwsh` / `cmd` / `rg`）保持原样、零改动。
 *
 * @param spec - 一次 spawn 请求（`argv` 原地插入，保持上游引用语义）。
 */
function withRunAsNodeSpecArgv(spec: { argv?: unknown[] }): void {
  const argv = spec.argv
  if (!Array.isArray(argv) || argv[0] !== process.execPath) return
  const preload = consolePreloadPath()
  if (argv.includes(preload)) return
  argv.splice(1, 0, '-r', preload)
}

/**
 * 判定一个值是否像上游的 spawn 请求（避免往无关对象上乱挂 `env`）。
 *
 * @param value - 待判定值。
 * @returns 是否具备 `argv`（数组）或 `cwd`（字符串）特征。
 */
function looksLikeSpawnSpec(value: unknown): value is { argv?: unknown[]; env?: NodeJS.ProcessEnv } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { argv?: unknown; cwd?: unknown }
  return Array.isArray(candidate.argv) || typeof candidate.cwd === 'string'
}

/** 需要包裹的启动方法名（上游 `ctx.subprocess` 的进程启动面）。 */
const LAUNCH_METHODS = ['spawn', 'start', 'exec'] as const

/**
 * 在 `ctx.subprocess` 的启动方法上包一层，给每次 spawn 的 `spec.env` 补运行期环境变量。
 *
 * 这是**共享启动咽喉**：pwsh 执行器（含沙箱包裹后的 argv）与文件搜索都从这里进入，一处包裹即可
 * 覆盖「目标命令」那一层——而 `child_process` 补丁只覆盖**外层 runner 自身的启动**，两者互补：
 * 外层的环境来自 `runnerEnvironment()` → `childEnv()`（走 `process.env`），
 * 目标的环境来自 `targetEnvironment(spec)` → `childEnv(spec.env)`（走 `spec.env`）。
 *
 * @param subprocess - `ctx.subprocess` 服务实例（boot 完成后从宿主上下文取得）。
 * @returns 是否挂载成功（非 Electron / 已是 Node 模式 / 服务面不可用时为 false）。
 */
export function installSubprocessHook(subprocess: unknown): boolean {
  if (!subprocessRunAsNode.patched) return false
  if (typeof subprocess !== 'object' || subprocess === null) return false
  const service = subprocess as Record<string, unknown>
  let installed = false
  for (const name of LAUNCH_METHODS) {
    const method = service[name]
    if (typeof method !== 'function') continue
    const call = method as (...args: unknown[]) => unknown
    // Object.assign 不做属性类型校验，是改写服务对象而又不触碰类型断言的最短路径。
    Object.assign(service, {
      [name]: (...args: unknown[]): unknown => {
        if (looksLikeSpawnSpec(args[0])) withRunAsNodeSpecEnv(args[0])
        // 必须保留接收者：上游方法内部大量使用 `this.selectContainmentMode(...)` 等私有成员，
        // 直接 `call(...args)` 会让 this 变 undefined，抛
        // `Cannot read properties of undefined (reading 'selectContainmentMode')`。
        return call.apply(service, args)
      },
    })
    installed = true
  }
  return installed
}
