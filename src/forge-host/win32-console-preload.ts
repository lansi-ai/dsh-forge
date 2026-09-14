/**
 * 子进程 runner 的控制台预载入口（由 `subprocess-run-as-node.ts` 以 `-r <本文件>` 注入）。
 *
 * 为什么需要：runner 与 Electron 主进程一样是 GUI 子系统（electron.exe），**不会**继承宿主
 * 控制台；而它创建的 pwsh / cmd（控制台子系统）在「创建者无控制台」时会被 Windows 新建一个
 * **可见**控制台窗口（= 工具调用时闪出的 cmd 黑框），受限令牌下同一动作还会死在 DLL 初始化
 * （`0xC0000142`）。详见 `./win32-console.ts` 的模块说明与判据表。
 *
 * 两条硬约束：
 *   ① 必须是 CJS —— Node 的 `-r` 只预载 CJS（本项目 `"type": "commonjs"`，满足）；
 *   ② **绝不能抛** —— 预载抛异常会让 runner 直接退出，所有走子进程的工具（pwsh / grep /
 *      沙箱 ACL runner）全挂。故 `ensureHostConsole` 内部全程 try/catch，这里只做一次调用
 *      并在失败时告警。
 */
import { ensureHostConsole } from './win32-console'

const attachment = ensureHostConsole('subprocess-runner')
if (attachment.mode === 'failed') {
  console.warn(
    `[dsh-subprocess-adapter] 子进程 runner 控制台挂接失败：${attachment.detail ?? '未知原因'}`
    + '（控制台类工具可能闪出 cmd 窗口；workspace-write 下可能报 0xC0000142）',
  )
}
