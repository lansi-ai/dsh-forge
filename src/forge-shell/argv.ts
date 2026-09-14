/**
 * dsh-forge 启动参数解析（Step 6·零端口验证 + --serve 兼容模式）。
 *
 * 对齐 docs/07-forge-shell.md §2 的启动参数规范：
 *   - --serve[=<port>]    启动兼容 webserver（loopback，默认 38000），供旧插件
 *                         「HTTP 原义」路由（如 dsh-terminal /terminal/stream）使用。
 *                         默认模式（不传 --serve）= 零端口 IPC 载波模式（红线 R-03）。
 *   - --install-plugin <spec>  一键安装外部插件（`github:owner/repo[@ref]` 或本地目录），
 *                         在 boot 前完成，装完本次启动即用。
 *
 * 仅识别 dsh-forge 自有的少量参数，其他参数（--profile / --user-data-dir 等）
 * 留给上游解析器，不做二次处理。
 */

/** 解析后的启动选项。 */
export interface CliOptions {
  /** 是否启用 --serve 兼容模式（默认 false = 零端口 IPC 载波模式）。 */
  serve: boolean
  /** --serve 监听端口（仅当 serve=true 时有意义）。默认 38000。 */
  servePort: number
  /** 是否静默启动（--hidden，开机自启登录后驻留托盘，不弹主窗口）。 */
  hidden: boolean
  /**
   * 是否重新选择数据目录（--select-data-dir，M4-a4）。
   * 强制弹出首启数据目录窗口（已有选择时预选当前目录，迁移源 = 当前在用目录）。
   */
  selectDataDir: boolean
  /**
   * 显式指定数据目录（--data-dir=<path>，M4 · 企业静默部署）。
   * 优先级最高：覆盖注册表预置与已持久化选择，启动即生效并写回持久化与注册表。
   */
  dataDir?: string
  /**
   * 一键安装外部插件（--install-plugin <spec>）。
   * spec 支持 `github:owner/repo[@ref]` 与本地目录路径；安装在 boot 之前完成，
   * 因此本次启动即可用（详见 `forge-host/plugin-install.ts`）。
   */
  installPlugin?: string
}

/** --serve 默认端口：Loopback 范围高位，避免与常用服务冲突。 */
export const DEFAULT_SERVE_PORT = 38000

/**
 * 解析 process.argv。
 *
 * 支持两种形式：
 *   - `--serve`（无值 → 使用默认端口）
 *   - `--serve=38080`（等号形式）
 *   - `--serve 38080`（空格 + 位置值，兼容写法）
 *
 * @param argv 原始 argv（默认取 process.argv）。
 * @param skip 跳过前几项：dev（`electron .`）为 2（node + script），打包版为 1
 *   （`DSH Forge.exe` + 参数，**没有 script 项**）。调用方按 `app.isPackaged` 给值。
 * @returns 解析后的 CLI 选项。
 */
export function parseArgv(argv: string[] = process.argv, skip = 2): CliOptions {
  const rest = argv.slice(skip)
  let serve = false
  let servePort = DEFAULT_SERVE_PORT
  let hidden = false
  let selectDataDir = false
  let dataDir: string | undefined
  let installPlugin: string | undefined
  let i = 0
  while (i < rest.length) {
    const arg = rest[i]
    if (arg === '--hidden') {
      hidden = true
    } else if (arg === '--select-data-dir') {
      selectDataDir = true
    } else if (arg === '--install-plugin') {
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--') && next.trim().length > 0) {
        installPlugin = next
        i += 1
      }
    } else if (arg.startsWith('--install-plugin=')) {
      const value = arg.slice('--install-plugin='.length)
      if (value.trim().length > 0) installPlugin = value
    } else if (arg === '--data-dir') {
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--') && next.trim().length > 0) {
        dataDir = next
        i += 1
      }
    } else if (arg.startsWith('--data-dir=')) {
      const value = arg.slice('--data-dir='.length)
      if (value.trim().length > 0) dataDir = value
    } else if (arg === '--serve') {
      serve = true
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        const parsed = Number.parseInt(next, 10)
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) {
          servePort = parsed
          i += 1
        }
      }
    } else if (arg.startsWith('--serve=')) {
      serve = true
      const value = arg.slice('--serve='.length)
      const parsed = Number.parseInt(value, 10)
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) {
        servePort = parsed
      }
    }
    i += 1
  }
  return {
    serve,
    servePort,
    hidden,
    selectDataDir,
    ...(dataDir !== undefined ? { dataDir } : {}),
    ...(installPlugin !== undefined ? { installPlugin } : {}),
  }
}
