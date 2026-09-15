/**
 * 打包态 asar 路径改写（`src/forge-host/subprocess-run-as-node.ts`）的行为断言。
 *
 * 真因：`@vscode/ripgrep` 的 `rgPath` 恒为 `…\app.asar\…\rg.exe`（模块解析结果），而 Windows
 * 无法启动归档内的文件 → 安装版 Glob/Grep 一律报「ripgrep provider failure」；适配器把这类 argv
 * 就地映射到 `app.asar.unpacked` 孪生。此处**不复制实现**，直接加载编译产物断言三个分支与原地语义，
 * 避免实现漂移（与 dsh-protocol / peer-fallback / plugin-install 同约定：先 `npm run build`）。
 */
'use strict'

const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const adapter = require(path.join(__dirname, '..', 'dist', 'forge-host', 'subprocess-run-as-node.js'))
const { toUnpackedAsarPath, withRunAsNodeSpecEnv } = adapter

const SEP = path.sep
const ASAR = `${SEP}app.asar${SEP}`
const UNPACKED = `${SEP}app.asar.unpacked${SEP}`
const PREFIX = `C:${SEP}Programs${SEP}dsh-forge${SEP}resources`
const RG_TAIL = `node_modules${SEP}@vscode${SEP}ripgrep-win32-x64${SEP}bin${SEP}rg.exe`
const ASAR_RG = `${PREFIX}${ASAR}${RG_TAIL}`
const UNPACKED_RG = `${PREFIX}${UNPACKED}${RG_TAIL}`
const ASAR_RUNNER = `${PREFIX}${ASAR}node_modules${SEP}@deepseek-ai${SEP}dsh-subprocess-local${SEP}lib${SEP}runner.js`

/** 真实孪生（走默认 existsSync 的原地改写断言必须落盘，否则逻辑只会走「不加改写」分支）。 */
const FIXTURE = path.join(__dirname, '..', '.tmp', 'asar-unpacked-path-test')
const FIXTURE_ASAR = path.join(FIXTURE, 'app.asar', 'node_modules', 'bin', 'rg.exe')
const FIXTURE_UNPACKED = path.join(FIXTURE, 'app.asar.unpacked', 'node_modules', 'bin', 'rg.exe')

after(() => {
  fs.rmSync(FIXTURE, { recursive: true, force: true })
})

test('asar 内的可执行文件 → 孪生真实路径', () => {
  assert.equal(toUnpackedAsarPath(ASAR_RG, () => true), UNPACKED_RG)
})

test('孪生不存在时保持原样（runner 入口 / 控制台预载只在 asar 内）', () => {
  assert.equal(toUnpackedAsarPath(ASAR_RG, () => false), ASAR_RG)
  assert.equal(toUnpackedAsarPath(ASAR_RUNNER, () => false), ASAR_RUNNER)
})

test('已是 unpacked 路径时不重复改写', () => {
  assert.equal(toUnpackedAsarPath(UNPACKED_RG, () => true), UNPACKED_RG)
})

test('非 asar 路径原样返回（系统可执行文件）', () => {
  const pwsh = `${PREFIX}${SEP}..${SEP}Windows${SEP}System32${SEP}WindowsPowerShell${SEP}v1.0${SEP}pwsh.exe`
  assert.equal(toUnpackedAsarPath(pwsh, () => true), pwsh)
  assert.equal(toUnpackedAsarPath('rg', () => true), 'rg')
})

test('spawn 补丁原地改写 argv 并保留接收对象（env 合并、元素身份不变）', () => {
  fs.mkdirSync(path.dirname(FIXTURE_ASAR), { recursive: true })
  fs.mkdirSync(path.dirname(FIXTURE_UNPACKED), { recursive: true })
  fs.writeFileSync(FIXTURE_UNPACKED, '')

  const argv = ['pwsh', '-NoProfile', FIXTURE_ASAR, 7]
  const spec = { argv, env: { KEEP: '1' } }
  const returned = withRunAsNodeSpecEnv(spec)
  assert.equal(returned, spec)
  assert.equal(spec.argv, argv)
  assert.deepEqual(argv, ['pwsh', '-NoProfile', FIXTURE_UNPACKED, 7])
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(spec.env.KEEP, '1')
})

test('无 argv 的请求不报错（仅补 env）', () => {
  const spec = { cwd: PREFIX }
  assert.equal(withRunAsNodeSpecEnv(spec), spec)
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1')
})
