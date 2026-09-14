/**
 * 外部插件装载链路验证（`npm run verify:profile-plugins`，纯 Node，不启动 Electron）。
 *
 * 覆盖的是一条曾经不存在的通路：`$DSH_HOME/profiles/dsh-forge` 用户补丁层 →
 * 外部插件发现（双锚点定位）→ peer 自动供给 → 包体检 → 官方补丁语义解析 →
 * 插入行裸名改写为入口绝对路径 → 插件模块真实 `import`（连 peer 解析一起证明）
 * → 浏览器半声明可用。
 *
 * 设计：**未安装任何外部插件时判为 SKIP 并以 0 退出** —— 这条通路的存在不该让
 * 没有装插件的机器上多一个红灯；装了才逐项断言。
 *
 * 用法：
 *   node scripts/verify-profile-plugins.cjs
 *   DSH_HOME=C:/Users/x/.dsh node scripts/verify-profile-plugins.cjs
 */
'use strict'

const { existsSync, readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const { resolveForgeProfile, rewriteInsertNames } = require('../dist/forge-host/profile-plugins.js')

const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
  if (!ok) failures.push(label)
}

async function main() {
  const profile = resolveForgeProfile()
  console.log(`profile 目录: ${profile.dir}`)
  console.log(`补丁层 ${profile.patchFiles.length} 个；外部包 ${profile.packages.length} 个`)

  if (profile.packages.length === 0) {
    console.log('\nSKIP  未安装外部插件（$DSH_HOME/profiles/node_modules 为空或未在补丁层声明）')
    return
  }

  check('补丁层里含 profile 用户层', profile.patchFiles.some((file) => file.endsWith('cordis.patch.yml')))

  // 官方补丁语义解析（!!js 求值 + 相对路径锚定），再改写裸名。
  const { loadOverlayPatches } = await import('@deepseek-ai/dsh-app-boot')
  const layers = []
  for (const file of profile.patchFiles) layers.push(...loadOverlayPatches('dsh-forge', file))
  const rewritten = rewriteInsertNames(layers, profile)
  check('插入行裸名改写生效', rewritten === profile.packages.length, `rewritten=${rewritten}`)
  const rows = layers.flatMap((patch) => (Array.isArray(patch.insert) ? patch.insert : []))

  for (const pkg of profile.packages) {
    console.log(`\n外部包 ${pkg.name}`)
    check('  入口文件存在', existsSync(pkg.entry), pkg.entry)
    check('  浏览器半产物存在', pkg.client === undefined || existsSync(pkg.client.path))

    const row = rows.find((entry) => entry && entry.name === pkg.entry)
    check('  插入行已被改写成入口绝对路径', row !== undefined)

    // peer 供给（`peer-fallback.ts`）：`resolveForgeProfile()` 已在体检前补过一轮。
    // 这里按"插件自身位置能否解析到每个声明过的 peer"断言——打包态走的是 ESM 代理，
    // 解析语义与 junction 一致，因此这条在两种形态下都成立。
    const missing = unresolvedPeersOf(pkg.dir)
    check('  peer 依赖可从插件自身位置解析', missing.length === 0, missing.join(', '))

    // 真实 import：peer 解析不成立时这里就会失败，正是要拦的故障。
    const mod = await import(pathToFileURL(pkg.entry).href)
    check('  模块可 import（peer 解析成立）', mod !== undefined)
    check('  导出 apply 为函数', typeof mod.apply === 'function', String(mod.name))
    if (pkg.client !== undefined) {
      check('  图谱 id 与 client bundle 内声明的 id 一致', clientBundleId(pkg.client.path) === pkg.name)
    }
  }

  console.log(`\n${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项: ${failures.join(' | ')}`}`)
  if (failures.length > 0) process.exitCode = 1
}

/**
 * 从插件自身位置解析不到的 peer（与 `plugin-package.ts` 的体检同一判据）。
 *
 * @param dir - 插件包目录。
 * @returns 解析不到的 peer 名列表。
 */
function unresolvedPeersOf(dir) {
  const probe = createRequire(join(dir, '__verify_peer__.cjs'))
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  return Object.keys(manifest.peerDependencies ?? {}).filter((name) => {
    try {
      probe.resolve(name)
      return false
    } catch {
      return true
    }
  })
}

/** 读 client bundle 里 `__ModuleLoader__.load({ id })` 声明的 id（图谱按 id 去重，必须一致）。 */
function clientBundleId(bundlePath) {
  try {
    const matched = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{\s*id\s*:\s*['"]([^'"]+)['"]/u.exec(readFileSync(bundlePath, 'utf8'))
    return matched?.[1]
  } catch {
    return undefined
  }
}

main().catch((error) => {
  console.error('验证异常:', error)
  process.exitCode = 1
})
