/**
 * 外部插件一键安装（`src/forge-host/plugin-install.ts`）的行为断言。
 *
 * 这条通路是「像 `dsh plugin --profile <p> add github:owner/repo` 一样一键装」的
 * 落地实现，因此要锁住三件事：
 *   1. 解包正确——剥离 GitHub 归档自带的顶层目录，并**丢弃**目录条目与穿越路径；
 *   2. 落位与写装载行——包目录落到 `profiles/node_modules/<包名>`，插入行的 id 优先
 *      取插件自己声明的 bundle patch（与插件仓 install-forge.cjs 语义一致），幂等；
 *   3. 安全——落点被链接占用时拒绝覆盖（否则会顺着链接删掉用户的目录）。
 *
 * 只走本地目录来源（不联网）；`github:` 那一段由 `parseArgv` 与真实机器验证覆盖。
 *
 * 依赖：Node >= 20（node:test 内置），运行 `npm test`（先 `npm run build`）。
 */
'use strict'

const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { gzipSync } = require('node:zlib')
const { parse: parseYaml } = require('yaml')

const install = require(path.join(__dirname, '..', 'dist', 'forge-host', 'plugin-install.js'))
const { parseArgv } = require(path.join(__dirname, '..', 'dist', 'forge-shell', 'argv.js'))

const ROOT = path.join(__dirname, '..', '.tmp', 'plugin-install-test')

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

/** 造一个 tar 成员（ustar 头 + 内容 + 512 对齐）。 */
function tarEntry(name, content, type = '0') {
  const data = Buffer.from(content, 'utf8')
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8)
  header.write('0000000\0', 108, 8)
  header.write('0000000\0', 116, 8)
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12)
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12)
  header.write('        ', 148, 8)
  header.write(type, 156, 1)
  header.write('ustar\0', 257, 6)
  header.write('00', 263, 2)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

/** 把成员打成一个 .tar.gz。 */
function tarGz(members) {
  return gzipSync(Buffer.concat([...members.map((one) => tarEntry(...one)), Buffer.alloc(1024)]))
}

/** 造一个形态完整的插件目录（含 bundle patch 声明与一个该被跳过的 node_modules）。 */
function pluginFixture(dir) {
  writeManifest(dir, { name: 'fake-plugin', version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } } })
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: fake-id\n      name: fake-plugin\n', 'utf8')
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export const apply = () => {}\n', 'utf8')
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'should not be copied\n', 'utf8')
  return dir
}

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
})

test('解包：剥掉 GitHub 顶层目录，目录条目与穿越路径被丢弃', () => {
  const archive = tarGz([
    // 真实 GitHub 归档的第一个成员是 pax 全局头（type `g`）且名字不含 `/`——
    // 拿它当"顶层目录"的判据会剥不掉外壳，这里固定住这条回归。
    ['pax_global_header', 'x', 'g'],
    ['fake-plugin-abc123/', '', '5'],
    ['fake-plugin-abc123/package.json', '{"name":"fake-plugin"}\n'],
    ['fake-plugin-abc123/lib/index.js', 'export const apply = () => {}\n'],
    ['../evil.txt', 'pwned'],
  ])
  const entries = install.extractTarGz(archive)
  assert.deepEqual(
    entries.map((one) => one.path),
    ['package.json', 'lib/index.js'],
  )
  assert.equal(entries[1].data.toString('utf8'), 'export const apply = () => {}\n')
})

test('本地目录安装：落位 + 写装载行（id 取插件自己声明的那一个）', async () => {
  const home = freshDir('home')
  const source = pluginFixture(freshDir('source'))

  const result = await install.installExternalPlugin(source, home)
  assert.equal(result.name, 'fake-plugin')
  assert.equal(result.version, '1.2.3')
  assert.equal(result.rowAdded, true)
  assert.equal(result.dir, path.join(home, 'profiles', 'node_modules', 'fake-plugin'))

  assert.equal(fs.existsSync(path.join(result.dir, 'lib', 'index.js')), true)
  assert.equal(fs.existsSync(path.join(result.dir, 'node_modules')), false)

  const patchPath = path.join(home, 'profiles', 'dsh-forge', 'cordis.patch.yml')
  const patch = fs.readFileSync(patchPath, 'utf8')
  assert.match(patch, /id: fake-id\n\s+name: fake-plugin/u)
  // 装载层的真正判据是"这份文件能不能被解析成补丁列表"：模板末尾的 `[]` 与块序列项
  // 混写会产出非法 YAML，那样插件会静默完全不生效。
  const parsed = parseYaml(patch, { logLevel: 'silent' })
  assert.deepEqual(parsed, [{ insert: [{ id: 'fake-id', name: 'fake-plugin' }] }])
})

test('幂等：重复安装不重复写行，装载点内容保持一份', async () => {
  const home = freshDir('home-idempotent')
  const source = pluginFixture(freshDir('source-idempotent'))
  const patchPath = path.join(home, 'profiles', 'dsh-forge', 'cordis.patch.yml')

  await install.installExternalPlugin(source, home)
  const first = fs.readFileSync(patchPath, 'utf8')
  const second = await install.installExternalPlugin(source, home)

  assert.equal(second.rowAdded, false)
  assert.equal(fs.readFileSync(patchPath, 'utf8'), first)
  assert.equal(first.match(/id: fake-id/gu).length, 1)
})

test('安全：装载点被链接占用时拒绝覆盖', async () => {
  const home = freshDir('home-linked')
  const source = pluginFixture(freshDir('source-linked'))
  const link = path.join(home, 'profiles', 'node_modules', 'fake-plugin')
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(source, link, 'junction')

  await assert.rejects(() => install.installExternalPlugin(source, home), /装载点已被链接占用/u)
  assert.equal(fs.realpathSync(link), fs.realpathSync(source))
})

test('argv：--install-plugin 的空格与等号两种写法都解析', () => {
  assert.equal(parseArgv(['node', 'main.js', '--install-plugin', 'github:a/b']).installPlugin, 'github:a/b')
  assert.equal(parseArgv(['node', 'main.js', '--install-plugin=github:a/b@v1']).installPlugin, 'github:a/b@v1')
  assert.equal(parseArgv(['node', 'main.js']).installPlugin, undefined)
  assert.equal(parseArgv(['node', 'main.js', '--install-plugin', '--hidden']).installPlugin, undefined)
})

test('argv：打包版偏移量为 1（argv[0] 即 exe，没有 script 项）', () => {
  // 打包版 argv = [exe, ...args]：按 dev 的偏移 2 解析会把唯一那个参数吃掉，
  // `--hidden` / `--data-dir` / `--install-plugin` 全部静默失效。
  const packaged = ['DSH Forge.exe', '--install-plugin', 'github:a/b']
  assert.equal(parseArgv(packaged, 1).installPlugin, 'github:a/b')
  assert.equal(parseArgv(['DSH Forge.exe', '--hidden'], 1).hidden, true)
  assert.equal(parseArgv(['DSH Forge.exe', '--data-dir=D:/dsh'], 1).dataDir, 'D:/dsh')
})
