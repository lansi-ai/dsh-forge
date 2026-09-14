/**
 * 外部插件 peer 供给层（`src/forge-host/peer-fallback.ts`）的行为断言。
 *
 * 锁三件事：
 *   1. 开发态供给 = junction 指向宿主那份包 → 插件解析到的是**同一个真实文件**
 *      （模块身份一致，"同一实例"这条硬要求的落地判据）；
 *   2. 纪律：幂等，且绝不覆盖插件自带 / 用户已链接 / 官方投影层写下的东西；
 *   3. 代理形态（打包态走的那条路）真的能承载 ESM 命名导出与默认导出，且目标
 *      没有默认导出时也不会报链接错误。
 *
 * 打包态独有的那一步（代理 re-export 指向 asar 内文件）无法在纯 Node 下断言——
 * 读 asar 需要 Electron 宿主，属实机验证项；本测试锁住判定分支与代理形态。
 *
 * 依赖：Node >= 20（node:test 内置），运行 `npm test`（先 `npm run build`）。
 */
'use strict'

const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

const peer = require(path.join(__dirname, '..', 'dist', 'forge-host', 'peer-fallback.js'))
const profilePlugins = require(path.join(__dirname, '..', 'dist', 'forge-host', 'profile-plugins.js'))

/** 用一个真实存在的宿主包当被供给对象（本项目直接依赖它）。 */
const PEER = 'yaml'

/** 临时工作区（`.tmp/` 已 gitignore；测试结束整体删除）。 */
const ROOT = path.join(__dirname, '..', '.tmp', 'peer-fallback-test')

/** 造一个干净的子目录。 */
function freshDir(name) {
  const dir = path.join(ROOT, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 写一个最小 package.json。 */
function writeManifest(dir, manifest) {
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
})

test('开发态供给：junction 指向宿主那份包（插件解析到同一真实文件）', () => {
  const dir = freshDir('dev-plugin')
  writeManifest(dir, { name: 'fake-plugin', version: '1.0.0', peerDependencies: { [PEER]: '*' } })

  const result = peer.ensurePeerSupply({ name: 'fake-plugin', dir })
  assert.deepEqual([...result.created], [PEER])
  assert.deepEqual([...result.failed], [])
  assert.equal(fs.lstatSync(path.join(dir, 'node_modules', PEER)).isSymbolicLink(), true)

  const hostEntry = createRequire(__filename).resolve(PEER)
  const pluginEntry = createRequire(path.join(dir, 'probe.cjs')).resolve(PEER)
  assert.equal(fs.realpathSync(pluginEntry), fs.realpathSync(hostEntry))
})

test('幂等：第二次供给只判"已就绪"，不再动手', () => {
  const dir = freshDir('idempotent')
  writeManifest(dir, { name: 'fake-plugin', version: '1.0.0', peerDependencies: { [PEER]: '*' } })

  peer.ensurePeerSupply({ name: 'fake-plugin', dir })
  const second = peer.ensurePeerSupply({ name: 'fake-plugin', dir })
  assert.deepEqual([...second.created], [])
  assert.deepEqual([...second.skipped], [PEER])
})

test('不覆盖：插件自带的依赖副本一律不动', () => {
  const dir = freshDir('keeps-plugin-copy')
  writeManifest(dir, { name: 'fake-plugin', version: '1.0.0', dependencies: { [PEER]: '*' } })
  const own = path.join(dir, 'node_modules', PEER)
  fs.mkdirSync(own, { recursive: true })
  writeManifest(own, { name: PEER, version: '9.9.9' })
  fs.writeFileSync(path.join(own, 'keep.txt'), 'untouched', 'utf8')

  const result = peer.ensurePeerSupply({ name: 'fake-plugin', dir })
  assert.deepEqual([...result.skipped], [PEER])
  assert.equal(fs.readFileSync(path.join(own, 'keep.txt'), 'utf8'), 'untouched')
  assert.equal(JSON.parse(fs.readFileSync(path.join(own, 'package.json'), 'utf8')).version, '9.9.9')
})

test('供给形态：宿主在 asar 内走代理，真实目录走链接', () => {
  assert.equal(peer.supplyFormOf('C:/app/resources/app.asar/node_modules/yaml/dist/index.js'), 'proxy')
  assert.equal(peer.supplyFormOf('E:/Projects/DSH/desktop/node_modules/yaml/dist/index.js'), 'junction')
})

test('代理形态：命名导出与默认导出都能穿过 re-export', async () => {
  const dir = freshDir('proxy')
  const target = path.join(dir, 'target.mjs')
  fs.writeFileSync(target, 'export const alpha = 1\nexport default { beta: 2 }\n', 'utf8')

  const source = peer.proxyEntrySource(target)
  assert.match(source, /^export \* from "file:\/\/\//u)
  // 生产里 `entry-0.js` 靠同目录 package.json 的 `type: module` 生效；这里用 .mjs
  // 后缀拿到同一语义，只验 re-export 形态本身。
  const entry = path.join(dir, 'entry-0.mjs')
  fs.writeFileSync(entry, source, 'utf8')

  const module = await import(pathToFileURL(entry).href)
  assert.equal(module.alpha, 1)
  assert.equal(module.default.beta, 2)
})

test('代理形态：目标没有默认导出时仍可 import（命名空间兜底）', async () => {
  const dir = freshDir('proxy-no-default')
  const target = path.join(dir, 'target.mjs')
  fs.writeFileSync(target, 'export const alpha = 1\n', 'utf8')

  const entry = path.join(dir, 'entry-0.mjs')
  fs.writeFileSync(entry, peer.proxyEntrySource(target), 'utf8')

  const module = await import(pathToFileURL(entry).href)
  assert.equal(module.alpha, 1)
  assert.equal(module.default, undefined)
})

test('装载前自检：好入口通过，坏入口 / 无 apply 一律记为不可装载', async () => {
  const okDir = freshDir('probe-ok')
  fs.writeFileSync(path.join(okDir, 'index.mjs'), 'export const apply = () => {}\n', 'utf8')
  assert.equal(await peer.probeExternalEntry({ name: 'probe-ok', entry: path.join(okDir, 'index.mjs') }), true)

  const missingDir = freshDir('probe-missing-peer')
  fs.writeFileSync(path.join(missingDir, 'index.mjs'), "import 'definitely-not-installed-xyz'\n", 'utf8')
  assert.equal(
    await peer.probeExternalEntry({ name: 'probe-missing-peer', entry: path.join(missingDir, 'index.mjs') }),
    false,
  )
  assert.equal(peer.unimportablePlugins().has('probe-missing-peer'), true)

  const noApplyDir = freshDir('probe-no-apply')
  fs.writeFileSync(path.join(noApplyDir, 'index.mjs'), 'export const something = 1\n', 'utf8')
  assert.equal(await peer.probeExternalEntry({ name: 'probe-no-apply', entry: path.join(noApplyDir, 'index.mjs') }), false)
})

test('摘除不可装载的插入行：只摘命中名，其余行原样保留', () => {
  const layers = [
    { insert: [{ id: 'a', name: 'p1' }, { id: 'b', name: 'p2' }] },
    { insert: [{ id: 'c', name: 'p1', config: { x: 1 } }] },
  ]
  assert.equal(profilePlugins.dropInsertRowsByName(layers, new Set()), 0)
  assert.equal(profilePlugins.dropInsertRowsByName(layers, new Set(['p1'])), 2)
  assert.deepEqual(
    layers.map((patch) => patch.insert.map((entry) => entry.name)),
    [['p2'], []],
  )
})
