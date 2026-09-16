/**
 * 插件管理面（`src/forge-host/plugin-install.ts` 的卸载/更新 + `cordis-inventory.ts`
 * 的外部行标注）行为断言。
 *
 * 锁住五件事（全部走本地目录来源，不联网）：
 *   1. 版本比较 —— `compareVersions` 的数值段/字典序/段数语义；
 *   2. 安装来源登记 —— 安装后写 `installed-sources.json`（kind/spec/version），
 *      重装覆盖、卸载删除；
 *   3. 卸载 —— 删补丁行（块级/条目级，注释保留，删空兜底 `[]`）+ 删包目录 +
 *      删登记；非外部插件 / 不安全包名拒绝；
 *   4. 检查更新 —— 本地安装无来源（no-source）、未安装（not-installed）、
 *      repository 回溯能推导来源（不会 no-source）；
 *   5. 快照标注 —— `buildExternalMetaByName` / `buildExternalMetaByEntryPath`
 *      只对「补丁层发现 + 包目录在盘」的外部包给出 `external` 元信息。
 *
 * 注：cordis-inventory 的 meta 构建走 `forgeProfile()`（进程级缓存，读
 * `$DSH_HOME`），故本文件在模块顶层把 `DSH_HOME` 指向临时根————node:test 每个
 * 测试文件独立进程，不影响其它套件。
 *
 * 依赖：Node >= 20（node:test 内置），运行 `npm test`（先 `npm run build`）。
 */
'use strict'

const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '.tmp', 'plugin-manage-test')
process.env.DSH_HOME = ROOT

const install = require(path.join(__dirname, '..', 'dist', 'forge-host', 'plugin-install.js'))
const inventory = require(path.join(__dirname, '..', 'dist', 'forge-host', 'cordis-inventory.js'))

/** 造一个干净的子目录。 */
function freshDir(name) {
  const dir = path.join(ROOT, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 写 package.json。 */
function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/** 造一个形态完整的本地插件源目录（含入口、可被 require 解析）。 */
function pluginFixture(dir, { name = 'fake-plugin', version = '1.2.3', repository } = {}) {
  writeManifest(dir, {
    name,
    version,
    main: 'lib/index.js',
    ...(repository !== undefined ? { repository } : {}),
  })
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'module.exports = { apply() {} }\n', 'utf8')
  return dir
}

/** 造一个安装过的外部插件 home（补丁行 + 包目录 + 登记），返回包目录。 */
function installedHome(name = 'fake-plugin', version = '1.2.3') {
  const home = freshDir(`home-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const dir = path.join(home, 'profiles', 'node_modules', name)
  pluginFixture(dir, { name, version })
  const profileDir = path.join(home, 'profiles', 'dsh-forge')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), `- insert:\n    - id: ${name}-id\n      name: ${name}\n`, 'utf8')
  return { home, dir }
}

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
})

// ── 版本比较 ────────────────────────────────────────────────────────────────

test('compareVersions：数值段、前导 v、段数与字典序语义', () => {
  assert.equal(install.compareVersions('1.2.3', '1.2.4'), -1)
  assert.equal(install.compareVersions('1.2.4', '1.2.3'), 1)
  assert.equal(install.compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(install.compareVersions('v1.2.3', '1.2.3'), 0)
  assert.equal(install.compareVersions('=1.2.3', '1.2.3'), 0)
  assert.equal(install.compareVersions('1.2.10', '1.2.9'), 1)
  assert.equal(install.compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(install.compareVersions('2.0.0', '1.99.99'), 1)
  // 语义与 semver 一致：正式版 > 预发布段（用于「远端正式版 > 已装预发布 → 有更新」）
  assert.equal(install.compareVersions('1.0.0', '1.0.0-beta'), 1)
  assert.equal(install.compareVersions('1.0.0-alpha', '1.0.0-beta'), -1)
  assert.equal(install.compareVersions('1.0.0', '1.0.0.1'), -1)
})

// ── 安装来源登记 ────────────────────────────────────────────────────────────

test('安装落登记：kind/spec/version 齐备，重装覆盖', async () => {
  const home = freshDir('home-registry')
  const source = pluginFixture(freshDir('fixture-src'), { name: 'fake-plugin', version: '1.0.0' })
  await install.installExternalPlugin(source, home)

  let records = install.readInstalledSources(home)
  let record = records.get('fake-plugin')
  assert.ok(record, '安装后应有登记')
  assert.equal(record.sourceKind, 'dir')
  assert.equal(record.version, '1.0.0')
  assert.equal(record.spec, source)

  // 重装（更高版本覆盖登记）
  await install.installExternalPlugin(pluginFixture(freshDir('fixture-src-v2'), { name: 'fake-plugin', version: '2.0.0' }), home)
  records = install.readInstalledSources(home)
  record = records.get('fake-plugin')
  assert.equal(record.version, '2.0.0')
})

// ── 卸载 ────────────────────────────────────────────────────────────────────

test('卸载：删补丁行 + 包目录 + 登记，二次卸载拒绝', async () => {
  const { home, dir } = installedHome('fake-plugin')
  const patchPath = path.join(home, 'profiles', 'dsh-forge', 'cordis.patch.yml')
  assert.ok(fs.existsSync(dir))

  // 用安装通路落一条登记，模拟 UI 安装的完整状态（含 registry）
  await install.installExternalPlugin(dir, home)

  const result = install.uninstallExternalPlugin('fake-plugin', home)
  assert.equal(result.name, 'fake-plugin')
  assert.ok(result.rowsRemoved >= 1)
  assert.ok(result.dirsRemoved.includes(dir))
  assert.ok(!fs.existsSync(dir), '包目录应已删除')
  assert.ok(!fs.existsSync(patchPath) || !fs.readFileSync(patchPath, 'utf8').includes('fake-plugin'), '补丁行应已删除')
  assert.ok(!install.readInstalledSources(home).has('fake-plugin'), '登记应已删除')

  // 二次卸载：什么都不剩 → 拒绝
  assert.throws(() => install.uninstallExternalPlugin('fake-plugin', home), /不是可卸载的外部插件/)
})

test('卸载：多条目块只删命中条目，注释原样保留', () => {
  const { home } = installedHome('pkg-a')
  const patchPath = path.join(home, 'profiles', 'dsh-forge', 'cordis.patch.yml')
  fs.writeFileSync(patchPath, [
    '# 用户补丁层注释（应保留）',
    '- insert:',
    '    - id: a',
    '      name: pkg-a',
    '    - id: b',
    '      name: pkg-b',
    '',
  ].join('\n'), 'utf8')

  const result = install.uninstallExternalPlugin('pkg-a', home)
  assert.equal(result.rowsRemoved, 1)
  const text = fs.readFileSync(patchPath, 'utf8')
  assert.ok(!text.includes('name: pkg-a'), '命中条目应被删除')
  assert.ok(text.includes('name: pkg-b'), '未命中条目应保留')
  assert.ok(text.includes('# 用户补丁层注释'), '注释应保留')
})

test('卸载：引号包名同样命中；删到最后只剩注释时兜底写 []', () => {
  const { home } = installedHome('pkg-q')
  const patchPath = path.join(home, 'profiles', 'dsh-forge', 'cordis.patch.yml')
  fs.writeFileSync(patchPath, [
    '# 只剩这段注释',
    '- insert:',
    '    - id: q',
    '      name: "pkg-q"',
    '',
  ].join('\n'), 'utf8')

  const result = install.uninstallExternalPlugin('pkg-q', home)
  assert.equal(result.rowsRemoved, 1)
  const text = fs.readFileSync(patchPath, 'utf8')
  assert.ok(!text.includes('pkg-q'), '条目应被删除')
  assert.ok(text.includes('# 只剩这段注释'), '注释应保留')
  assert.ok(/\n\[\]\s*$/u.test(text), '删空后应写回 [] 占位（否则启动失败）')
})

test('卸载：不安全包名在动盘之前拒绝', () => {
  const home = freshDir('home-unsafe')
  for (const bad of ['../evil', 'a b', 'C:\\x']) {
    assert.throws(() => install.uninstallExternalPlugin(bad, home), /插件名不可用/)
  }
  assert.ok(!fs.existsSync(path.join(home, 'profiles')), '不应有任何落盘动作')
})

// ── 检查更新 ────────────────────────────────────────────────────────────────

test('checkPluginUpdate：本地安装无来源（no-source），未安装（not-installed）', async () => {
  const { home } = installedHome('fake-plugin', '1.2.3')
  const local = await install.checkPluginUpdate('fake-plugin', home)
  assert.equal(local.status, 'no-source')
  assert.equal(local.installedVersion, '1.2.3')

  const ghost = await install.checkPluginUpdate('ghost-plugin', home)
  assert.equal(ghost.status, 'not-installed')
})

test('checkPluginUpdate：repository 回溯能推导 github 来源（不会 no-source）', async () => {
  const { home } = installedHome('repo-plugin', '9.9.9')
  // 补上 repository（registry 无记录，走 package.json 回溯）。用必不存在的仓库：
  // 无论在线/离线，检查都只会失败为 error，绝不会是 no-source——证明来源已推导。
  writeManifest(path.join(home, 'profiles', 'node_modules', 'repo-plugin'), {
    name: 'repo-plugin',
    version: '9.9.9',
    main: 'lib/index.js',
    repository: { type: 'git', url: 'git+https://github.com/dsh-forge-nonexistent-repo-8f3a/plugin.git' },
  })
  const result = await install.checkPluginUpdate('repo-plugin', home)
  assert.equal(result.installedVersion, '9.9.9')
  assert.notEqual(result.status, 'no-source', 'repository 应推导出 github 来源')
  assert.notEqual(result.status, 'not-installed')
})

test('updateExternalPlugin：本地安装无来源时拒绝', async () => {
  const { home } = installedHome('fake-plugin')
  await assert.rejects(install.updateExternalPlugin('fake-plugin', home), /没有可更新的 github 来源/)
})

// ── 快照标注（cordis-inventory）─────────────────────────────────────────────

test('buildExternalMetaByName：只标注「补丁层发现 + 包目录在盘」的外部包', async () => {
  const home = ROOT // DSH_HOME 指向的临时根
  const dir = path.join(home, 'profiles', 'node_modules', 'fake-plugin')
  fs.rmSync(dir, { recursive: true, force: true })
  pluginFixture(dir, { name: 'fake-plugin', version: '3.0.0' })
  const profileDir = path.join(home, 'profiles', 'dsh-forge')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), `- insert:\n    - id: fake-plugin-id\n      name: fake-plugin\n`, 'utf8')

  // 用安装通路写一条登记（sourceKind = dir）
  await install.installExternalPlugin(dir, home)

  const meta = inventory.buildExternalMetaByName()
  const record = meta.get('fake-plugin')
  assert.ok(record, '外部包应有元信息')
  assert.equal(record.packageName, 'fake-plugin')
  assert.equal(record.version, '3.0.0')
  assert.equal(record.sourceKind, 'dir')
  assert.ok(typeof record.spec === 'string' && record.spec.length > 0)
})

test('buildExternalMetaByEntryPath：以入口绝对路径反查外部身份', () => {
  const byEntry = inventory.buildExternalMetaByEntryPath()
  assert.ok(byEntry.size >= 1, '至少一个外部包入口')
  for (const [entryPath, meta] of byEntry) {
    assert.ok(path.isAbsolute(entryPath), '键应为绝对入口路径')
    assert.ok(meta.packageName.length > 0)
  }
})