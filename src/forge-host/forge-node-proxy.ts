/**
 * Node/undici 出口代理（网络设置的第二条栈：Chromium 之外的 Node 侧真实出口）。
 *
 * 上游 `@deepseek-ai/dsh-http-proxy` 的语义是：**不安装策略 = `proxyRouteFor` 恒直连**，
 * 且官方由 launcher 在首个插件挂载前安装；Electron 宿主没有 launcher 那一段 → 本模块补上，
 * 让 `web_fetch` 抓取 / `web_search` / 模型 API / MCP 与「网络设置」走同一口径。
 *
 * 三态：
 *   - `direct`：释放策略（不装 = 直连）；
 *   - `system`：取 Chromium 解析出的**系统代理**（`session.resolveProxy`，与渲染进程同源），
 *     解析为 DIRECT 时回落到进程环境变量，两者都无才直连（选取结果打进日志，便于排查）；
 *   - `manual`：用调用方解析好的地址（SOCKS 传 null → 上游只支持 http(s)，Node 侧直连）。
 *
 * 已知边界：
 *   - PAC 按 host 变化时，本模块按两个 scheme 采样解析，属**近似值**（策略是每进程一个答案，
 *     无法逐请求走 PAC）；
 *   - 系统代理在运行期被改动不会被自动感知（Chromium 未暴露对应事件）→ 重新应用设置或重启生效；
 *   - 本模块失败不阻断 Chromium 侧与设置持久化，仅记日志（Node 栈不可用不影响桌面主体）。
 *
 * 无监听器/定时器；策略释放器在重装时显式释放（dispose 会还原 dispatcher 与环境变量）。
 */

import { session } from 'electron'
import type { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy' with { 'resolution-mode': 'import' }
import type { ProxyMode } from './forge-proxy.js'
import { log } from './log.js'

const TAG = '[dsh-network]'

/** 上游 `installProxyFromEnvironment` 的入参类型（由官方签名推导，不手写平行类型）。 */
type EnvLookup = Parameters<typeof installProxyFromEnvironment>[0]

/** 系统代理解析的采样项：环境变量名 + 代表该 scheme 的样本 URL。 */
const SYSTEM_SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ['http_proxy', 'http://example.com'],
  ['https_proxy', 'https://example.com'],
]

/** 当前已安装策略的释放器（重装前必须先释放，避免旧 dispatcher 与旧环境残留）。 */
let nodeProxyDispose: (() => Promise<void>) | null = null

/** 由固定键值表构造上游所需的 EnvLookup（只回答代理相关名字，其余一律「未设置」）。 */
function envLookupOf(values: Readonly<Record<string, string>>): EnvLookup {
  return {
    get: (name: string) => {
      const value = values[name]
      return value === undefined || value === '' ? undefined : { value }
    },
  }
}

/**
 * 把 Chromium `resolveProxy` 的结果翻译成 Node 侧代理 URL。
 *
 * 结果形如 `DIRECT` / `PROXY host:port` / `HTTPS host:port` / `SOCKS5 host:port`，
 * 回退链以 `;` 分隔（取首项）。
 *
 * @param raw Chromium 的原始返回串。
 * @returns 代理 URL；`DIRECT` 返回 null；上游不支持的 scheme 返回 'unsupported'。
 */
function proxyUrlOfResolved(raw: string): string | null | 'unsupported' {
  const first = raw.split(';')[0]?.trim() ?? ''
  if (first === '' || first.toUpperCase() === 'DIRECT') return null
  const [kind, authority] = first.split(/\s+/)
  if (kind === undefined || authority === undefined) return 'unsupported'
  const upper = kind.toUpperCase()
  if (upper === 'PROXY') return `http://${authority}`
  if (upper === 'HTTPS') return `https://${authority}`
  return 'unsupported'
}

/**
 * 取系统代理（Chromium 解析优先 → 进程环境变量回落）。
 *
 * @returns 环境变量名 → 代理 URL；未取得任何代理时为空对象。
 */
async function systemProxyEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  for (const [name, sample] of SYSTEM_SAMPLES) {
    let resolved = ''
    try {
      resolved = await session.defaultSession.resolveProxy(sample)
    } catch (error) {
      log.warn(`${TAG} [node] 系统代理解析失败（${name}）:`, error)
    }
    const url = proxyUrlOfResolved(resolved)
    if (url === 'unsupported') {
      log.warn(
        `${TAG} [node] 系统代理 "${resolved}" 不是 http(s) 代理，上游不支持 → Node 侧 ${name} 直连`,
      )
      continue
    }
    if (url !== null) {
      env[name] = url
      continue
    }
    // 系统代理判为直连时回落进程环境变量（从终端带 HTTPS_PROXY 启动的场景）
    const inherited = (process.env[name] ?? process.env[name.toUpperCase()] ?? '').trim()
    if (inherited !== '') env[name] = inherited
  }
  return env
}

/**
 * 安装（或释放）Node 侧出口策略。
 *
 * @param mode 代理模式（direct / system / manual）。
 * @param manualProxyUrl 手动模式已解析好的代理 URL（非 manual 忽略；SOCKS/非法传 null）。
 */
export async function applyNodeProxy(mode: ProxyMode, manualProxyUrl: string | null): Promise<void> {
  const previous = nodeProxyDispose
  nodeProxyDispose = null
  if (previous !== null) await previous()

  if (mode === 'direct') return

  let env: Record<string, string>
  if (mode === 'system') {
    env = await systemProxyEnv()
  } else {
    if (manualProxyUrl === null) {
      log.warn(
        `${TAG} [node] 手动地址不含 http(s) 代理，Node 侧出口保持直连` +
          '（web_fetch / web_search / 模型请求不走代理）',
      )
      return
    }
    env = { http_proxy: manualProxyUrl, https_proxy: manualProxyUrl }
  }

  if (Object.keys(env).length === 0) {
    log.warn(`${TAG} [node] 未取得可用代理，Node 侧出口保持直连`)
    return
  }

  try {
    const { installProxyFromEnvironment } = await import('@deepseek-ai/dsh-http-proxy')
    nodeProxyDispose = await installProxyFromEnvironment(envLookupOf(env), (message) =>
      log.warn(`${TAG} [node] ${message}`),
    )
    log.ok(`${TAG} [node] undici 出口策略已安装: ${mode} (${Object.values(env).join(', ')})`)
  } catch (error) {
    log.warn(`${TAG} [node] 出口策略安装失败，Node 侧保持直连:`, error)
  }
}
