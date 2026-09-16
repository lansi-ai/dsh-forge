/**
 * dsh-forge 外部插件装载层（ADR-004「bundle 即分发的分发面」的落地）。
 *
 * 背景：上游 `boot()` 本身**不读 profile** —— `loadProfile` 是调用方的职责
 * （`dsh-app-boot` 只在 CLI 里接），而 dsh-forge 过去直传自写补丁栈，于是
 * `$DSH_HOME/profiles/dsh-forge/cordis.patch.yml` 这层被整个跳过了。本模块把
 * 这一层接回来，让插件**装了就生效、不装零影响**。
 *
 * 两个刻意的取舍：
 *
 * 1. **发现与作用分离**。本模块的扫描是**同步**的（`yaml.parse` 只读行，求
 *    「哪些裸名是外部包」），因为客户端图谱在页面加载时同步生成；而**补丁解析
 *    与作用**交给 boot.ts 里的官方 `loadOverlayPatches`（异步），保证 `!!js`
 *    与相对路径锚定等语义与上游逐字一致。
 *
 * 2. **解析不了就不装，绝不连坐**。外部插件以**绝对路径**声明给 Loader（见
 *    `plugin-package.ts` 的说明），并且在插入前先做体检；装坏的插件只会被
 *    跳过并留下可操作的告警，不会让整个应用起不来。
 *
 * 零回归：profile 目录不存在、且没有任何外部包时，补丁栈与从前完全相同。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { resolveDshHome } from './forge-home-paths.js'
import { log } from './log.js'
import { locateExternalPackage, inspectExternalPackage, type ExternalPackage } from './plugin-package.js'
import { ensurePeerSupply, unimportablePlugins } from './peer-fallback.js'
import type { BootBundleDecl } from './boot-graph.js'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include' with { 'resolution-mode': 'import' }

const PROFILE_NAME = 'dsh-forge'
/** 用户补丁层文件名（plugin-install.ts 的卸载/装源登记复用，防命名漂移）。 */
export const PATCH_FILENAME = 'cordis.patch.yml'

/** profile 骨架：应用自有的 profile 目录（bundles 留空，用户层即装载点）。 */
const PROFILE_MANIFEST = {
  name: 'dsh-forge-profile',
  version: '0.0.0',
  private: true,
  dsh: { profile: { bundles: [], patchReload: 'startup' } },
}

/** 用户补丁层模板（首次初始化时写出；`--install-plugin` 也用它保证首次内容一致）。 */
export const PROFILE_PATCH_TEMPLATE = `# dsh-forge 外部插件装载点（用户补丁层，在每个 bundle 层之后应用）。
#
# 往这里加一行 insert，外部插件就会被装载；删掉这一行即卸载。文件为空或只剩
# 注释会导致启动失败，要停用本层就写 []。
#
# 示例（把插件包放到同级的 ../node_modules/<包名>/，或按需改成绝对路径）：
#
# - insert:
#     - id: llm-app-credentials
#       name: dsh-llm-app-credentials
#
# 裸名会从 $DSH_HOME/profiles/node_modules 解析；也可以直接写绝对路径或相对本
# 文件的相对路径（后者由上游自动锚定）。
[]
`

/** 解析出的 forge profile 事实。 */
export interface ForgeProfile {
  /** profile 目录绝对路径。 */
  readonly dir: string
  /** 用户补丁层文件绝对路径。 */
  readonly patchPath: string
  /** 需要按应用顺序加载的补丁文件（各 bundle 层在前，用户层在末）。 */
  readonly patchFiles: readonly string[]
  /** 体检通过的外部包。 */
  readonly packages: readonly ExternalPackage[]
  /** 裸包名 → 入口绝对路径。 */
  readonly entryByName: ReadonlyMap<string, string>
}

/**
 * 解析（并按需初始化）forge 的应用自有 profile。
 *
 * @returns profile 事实；任何一步失败都降级为「没有外部插件」，不抛。
 */
export function resolveForgeProfile(): ForgeProfile {
  const root = join(resolveDshHome(), 'profiles')
  const dir = join(root, PROFILE_NAME)
  const patchPath = join(dir, PATCH_FILENAME)
  try {
    ensureProfileSkeleton(dir, patchPath)
  } catch (error) {
    log.warn('[dsh-profile] profile 目录初始化失败，外部插件装载已停用:', error)
    return { dir, patchPath, patchFiles: [], packages: [], entryByName: new Map() }
  }
  const patchFiles = collectPatchFiles(dir, patchPath)
  const packages = discoverPackages(patchFiles, root, dir)
  return { dir, patchPath, patchFiles, packages, entryByName: new Map(packages.map((one) => [one.name, one.entry])) }
}

/**
 * 进程级缓存的 profile 事实。
 *
 * boot 路径上有多处消费者（补丁栈、客户端图谱、插件清单），而扫描要读盘并做
 * 包解析；缓存把开销压到每次进程一次。**新装插件需要重启应用**才生效——这与
 * 「图谱在页面加载时重建」并不矛盾：那是已装载包的 bundle 重新计算 rev，不是
 * 重新发现外部包。
 */
let cachedProfile: ForgeProfile | undefined

/** 取（并缓存）forge 的应用自有 profile 事实。 */
export function forgeProfile(): ForgeProfile {
  cachedProfile ??= resolveForgeProfile()
  return cachedProfile
}

/**
 * 外部包声明的浏览器半（供客户端图谱装载）。
 *
 * 装载前自检失败的包要一并剔除：图谱在页面加载时重建（晚于 boot 的自检），不剔
 * 就会留下"设置页在、宿主半没装"的半截状态。
 */
export function externalClientDecls(profile: ForgeProfile): BootBundleDecl[] {
  const broken = unimportablePlugins()
  const decls: BootBundleDecl[] = []
  for (const pkg of profile.packages) {
    if (pkg.client !== undefined && !broken.has(pkg.name)) decls.push(pkg.client)
  }
  return decls
}

/**
 * 就地改写补丁里插入行的裸包名为入口绝对路径。
 *
 * 只改写 `insert` 数组：`{ id, name, config }` 形式的覆盖补丁里 `name` 是
 * **匹配条件**，改写它会直接让该补丁失效。
 *
 * @returns 被改写的行数（供启动日志展示）。
 */
export function rewriteInsertNames(patches: readonly PatchOptions[], profile: ForgeProfile): number {
  if (profile.entryByName.size === 0) return 0
  let rewritten = 0
  for (const patch of patches as LoosePatch[]) {
    if (!Array.isArray(patch.insert)) continue
    for (const entry of patch.insert as LooseEntry[]) {
      if (typeof entry.name !== 'string') continue
      const entryPath = profile.entryByName.get(entry.name)
      if (entryPath === undefined) continue
      entry.name = entryPath
      rewritten += 1
    }
  }
  return rewritten
}

/**
 * 删掉指定裸包名的插入行（装载前自检失败的插件 = 等同没装）。
 *
 * 与 `rewriteInsertNames` 分工：后者把**可装载**的裸名换成入口绝对路径，本函数把
 * **不可装载**的行摘掉。少了这一步，那行裸名会落到上游 Loader 手里——它解析不到，
 * 而 `assertEntriesActivated` 对任一未激活条目都回滚整棵树，应用直接起不来。
 *
 * 只动 `insert`：覆盖补丁里的 `name` 是匹配条件，删它会误伤别的行。
 *
 * @param patches - 已加载的补丁层。
 * @param names - 要摘除的裸包名。
 * @returns 被删除的行数（供启动日志展示）。
 */
export function dropInsertRowsByName(patches: readonly PatchOptions[], names: ReadonlySet<string>): number {
  if (names.size === 0) return 0
  let dropped = 0
  for (const patch of patches as LoosePatch[]) {
    if (!Array.isArray(patch.insert)) continue
    patch.insert = (patch.insert as LooseEntry[]).filter((entry) => {
      const matched = typeof entry.name === 'string' && names.has(entry.name)
      if (matched) dropped += 1
      return !matched
    })
  }
  return dropped
}

// ── 骨架 ───────────────────────────────────────────────────────────────────

/** 建目录 + 最小清单 + 补丁模板（缺什么补什么，已存在一律不碰）。 */
function ensureProfileSkeleton(dir: string, patchPath: string): void {
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, `${JSON.stringify(PROFILE_MANIFEST, null, 2)}\n`, 'utf8')
    log.info(`[dsh-profile] 已创建外部插件 profile 清单：${manifestPath}`)
  }
  if (!existsSync(patchPath)) {
    writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE, 'utf8')
    log.ok(`[dsh-profile] 已创建外部插件装载点：${patchPath}`)
  }
}

// ── 补丁文件收集 ───────────────────────────────────────────────────────────

/** 各 bundle 层在前、用户层在末（与上游 profile 的层序一致）。 */
function collectPatchFiles(dir: string, patchPath: string): string[] {
  const files: string[] = []
  for (const bundle of profileBundles(dir)) {
    const patch = bundlePatchFile(bundle, dir)
    if (patch === undefined) continue
    files.push(patch)
  }
  if (existsSync(patchPath)) files.push(patchPath)
  return files
}

/** 读 profile 清单里的 `dsh.profile.bundles`（读不到就当作空）。 */
function profileBundles(dir: string): string[] {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const bundles = (manifest as { dsh?: { profile?: { bundles?: unknown } } })?.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles.filter((one): one is string => typeof one === 'string') : []
  } catch {
    return []
  }
}

/** 解析一个 bundle 的补丁文件；解析不到就告警跳过（不阻断其它层）。 */
function bundlePatchFile(bundle: string, dir: string): string | undefined {
  for (const anchor of [dir, __dirname]) {
    try {
      const pkgJson = createRequire(join(anchor, '__forge_bundle__.cjs')).resolve(`${bundle}/package.json`)
      const pkgDir = dirname(pkgJson)
      const manifest: unknown = JSON.parse(readFileSync(pkgJson, 'utf8'))
      const declared = (manifest as { dsh?: { bundle?: { patch?: unknown } } })?.dsh?.bundle?.patch
      if (typeof declared !== 'string') continue
      const patch = resolve(pkgDir, declared)
      if (existsSync(patch)) return patch
    } catch {
      /* 换下一个锚点 */
    }
  }
  log.warn(`[dsh-profile] bundle ${bundle} 的补丁文件解析失败，已跳过该层`)
  return undefined
}

// ── 外部包发现 ─────────────────────────────────────────────────────────────

/** 扫描各补丁层的 insert 行，挑出「应用自身解析不到」的裸包名，先供给 peer 再逐个体检。 */
function discoverPackages(
  patchFiles: readonly string[],
  profilesRoot: string,
  profileDir: string,
): ExternalPackage[] {
  const candidates = new Set<string>()
  for (const file of patchFiles) {
    for (const name of insertedNames(file)) {
      if (!isAppResolvable(name)) candidates.add(name)
    }
  }
  const packages: ExternalPackage[] = []
  for (const name of [...candidates].sort()) {
    const located = locateExternalPackage(name, profilesRoot, profileDir)
    if (located === undefined) {
      log.warn(`[dsh-profile] 外部插件 ${name} 不可装载，已跳过：两个装载锚点都解析不到`)
      continue
    }
    // 供给必须排在体检之前：体检把"peer 解析不到"直接判死，而供给正是补这一步。
    ensurePeerSupply(located)
    const verdict = inspectExternalPackage(name, profilesRoot, profileDir)
    if (verdict.ok) {
      packages.push(verdict.pkg)
      log.ok(`[dsh-profile] 外部插件已装载：${name} (${verdict.pkg.dir})`)
    } else {
      log.warn(`[dsh-profile] 外部插件 ${name} 不可装载，已跳过：${verdict.reason}`)
    }
  }
  return packages
}

/** 一个补丁文件里出现过的裸包名（解析失败即返回空集，绝不抛）。 */
function insertedNames(file: string): string[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    // 只读行，不求值：`!!js` 在这里是普通字符串（上游负责真正的求值）。
    parsed = parseYaml(text, { logLevel: 'silent' })
  } catch {
    log.warn(`[dsh-profile] ${file} 解析失败，其中的外部插件浏览器半将不可见`)
    return []
  }
  if (!Array.isArray(parsed)) return []
  const names: string[] = []
  for (const patch of parsed as LoosePatch[]) {
    if (!Array.isArray(patch.insert)) continue
    for (const entry of patch.insert as LooseEntry[]) {
      if (typeof entry.name === 'string' && isBareSpecifier(entry.name)) names.push(entry.name)
    }
  }
  return names
}

/** 裸 specifier：既不是绝对路径，也不是相对路径，也不是 file:// URL。 */
function isBareSpecifier(name: string): boolean {
  if (name.length === 0) return false
  if (name.startsWith('.') || name.startsWith('file:')) return false
  return !isAbsolute(name)
}

/** 应用自身（含 asar 内的 node_modules）能否解析该包 —— 能则不需要外部装载。 */
function isAppResolvable(name: string): boolean {
  try {
    createRequire(__filename).resolve(name)
    return true
  } catch {
    return false
  }
}

/** 行走补丁用的宽松结构（补丁解析已由上游保证，这里只读形状）。 */
interface LooseEntry {
  name?: unknown
  [key: string]: unknown
}
interface LoosePatch {
  insert?: unknown
  [key: string]: unknown
}
