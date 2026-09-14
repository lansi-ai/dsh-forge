/**
 * 外部插件的 peer 供给层（dsh-forge 自建，取代插件侧的 `link-peers.cjs`）。
 *
 * 为什么需要：外部插件的 `import '@deepseek-ai/dsh-llm'` 由 **Node 自己**解析
 * ——从该文件的**真实路径**向上找 node_modules，上游不为插件改写 import。官方
 * dsh 因此每次启动都把安装依赖闭包投影到 `$DSH_HOME/profiles/node_modules`
 * （`dsh-app-boot` 的 `healProfilesModuleFallback`：普通 Node 写 symlink、pkg
 * 打包写 ESM 代理），插件于是天然解析得到，且拿到的是**宿主那份模块实例**。
 *
 * forge 是 Electron + asar，符号链接穿不进 asar，所以这里照官方「代理包」的形态
 * 自建供给，落点在**插件自己的目录**内（`<插件目录>/node_modules/<peer>`）——
 * 这个位置在 Node 的上溯链上，且对"链接形态的插件"（真实路径在别处）同样成立：
 *   - 开发态（宿主模块是真实目录）：junction 指向宿主的 node_modules；
 *   - 打包态（宿主模块在 asar 内）：真目录 + `entry-0.js`，`export *` 宿主文件的
 *     file URL —— re-export 保留绑定，插件拿到的仍是**宿主同一份实例**。
 *
 * 三条纪律：
 *   1. **只在缺失时创建**：插件自带的依赖副本、用户跑过的 `link-peers`、官方投影
 *      层一律不动（"修好别人写坏的东西"是另一个故障，不在本模块职责内）。
 *   2. **只供给插件直接声明的 peer / dependency**：被供给包自己的传递依赖从它的
 *      位置（打包态即 asar 内）解析，本来就能找到，不必复制整棵闭包。
 *   3. **绝不抛**：失败只告警并计入 `failed`，由调用方判该插件不可装载 —— 宁可这
 *      个插件不生效，也不让上游 Loader 回滚整棵树。
 *
 * 本模块不依赖 Electron（打包与否由"宿主模块路径是否含 `.asar`"直接判定），
 * 因此可在沙箱内用纯 Node 验证。
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { log } from './log.js'
import { packageDirFromEntry, summarizeError } from './plugin-package.js'

/** 以应用自身为锚点解析宿主包（打包态走 asar 路径：Electron 主进程的 require.resolve 支持）。 */
const appRequire = createRequire(__filename)

/** 供给目标：一个已定位的外部插件包。 */
export interface PeerTarget {
  /** 包名。 */
  readonly name: string
  /** 包目录绝对路径（供给写在它下面的 `node_modules/`）。 */
  readonly dir: string
}

/** 一次供给的结果（供日志与"可否装载"判定）。 */
export interface PeerSupplyResult {
  /** 本次新建的 peer 名。 */
  readonly created: readonly string[]
  /** 已存在（插件自带 / 用户链接 / 官方投影）而跳过的 peer 名。 */
  readonly skipped: readonly string[]
  /** 供给失败的 peer 名（宿主也解析不到，或写盘失败）。 */
  readonly failed: readonly string[]
}

/**
 * 为外部插件补齐缺失的 peer / dependency。
 *
 * @param target - 已定位的外部插件包。
 * @returns 供给明细；任何失败都不抛。
 */
export function ensurePeerSupply(target: PeerTarget): PeerSupplyResult {
  const manifest = readPackageJson(target.dir)
  if (manifest === undefined) {
    log.warn(`[dsh-peer] ${target.name} 读不到 package.json，peer 供给已跳过`)
    return { created: [], skipped: [], failed: [] }
  }
  const created: string[] = []
  const skipped: string[] = []
  const failed: string[] = []
  for (const name of neededPeerNames(manifest)) {
    const verdict = supplyOne(name, join(target.dir, 'node_modules', name))
    if (verdict === 'created') created.push(name)
    else if (verdict === 'skipped') skipped.push(name)
    else failed.push(name)
  }
  if (created.length > 0) {
    log.ok(`[dsh-peer] 已为 ${target.name} 供给 ${String(created.length)} 个 peer：${created.join(', ')}`)
  }
  return { created, skipped, failed }
}

/** 供给形态：链接（宿主是真实目录）或 ESM 代理（宿主在 asar 内）。 */
export type SupplyForm = 'junction' | 'proxy'

/**
 * 由宿主模块的解析路径判定该用什么形态——判据是路径里有没有 `.asar`。
 *
 * 这条判据是自证的：只有打包态 Electron 才会把宿主模块解析到 asar 内，而不需要
 * 反过来依赖 electron 的 `app.isPackaged`（本模块因此能在纯 Node 下验证）。
 *
 * @param hostEntry - 宿主自己那份包的入口绝对路径。
 * @returns 供给形态。
 */
export function supplyFormOf(hostEntry: string): SupplyForm {
  return hostEntry.includes('.asar') ? 'proxy' : 'junction'
}

/**
 * 生成 ESM 代理的入口源码。
 *
 * 命名导出走 `export *`（保留绑定，插件拿到的是宿主同一份实例）；默认导出必须经
 * 命名空间取值——直接写 `export { default }` 会在目标没有 default 时报链接错误，
 * 而这条错误发生在**装载期**，会连累整棵树（官方代理用的是同一条写法）。
 *
 * @param target - 目标模块的绝对文件路径。
 * @returns `entry-0.js` 的源码。
 */
export function proxyEntrySource(target: string): string {
  const specifier = JSON.stringify(pathToFileURL(target).href)
  return `export * from ${specifier}\nimport * as target from ${specifier}\nexport default target.default\n`
}

/** 供给一个 peer（幂等；返回本次动作）。 */
function supplyOne(name: string, link: string): 'created' | 'skipped' | 'failed' {
  const host = resolveHostPackage(name)
  if (host === undefined) {
    log.warn(`[dsh-peer] 宿主解析不到 ${name}，无法为外部插件供给该 peer`)
    return 'failed'
  }
  const ownTarget = ownProxyTarget(link)
  if (ownTarget !== undefined) {
    // 本模块上一轮写的代理：目标没变就复用，变了（宿主换位置/换版本）就重写。
    if (ownTarget === pathToFileURL(host.esmEntry).href) return 'skipped'
    try {
      rmSync(link, { recursive: true, force: true })
    } catch (error) {
      log.warn(`[dsh-peer] 旧供给清理失败（${name}）：${summarizeError(error)}`)
      return 'failed'
    }
  } else if (existsAt(link)) {
    return 'skipped'
  }
  try {
    mkdirSync(dirname(link), { recursive: true })
    if (host.form === 'proxy') writeProxy(name, link, host.esmEntry)
    else symlinkSync(host.dir, link, 'junction')
    return 'created'
  } catch (error) {
    log.warn(`[dsh-peer] 供给 ${name} 失败：${summarizeError(error)}`)
    return 'failed'
  }
}

/** 宿主自己那份包的位置与形态。 */
interface HostPackage {
  /** 包目录（junction 形态指向它）。 */
  readonly dir: string
  /** ESM import 条件下解析到的入口文件（代理形态 re-export 它）。 */
  readonly esmEntry: string
  /** 供给形态。 */
  readonly form: SupplyForm
}

/** 解析宿主自己的包；宿主也没有时返回 undefined（该 peer 无法供给）。 */
function resolveHostPackage(name: string): HostPackage | undefined {
  try {
    const entry = appRequire.resolve(name)
    const dir = packageDirFromEntry(entry)
    return { dir, esmEntry: esmEntryOf(dir) ?? entry, form: supplyFormOf(entry) }
  } catch (error) {
    log.warn(`[dsh-peer] 宿主解析 ${name} 失败：${summarizeError(error)}`)
    return undefined
  }
}

/** 写一个 ESM 代理包（形态与官方 `healProfilesModuleFallback` 的 pkg 代理一致）。 */
function writeProxy(name: string, link: string, target: string): void {
  const manifest = {
    name,
    version: '0.0.0',
    private: true,
    type: 'module',
    exports: { '.': './entry-0.js' },
    dsh: { peerFallback: { target: pathToFileURL(target).href } },
  }
  mkdirSync(link, { recursive: true })
  writeFileSync(join(link, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
  writeFileSync(join(link, 'entry-0.js'), proxyEntrySource(target), 'utf8')
}

/** 读本模块写的代理的 re-export 目标（不是本模块写的返回 undefined）。 */
function ownProxyTarget(link: string): string | undefined {
  const manifest = readPackageJson(link)
  const target = (manifest?.dsh as { peerFallback?: { target?: unknown } } | undefined)?.peerFallback?.target
  return typeof target === 'string' ? target : undefined
}

/** 需要供给的包名：插件直接声明的 peer + 运行期依赖。 */
function neededPeerNames(manifest: Record<string, unknown>): string[] {
  const declared = [...keysOf(manifest.peerDependencies), ...keysOf(manifest.dependencies)]
  return [...new Set(declared)].sort()
}

/** 取一个清单字段的键名（非对象即空）。 */
function keysOf(value: unknown): string[] {
  return value !== null && typeof value === 'object' ? Object.keys(value as Record<string, unknown>) : []
}

/** 取包在 ESM import 条件下解析到的入口文件。 */
function esmEntryOf(dir: string): string | undefined {
  const manifest = readPackageJson(dir)
  if (manifest === undefined) return undefined
  const relative =
    pickCondition(manifest.exports !== null && typeof manifest.exports === 'object' ? underRoot(manifest.exports) : manifest.exports) ??
    pickString(manifest.module) ??
    pickString(manifest.main)
  if (relative === undefined) return undefined
  const file = resolve(dir, relative)
  return existsSync(file) ? file : undefined
}

/** 取 `exports` 的根条件（`.` 子路径优先，否则整体当一个条件树）。 */
function underRoot(exportsField: object): unknown {
  const record = exportsField as Record<string, unknown>
  return record['.'] ?? exportsField
}

/** 在条件树里挑相对路径（import → node → default；只认 `./` 开头的包内路径）。 */
function pickCondition(node: unknown): string | undefined {
  if (typeof node === 'string') return node.startsWith('.') ? node : undefined
  if (node === null || typeof node !== 'object') return undefined
  const record = node as Record<string, unknown>
  for (const key of ['import', 'node', 'default']) {
    const chosen = pickCondition(record[key])
    if (chosen !== undefined) return chosen
  }
  return undefined
}

/** 字符串字段的取值（非字符串即 undefined）。 */
function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 读一个目录下的 package.json（读不到返回 undefined）。 */
function readPackageJson(dir: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** `lstat` 探在（不穿过链接本身；仅用于判"位置上有没有东西"）。 */
function existsAt(link: string): boolean {
  try {
    lstatSync(link)
    return true
  } catch {
    return false
  }
}

/** 自检失败的入口（进程内缓存；客户端图谱据此剔除其浏览器半）。 */
const unimportable = new Set<string>()

/**
 * 装载前自检一次入口（真实 `import`）。
 *
 * 体检只证明 peer **名字能解析**，证明不了"代理真的能被 import"——打包态那是
 * 跨 asar 的 re-export，只有真跑一次才知道。失败即记入 `unimportable`，调用方
 * 据此删掉该插件的插入行（等同没装），绝不交给 Loader 去回滚整棵树。
 *
 * @param pkg - 已体检通过的外部包。
 * @returns 该插件此刻可否装载。
 */
export async function probeExternalEntry(pkg: { readonly name: string; readonly entry: string }): Promise<boolean> {
  try {
    const module: unknown = await import(pathToFileURL(pkg.entry).href)
    if (module === null || typeof module !== 'object' || typeof (module as { apply?: unknown }).apply !== 'function') {
      log.warn(`[dsh-peer] 外部插件 ${pkg.name} 的入口未导出 apply，已跳过`)
      unimportable.add(pkg.name)
      return false
    }
    return true
  } catch (error) {
    log.warn(`[dsh-peer] 外部插件 ${pkg.name} 装载前自检失败，已跳过：${summarizeError(error)}`)
    unimportable.add(pkg.name)
    return false
  }
}

/** 自检失败的包名（同步查询；图谱侧用它剔除浏览器半，避免"页面有、宿主没有"）。 */
export function unimportablePlugins(): ReadonlySet<string> {
  return unimportable
}
