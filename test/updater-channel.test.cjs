/**
 * 更新渠道规则断言（`src/forge-host/updater-channels.ts`）。
 *
 * 背景（坑 75）：`electron-updater` 的 `allowPrerelease` 默认由**当前版本**推导
 * （`AppUpdater.js:218`），导致「正式版装机 + 预发布渠道」永远看不到 `-rc.N`。
 * 本模块把「渠道 → feed / 是否纳入预发布」固定成纯规则，这里锁死其行为，
 * 避免哪天又被改回「按当前版本推导」而在实机上表现为「检查更新永远已是最新」。
 *
 * 约定同其它 dist 断言：先 `npm run build`。
 */
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { CHANNEL_FEED, allowPrereleaseFor } = require(path.join(__dirname, '..', 'dist', 'forge-host', 'updater-channels.js'))

test('CHANNEL_FEED：stable → null（latest.yml）、rc → rc（rc.yml）', () => {
  assert.deepEqual(Object.keys(CHANNEL_FEED).sort(), ['rc', 'stable'])
  assert.equal(CHANNEL_FEED.stable, null)
  assert.equal(CHANNEL_FEED.rc, 'rc')
})

test('allowPrereleaseFor：只有 rc 渠道纳入预发布候选', () => {
  assert.equal(allowPrereleaseFor('rc'), true, '预发布渠道必须能拿到 -rc.N')
  assert.equal(allowPrereleaseFor('stable'), false, '正式渠道严格只看正式版')
  assert.equal(allowPrereleaseFor('off'), false)
})
