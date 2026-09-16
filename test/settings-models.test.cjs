/**
 * 模型设置自有化 · 纯函数层 + 注册契约断言。
 *
 * 与 workspace-rows/tree 同构：vm 沙箱加载浏览器 bundle 并抓 `exports.pure` ——
 * 与生产共用同一份真源代码，不重复实现语义。
 *
 * 覆盖三层：
 *   1. 纯函数（派生/校验/join/就绪度/路径操作）——逐条对齐官方 ui-settings-models 语义；
 *   2. 注册契约（apply 在假 ctx 上的插槽注册面）——section id/order/children 与两步 onboarding；
 *   3. 宿主装载契约（boot-graph.ts 文本级：官方包入互斥排除表 + 自研 bundle 入 desktopDecls）。
 *
 * 注意：vm 内创建的对象/数组原型来自另一个 realm，`assert.deepStrictEqual` 会以
 * 「same structure but are not reference-equal」失败；结构化比较一律走 {@link same}。
 *
 * 依赖：Node >= 20（node:test 内置），运行 `npm test`。
 */
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const BUNDLE = path.join(ROOT, 'src', 'forge-shell', 'web', 'forge-settings-models-client.js')
const PLUGIN_ID = '@lansi-ai/dsh-forge-settings-models'

/** 跨 vm realm 的结构化比较（JSON 往返抹平原型差异）。 */
function same(actual, expected, message) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message)
}

/** 最小快照 store 替身（createSnapshotStore 的生产实现由 @deepseek-ai/dsh-client-store 提供）。 */
function fakeSnapshotStore(init) {
  let state = init
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update: (mutator) => {
      mutator(state)
      for (const listener of listeners) listener()
    },
    set: (next) => {
      state = next
      for (const listener of listeners) listener()
    },
  }
}

/** 抓取 bundle 的注册声明与导出面（与生产共用同一份 bundle）。 */
function loadBundle() {
  const source = fs.readFileSync(BUNDLE, 'utf8')
  let spec = null
  const context = {
    console,
    structuredClone,
    URL,
    window: { __ModuleLoader__: { load: (registration) => { spec = registration } } },
    require: (id) => {
      switch (id) {
        case '@deepseek-ai/dsh-client-store': return { createSnapshotStore: fakeSnapshotStore }
        case '@deepseek-ai/dsh-client-ui-primitives': return {}
        default: return {}
      }
    },
  }
  vm.createContext(context)
  vm.runInContext(source, context, { filename: BUNDLE })
  if (spec === null) throw new Error('__ModuleLoader__.load 未执行，bundle 加载失败')
  return { spec, exports: spec.factory(context.require) }
}

const { spec, exports: plugin } = loadBundle()
const pure = plugin.pure

// ── 1. 纯函数层 ────────────────────────────────────────────────────────

test('deriveKeyRef：大写 + 非字母数字段归一下划线 + _API_KEY 后缀', () => {
  assert.equal(pure.deriveKeyRef('minimax-cn'), 'MINIMAX_CN_API_KEY')
  assert.equal(pure.deriveKeyRef('deepseek-official'), 'DEEPSEEK_OFFICIAL_API_KEY')
  assert.equal(pure.deriveKeyRef('a.b c'), 'A_B_C_API_KEY')
})

test('apiKeyFailure：空=通过（保留既有）、仅空白=keyBlank、环境行/引号/空格=非法', () => {
  assert.equal(pure.apiKeyFailure(''), undefined)
  assert.equal(pure.apiKeyFailure('sk-abc123'), undefined)
  assert.equal(pure.apiKeyFailure('   '), 'keyBlank')
  assert.equal(pure.apiKeyFailure('MINIMAX_API_KEY=xx'), 'keyIllegalCharacters')
  assert.equal(pure.apiKeyFailure('"sk-abc"'), 'keyIllegalCharacters')
  assert.equal(pure.apiKeyFailure('sk abc'), 'keyIllegalCharacters')
})

test('parseCapacity / formatCapacity：K/M 十进制后缀，往返最短写法', () => {
  assert.equal(pure.parseCapacity(''), undefined)
  assert.equal(pure.parseCapacity('131072'), 131072)
  assert.equal(pure.parseCapacity('256K'), 256000)
  assert.equal(pure.parseCapacity('1M'), 1000000)
  assert.equal(Number.isNaN(pure.parseCapacity('12X')), true)
  assert.equal(pure.formatCapacity(1000000), '1M')
  assert.equal(pure.formatCapacity(256000), '256K')
  assert.equal(pure.formatCapacity(131072), '131072')
  assert.equal(pure.formatCapacity(0), '0')
  assert.equal(pure.capacitySpelling(undefined), '')
  assert.equal(pure.capacitySpelling(32000), '32K')
})

test('validateDeepSeekModels：id 必填/唯一、name 非空、容量正整数', () => {
  assert.equal(pure.validateDeepSeekModels(undefined), undefined)
  assert.equal(pure.validateDeepSeekModels([{ id: 'a' }, { id: 'b', name: 'B', contextWindow: 131072, maxTokens: 8192 }]), undefined)
  same(pure.validateDeepSeekModels([{ id: '' }]), { index: 0, key: 'modelIdRequired' })
  same(pure.validateDeepSeekModels([{ id: ' a ' }, { id: 'a' }]), { index: 1, key: 'modelIdDuplicate' })
  same(pure.validateDeepSeekModels([{ id: 'a', name: '' }]), { index: 0, key: 'modelNameInvalid' })
  same(pure.validateDeepSeekModels([{ id: 'a', contextWindow: 0 }]), { index: 0, key: 'modelContextInvalid' })
  same(pure.validateDeepSeekModels([{ id: 'a', maxTokens: 1.5 }]), { index: 0, key: 'modelMaxTokensInvalid' })
})

test('joinProviderDirectory：声明行在前（带 active/declared/error），未声明的在线路由在后', () => {
  const rows = pure.joinProviderDirectory(
    [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'stray', name: 'Stray' }],
    [
      { provider: 'deepseek-official', displayName: 'DeepSeek 官方', settingsNs: 'llm-deepseek', settingsPath: [] },
      { provider: 'acme', displayName: 'Acme', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme'], declared: true, error: 'boom' },
    ],
  )
  same(rows, [
    { provider: 'deepseek-official', displayName: 'DeepSeek 官方', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
    { provider: 'acme', displayName: 'Acme', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme'], active: false, declared: true, error: 'boom' },
    { provider: 'stray', displayName: 'Stray', settingsNs: '', settingsPath: [], active: true },
  ])
})

test('providerUsable：路由未注册不可用；profile 未指名引用视为自鉴权可用', () => {
  assert.equal(pure.providerUsable({ entry: { active: false }, apiKeyEnv: undefined }), false)
  assert.equal(pure.providerUsable({ entry: { active: true }, apiKeyEnv: undefined }), true)
  assert.equal(pure.providerUsable({ entry: { active: true }, apiKeyEnv: 'X_API_KEY', credential: { configured: false } }), false)
  assert.equal(pure.providerUsable({ entry: { active: true }, apiKeyEnv: 'X_API_KEY', credential: { configured: true } }), true)
  assert.equal(pure.providerUsable({ entry: { active: true }, apiKeyEnv: 'X_API_KEY' }), false)
})

test('onboardingReadiness：任一条可用即结束；只有官方 DeepSeek 路线决定是否提示密钥', () => {
  const officialRow = {
    entry: { provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
    apiKeyEnv: 'DEEPSEEK_OFFICIAL_API_KEY',
    credential: { configured: false, writable: true },
  }
  const base = { status: 'ready', error: null, credentialError: null, writable: true, rows: [officialRow], namespaces: new Map() }
  same(pure.onboardingReadiness({ ...base, status: 'idle', rows: [] }), { kind: 'loading' })
  same(pure.onboardingReadiness({ ...base, status: 'loading', rows: [] }), { kind: 'loading' })
  same(pure.onboardingReadiness({ ...base, status: 'error' }), { kind: 'unavailable', reason: 'load-failed' })
  same(pure.onboardingReadiness(base), { kind: 'credential-missing' })
  same(pure.onboardingReadiness({ ...base, rows: [] }), { kind: 'adapter-absent' })
  same(pure.onboardingReadiness({ ...base, rows: [{ ...officialRow, entry: { ...officialRow.entry, active: false } }] }), { kind: 'unavailable', reason: 'provider-inactive' })
  same(pure.onboardingReadiness({ ...base, credentialError: 'nope' }), { kind: 'unavailable', reason: 'credentials-unavailable' })
  same(pure.onboardingReadiness({ ...base, writable: false }), { kind: 'unavailable', reason: 'settings-read-only' })
  same(pure.onboardingReadiness({ ...base, rows: [{ ...officialRow, credential: { configured: false, writable: false } }] }), { kind: 'unavailable', reason: 'credential-read-only' })
  same(pure.onboardingReadiness({ ...base, rows: [{ ...officialRow, apiKeyEnv: undefined }] }), { kind: 'provider-ready' })
})

test('pathOps：只写变化键 + 缺失键 unset（深比较，含数组与对象）', () => {
  const ops = pure.pathOps(['providers', 'acme'], { baseURL: 'https://a', models: [{ id: 'x' }] }, { baseURL: 'https://b', models: [{ id: 'x' }], api: 'openai' })
  same(ops, [
    { op: 'set', path: ['providers', 'acme', 'baseURL'], value: 'https://b' },
    { op: 'set', path: ['providers', 'acme', 'api'], value: 'openai' },
  ])
  same(pure.pathOps([], undefined, {}), [])
  same(pure.pathOps([], { a: 1, b: 2 }, { a: 1 }), [{ op: 'unset', path: ['b'] }])
})

test('needsSetup / keyConfiguredOf / targetOf：首次配置姿态与受管凭据判定', () => {
  const row = (over) => ({
    entry: { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true, ...over },
    apiKeyEnv: 'DEEPSEEK_OFFICIAL_API_KEY',
    credential: { configured: false, writable: true },
    derivedCredential: { configured: true },
  })
  assert.equal(pure.needsSetup(row(), false), true)
  assert.equal(pure.needsSetup(row(), true), false)
  assert.equal(pure.needsSetup(row({ settingsPath: ['providers', 'x'] }), false), false)
  assert.equal(pure.needsSetup({ ...row(), credential: { configured: true, writable: true } }, false), false)
  assert.equal(pure.keyConfiguredOf(row()), false)
  assert.equal(pure.keyConfiguredOf({ ...row(), apiKeyEnv: undefined }), true)
  same(pure.targetOf({ ...row(), credential: { configured: true, writable: true } }), {
    provider: 'deepseek-official',
    displayName: 'DeepSeek',
    settingsNs: 'llm-deepseek',
    settingsPath: [],
    credentialRef: 'DEEPSEEK_OFFICIAL_API_KEY',
  })
  // 未确认配置 / 只读凭据 / 非本页推导引用 → 不带 credentialRef（删除不动它）
  assert.equal(pure.targetOf(row()).credentialRef, undefined)
  assert.equal(pure.targetOf({ ...row(), credential: { configured: true, writable: false } }).credentialRef, undefined)
  assert.equal(pure.targetOf({ ...row(), apiKeyEnv: 'CUSTOM_ENV' }).credentialRef, undefined)
  assert.equal(pure.targetOf({ ...row(), entry: { ...row().entry, declared: true } }).declared, true)
})

test('providerCopy / providerTargetLabel：唯一占位符替换，同名路由不重复括注', () => {
  assert.equal(pure.providerTargetLabel({ provider: 'acme', displayName: 'Acme' }), 'Acme (acme)')
  assert.equal(pure.providerTargetLabel({ provider: 'acme', displayName: 'acme' }), 'acme')
  assert.equal(pure.providerCopy('删除 {provider}？', { provider: 'acme', displayName: 'Acme' }), '删除 Acme (acme)？')
})

test('杂项：layoutOf / isHttpUrl / refFor / adopt / decodeWelcomeSection / protocolChoices', () => {
  assert.equal(pure.layoutOf('llm-deepseek'), 'deepseek')
  assert.equal(pure.layoutOf('llm-pi-ai'), 'pi-ai')
  assert.equal(pure.layoutOf('other'), 'unknown')
  assert.equal(pure.isHttpUrl('https://a.example/v1'), true)
  assert.equal(pure.isHttpUrl('http://127.0.0.1:8080'), true)
  assert.equal(pure.isHttpUrl('ftp://a'), false)
  assert.equal(pure.isHttpUrl('not a url'), false)
  same(pure.adopt({ id: 'x', name: 'X', contextWindow: 1000, maxTokens: 100, extra: 'drop' }), {
    id: 'x',
    name: 'X',
    contextWindow: 1000,
    maxTokens: 100,
  })
  same(pure.decodeWelcomeSection(null), {})
  same(pure.decodeWelcomeSection([1]), {})
  same(pure.decodeWelcomeSection({ welcomeNoticeVersion: 'v' }), { welcomeNoticeVersion: 'v' })
  // refFor：profile 记录 apiKeyEnv 优先，否则用推导引用
  const schema = {
    getPath: (value, p) => {
      let node = value
      for (const key of p) {
        if (node === null || typeof node !== 'object') return undefined
        node = node[key]
      }
      return node
    },
  }
  assert.equal(pure.refFor(schema, { value: { apiKeyEnv: 'CUSTOM_KEY' } }, [], 'acme'), 'CUSTOM_KEY')
  assert.equal(pure.refFor(schema, { value: {} }, [], 'acme'), 'ACME_API_KEY')
  // protocolChoices：读命名空间 schema 里 `providers.<probe>.api` 的 union 分支（非字符串项被滤掉）
  const schemaOps = {
    rehydrate: () => 'ROOT',
    nodeAtPath: (root, p) => (p[0] === 'providers' && p[2] === 'api' ? { type: 'union', list: [{ value: 'openai' }, { value: 'anthropic' }, { value: 7 }] } : undefined),
  }
  same(pure.protocolChoices({ schema: 'S' }, schemaOps), ['openai', 'anthropic'])
  same(pure.protocolChoices(undefined, schemaOps), [])
})

test('isOpencodeGateway：按路由 id 前缀或 opencode.ai host 判定', () => {
  assert.equal(pure.isOpencodeGateway('opencode-go', undefined), true)
  assert.equal(pure.isOpencodeGateway('OpenCode', undefined), true)
  assert.equal(pure.isOpencodeGateway('acme', 'https://opencode.ai/zen/go'), true)
  assert.equal(pure.isOpencodeGateway('acme', 'https://zen.opencode.ai/v1'), true)
  assert.equal(pure.isOpencodeGateway('acme', 'https://example.com/v1'), false)
  assert.equal(pure.isOpencodeGateway('acme', 'not a url'), false)
  assert.equal(pure.isOpencodeGateway('acme', undefined), false)
})

test('headerRows / hasHeader：字典转有序行，名称大小写不敏感', () => {
  same(pure.headerRows({ 'x-opencode-session': 'abc', 'X-Trace': '1' }), [
    { name: 'x-opencode-session', value: 'abc' },
    { name: 'X-Trace', value: '1' },
  ])
  same(pure.headerRows(undefined), [])
  same(pure.headerRows([1, 2]), [])
  assert.equal(pure.hasHeader({ 'X-Opencode-Session': 'a' }, 'x-opencode-session'), true)
  assert.equal(pure.hasHeader({}, 'x-opencode-session'), false)
})

test('firstHeaderFailure：空行忽略、名称/值/重名校验', () => {
  assert.equal(pure.firstHeaderFailure([]), undefined)
  assert.equal(pure.firstHeaderFailure([{ name: '', value: '' }]), undefined)
  assert.equal(pure.firstHeaderFailure([{ name: 'x-a', value: 'b' }]), undefined)
  same(pure.firstHeaderFailure([{ name: 'x a', value: 'b' }]), { index: 0, key: 'headerNameInvalid' })
  same(pure.firstHeaderFailure([{ name: 'x-a', value: 'bad\nvalue' }]), { index: 0, key: 'headerValueInvalid' })
  same(pure.firstHeaderFailure([{ name: 'x-a', value: 'b' }, { name: 'X-A', value: 'c' }]), { index: 1, key: 'headerNameDuplicate' })
})

test('newSessionId：非空、同形（UUID 或 hex 拼装），两次不同', () => {
  const id = pure.newSessionId()
  assert.equal(typeof id, 'string')
  assert.ok(id.length >= 32, `会话 ID 过短: ${id}`)
  assert.notEqual(pure.newSessionId(), id)
})

// ── 2. 注册契约（假 ctx 上跑 apply）────────────────────────────────────

test('bundle 注册声明：id / inject / apply / pure 导出面', () => {
  assert.equal(spec.id, PLUGIN_ID)
  assert.equal(typeof plugin.apply, 'function')
  same(plugin.inject, ['slots', 'locale', 'remote', 'remote.credentials', 'remote.llm', 'remote.settings', 'settingsScope', 'settingsSchema'])
  assert.equal(typeof plugin.pure, 'object')
})

test('apply 注册面：models section（id/order/children）+ 两步 onboarding', () => {
  const registrations = []
  const ctx = {
    effect: (factory) => factory(),
    locale: { register: () => {}, bind: () => (key) => key },
    remote: { $on: () => () => {}, credentials: {}, llm: {}, settings: {} },
    on: () => () => {},
    settingsScope: {
      describe: () => ({ ensure: () => Promise.resolve(), getSnapshot: () => ({ view: undefined, error: null }) }),
      bind: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ mode: 'memory', status: 'ready', value: {} }) }),
    },
    settingsSchema: {},
    slots: {
      inject: (name, factory) => registrations.push({ name, spec: factory() }),
      register: (options, component) => ({ options, component }),
    },
  }
  plugin.apply(ctx)
  const bySlot = (name) => registrations.filter((entry) => entry.name === name).map((entry) => entry.spec.options)

  const sections = bySlot('settings.section')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].id, 'models')
  assert.equal(sections[0].order, 10)
  same(Object.keys(sections[0].children), ['settings.models.provider-card', 'settings.models.footer'])
  same(sections[0].children['settings.models.provider-card'], { kind: 'keyed', scope: 'root' })
  same(sections[0].children['settings.models.footer'], { kind: 'list', scope: 'root' })

  // 两步引导顺序与官方一致：welcome-notice(-100) 先于 deepseek-official(0)。
  same(bySlot('settings.onboarding').map((options) => [options.id, options.order]), [['welcome-notice', -100], ['deepseek-official', 0]])
})

// ── 3. 宿主装载契约（boot-graph.ts 文本级）─────────────────────────────

test('boot-graph：官方 ui-settings-models 入互斥排除表，自研 bundle 入 desktopDecls', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'forge-host', 'boot-graph.ts'), 'utf8')
  const setStart = source.indexOf('const CLIENT_EXCLUDE_IDS = new Set([')
  const setEnd = source.indexOf('])', setStart)
  assert.ok(setStart >= 0 && setEnd > setStart, '应能定位 CLIENT_EXCLUDE_IDS 字面量')
  assert.ok(
    source.slice(setStart, setEnd).includes("'@deepseek-ai/dsh-client-ui-settings-models'"),
    '官方 ui-settings-models 应入 CLIENT_EXCLUDE_IDS（互斥副本）',
  )
  assert.ok(source.includes(`id: '${PLUGIN_ID}'`), 'desktopDecls 应含自研模型设置插件')
  assert.ok(source.includes("resolveLocalWebBundle('forge-settings-models-client.js')"), '自研插件应指向本地 bundle 产物')
})
