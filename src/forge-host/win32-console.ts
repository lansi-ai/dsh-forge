/**
 * Windows 宿主控制台适配器（M6 · 2026-09-14）——治「工具调用时闪出 cmd 黑框」（与 R23 同根因）。
 *
 * 背景：上游 Windows 进程原语（`@deepseek-ai/dsh-win32-process` 的 `CreateProcessW` /
 * `CreateProcessAsUserW`）创建目标进程时**不带任何控制台标志**——该包的 ABI 常量表里根本没有
 * `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE`。它的设计前提写在下游 README 里：
 * `dsh-sandbox-windows-acl`「已知限制」原文「**子进程共享宿主控制台**」（并注明以
 * CREATE_NO_WINDOW / CREATE_NEW_CONSOLE 创建的子进程会在 DLL 初始化期以
 * `STATUS_DLL_INIT_FAILED` / `0xC0000142` 死亡）。
 *
 * 于是行为完全取决于**创建者有没有控制台**（实测，见表）：
 *   | 创建者 | 目标（pwsh 等控制台子系统） | 现象 |
 *   | 有控制台（官方 CLI/web 跑在终端里） | 挂到同一控制台（进程数 4→5，无新窗口） | 不闪框 |
 *   | **无控制台（Electron：GUI 子系统不继承控制台）** | **Windows 新建一个可见控制台**（hwnd≠0、windowVisible=1、进程数=1） | **闪框**；受限令牌下同一动作死在 DLL 初始化 = `0xC0000142` |
 *
 * 解法 = 把上游假设的前提补上：让**创建者**持有控制台。
 *   ① 主进程：`AttachConsole(ATTACH_PARENT_PROCESS)`（从终端启动时复用用户终端控制台，
 *      零新建、零闪框），失败再 `AllocConsole()` 并立即 `ShowWindow(SW_HIDE)`（双击启动等
 *      无祖先控制台的场景）；
 *   ② 子进程 runner：electron.exe 同样是 GUI 子系统、也不会继承控制台，必须自己挂——
 *      由 `subprocess-run-as-node.ts` 以 `-r <本模块的预载入口>` 注入（见
 *      `./win32-console-preload.ts`），同样 attach → alloc。
 * 这样 runner 创建的所有目标（pwsh / cmd / 沙箱 ACL runner）都落到同一个（隐藏）控制台。
 *
 * 影响面与安全：
 *   - 只「挂接/分配控制台」，**不重定向任何 stdio**：工具输出始终走上游的管道
 *     （`STARTF_USESTDHANDLES` 那条路），与目标进程的读写无关；
 *   - **只在 attach 时不隐藏**：挂到的可能是用户自己的终端窗口，隐藏它会藏掉用户的终端；
 *     只有我们自己 `AllocConsole()` 出来的才隐藏；
 *   - 全程 try/catch，**绝不抛**：预载阶段抛异常会让 runner 直接退出（工具全挂），
 *     故失败只记状态、由调用方告警；
 *   - 幂等：每个进程只判定一次，结果缓存。
 *
 * @module forge-host/win32-console
 */
import path from 'node:path'

/** koffi 的最小使用面（只在需要时懒加载，不进入口关键路径）。 */
interface KoffiLibrary {
  func(definition: string): (...args: unknown[]) => unknown
}
interface KoffiModule {
  load(file: string): KoffiLibrary
}

/** AttachConsole 的伪 PID：挂到「父进程」的控制台。 */
const ATTACH_PARENT_PROCESS = 0xffff_ffff
/** ShowWindow 命令：隐藏窗口。 */
const SW_HIDE = 0

/** 谁在申请控制台（用于日志归属）。 */
export type ConsoleOwner = 'main' | 'subprocess-runner'

/** 挂接结果：`attach` 复用既有控制台（未新建）· `alloc` 新建后立即隐藏 · `failed` 皆失败 · `skipped` 非 Windows。 */
export interface ConsoleAttachment {
  owner: ConsoleOwner
  mode: 'attach' | 'alloc' | 'failed' | 'skipped'
  detail?: string
}

/** 每个进程只判定一次（幂等；失败也不重试，避免刷屏）。 */
let attachment: ConsoleAttachment | undefined

/**
 * 懒加载 Win32 绑定。
 *
 * 懒加载有两个理由：① 不把原生模块加载塞进「入口首条 import」的关键路径（D-22 启动即时响应）；
 * ② koffi 缺失或打包态未解出 asar 时，只在调用点失败，不让整个主进程起不来。
 */
function loadWin32() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as KoffiModule
  const kernel32 = koffi.load('kernel32.dll')
  const user32 = koffi.load('user32.dll')
  return {
    attachConsole: kernel32.func('int AttachConsole(uint32 dwProcessId)'),
    allocConsole: kernel32.func('int AllocConsole()'),
    getConsoleWindow: kernel32.func('uint64 GetConsoleWindow()'),
    getLastError: kernel32.func('uint32 GetLastError()'),
    showWindow: user32.func('int ShowWindow(uint64 hWnd, int nCmdShow)'),
  }
}

/**
 * 确保当前进程持有控制台（幂等、不抛）。
 *
 * 顺序：先挂父进程控制台（免费且零闪框），再退化为自行分配 + 隐藏。
 *
 * @param owner - 调用方身份，仅用于结果归属与日志。
 * @returns 挂接结果（同一进程内多次调用返回同一结果）。
 */
export function ensureHostConsole(owner: ConsoleOwner): ConsoleAttachment {
  if (attachment !== undefined) return attachment
  if (process.platform !== 'win32') {
    attachment = { owner, mode: 'skipped', detail: '仅 Windows 需要控制台适配' }
    return attachment
  }
  try {
    const win32 = loadWin32()
    if (Number(win32.attachConsole(ATTACH_PARENT_PROCESS)) !== 0) {
      // 挂到的是祖先（终端 / 已适配的宿主）的控制台：**不隐藏**，那可能是用户的终端窗口。
      attachment = { owner, mode: 'attach' }
      return attachment
    }
    const attachError = Number(win32.getLastError())
    if (Number(win32.allocConsole()) === 0) {
      attachment = {
        owner,
        mode: 'failed',
        detail: `AttachConsole=${attachError}（无祖先控制台）· AllocConsole=${Number(win32.getLastError())}`,
      }
      return attachment
    }
    // 自己新建的控制台：隐藏窗口后子进程仍共用它，桌面上不会出现可见窗口。
    // 例外：控制台由终端托管（Windows Terminal / ConPTY）时 GetConsoleWindow() 返回 0 —— 拿不到
    // 窗口句柄也就无法隐藏，此时**保留**该控制台（子进程照样共用、不再新建窗口），并把情况记进 detail。
    const window = Number(win32.getConsoleWindow())
    if (window !== 0) win32.showWindow(window, SW_HIDE)
    attachment = window === 0
      ? { owner, mode: 'alloc', detail: '控制台由终端托管（ConPTY）：无法隐藏其窗口，但子进程会共用它' }
      : { owner, mode: 'alloc' }
    return attachment
  } catch (error) {
    attachment = { owner, mode: 'failed', detail: `控制台适配异常：${String(error)}` }
    return attachment
  }
}

/**
 * 控制台预载入口的绝对路径（子进程以 `-r <path>` 挂载；与本模块编译产物同目录）。
 *
 * @returns `dist/forge-host/win32-console-preload.js` 的绝对路径。
 */
export function consolePreloadPath(): string {
  return path.join(__dirname, 'win32-console-preload.js')
}
