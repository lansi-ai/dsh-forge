/**
 * 外部插件包的解析与体检（dsh-forge 装载层的第一级）。
 *
 * 一个「外部插件包」= 不在应用自身 node_modules 里、由用户装到
 * `$DSH_HOME/profiles/node_modules` 的 DSH 插件包。本模块只回答三件事：
 *   1. 它在哪里（入口文件 + 包目录）；
 *   2. 它声明的 peer 依赖此刻能不能解析 —— **不能就判为不可装载**；
 *   3. 它有没有浏览器半（`dsh.client` + `exports["./client"]`）。
 *
 * 第 2 条是安全阀：Loader 的 `assertEntriesActivated` 对**任一**未激活条目都会
 * 抛错并回滚整棵树，所以一个装坏的外部插件足以让应用起不来。这里在装载前
 * 先判定，装坏 = 跳过 + 响亮告警，**绝不连坐主程序**。
 *
 * 本模块不依赖 Electron，也不 import 任何官方运行时（只读 package.json），
 * 因此可在沙箱内单独验证。
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { BootBundleDecl } from './boot-graph.js'

/** 一个可装载外部包的完整事实。 */
export interface ExternalPackage {
  /** 包名（patch 行里写的裸 specifier）。 */
  readonly name: string
  /** 包目录绝对路径。 */
  readonly dir: string
  /** 入口文件绝对路径（插入行的 `name` 会被改写成它）。 */
  readonly entry: string
  /** 浏览器半声明；包没声明 `dsh.client` 时为 undefined。 */
  readonly client: BootBundleDecl | undefined
}

/** 体检结果：可装载，或携带原因被判为不可装载。 */
export type PackageVerdict =
  | { readonly ok: true; readonly pkg: ExternalPackage }
  | { readonly ok: false; readonly reason: string }

/** 包清单中本模块关心的字段。 */
interface PackageManifest {
  name?: unknown
  version?: unknown
  main?: unknown
  exports?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
  dsh?: { client?: { platform?: unknown; inject?: unknown; external?: unknown; immediately?: unknown } }
}

/**
 * 解析并体检一个外部包。
 *
 * @param name - patch 行里写的裸包名。
 * @param profilesRoot - `$DSH_HOME/profiles` 目录（其下的 `node_modules` 是外部包的安装位置）。
 * @returns 体检结论；不可装载时 `reason` 即告警正文。
 */
export function inspectExternalPackage(name: string, profilesRoot: string): PackageVerdict {
  const profilesModules = join(profilesRoot, 'node_modules')
  const resolveFromProfiles = createRequire(join(profilesModules, '__forge_resolve__.cjs'))

  let entry: string
  try {
    entry = resolveFromProfiles.resolve(name)
  } catch (error) {
    return { ok: false, reason: `解析不到入口（${summarize(error)}）` }
  }
  const dir = packageDirOf(name, entry, profilesModules)
  const manifest = readManifest(dir)
  if (manifest === undefined) return { ok: false, reason: `读不到 ${join(dir, 'package.json')}` }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    return { ok: false, reason: 'package.json 未声明非空 version' }
  }

  const unresolvedPeers = unresolvedPeersOf(manifest, dir)
  if (unresolvedPeers.length > 0) {
    return {
      ok: false,
      reason:
        `peer 依赖无法从该包自身位置解析：${unresolvedPeers.join(', ')}。` +
        `先在本插件目录里执行 node scripts/link-peers.cjs --forge <dsh-forge 目录>，` +
        `或把它装到 ${profilesModules} 并保证宿主的依赖闭包也在那里。`,
    }
  }

  return { ok: true, pkg: { name, dir, entry, client: clientDeclOf(name, dir, manifest) } }
}

/** 找包目录：优先 `exports["./package.json"]`，否则从入口向上找到最近的 package.json。 */
function packageDirOf(name: string, entry: string, profilesModules: string): string {
  try {
    return dirname(createRequire(join(profilesModules, '__forge_resolve__.cjs')).resolve(`${name}/package.json`))
  } catch {
    /* 未导出 ./package.json：按入口向上找 */
  }
  let current = dirname(entry)
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirname(entry)
}

/** 读一个包的清单；不可解析时返回 undefined（调用方给出可读告警）。 */
function readManifest(dir: string): PackageManifest | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as PackageManifest) : undefined
  } catch {
    return undefined
  }
}

/**
 * 列出从该包自身位置解析不到的 peer 依赖。
 *
 * 判定语义与 Node 一致（从包目录向上找 node_modules），所以检出即等价于
 * 「Loader 加载这个包时必然失败」。整包不可用时不逐个列举——那是另一个故障。
 */
function unresolvedPeersOf(manifest: PackageManifest, dir: string): string[] {
  const peers = Object.keys(manifest.peerDependencies ?? {})
  if (peers.length === 0) return []
  const probe = createRequire(join(dir, '__forge_peer_probe__.cjs'))
  const missing: string[] = []
  for (const peer of peers) {
    try {
      probe.resolve(peer)
    } catch {
      missing.push(peer)
    }
  }
  return missing
}

/** 读包的浏览器半声明（`dsh.client.platform === 'web'` + `exports["./client"]`）。 */
function clientDeclOf(name: string, dir: string, manifest: PackageManifest): BootBundleDecl | undefined {
  const decl = manifest.dsh?.client
  if (decl === undefined || decl.platform !== 'web') return undefined
  const clientRel = clientExportOf(manifest)
  if (clientRel === undefined) return undefined
  const clientPath = join(dir, clientRel)
  if (!existsSync(clientPath)) return undefined
  return {
    id: name,
    path: clientPath,
    ...(Array.isArray(decl.inject) ? { inject: decl.inject.filter((one): one is string => typeof one === 'string') } : {}),
    ...(Array.isArray(decl.external)
      ? { external: decl.external.filter((one): one is string => typeof one === 'string') }
      : {}),
    ...(decl.immediately === true ? { immediately: true } : {}),
  }
}

/** 解析 `exports["./client"]` 的相对产物路径（接受字符串与一层条件形式）。 */
function clientExportOf(manifest: PackageManifest): string | undefined {
  const client = manifest.exports?.['./client']
  if (typeof client === 'string') return client
  if (client !== null && typeof client === 'object') {
    const fallback = (client as { default?: unknown }).default
    if (typeof fallback === 'string') return fallback
  }
  return undefined
}

/** 把异常压成一行短句，供告警正文使用。 */
function summarize(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return error instanceof Error ? error.message : String(error)
}
