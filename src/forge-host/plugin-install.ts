/**
 * 外部插件的一键安装（`--install-plugin <spec>`）。
 *
 * 这是官方 `dsh plugin --profile <p> add github:owner/repo` 在 forge 上的等价入口，
 * 但**零外部依赖**：下载、解包、落位、写装载行全在宿主进程内完成——用户的机器上
 * 不需要 Node、pnpm，也不需要官方 `dsh` CLI（那三样恰恰是照抄官方命令装不上的原因）。
 *
 * 支持的 spec：
 *   - `github:<owner>/<repo>`       —— 经 GitHub API 取默认分支（限流时回退探测 main/master），
 *                                      再从 codeload 拉 tar.gz；
 *   - `github:<owner>/<repo>@<ref>` —— 直取指定分支 / 标签 / 提交；
 *   - 本地目录路径                   —— 旁加载（开发、离线分发）。
 *
 * 落位与装载语义与插件仓的 `scripts/install-forge.cjs` 完全一致：
 *   1. 包目录放 `$DSH_HOME/profiles/node_modules/<包名>`（装载层的主锚点）；
 *   2. 在 `$DSH_HOME/profiles/dsh-forge/cordis.patch.yml` 追加一行 insert —— 幂等，
 *      且判定只看**生效行**（注释与模板是假阳性高发区，坑 64）；
 *   3. peer 由装载层自动供给（`peer-fallback.ts`），所以包内不需要 node_modules。
 *
 * 安装发生在 boot **之前**，所以装完本次启动即可用，不必再重启一次。
 *
 * **管理面（M6-P6 之后补齐 · 插件列表操作）**：本模块同时承载三个 UI 动作的
 * 宿主半——
 *   - 安装来源登记（`installed-sources.json`）：每次安装落一条
 *     `{ spec, sourceKind, version, installedAt }`，供「检查更新/重装」对照来源；
 *   - 卸载（`uninstallExternalPlugin`）：删补丁行 + 删包目录 + 删登记；
 *   - 检查更新 / 应用更新（`checkPluginUpdate` / `updateExternalPlugin`）：github
 *     来源对照**默认分支**的 package.json 版本（轻量比较，无 semver 依赖），
 *     更新 = 重装默认分支（忽略登记里的固定 ref）。
 * 运行中实例无法热装载插件树（外部插件只在进程启动时发现），故安装/卸载/更新
 * 成功后均由 UI 提示「重启后生效」——这些动作改的是磁盘，不改已挂载的树。
 *
 * 安全：归档来自网络，所有路径先过 `safeRelative()`（拒绝绝对路径、盘符、`..`），
 * 包名过 `isSafePackageName()`（拒绝 `..` 与 Windows 保留字符），落点被链接占用时
 * 直接拒绝而不是覆盖；卸载的删除同样拒绝链接与穿越。
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { log } from './log.js'
import { summarizeError } from './plugin-package.js'
import { PATCH_FILENAME, PROFILE_PATCH_TEMPLATE } from './profile-plugins.js'

/** 一次安装的结果（供启动横幅与失败诊断）。 */
export interface PluginInstallResult {
  /** 包名（取自插件自己的 package.json）。 */
  readonly name: string
  /** 版本。 */
  readonly version: string
  /** 落位后的包目录。 */
  readonly dir: string
  /** 本次是否新写了装载行（false = 补丁层里本来就有）。 */
  readonly rowAdded: boolean
  /** 来源描述（日志用）。 */
  readonly source: string
}

/** 归档里的一个文件（路径已剥离 GitHub 自带的顶层目录，恒为 POSIX 相对路径）。 */
export interface ArchiveEntry {
  readonly path: string
  readonly data: Buffer
}

/** 安装来源。 */
type Source =
  | { readonly kind: 'github'; readonly url: string; readonly label: string }
  | { readonly kind: 'dir'; readonly path: string; readonly label: string }

/** 插件清单中本模块关心的字段。 */
interface PluginManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly dsh?: unknown
}

/**
 * 安装一个外部插件。
 *
 * @param spec - `github:owner/repo[@ref]` 或本地目录路径。
 * @param home - `$DSH_HOME`。
 * @returns 安装结果。
 * @throws 来源无法识别、下载失败、包不合法、落点被链接占用时抛出（调用方负责提示）。
 */
export async function installExternalPlugin(spec: string, home: string): Promise<PluginInstallResult> {
  const source = await resolveSource(spec)
  if (source.kind === 'github') log.info(`[dsh-install] 正在下载 ${source.label} …`)
  const files = source.kind === 'github' ? extractTarGz(await download(source.url)) : readTree(source.path)
  const manifest = readManifestOf(files)
  const name = manifest.name
  if (typeof name !== 'string' || !isSafePackageName(name)) {
    throw new Error(`插件声明的包名不可用：${JSON.stringify(name)}`)
  }
  const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  const target = join(home, 'profiles', 'node_modules', name)
  clearForInstall(target)
  writeTree(target, files)
  const rowAdded = ensurePatchRow(home, entryIdOf(files, manifest, name), name)
  writeInstalledSource(home, name, {
    spec: source.label,
    sourceKind: source.kind,
    version,
    installedAt: new Date().toISOString(),
  })
  return { name, version, dir: target, rowAdded, source: source.label }
}

// ── 来源 ───────────────────────────────────────────────────────────────────

/** 解析来源：`github:` 前缀走网络，其余按本地目录。 */
async function resolveSource(spec: string): Promise<Source> {
  const trimmed = spec.trim()
  if (!trimmed.startsWith('github:')) {
    const dir = resolve(trimmed)
    if (!existsSync(dir)) {
      throw new Error(`无法识别的插件来源：${spec}（支持 github:owner/repo[@ref] 或已存在的本地目录）`)
    }
    return { kind: 'dir', path: dir, label: dir }
  }
  const matched = /^github:([^/\s]+)\/([^/@\s]+)(?:@(\S+))?$/u.exec(trimmed)
  if (matched === null) throw new Error(`github 来源格式应为 github:owner/repo[@ref]：${spec}`)
  const owner = matched[1] ?? ''
  const repo = matched[2] ?? ''
  const ref = matched[3]
  if (ref !== undefined) {
    return { kind: 'github', label: trimmed, url: `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}` }
  }
  const branch = await resolveDefaultBranch(owner, repo)
  return {
    kind: 'github',
    label: trimmed,
    url: `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${branch}`,
  }
}

/**
 * 取默认分支：先问 GitHub API，失败（限流 / 离线）再探测 `main` / `master`。
 *
 * 为什么要回退：匿名 API 限流是 **IP 级**的（60 次/小时，共享出口会被整片拖下水，
 * 实测本机就被限流）。这条命令是"一条命令装插件"，不该因为别人的请求量而不可用；
 * 而 codeload 取 tarball 不走这个限额。探测猜测错了也只是 404，会带着原文报错。
 */
async function resolveDefaultBranch(owner: string, repo: string): Promise<string> {
  try {
    return await defaultBranchOf(owner, repo)
  } catch (error) {
    log.warn(`[dsh-install] 查询默认分支失败，回退探测 main / master：${summarizeError(error)}`)
    for (const candidate of ['main', 'master']) {
      if (await reachable(`https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${candidate}`)) {
        return candidate
      }
    }
    throw error
  }
}

/** 一个 URL 是否可达（HEAD，任意非 4xx/5xx 视为可达）。 */
async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD', headers: { 'user-agent': 'dsh-forge' } })
    return response.ok
  } catch {
    return false
  }
}

/** 问 GitHub API 拿默认分支（不猜 main/master）。 */
async function defaultBranchOf(owner: string, repo: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-forge' },
  })
  if (!response.ok) throw new Error(`查询仓库默认分支失败：HTTP ${String(response.status)}（${owner}/${repo}）`)
  const payload: unknown = await response.json()
  const branch = (payload as { default_branch?: unknown }).default_branch
  if (typeof branch !== 'string' || branch.length === 0) throw new Error(`${owner}/${repo} 未返回默认分支`)
  return branch
}

/** 下载一个 URL 为 Buffer。 */
async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { 'user-agent': 'dsh-forge' } })
  if (!response.ok) throw new Error(`下载插件失败：HTTP ${String(response.status)}（${url}）`)
  return Buffer.from(await response.arrayBuffer())
}

// ── 解包 ───────────────────────────────────────────────────────────────────

/**
 * 解一个 gzip tar 归档，并剥离 GitHub 归档自带的顶层目录（`<repo>-<ref>/`）。
 *
 * 顶层目录按「所有普通成员共同的首段」判定——不能拿第一个头当答案：GitHub 的
 * tar 里第一个成员是 `pax_global_header`（type `g`，且名字不含 `/`），照它判会得到
 * "没有顶层目录"，`package.json` 就此找不到（实测踩中）。
 *
 * @param archive - `.tar.gz` 原始字节。
 * @returns 归档内的普通文件（目录、pax/GNU 扩展头一律跳过）。
 */
export function extractTarGz(archive: Buffer): ArchiveEntry[] {
  const members = readMembers(gunzipSync(archive))
  const root = commonTopLevel(plausibleTopLevelNames(members))
  const entries: ArchiveEntry[] = []
  for (const member of members) {
    if (!isRegular(member.type)) continue
    const safe = safeRelative(stripRoot(member.name, root))
    if (safe === undefined) continue
    entries.push({ path: safe, data: member.data })
  }
  return entries
}

/**
 * 参与"共同顶层目录"判定的候选名。
 *
 * 只取普通文件成员，且剔除含 `..` 段的成员——穿越路径是**要被丢弃**的东西，让它
 * 参与判定会因为"首段不一致"把真正的顶层目录判成"不存在"，于是整包解出来都带着
 * 外壳目录（`package.json` 从此找不到）。
 */
function plausibleTopLevelNames(members: readonly TarMember[]): string[] {
  return members
    .filter((one) => isRegular(one.type) && !one.name.split('/').includes('..'))
    .map((one) => one.name)
}

/** 归档成员（未剥顶层目录的原始名字）。 */
interface TarMember {
  readonly name: string
  readonly type: string
  readonly data: Buffer
}

/** 逐块读 tar 头，取出全部成员（含目录与扩展头，由调用方按类型筛）。 */
function readMembers(tar: Buffer): TarMember[] {
  const members: TarMember[] = []
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512)
    if (isZeroBlock(header)) break
    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 500)
    const bodyStart = offset + 512
    const size = Number.parseInt(readString(header, 124, 136).trim() || '0', 8)
    const type = String.fromCharCode(header[156] ?? 0)
    offset = bodyStart + (Number.isFinite(size) ? Math.ceil(size / 512) * 512 : 0)
    members.push({
      name: prefix.length > 0 ? `${prefix}/${name}` : name,
      type,
      data: tar.subarray(bodyStart, bodyStart + size),
    })
  }
  return members
}

/** 普通文件成员（含 `ustar` 里用 NUL 表示的老式写法）。 */
function isRegular(type: string): boolean {
  return type === '0' || type === '\u0000'
}

/**
 * 所有成员共同拥有的顶层目录名（`<repo>-<ref>`）。
 *
 * 任一名不含 `/`、或首段不一致 → 判定没有共同顶层（不做任何剥离）。
 */
function commonTopLevel(names: readonly string[]): string | undefined {
  let root: string | undefined
  for (const name of names) {
    const slash = name.indexOf('/')
    if (slash <= 0) return undefined
    const segment = name.slice(0, slash)
    if (root === undefined) root = segment
    else if (segment !== root) return undefined
  }
  return root
}

/** 剥掉顶层目录（不在其下的条目原样保留，交给 `safeRelative` 把关）。 */
function stripRoot(full: string, root: string | undefined): string {
  if (root === undefined) return full
  if (full === root) return ''
  return full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full
}

/** tar 头里的定长字符串（截到 NUL）。 */
function readString(buffer: Buffer, start: number, end: number): string {
  const slice = buffer.subarray(start, Math.min(end, buffer.length))
  const zero = slice.indexOf(0)
  return slice.subarray(0, zero === -1 ? slice.length : zero).toString('utf8')
}

/** 全零块 = 归档结束标记。 */
function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0)
}

/** 读一个本地目录成归档条目（跳过 node_modules / .git / 链接）。 */
function readTree(dir: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  const walk = (current: string): void => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      if (item.name === 'node_modules' || item.name === '.git') continue
      const full = join(current, item.name)
      if (item.isDirectory()) {
        walk(full)
        continue
      }
      if (!item.isFile()) continue
      const safe = safeRelative(relative(dir, full).split(sep).join('/'))
      if (safe === undefined) continue
      entries.push({ path: safe, data: readFileSync(full) })
    }
  }
  walk(dir)
  return entries
}

/** 归档路径 → 安全相对路径（拒绝绝对路径、盘符、`..`）。 */
function safeRelative(path: string): string | undefined {
  if (path.length === 0) return undefined
  const unified = path.split('\\').join('/').replace(/^\.\//u, '')
  const normalized = normalize(unified).split(sep).join('/')
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return undefined
  if (isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized)) return undefined
  return normalized
}

// ── 落位 ───────────────────────────────────────────────────────────────────

/** 读归档里的 package.json。 */
function readManifestOf(files: readonly ArchiveEntry[]): PluginManifest {
  const entry = files.find((one) => one.path === 'package.json')
  if (entry === undefined) throw new Error('插件包里没有 package.json')
  const parsed: unknown = JSON.parse(entry.data.toString('utf8'))
  if (parsed === null || typeof parsed !== 'object') throw new Error('插件的 package.json 不是对象')
  return parsed as PluginManifest
}

/** 包名白名单：允许 `@scope/name`，拒绝 `..`、盘符与 Windows 保留字符。 */
function isSafePackageName(name: string): boolean {
  if (name.length === 0 || name.length > 214) return false
  if (name.startsWith('.') || name.startsWith('_') || name.includes('..')) return false
  return !/[\\:*?"<>|\s]/u.test(name)
}

/** 取装载行的 id：优先插件 bundle patch 里声明的 id，否则用包名。 */
function entryIdOf(files: readonly ArchiveEntry[], manifest: PluginManifest, fallback: string): string {
  const declared = (manifest.dsh as { bundle?: { patch?: unknown } } | undefined)?.bundle?.patch
  if (typeof declared !== 'string') return fallback
  const safe = safeRelative(declared.replace(/^\.\//u, ''))
  const entry = safe === undefined ? undefined : files.find((one) => one.path === safe)
  if (entry === undefined) return fallback
  try {
    const parsed: unknown = parseYaml(entry.data.toString('utf8'), { logLevel: 'silent' })
    if (Array.isArray(parsed)) {
      for (const patch of parsed as { insert?: unknown }[]) {
        if (!Array.isArray(patch.insert)) continue
        for (const row of patch.insert as { id?: unknown }[]) {
          if (typeof row.id === 'string' && row.id.length > 0) return row.id
        }
      }
    }
  } catch {
    /* 补丁层解析失败：退回包名当 id，不阻断安装 */
  }
  return fallback
}

/** 清掉旧安装（链接占用时拒绝，避免把用户的链接目标一起删掉）。 */
function clearForInstall(target: string): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(target)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`装载点已被链接占用：${target}。先用插件自带脚本 --uninstall 卸载，或手工删除该链接`)
  }
  rmSync(target, { recursive: true, force: true })
  log.info(`[dsh-install] 已覆盖旧版本目录：${target}`)
}

/** 把归档条目写到落点。 */
function writeTree(target: string, files: readonly ArchiveEntry[]): void {
  for (const file of files) {
    const destination = join(target, ...file.path.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, file.data)
  }
}

/**
 * 在 profile 用户补丁层追加装载行（幂等）。
 *
 * 判定只看**生效行**：脚本/模板自己写出的注释里就带同样字符串，直接 `includes`
 * 必然误判"已装"（坑 64）。
 *
 * 路径全部由传入的 `home` 推导（不读环境变量），保证"装到哪个 home"与"写到哪个
 * home"永远同一个——`--data-dir` 自定义数据目录时这一点尤其重要。
 *
 * @returns 本次是否新写了行。
 */
function ensurePatchRow(home: string, id: string, name: string): boolean {
  const profileDir = join(home, 'profiles', 'dsh-forge')
  const patchPath = join(profileDir, PATCH_FILENAME)
  const row = `- insert:\n    - id: ${id}\n      name: ${name}\n`
  mkdirSync(profileDir, { recursive: true })
  const existed = existsSync(patchPath)
  const existing = existed ? readFileSync(patchPath, 'utf8') : PROFILE_PATCH_TEMPLATE
  const active = existing.split('\n').filter((line) => !line.trimStart().startsWith('#'))
  if (existed && active.some((line) => line.includes(`id: ${id}`) || line.includes(`name: ${name}`))) return false
  // 空列表 `[]` 必须先摘掉：模板末尾就是它，直接续写块序列项会得到
  // `[]` + `- insert:` 这种**非法 YAML**——装载层解析失败后整层读不出任何插件
  // （表现为"装上了却完全没生效"，实测踩中）。
  const head = existing.replace(/^\s*(#.*\n|\s*\n)*\[\]\s*$/u, '').replace(/\[\]\s*$/u, '')
  const separator = head.trim().length === 0 ? '' : `${head.replace(/\s*$/u, '')}\n`
  writeFileSync(patchPath, `${separator}${row}`, 'utf8')
  log.ok(`[dsh-install] 已写入装载行：${patchPath}`)
  return true
}

// ── 安装来源登记（installed-sources.json）────────────────────────────────────

/** 安装来源登记文件名（位于 forge profile 目录）。 */
const INSTALLED_SOURCES_FILENAME = 'installed-sources.json'

/** 一条安装来源登记（版本 + 来源，供「检查更新/重装」对照）。 */
export interface InstalledSourceRecord {
  /** 安装 spec 原文（`github:owner/repo[@ref]` 或本地目录绝对路径）。 */
  readonly spec: string
  readonly sourceKind: 'github' | 'dir'
  /** 安装时读到的包版本。 */
  readonly version: string
  readonly installedAt: string
}

/** 读安装来源登记（文件不存在 → 空表；单条损坏只丢该条，不阻断整体）。 */
export function readInstalledSources(home: string): Map<string, InstalledSourceRecord> {
  const file = join(home, 'profiles', 'dsh-forge', INSTALLED_SOURCES_FILENAME)
  const map = new Map<string, InstalledSourceRecord>()
  if (!existsSync(file)) return map
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return map
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return map
  for (const [name, value] of Object.entries(parsed)) {
    const record = value as Partial<InstalledSourceRecord>
    if (typeof record.spec !== 'string' || (record.sourceKind !== 'github' && record.sourceKind !== 'dir')) continue
    map.set(name, {
      spec: record.spec,
      sourceKind: record.sourceKind,
      version: typeof record.version === 'string' ? record.version : '0.0.0',
      installedAt: typeof record.installedAt === 'string' ? record.installedAt : '',
    })
  }
  return map
}

/** 写一条安装来源登记（整表重写，保持其余条目）。 */
function writeInstalledSource(home: string, name: string, record: InstalledSourceRecord): void {
  const dir = join(home, 'profiles', 'dsh-forge')
  const file = join(dir, INSTALLED_SOURCES_FILENAME)
  const map = readInstalledSources(home)
  map.set(name, record)
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, `${JSON.stringify(Object.fromEntries(map), null, 2)}\n`, 'utf8')
}

/** 删一条安装来源登记（没有该文件/条目时静默）。 */
function removeInstalledSource(home: string, name: string): void {
  const file = join(home, 'profiles', 'dsh-forge', INSTALLED_SOURCES_FILENAME)
  if (!existsSync(file)) return
  const map = readInstalledSources(home)
  if (!map.delete(name)) return
  writeFileSync(file, `${JSON.stringify(Object.fromEntries(map), null, 2)}\n`, 'utf8')
}

// ── 版本读取与比较 ───────────────────────────────────────────────────────────

/** 读一个包目录的 package.json 版本；读不到返回 undefined。 */
export function readPackageVersion(dir: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const version = (parsed as { version?: unknown } | null)?.version
    return typeof version === 'string' && version.length > 0 ? version : undefined
  } catch {
    return undefined
  }
}

/** 读一个外部插件的已装版本（两个落点锚点，任意命中即返回）。 */
function readInstalledVersion(name: string, home: string): string | undefined {
  const dir = installedDirOf(name, home)
  return dir === undefined ? undefined : readPackageVersion(dir)
}

/** 规范化版本号：去掉前导 `v`/`V`/`=` 与空白。 */
function normalizeVersion(value: string): string {
  return value.trim().replace(/^[vV=]+/u, '')
}

/**
 * 轻量版本比较（零依赖）：点分段比较，纯数字段按数值比、其余段按字典序。
 * 返回 >0 / 0 / <0（a 大于 / 等于 / 小于 b）。只用于「远端是否比已装新」的判定，
 * 刻意不追求完整 semver 语义（预发布段不特殊处理，段数多的视为更新）。
 */
export function compareVersions(a: string, b: string): number {
  const left = normalizeVersion(a).split('.')
  const right = normalizeVersion(b).split('.')
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return y === undefined ? 0 : -1
    if (y === undefined) return 1
    if (x === y) continue
    const numericX = /^\d+$/u.test(x)
    const numericY = /^\d+$/u.test(y)
    if (numericX && numericY) {
      if (x.length !== y.length) return x.length > y.length ? 1 : -1
      return x < y ? -1 : 1
    }
    if (numericX) return 1
    if (numericY) return -1
    const order = x.localeCompare(y)
    if (order !== 0) return order > 0 ? 1 : -1
  }
  return 0
}

// ── 更新来源解析与检查 ───────────────────────────────────────────────────────

/** 一个可更新的 github 来源。 */
interface GithubUpdateSource {
  readonly owner: string
  readonly repo: string
}

/** 已装包目录（两个锚点，优先 `profiles/node_modules`）。 */
function installedDirOf(name: string, home: string): string | undefined {
  for (const anchor of [
    join(home, 'profiles', 'node_modules', name),
    join(home, 'profiles', 'dsh-forge', 'node_modules', name),
  ]) {
    if (existsSync(join(anchor, 'package.json'))) return anchor
  }
  return undefined
}

/** 解析 `github:owner/repo[@ref]`（与 resolveSource 同一正则）。 */
function parseGithubSpec(spec: string): GithubUpdateSource | undefined {
  const matched = /^github:([^/\s]+)\/([^/@\s]+)/u.exec(spec.trim())
  if (matched === null) return undefined
  return { owner: matched[1] ?? '', repo: matched[2] ?? '' }
}

/** 从已装 package.json 的 `repository` 字段推导 github owner/repo。 */
function githubSourceFromRepository(dir: string): GithubUpdateSource | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const repository = (parsed as { repository?: unknown } | null)?.repository
    if (repository === null || repository === undefined) return undefined
    const url = typeof repository === 'string' ? repository : (repository as { url?: unknown }).url
    if (typeof url !== 'string') return undefined
    const matched = /github\.com[/:]([^/\s]+)\/([^/\s#?]+)/u.exec(url)
    if (matched === null) return undefined
    const repo = matched[2]?.replace(/\.git$/u, '')
    if (repo === undefined || repo.length === 0) return undefined
    return { owner: matched[1] ?? '', repo }
  } catch {
    return undefined
  }
}

/**
 * 解析外部插件的更新来源：
 *   1. 安装来源登记里的 `github:` spec（优先）；
 *   2. 已装 package.json 的 `repository`（github.com 链接，兼容登记缺失的存量安装）。
 * 本地目录安装 / 无 github 来源 → undefined（无远端可对照）。
 */
function updateSourceOf(name: string, home: string): GithubUpdateSource | undefined {
  const record = readInstalledSources(home).get(name)
  if (record !== undefined && record.sourceKind === 'github') {
    const parsed = parseGithubSpec(record.spec)
    if (parsed !== undefined) return parsed
  }
  const dir = installedDirOf(name, home)
  if (dir === undefined) return undefined
  return githubSourceFromRepository(dir)
}

/** 拉仓库指定分支的 package.json 版本（raw.githubusercontent，不下载整包）。 */
async function fetchRemoteVersion(owner: string, repo: string, branch: string): Promise<string> {
  const response = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/package.json`, {
    headers: { 'user-agent': 'dsh-forge' },
  })
  if (!response.ok) throw new Error(`读取远端版本失败：HTTP ${String(response.status)}（${owner}/${repo}）`)
  const parsed: unknown = await response.json()
  const version = (parsed as { version?: unknown } | null)?.version
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${owner}/${repo} ${branch} 分支的 package.json 未声明版本号`)
  }
  return version
}

/** 「检查更新」结果（status 语义见各字段注释）。 */
export interface PluginUpdateCheck {
  /** 有新版本（远端版本号更高）。 */
  readonly status: 'update-available' | 'up-to-date' | 'no-source' | 'not-installed' | 'error'
  /** 已装版本。 */
  readonly installedVersion?: string
  /** 远端（默认分支）版本。 */
  readonly remoteVersion?: string
  /** 更新来源（`github:owner/repo`）。 */
  readonly source?: string
  /** 失败/无来源时的可读说明。 */
  readonly message?: string
}

/**
 * 检查一个外部插件是否有更新：对照来源仓库**默认分支**的 package.json 版本。
 * 已装版本 ≥ 远端版本视为「已是最新」（版本号不同才算有更新，见 compareVersions）。
 * 网络失败不抛：折叠为 `status: 'error'` 供 UI 直接展示。
 */
export async function checkPluginUpdate(name: string, home: string): Promise<PluginUpdateCheck> {
  const installed = readInstalledVersion(name, home)
  if (installed === undefined) return { status: 'not-installed' }
  const source = updateSourceOf(name, home)
  if (source === undefined) return { status: 'no-source', installedVersion: installed }
  const label = `github:${source.owner}/${source.repo}`
  try {
    const branch = await resolveDefaultBranch(source.owner, source.repo)
    const remote = await fetchRemoteVersion(source.owner, source.repo, branch)
    if (compareVersions(remote, installed) > 0) {
      return { status: 'update-available', installedVersion: installed, remoteVersion: remote, source: label }
    }
    return { status: 'up-to-date', installedVersion: installed, remoteVersion: remote, source: label }
  } catch (error) {
    return { status: 'error', installedVersion: installed, message: summarizeError(error) }
  }
}

/**
 * 应用更新：按来源重装（github 恒取默认分支，忽略登记里的固定 ref）。
 * 复用 installExternalPlugin 的「清旧目录 → 写新包 → 幂等补行 → 重登记版本」。
 */
export async function updateExternalPlugin(name: string, home: string): Promise<PluginInstallResult> {
  const source = updateSourceOf(name, home)
  if (source === undefined) {
    throw new Error(`插件 ${name} 没有可更新的 github 来源（本地安装无法检查更新）`)
  }
  return installExternalPlugin(`github:${source.owner}/${source.repo}`, home)
}

// ── 卸载 ─────────────────────────────────────────────────────────────────────

/** 卸载结果。 */
export interface PluginUninstallResult {
  /** 包名。 */
  readonly name: string
  /** 删除的插入行条目数。 */
  readonly rowsRemoved: number
  /** 删除的包目录（绝对路径）。 */
  readonly dirsRemoved: readonly string[]
}

/**
 * 卸载一个用户安装的外部插件：删补丁行 + 删包目录 + 删安装来源登记。
 *
 * 只认「补丁行或落点目录存在」的包；两者都不在时抛错——这个判定天然排除了
 * 应用自身的官方/自研插件（它们不在 profiles 落点，也从来不会被我们的
 * `ensurePatchRow` 写行），不会误删内置件。
 */
export function uninstallExternalPlugin(name: string, home: string): PluginUninstallResult {
  if (!isSafePackageName(name)) throw new Error(`插件名不可用：${JSON.stringify(name)}`)
  const patchPath = join(home, 'profiles', 'dsh-forge', PATCH_FILENAME)
  const rowsRemoved = existsSync(patchPath) ? removePatchRowsForName(patchPath, name) : 0
  const dirsRemoved: string[] = []
  for (const anchor of [
    join(home, 'profiles', 'node_modules', name),
    join(home, 'profiles', 'dsh-forge', 'node_modules', name),
  ]) {
    if (removeExternalDir(anchor)) dirsRemoved.push(anchor)
  }
  removeInstalledSource(home, name)
  if (rowsRemoved === 0 && dirsRemoved.length === 0) {
    throw new Error(`不是可卸载的外部插件：${name}（未找到补丁行或包目录）`)
  }
  return { name, rowsRemoved, dirsRemoved }
}

/** 删除一个外部包落点目录（链接占用时拒绝，绝不顺着链接删目标）。 */
function removeExternalDir(target: string): boolean {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(target)
  } catch {
    return false
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`卸载点已被链接占用：${target}。请手工删除该链接后重试`)
  }
  rmSync(target, { recursive: true, force: true })
  return true
}

/**
 * 从用户补丁层删掉指定裸包名的插入行。
 *
 * 行级编辑刻意不重新序列化 YAML：模板注释、用户手写的注释、`- insert:` 多条目
 * 块都原样保留，只移除命中的条目（块内条目全部命中时连块头一起删）。删空后
 * 必须写回可加载的 `[]` 占位（模板铁律：文件为空或只剩注释会导致启动失败）。
 *
 * @returns 被删除的条目数（0 = 未命中）。
 */
function removePatchRowsForName(patchPath: string, name: string): number {
  const text = readFileSync(patchPath, 'utf8')
  const lines = text.split('\n')
  const quoted = quoteVariants(name)
  const out: string[] = []
  let removed = 0
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const blockMatch = /^(\s*)- insert:\s*(?:#.*)?$/u.exec(line)
    if (blockMatch === null) {
      out.push(line)
      i += 1
      continue
    }
    const blockIndent = blockMatch[1].length
    const block: string[] = [line]
    let j = i + 1
    for (; j < lines.length; j += 1) {
      const next = lines[j]
      if (next.trim().length === 0) {
        block.push(next)
        continue
      }
      if (indentOf(next) <= blockIndent) break
      block.push(next)
    }
    const kept = stripBlockEntries(block, quoted)
    removed += kept.removed
    out.push(...kept.lines)
    i = j
  }
  if (removed === 0) return 0
  let joined = out.join('\n')
  const trimmed = joined.trim()
  if (trimmed.length === 0) {
    joined = '[]\n'
  } else if (hasNoActiveContent(joined)) {
    const last = trimmed.split('\n').pop() ?? ''
    if (last !== '[]') joined = `${trimmed}\n[]\n`
  }
  writeFileSync(patchPath, joined.replace(/\n{3,}/gu, '\n\n'), 'utf8')
  return removed
}

/** 行首空白宽度。 */
function indentOf(line: string): number {
  return line.match(/^\s*/u)?.[0].length ?? 0
}

/** 目标裸包名的引号变体（卸载判定兼容用户手写的引号与行尾注释）。 */
function quoteVariants(name: string): string[] {
  const bare = name.replace(/["']/gu, '')
  return [bare, JSON.stringify(bare), `'${bare}'`]
}

/** 转义正则元字符。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * 块内按条目（`- ...` 行 + 其续行）粒度删命中条目。
 * 返回剩余行与删除数；条目被删光时返回空行数组（调用方据此连块头一起丢）。
 */
function stripBlockEntries(block: string[], quoted: readonly string[]): { lines: string[]; removed: number } {
  const head = block[0]
  const rest = block.slice(1)
  let entryStartIndent = Number.POSITIVE_INFINITY
  for (const line of rest) {
    const match = /^(\s*)- /u.exec(line)
    if (match !== null) {
      entryStartIndent = match[1].length
      break
    }
  }
  if (!Number.isFinite(entryStartIndent)) return { lines: block, removed: 0 }
  const kept: string[] = []
  let removed = 0
  let cursor = 0
  while (cursor < rest.length) {
    const line = rest[cursor]
    const match = /^(\s*)- /u.exec(line)
    if (match === null) {
      kept.push(line)
      cursor += 1
      continue
    }
    const entryIndent = match[1].length
    const entry: string[] = [line]
    let k = cursor + 1
    for (; k < rest.length; k += 1) {
      const next = rest[k]
      if (next.trim().length === 0) {
        entry.push(next)
        continue
      }
      if (indentOf(next) <= entryIndent) break
      entry.push(next)
    }
    if (entryNameMatches(entry, quoted)) removed += 1
    else kept.push(...entry)
    cursor = k
  }
  if (removed === 0) return { lines: block, removed: 0 }
  if (kept.length === 0) return { lines: [], removed }
  return { lines: [head, ...kept], removed }
}

/** 一个条目是否声明了目标裸包名（`name:` 属性行，兼容引号与行尾注释）。 */
function entryNameMatches(entry: readonly string[], quoted: readonly string[]): boolean {
  for (const line of entry) {
    const trimmed = line.trim()
    for (const value of quoted) {
      if (new RegExp(`^name:\\s*${escapeRegExp(value)}\\s*(?:#.*)?$`, 'u').test(trimmed)) return true
    }
  }
  return false
}

/** 文件里是否还有「非注释、非空、非 `[]` 占位」的生效内容。 */
function hasNoActiveContent(text: string): boolean {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    if (trimmed === '[]') continue
    return false
  }
  return true
}
