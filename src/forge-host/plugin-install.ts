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
 * 安全：归档来自网络，所有路径先过 `safeRelative()`（拒绝绝对路径、盘符、`..`），
 * 包名过 `isSafePackageName()`（拒绝 `..` 与 Windows 保留字符），落点被链接占用时
 * 直接拒绝而不是覆盖。
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { log } from './log.js'
import { summarizeError } from './plugin-package.js'
import { PROFILE_PATCH_TEMPLATE } from './profile-plugins.js'

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
  const patchPath = join(profileDir, 'cordis.patch.yml')
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
