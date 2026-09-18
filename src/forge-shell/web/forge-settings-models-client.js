/**
 * @lansi-ai/dsh-forge-settings-models —— 模型设置（设置「模型」分区）自有化。
 *
 * 接管面（对照官方 `@deepseek-ai/dsh-client-ui-settings-models`，该包已入
 * boot-graph.ts `CLIENT_EXCLUDE_IDS`）：
 *   ① `settings.section` id='models' order=10 —— 官方信息架构 1:1（provider 目录行 +
 *      单卡编辑器 + 添加提供方 + 自定义路由 + 删除确认 + 模型探测选择器 + 只读/冲突态）；
 *   ② 子槽位 `settings.models.provider-card`（keyed，entryKey=settingsNs）与
 *      `settings.models.footer`（list）原样声明并 dispatch —— 第三方扩展位不变；
 *   ③ `settings.onboarding` 两步引导复刻（welcome-notice order -100 / deepseek-official order 0）。
 * 字典命名空间沿用官方 `settings.models`（官方包已被互斥排除，无注册冲突；键集与官方一致，
 * 保证任何 bind 该命名空间的消费方措辞不变）。
 *
 * 数据面零新增（IPC 载波 + api-remotes 信封）：
 *   provider 目录  = `llm/listProviders` ∪ `llm/listConfigurableProviders`
 *   settings       = `ctx.settingsScope.describe()`（共享镜像 + writable）+ `settings/mutate`
 *   凭证           = `credentials/describe|set|unset`
 *   模型探测       = `llm/discoverModels`
 *   结构读写       = `ctx.settingsSchema`（rehydrate/nodeAtPath/getPath/setPath/deletePath/validate/hasPath）
 *
 * 与官方实现的差异（自绘换皮，语义等价）：
 *   - 视觉全部自有 class（`dsfm-` 前缀）+ 官方 `--dsw-*` 设计 token，动态样式 important 化（坑 19）；
 *   - 快照面显式用 `React.useSyncExternalStore(store.subscribe, store.getSnapshot)`，
 *     不依赖 slots 引擎的 `hooks → use<Key>` 注入约定；
 *   - 纯函数层经 `exports.pure` 导出，供 test/ 单测在 vm 沙箱内断言（与 workspaces 的
 *     `exports.derive` 同款做法）。
 *
 * 注：本文件为浏览器侧 bundle（含 window 全局），不参与 Node 编译。
 */
window.__ModuleLoader__.load({
  id: '@lansi-ai/dsh-forge-settings-models',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')

    /** 字典命名空间（沿用官方；官方包已排除）。 */
    const NS = 'settings.models'
    /** 手声明路由写入的命名空间（pi-ai 适配器家族）。 */
    const PI_AI_NS = 'llm-pi-ai'
    /** 直接 DeepSeek 适配器家族命名空间。 */
    const DEEPSEEK_NS = 'llm-deepseek'
    /** DeepSeek 官方路由 id 与它在本页的 settings 地址（onboarding 就绪判定的锚点）。 */
    const DEEPSEEK_OFFICIAL_ROUTE = 'deepseek-official'
    /** 欢迎声明的 settings 命名空间与确认字段（host 行 ui-settings-general 注册）。 */
    const WELCOME_NOTICE_NS = 'ui-onboarding'
    const WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion'
    /** 文案实质变更时才 bump：确认值按精确相等比较。 */
    const WELCOME_NOTICE_VERSION = '2026-08-13.1'

    // ── 字典（键集与官方一致；zh 对齐官方中文，en 对齐官方英文）───────────

    const en = {
      nav: 'Models',
      title: 'Models',
      intro: 'Enter your API keys to use models from the following providers.',
      edit: 'Edit',
      editProvider: 'Edit {provider}',
      remove: 'Delete',
      removeProvider: 'Delete {provider}',
      deleteTitle: 'Delete {provider}?',
      deleteDescription: 'Deleting {provider} removes its configuration. Any credential it uses is managed elsewhere and will be kept.',
      deleteDescriptionWithCredential: 'Deleting {provider} removes its configuration and stored API key.',
      deleteConfirm: 'Delete {provider}',
      deleting: 'Deleting {provider}…',
      add: 'Add provider',
      provider: 'Provider',
      close: 'Close',
      cancel: 'Cancel',
      apply: 'Apply',
      applying: 'Applying…',
      savedProvider: 'Saved {provider}.',
      credentialConfigured: 'API key configured',
      credentialMissing: 'API key missing',
      readOnly: 'The settings document is read-only in this deployment.',
      loadFailed: 'Loading the provider directory failed',
      conflict: 'Someone else changed these settings while this card was open. Close it and reopen to edit the current values.',
      retry: 'Retry',
      keyInput: 'API key',
      keyPlaceholder: 'Enter your API key',
      keyPlaceholderNative: 'Enter an API key, or leave blank to use environment authentication',
      keyStored: 'Configured — enter a new value to replace',
      keyEnvLocked: 'Provided by the launch environment (read-only)',
      headers: 'Request headers',
      headersHint: 'Extra headers this gateway requires. They are stored in settings and sent on every request of this route.',
      headerName: 'Name',
      headerValue: 'Value',
      addHeader: 'Add header',
      removeHeader: 'Remove header',
      headerNameInvalid: 'A header name may contain letters, digits, and !#$%&\'*+-.^_`|~ only.',
      headerValueInvalid: 'A header value cannot contain line breaks or control characters, and every character must fit in one byte — non-ASCII text (e.g. Chinese) cannot go into an HTTP header.',
      headerNameDuplicate: 'This header is already listed.',
      headerEmpty: 'No extra request headers.',
      opencodeHint: 'This route targets an opencode gateway. opencode requires a stable session ID in x-opencode-session on every request — without it the upstream refuses to route and answers 400 MissingSessionID (routing and prompt caching are lost).',
      opencodeGenerate: 'Generate session ID',
      opencodeStaticNote: 'The value is generated once per route and stays the same for every conversation on it.',
      customized: 'Customized settings',
      baseUrl: 'Base URL',
      baseUrlDefault: 'Provider default',
      models: 'Models',
      modelsInherited: 'Using the adapter defaults',
      modelsCustomized: 'Customized model catalog',
      resetModels: 'Restore defaults',
      model: 'Model',
      modelId: 'Model ID',
      modelName: 'Display name',
      modelNamePlaceholder: 'Uses the model ID when empty',
      contextWindow: 'Context window',
      contextWindowPlaceholder: 'Uses the provider default',
      maxTokens: 'Max output tokens',
      maxTokensPlaceholder: 'Uses the provider default',
      modelAdvanced: 'Capacities',
      addModel: 'Add model',
      removeModel: 'Delete model',
      modelsEmpty: 'No models will be shown in the selector. Unlisted IDs can still be sent directly.',
      keyBlank: 'Enter the API key, or leave the field empty to keep the stored one.',
      keyBlankNew: 'Enter the API key, or leave the field empty if this provider authenticates another way.',
      keyIllegalCharacters: 'This API key is not in a valid format. Please check it.',
      modelIdRequired: 'Model ID is required.',
      modelIdDuplicate: 'Model ID must be unique.',
      modelNameInvalid: 'Display name cannot be empty.',
      modelContextInvalid: 'Context window must be a positive count, like 131072, 256K, or 1M.',
      modelMaxTokensInvalid: 'Max output tokens must be a positive count, like 8192, 64K, or 1M.',
      advancedHint: 'Other fields live in settings.yaml; edit that section directly.',
      modelCapacityInvalid: 'A capacity must be a number, optionally suffixed K or M.',
      modelDuplicate: 'Each model ID may appear once.',
      modelContextWindow: 'Context window',
      modelMaxTokens: 'Max output tokens',
      modelInput: 'Input modalities',
      inputInherit: 'Not declared (inherits)',
      inputText: 'Text only',
      inputBoth: 'Text + image',
      inputRaw: 'Keep as-is',
      defaultInput: 'Default input modalities',
      defaultInputHint: 'Models on this route that declare no modalities inherit this value. When nothing is declared, the host serves them as text only — paste an image and the request is refused.',
      customApiCatalogHint: 'Leave this as is when the bundled catalog already describes the route; set it only when you list a model that catalog does not describe — such a model cannot inherit a protocol and the save is refused without one.',
      catalogReplacedHint: 'This list replaces the provider catalog for this route: models you do not list stop being offered.',
      fetchSourceCatalog: 'Source: the bundled pi-ai catalog (a snapshot that may lag behind the provider).',
      fetchSourceEndpoint: 'Source: the provider endpoint (live).',
      fetchModels: 'Fetch available models',
      fetching: 'Asking the provider…',
      fetchNeedsBaseUrl: 'Enter the base URL first, then fetch.',
      fetchEmpty: 'The provider listed no models. Add them by hand.',
      fetchTitle: 'Choose models to add',
      fetchDescription: 'These are the models this provider has available. Choose the ones to add.',
      fetchSearch: 'Search models',
      fetchNoMatches: 'No matching models.',
      fetchSelectAll: 'Select all',
      fetchDeselectAll: 'Deselect all',
      fetchAdopt: 'Add selected',
      customAdd: 'Add a custom provider',
      customTitle: 'Custom provider',
      customTag: 'Custom',
      customRoute: 'Provider ID',
      customRouteHint: 'Lowercase identifier, starting with a letter, that uniquely names this provider in requests and as its credential name.',
      customRouteInvalid: 'Start with a lowercase letter; then lowercase letters, digits, and dashes.',
      customRouteTaken: 'A provider already uses this ID.',
      customDisplayName: 'Display name',
      customApi: 'API protocol',
      customApiUnset: 'Not selected',
      customNeedsBaseUrl: 'A custom provider needs a base URL.',
      customBaseUrlInvalid: 'Enter a valid HTTP or HTTPS URL.',
      customNeedsModels: 'A custom provider needs at least one model.',
      customBaseUrlPlaceholder: 'https://gateway.example/v1',
      settingsPathUnresolvable: 'unresolvable settings path',
      create: 'Create provider',
      creating: 'Creating…',
      welcomeTitle: 'Internal Testing Notice',
      welcomeBody: 'DeepSeek Harness 0.1 remains in testing for Harness developers. Many areas need further improvement, and we welcome feedback from the developer community. DeepSeek Harness\'s core plugins and foundational APIs will continue to evolve rapidly over the coming months.\n\nWe look forward to exploring the limits of intelligence with developers around the world, building on open-source, open, reusable, and composable infrastructure. We welcome Harness developers everywhere to join the DSH plugin ecosystem.',
      welcomeContinue: 'Continue',
      welcomeError: 'The acknowledgement could not be saved. Please try again.',
      onboardingTitle: 'Add an API key to get started',
      onboardingDescription: 'Configure the official DeepSeek provider to start building.',
      onboardingLater: 'Configure later',
      onboardingSave: 'Save and continue',
      onboardingSaving: 'Saving…',
      keyRequired: 'Enter an API key to continue.',
    }

    const zh = {
      nav: '模型',
      title: '模型',
      intro: '填入各提供方的 API 密钥即可使用其模型。',
      edit: '编辑',
      editProvider: '编辑 {provider}',
      remove: '删除',
      removeProvider: '删除 {provider}',
      deleteTitle: '删除 {provider}？',
      deleteDescription: '删除 {provider} 会移除其配置；其使用的凭证（如有）由其他位置管理，将会保留。',
      deleteDescriptionWithCredential: '删除 {provider} 会移除其配置和存储的 API 密钥。',
      deleteConfirm: '删除 {provider}',
      deleting: '正在删除 {provider}…',
      add: '添加提供方',
      provider: '提供方',
      close: '关闭',
      cancel: '取消',
      apply: '保存',
      applying: '保存中…',
      savedProvider: '已保存 {provider}。',
      credentialConfigured: 'API 密钥已配置',
      credentialMissing: 'API 密钥缺失',
      readOnly: '当前部署的设置文档为只读。',
      loadFailed: '加载提供方目录失败',
      conflict: '这张卡片打开期间，这些设置已被其他地方改动。请关闭后重新打开，在当前值上编辑。',
      retry: '重试',
      keyInput: 'API 密钥',
      keyPlaceholder: '输入 API 密钥',
      keyPlaceholderNative: '输入 API 密钥，或留空使用环境认证',
      keyStored: '已配置——输入新值可替换',
      keyEnvLocked: '由启动环境提供（只读）',
      headers: '请求头',
      headersHint: '该网关要求的额外请求头；保存在设置里，对该路由的每个请求都会发送。',
      headerName: '名称',
      headerValue: '值',
      addHeader: '添加请求头',
      removeHeader: '删除请求头',
      headerNameInvalid: '请求头名称只能包含字母、数字与 !#$%&\'*+-.^_`|~。',
      headerValueInvalid: '请求头值不能包含换行或控制字符，且每个字符必须能用一个字节表示——中文一类非 ASCII 文本放不进 HTTP 头。',
      headerNameDuplicate: '该请求头已存在。',
      headerEmpty: '暂无额外请求头。',
      opencodeHint: '该路由指向 opencode 网关。opencode 要求每个请求都带稳定的会话 ID（x-opencode-session），缺失时上游拒绝路由并返回 400 MissingSessionID（同时失去路由与提示缓存优化）。',
      opencodeGenerate: '生成会话 ID',
      opencodeStaticNote: '该值每个路由生成一次，本路由的所有会话共用。',
      customized: '自定义设置',
      baseUrl: 'API 地址',
      baseUrlDefault: '提供方默认',
      models: '模型目录',
      modelsInherited: '正在使用适配器默认模型',
      modelsCustomized: '已自定义模型目录',
      resetModels: '恢复默认模型',
      model: '模型',
      modelId: '模型 ID',
      modelName: '显示名称',
      modelNamePlaceholder: '留空时使用模型 ID',
      contextWindow: '上下文窗口',
      contextWindowPlaceholder: '使用提供方默认值',
      maxTokens: '最大输出 token 数',
      maxTokensPlaceholder: '使用提供方默认值',
      modelAdvanced: '容量',
      addModel: '添加模型',
      removeModel: '删除模型',
      modelsEmpty: '模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。',
      keyBlank: '请输入 API 密钥；留空则保持已存储的密钥。',
      keyBlankNew: '请输入 API 密钥；若该提供方以其他方式鉴权，可以留空。',
      keyIllegalCharacters: '该 API 密钥格式错误，请检查。',
      modelIdRequired: '模型 ID 不能为空。',
      modelIdDuplicate: '模型 ID 不能重复。',
      modelNameInvalid: '显示名称不能为空。',
      modelContextInvalid: '上下文窗口必须是正数，例如 131072、256K 或 1M。',
      modelMaxTokensInvalid: '最大输出 token 数必须是正数，例如 8192、64K 或 1M。',
      advancedHint: '其余字段在 settings.yaml 中，请直接编辑对应段。',
      modelCapacityInvalid: '容量需为数字，可加 K 或 M 后缀。',
      modelDuplicate: '每个模型 ID 只能出现一次。',
      modelContextWindow: '上下文窗口',
      modelMaxTokens: '最大输出 token',
      modelInput: '输入模态',
      inputInherit: '不声明（继承）',
      inputText: '仅文本',
      inputBoth: '文本 + 图像',
      inputRaw: '保持原样',
      defaultInput: '默认输入模态',
      defaultInputHint: '本路由中未单独声明模态的模型都继承此值。完全不声明时，host 按仅文本处理——贴图会被上游闸门拒绝。',
      customApiCatalogHint: '内置目录已描述的路由保持现状即可；只有当你列出目录未收录的模型时才需要在这里指定协议——这类模型没有可继承的协议，不指定会被拒绝保存。',
      catalogReplacedHint: '这份列表会替换该路由的提供方目录：未列出的模型将不再提供。',
      fetchSourceCatalog: '来源：pi-ai 内置目录（快照，可能滞后于提供方）。',
      fetchSourceEndpoint: '来源：提供方端点（实时）。',
      fetchModels: '获取可用模型',
      fetching: '正在询问提供方…',
      fetchNeedsBaseUrl: '请先填写 API 地址，再获取。',
      fetchEmpty: '该提供方没有列出任何模型，请手动添加。',
      fetchTitle: '选择要添加的模型',
      fetchDescription: '以下是模型提供方的可用模型，勾选要添加的模型。',
      fetchSearch: '搜索模型',
      fetchNoMatches: '没有匹配的模型。',
      fetchSelectAll: '全选',
      fetchDeselectAll: '取消全选',
      fetchAdopt: '添加所选',
      customAdd: '添加自定义提供方',
      customTitle: '自定义提供方',
      customTag: '自定义',
      customRoute: 'Provider ID',
      customRouteHint: '以小写字母开头的标识，在请求中唯一标识该提供方，并用于派生凭据名。',
      customRouteInvalid: '需以小写字母开头，之后可用小写字母、数字和短横线。',
      customRouteTaken: '已有提供方使用了这个 ID。',
      customDisplayName: '显示名称',
      customApi: 'API 协议',
      customApiUnset: '未选择',
      customNeedsBaseUrl: '自定义提供方需要填写 API 地址。',
      customBaseUrlInvalid: '请输入有效的 HTTP 或 HTTPS 地址。',
      customNeedsModels: '自定义提供方至少需要一个模型。',
      customBaseUrlPlaceholder: 'https://gateway.example/v1',
      settingsPathUnresolvable: '无法解析设置路径',
      create: '创建提供方',
      creating: '创建中…',
      welcomeTitle: '内测声明',
      welcomeBody: 'DeepSeek Harness 目前的 0.1 版本仍处在面向 Harness 开发者进行测试的阶段，还有许多地方需要持续改进和打磨，希望听取广大开发者的反馈建议。预计 DeepSeek Harness 的核心插件以及基础 API 都会在接下来的一段时间内快速迭代、持续演化。\n\n我们期待与全球开发者一起，在开源、开放、可复用、可组合的基础设施之上，共同探索智能上限。欢迎全球 Harness 开发者加入 DSH 插件生态。',
      welcomeContinue: '继续',
      welcomeError: '暂时无法保存确认状态，请重试。',
      onboardingTitle: '添加一个 API Key 开始使用',
      onboardingDescription: '配置 DeepSeek 官方模型，即可开始使用。',
      onboardingLater: '稍后配置',
      onboardingSave: '保存并继续',
      onboardingSaving: '保存中…',
      keyRequired: '请输入 API 密钥后继续。',
    }

    // ── 样式（自有 class `dsfm-` + 官方 --dsw-* token；布局关键项 important 化，坑 19）──

    const CSS_TEXT = [
      '.dsfm-section{display:flex!important;flex-direction:column!important;gap:12px!important;max-width:720px;color:var(--dsw-alias-label-primary)}',
      '.dsfm-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}',
      '.dsfm-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}',
      '.dsfm-notice{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label)}',
      '.dsfm-savedNotice{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}',
      '.dsfm-rows{display:flex!important;flex-direction:column!important;gap:8px!important;margin:12px 0 0!important;padding:0!important;list-style:none!important}',
      '.dsfm-rowCard{display:flex!important;flex-direction:column!important;gap:12px!important;padding:12px 14px!important;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px}',
      '.dsfm-rowHead{display:flex!important;align-items:center!important;gap:10px!important}',
      '.dsfm-rowIdentity{display:inline-flex!important;align-items:center!important;gap:6px!important;min-width:0}',
      '.dsfm-rowName{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.dsfm-rowTag{flex:none;padding:1px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l3);border-radius:4px}',
      '.dsfm-dot{display:inline-block!important;flex:none;width:8px;height:8px;border-radius:50%}',
      '.dsfm-dotOn{background:var(--dsw-alias-state-success-primary)}',
      '.dsfm-dotOff{background:var(--dsw-alias-state-error-primary)}',
      '.dsfm-rowActions{display:inline-flex!important;align-items:center!important;gap:4px!important;margin-left:auto!important}',
      '.dsfm-btn{display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:4px!important;box-sizing:border-box;height:36px;padding:0 14px;font:inherit;font-size:14px;line-height:22px;cursor:pointer;border:none;border-radius:18px}',
      '.dsfm-btn:disabled{cursor:default;opacity:.5}',
      '.dsfm-btnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dsfm-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dsfm-btnSecondary{background:transparent;color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l3)}',
      '.dsfm-btnSecondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsfm-btnDanger{background:transparent;color:var(--dsw-alias-state-error-primary);border:.5px solid var(--dsw-alias-state-error-primary)}',
      '.dsfm-btnDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsfm-btnAdd{background:transparent;color:var(--dsw-alias-label-primary);border:.5px dashed var(--dsw-alias-border-l3)}',
      '.dsfm-btnAdd:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsfm-btnSm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:14px}',
      '.dsfm-linkBtn{padding:0;font:inherit;font-size:12px;line-height:18px;cursor:pointer;color:var(--dsw-alias-button-info-fill,#4d6bfe);background:none;border:none}',
      '.dsfm-linkBtn:disabled{cursor:default;opacity:.5}',
      '.dsfm-iconBtn{display:inline-flex!important;align-items:center!important;justify-content:center!important;width:24px;height:24px;padding:0;cursor:pointer;color:var(--dsw-alias-label-tertiary);background:none;border:none;border-radius:6px}',
      '.dsfm-iconBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsfm-iconBtn:disabled{cursor:default;opacity:.4}',
      '.dsfm-editor{display:flex!important;flex-direction:column!important;gap:12px!important}',
      '.dsfm-editorHead{display:flex!important;align-items:baseline!important;gap:8px!important}',
      '.dsfm-editorTitle{font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.dsfm-editorRoute{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dsfm-editorActions{display:flex!important;justify-content:flex-end!important;align-items:center!important;gap:8px!important;margin-top:4px}',
      '.dsfm-field{display:flex!important;flex-direction:column!important;gap:6px!important}',
      '.dsfm-fieldLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsfm-input{box-sizing:border-box;width:100%;height:36px;padding:0 12px;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3,transparent);border:.5px solid var(--dsw-alias-border-l3);border-radius:10px}',
      '.dsfm-input:focus{outline:none;border-color:var(--dsw-alias-button-info-fill,#4d6bfe)}',
      '.dsfm-input:disabled{opacity:.6}',
      '.dsfm-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      '.dsfm-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dsfm-customized{border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;padding:10px 12px}',
      '.dsfm-customized>summary{cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.dsfm-customizedBody{display:flex!important;flex-direction:column!important;gap:12px!important;padding-top:12px!important}',
      '.dsfm-catalog{display:flex!important;flex-direction:column!important;gap:8px!important}',
      '.dsfm-catalogHead{display:flex!important;align-items:baseline!important;gap:8px!important}',
      '.dsfm-catalogTitle{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dsfm-catalogMeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dsfm-catalogHead .dsfm-linkBtn{margin-left:auto!important}',
      '.dsfm-modelList{display:flex!important;flex-direction:column!important;gap:6px!important}',
      '.dsfm-modelEntry{display:flex!important;flex-direction:column!important;gap:6px!important;padding:6px 0!important;border-bottom:.5px solid var(--dsw-alias-border-l4)}',
      '.dsfm-modelRow{display:flex!important;align-items:center!important;gap:6px!important}',
      '.dsfm-modelRow .dsfm-input{flex:1!important;min-width:0}',
      '.dsfm-modelFields{display:flex!important;gap:12px!important;padding:2px 0 4px 20px!important}',
      '.dsfm-headerList{display:flex!important;flex-direction:column!important;gap:6px!important}',
      '.dsfm-headerRow{display:flex!important;align-items:center!important;gap:6px!important}',
      '.dsfm-headerRow .dsfm-input{flex:1!important;min-width:0}',
      '.dsfm-modelField{display:flex!important;flex-direction:column!important;gap:4px!important;flex:1!important;min-width:0}',
      '.dsfm-modelFieldLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.dsfm-modelEmpty{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dsfm-addBlock{display:flex!important;flex-direction:column!important;gap:12px!important;margin-top:4px!important}',
      '.dsfm-addActions{display:flex!important;gap:8px!important;flex-wrap:wrap!important}',
      '.dsfm-addCard{display:flex!important;flex-direction:column!important;gap:12px!important;padding:14px!important;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px}',
      '.dsfm-pickerToolbar{display:flex!important;align-items:center!important;gap:8px!important}',
      '.dsfm-pickerToolbar .dsfm-input{flex:1!important}',
      '.dsfm-candidateList{display:flex!important;flex-direction:column!important;max-height:320px;margin-top:12px!important;overflow-y:auto}',
      '.dsfm-candidate{display:flex!important;align-items:center!important;gap:8px!important;padding:8px 4px!important;cursor:pointer;border-bottom:.5px solid var(--dsw-alias-border-l4)}',
      '.dsfm-candidateId{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dsfm-candidateLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dsfm-candidateEmpty{margin:12px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dsfm-onbContent{display:flex!important;flex-direction:column!important;box-sizing:border-box;max-height:calc(100vh - 48px);padding:28px;overflow-y:auto}',
      '.dsfm-onbTitle{margin:0;font-size:20px;font-weight:500;line-height:28px;color:var(--dsw-alias-label-primary);outline:none}',
      '.dsfm-onbBody{margin-top:20px}',
      '.dsfm-onbCopy{font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary)}',
      '.dsfm-onbCopy p{margin:0}',
      '.dsfm-onbCopy p+p{margin-top:12px}',
      '.dsfm-onbError{margin:16px 0 0;font-size:14px;line-height:22px;color:var(--dsw-alias-state-error-primary)}',
      '.dsfm-onbActions{display:flex!important;justify-content:flex-end!important;margin-top:24px!important}',
    ].join('')

    /** 注入自有样式表（幂等；id 固定便于热重载替换）。 */
    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-forge-settings-models-css') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-forge-settings-models-css'
      style.textContent = CSS_TEXT
      document.head.appendChild(style)
    }

    // ── 纯函数层（导出给单测；语义逐条对齐官方）─────────────────────────

    /** 合法 API Key 字符集（与 @deepseek-ai/dsh-llm 的 normalizeApiKey 同步）。 */
    const LEGAL_API_KEY = /^[\x21-\x7E]+$/
    /** 误粘贴的 `NAME=value` 环境行（大写名 + 单个等号开头）。 */
    const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/
    /** 手声明路由 id 形态：小写字母开头的小写字母/数字/短横线。 */
    const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
    /** 容量写法：十进制数 + 可选 K/M 后缀（1M = 1000K，按模型容量惯用口径）。 */
    const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i
    const CAPACITY_SCALE = { k: 1e3, m: 1e6 }
    /** 空容量字段的提示值（适配器路由级默认的常见量级，仅作提示）。 */
    const CAPACITY_HINT = { contextWindow: '256K', maxTokens: '32K' }
    /** DeepSeek 公共端点（baseURL placeholder）。 */
    const DEEPSEEK_PUBLIC_BASE_URL = 'https://api.deepseek.com'
    /** 协议候选的探针路由 id：不可能与已配置路由冲突。 */
    const PROBE_ROUTE = '\0probe'

    /** 值是否被一对匹配的引号包裹。 */
    function isQuoted(value) {
      const first = value[0]
      if (first !== '"' && first !== "'" && first !== '`') return false
      return value.length > 1 && value.endsWith(first)
    }

    /**
     * 判断密钥输入框当前值：空=通过（留空表示保留既有密钥）；仅空白/非法字符=报错键。
     * @param draft 未修剪的输入值。
     * @returns 文案键，或 undefined 表示可提交。
     */
    function apiKeyFailure(draft) {
      if (draft.length === 0) return undefined
      const value = draft.trim()
      if (value.length === 0) return 'keyBlank'
      if (ENV_LINE.test(value) || isQuoted(value)) return 'keyIllegalCharacters'
      if (!LEGAL_API_KEY.test(value)) return 'keyIllegalCharacters'
      return undefined
    }

    /**
     * 读取可带 K/M 后缀的容量输入。空=undefined（继承），不可读=NaN（提交前被校验拦下）。
     * @param text 字段原文。
     * @returns 计数。
     */
    function parseCapacity(text) {
      const trimmed = text.trim()
      if (trimmed.length === 0) return undefined
      const match = CAPACITY_PATTERN.exec(trimmed)
      if (match === null) return NaN
      const suffix = match[2] === undefined ? undefined : match[2].toLowerCase()
      const scale = suffix === 'k' || suffix === 'm' ? CAPACITY_SCALE[suffix] : 1
      const scaled = Number(match[1]) * scale
      const rounded = Math.round(scaled)
      return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled
    }

    /** 把存量计数拼回最短且能往返的写法。 */
    function formatCapacity(value) {
      if (!Number.isInteger(value) || value <= 0) return String(value)
      if (value % CAPACITY_SCALE.m === 0) return `${String(value / CAPACITY_SCALE.m)}M`
      if (value % CAPACITY_SCALE.k === 0) return `${String(value / CAPACITY_SCALE.k)}K`
      return String(value)
    }

    /** 可能未设置的容量字段文本（未设置=空串）。 */
    function capacitySpelling(value) {
      return value === undefined ? '' : formatCapacity(value)
    }

    // ── 输入模态（`models[].input` 与路由 `defaultInput` 共用一套三态）──────
    // 为什么必须有这个控件：模态**不在探测回包里**（`llm/discoverModels` 只回
    // id/name/contextWindow/maxTokens），而目录未收录的模型也没有 `base.input` 可继承
    // （pi-ai 的 `dsh-llm-pi-ai` 按 `entry.input ?? base.input ?? defaultInput` 逐层回落），
    // 于是手填模型一律落成 `defaultInput` 的 schema 默认 `["text"]` → 贴图会被
    // 会话控制器拒绝（`Model "…" does not support image input.`，读
    // `inputModalities` 的那道闸门）。目录里 `deepseek-v4.1-flash` 这类多模态模型
    // 因此变成"能选不能发图"，且旧版页面没有任何字段能改它。

    /**
     * 模态声明的规范化三态（外加一个"原样保留"态）。
     *
     * - `inherit`：空数组/缺席 = **未声明**（schema 把缺席 materialize 成 `[]`，pi-ai 的
     *   `declaredInput()` 把空数组读作"无答案"→ 继续回落下一层）；
     * - `text` / `both`：两个规范组合，分别写 `["text"]` / `["text","image"]`；
     * - `raw`：既非空也非规范组合（如仅 `["image"]`，或带重复项的数组）。**保留原值不改写**，
     *   只在界面上显示原始内容——编辑器不该悄悄替用户重写它看不懂的值。
     * @param list 声明的模态数组（`models[].input` 或 `defaultInput`），可空。
     * @returns 规范化选择键。
     */
    function modalityChoiceOf(list) {
      const values = Array.isArray(list) ? list.filter((item) => item === 'text' || item === 'image') : []
      if (values.length === 0) return 'inherit'
      const hasText = values.includes('text')
      const hasImage = values.includes('image')
      if (hasText && hasImage && values.length === 2) return 'both'
      if (hasText && values.length === 1) return 'text'
      return 'raw'
    }

    /**
     * 规范化选择键 → 要写入的模态数组。
     * `inherit`（清空声明）与 `raw`（保留原值，选择器不会产生它）都返回 undefined，
     * 调用方据此**删除该键**而不是写空数组——空数组与新键在 schema 里语义不同。
     * @param choice {@link modalityChoiceOf} 的返回值。
     * @returns `["text"]` / `["text","image"]`，或 undefined 表示不声明。
     */
    function modalitiesFromChoice(choice) {
      if (choice === 'text') return ['text']
      if (choice === 'both') return ['text', 'image']
      return undefined
    }

    /** 把 schema 校验过的目录值转成不丢隐藏字段的记录数组。 */
    function modelDrafts(value) {
      if (!Array.isArray(value)) return []
      return value.map((entry) => (typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry : {}))
    }

    /** 一行的文本字段，未设置或非字符串时为空串。 */
    function textOf(model, key) {
      const value = model[key]
      return typeof value === 'string' ? value : ''
    }

    /** 一行的数值字段，未设置或非数字时为 undefined。 */
    function numberOf(model, key) {
      const value = model[key]
      return typeof value === 'number' ? value : undefined
    }

    /** 编辑缓冲键里编码的行号。 */
    function rowOf(key) {
      return Number(key.slice(0, key.indexOf(':')))
    }

    /**
     * 校验序列化 schema 表达不了的适配器约束。
     * @param value 用户层 `models` 值，或 undefined（继承态）。
     * @returns {index, key} 首个非法行，或 undefined。
     */
    function validateDeepSeekModels(value) {
      if (value === undefined) return undefined
      const models = modelDrafts(value)
      const seen = new Set()
      for (const [index, model] of models.entries()) {
        const id = model.id
        const trimmed = typeof id === 'string' ? id.trim() : undefined
        if (trimmed === undefined || trimmed.length === 0) return { index, key: 'modelIdRequired' }
        if (seen.has(trimmed)) return { index, key: 'modelIdDuplicate' }
        seen.add(trimmed)
        const name = model.name
        if (name !== undefined && (typeof name !== 'string' || name.length === 0)) return { index, key: 'modelNameInvalid' }
        const contextWindow = model.contextWindow
        if (contextWindow !== undefined && (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow <= 0)) {
          return { index, key: 'modelContextInvalid' }
        }
        const maxTokens = model.maxTokens
        if (maxTokens !== undefined && (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0)) {
          return { index, key: 'modelMaxTokensInvalid' }
        }
      }
      return undefined
    }

    /**
     * 把「已声明可配置提供方」与「当前已注册路由」join 成页面行。
     * @param registered 已注册路由（注册序）。
     * @param directory 已声明可配置提供方（声明序）。
     * @returns 官方顺序：声明行在前，未声明的在线路由在后。
     */
    function joinProviderDirectory(registered, directory) {
      const active = new Set(registered.map((provider) => provider.id))
      const declared = new Set(directory.map((entry) => entry.provider))
      const rows = directory.map((entry) => ({
        provider: entry.provider,
        displayName: entry.displayName,
        settingsNs: entry.settingsNs,
        settingsPath: [...entry.settingsPath],
        active: active.has(entry.provider),
        ...(entry.declared === undefined ? {} : { declared: entry.declared }),
        ...(entry.error === undefined ? {} : { error: entry.error }),
      }))
      for (const provider of registered) {
        if (declared.has(provider.id)) continue
        rows.push({
          provider: provider.id,
          displayName: provider.name,
          settingsNs: '',
          settingsPath: [],
          active: true,
        })
      }
      return rows
    }

    /** 推导提供方的惯例凭据引用：`<ROUTE>_API_KEY`（非字母数字连续段归一为 `_`）。 */
    function deriveKeyRef(provider) {
      return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
    }

    /** 手声明路由可选的传输协议：读命名空间 schema 自身（与适配器接受的集合不会漂移）。 */
    function protocolChoices(namespace, schema) {
      if (namespace === undefined) return []
      const list = schema.nodeAtPath(schema.rehydrate(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
      if (list === undefined || list === null || list.type !== 'union' || list.list === undefined) return []
      return list.list.map((entry) => entry.value).filter((value) => typeof value === 'string')
    }

    /** 已解析 profile 记录的凭据引用（`apiKeyEnv`）。 */
    function apiKeyEnvOf(namespace, path, schema) {
      if (namespace === undefined) return undefined
      const profile = schema.getPath(namespace.value, path)
      if (typeof profile !== 'object' || profile === null) return undefined
      const ref = profile.apiKeyEnv
      return typeof ref === 'string' && ref.length > 0 ? ref : undefined
    }

    /**
     * 一行是否已能真正发请求：路由已注册；profile 未指名引用时视为自鉴权（无需本页密钥）。
     * @param row join 后的行。
     * @returns 用户是否已有一条可用提供方。
     */
    function providerUsable(row) {
      if (!row.entry.active) return false
      if (row.apiKeyEnv === undefined) return true
      return row.credential !== undefined && row.credential.configured === true
    }

    /**
     * 从同一份 join 快照投影首次引导就绪态：任一条可用即结束；全不可用时才落到
     * DeepSeek 官方路由（唯一能在此提示密钥的路线）判断是否值得引导。
     * @param state 页面快照。
     * @returns 就绪态判别式。
     */
    function onboardingReadiness(state) {
      if ((state.status === 'idle' || state.status === 'loading') && state.rows.length === 0) return { kind: 'loading' }
      if (state.status === 'error') return { kind: 'unavailable', reason: 'load-failed' }
      if (state.rows.some(providerUsable)) return { kind: 'provider-ready' }
      const row = state.rows.find((candidate) => candidate.entry.provider === DEEPSEEK_OFFICIAL_ROUTE && candidate.entry.settingsNs === DEEPSEEK_NS && candidate.entry.settingsPath.length === 0)
      if (row === undefined) return { kind: 'adapter-absent' }
      if (!row.entry.active) return { kind: 'unavailable', reason: 'provider-inactive' }
      if (state.credentialError !== null || row.credential === undefined) return { kind: 'unavailable', reason: 'credentials-unavailable' }
      if (!state.writable) return { kind: 'unavailable', reason: 'settings-read-only' }
      if (!row.credential.writable) return { kind: 'unavailable', reason: 'credential-read-only' }
      return { kind: 'credential-missing' }
    }

    /** HTTP(S) 地址判定。 */
    function isHttpUrl(value) {
      try {
        const protocol = new URL(value).protocol
        return protocol === 'http:' || protocol === 'https:'
      } catch {
        return false
      }
    }

    /** 用户层某个子树（缺席=空对象）。 */
    function draftAt(schema, namespace, path) {
      const subtree = schema.getPath(namespace.user, path)
      if (typeof subtree !== 'object' || subtree === null || Array.isArray(subtree)) return {}
      return structuredClone(subtree)
    }

    /**
     * 把 `after` 相对 `before` 的最小差异写成路径操作：只命名卡片看得见的键。
     * @param base 被编辑子树在用户段中的路径。
     * @param before 载入时的子树，或 undefined（新建）。
     * @param after 编辑后的子树。
     * @returns 有序 set/unset 操作；无变化时为空。
     */
    function pathOps(base, before, after) {
      const previous = typeof before === 'object' && before !== null && !Array.isArray(before) ? before : {}
      const previousRecord = /** @type {Record<string, unknown>} */ (previous)
      const ops = []
      for (const [key, value] of Object.entries(after)) {
        if (JSON.stringify(previousRecord[key]) === JSON.stringify(value)) continue
        ops.push({ op: 'set', path: [...base, key], value })
      }
      for (const key of Object.keys(previousRecord)) {
        if (!(key in after)) ops.push({ op: 'unset', path: [...base, key] })
      }
      return ops
    }

    /** 命名空间对应的编辑器布局。 */
    function layoutOf(ns) {
      if (ns === DEEPSEEK_NS) return 'deepseek'
      if (ns === PI_AI_NS) return 'pi-ai'
      return 'unknown'
    }

    /** 该 profile 解析密钥所用的凭据引用。 */
    function refFor(schema, namespace, path, provider) {
      const profile = schema.getPath(namespace.value, path)
      const named = typeof profile === 'object' && profile !== null ? profile.apiKeyEnv : undefined
      return typeof named === 'string' && named.length > 0 ? named : deriveKeyRef(provider)
    }

    // ── 请求头（网关附加要求；写 profile 的 `headers` 字典）────────────────
    // 背景：上游 profile schema 本就有 `headers`（`z.dict(z.string())`，pi-ai 三条发请求
    // 路径都会带上），但官方设置页不暴露它——于是「网关要求自定义头」在官方 UI 里无路可走
    // （opencode 网关要 `x-opencode-session`，缺了直接 400 MissingSessionID）。自有件补上。

    /** RFC 7230 token：请求头名称合法字符集（对齐上游 `assertValidHeaders` 的口径）。 */
    const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
    /**
     * 请求头值：可见 ASCII + 水平制表 + obs-text；禁 CR/LF/NUL 等控制字符。
     *
     * 上限钉在 `\xFF` 不是随手取的：上游 `assertValidHeaders` 的真身就是
     * `new Headers([[name, value]])` 包在 try/catch 里，即**用 undici 的 ByteString 检查**兜底
     * （错误文案 "…representable as bytes"）；码元 > `0xFF` 的字符（中文等）在真实发请求时
     * 直接抛 `TypeError`，表现为「填的时候没报错、一发消息就炸」。故此处**前置拦掉**，
     * 见坑 76（该坑正是「中文标签进不了 undici」）。
     */
    const HEADER_VALUE_PATTERN = /^[\t\x20-\x7E\x80-\xFF]*$/

    /**
     * 该路由是否指向 opencode 网关：路由 id 以 `opencode` 开头，或 baseURL host 属于 opencode.ai。
     * @param provider 路由 id。
     * @param baseURL 配置的 API 地址（可空）。
     * @returns 是否 opencode 网关。
     */
    function isOpencodeGateway(provider, baseURL) {
      if (typeof provider === 'string' && provider.toLowerCase().startsWith('opencode')) return true
      if (typeof baseURL !== 'string' || baseURL.length === 0) return false
      try {
        const host = new URL(baseURL).hostname.toLowerCase()
        return host === 'opencode.ai' || host.endsWith('.opencode.ai')
      } catch {
        return false
      }
    }

    /** 请求头字典 → 有序行（非对象读作空表；非字符串值按字符串看待）。 */
    function headerRows(headers) {
      if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return []
      return Object.entries(headers).map(([name, value]) => ({ name, value: typeof value === 'string' ? value : String(value) }))
    }

    /** 大小写不敏感地判断某请求头是否已在表中。 */
    function hasHeader(headers, name) {
      const target = name.toLowerCase()
      return headerRows(headers).some((row) => row.name.toLowerCase() === target)
    }

    /**
     * 校验一行请求头。
     * @param row 待校验行。
     * @param rows 全表（用于重名判定）。
     * @returns 文案键，或 undefined 表示合法。
     */
    function headerRowFailure(row, rows) {
      // 刚添加、尚未填写的空行不算错（否则「添加请求头」一按就卡住提交）。
      if (row.name.trim().length === 0 && row.value.length === 0) return undefined
      const name = row.name.trim()
      if (name.length === 0 || !HEADER_NAME_PATTERN.test(name)) return 'headerNameInvalid'
      if (!HEADER_VALUE_PATTERN.test(row.value) || row.value.trim() !== row.value) return 'headerValueInvalid'
      const target = name.toLowerCase()
      const first = rows.findIndex((candidate) => candidate.name.trim().toLowerCase() === target)
      const self = rows.indexOf(row)
      if (first !== -1 && self !== -1 && first !== self) return 'headerNameDuplicate'
      return undefined
    }

    /** 全表首行非法项（提交闸门）。 */
    function firstHeaderFailure(rows) {
      for (let index = 0; index < rows.length; index += 1) {
        const failure = headerRowFailure(rows[index], rows)
        if (failure !== undefined) return { index, key: failure }
      }
      return undefined
    }

    /** 生成一个稳定的会话 ID（opencode 的 `x-opencode-session` 值）。 */
    function newSessionId() {
      const cryptoApi = typeof crypto === 'undefined' ? undefined : crypto
      if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
      const bytes = []
      for (let index = 0; index < 16; index += 1) bytes.push(Math.floor(Math.random() * 256))
      const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }

    /**
     * 整节提供方是否仍需首次密钥：非首次姿态（已有可用提供方）不再弹卡片。
     * @param row join 后的行。
     * @param anyUsable 是否已有任一可用行。
     * @returns 是否渲染首次配置卡片。
     */
    function needsSetup(row, anyUsable) {
      if (anyUsable) return false
      if (row.entry.settingsPath.length > 0) return false
      return !(row.credential !== undefined && row.credential.configured === true)
    }

    /** provider-card 扩展位的凭证事实（profile 引用优先，否则用页面推导引用）。 */
    function keyConfiguredOf(row) {
      if (row.apiKeyEnv !== undefined) return row.credential !== undefined && row.credential.configured === true
      return row.derivedCredential !== undefined && row.derivedCredential.configured === true
    }

    /** 行 → 编辑目标（仅当密钥确为本页管理的引用且可写时携带 credentialRef）。 */
    function targetOf(row) {
      const managedRef = deriveKeyRef(row.entry.provider)
      const credentialRef = row.apiKeyEnv === managedRef && row.credential !== undefined && row.credential.configured === true && row.credential.writable ? managedRef : undefined
      return {
        provider: row.entry.provider,
        displayName: row.entry.displayName,
        settingsNs: row.entry.settingsNs,
        settingsPath: row.entry.settingsPath,
        ...(credentialRef === undefined ? {} : { credentialRef }),
        ...(row.entry.declared === true ? { declared: true } : {}),
      }
    }

    /** 一个目标的稳定可见与无障碍标识。 */
    function providerTargetLabel(target) {
      return target.provider === target.displayName ? target.provider : `${target.displayName} (${target.provider})`
    }

    /** 替换破坏性操作文案里的唯一 provider 占位符。 */
    function providerCopy(template, target) {
      return template.replace('{provider}', () => providerTargetLabel(target))
    }

    /**
     * 删除一个用户添加的提供方及其由本页管理的凭据。先删凭据，使第二步失败时行仍在、
     * 整个操作可安全重试（两次 unset 都幂等）。
     * @param operations host 操作面。
     * @param controller 页面 store。
     * @param target 提供方的 settings 地址与可选受管凭据。
     * @returns 失败文案，或 undefined 表示写入与重载都完成。
     */
    async function removeProviderProfile(operations, controller, target) {
      if (target.credentialRef !== undefined) {
        const credential = await operations.removeCredential(target.credentialRef)
        if (credential !== undefined) return credential
      }
      const written = await operations.writeSettings(target.settingsNs, [{ op: 'unset', path: [...target.settingsPath] }], undefined)
      if (written.kind !== 'written') return written.message
      await controller.load()
      return undefined
    }

    /** 采纳一个探测候选，保留提供方披露的容量。 */
    function adopt(candidate) {
      return {
        id: candidate.id,
        ...(candidate.name === undefined ? {} : { name: candidate.name }),
        ...(candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow }),
        ...(candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens }),
      }
    }

    /** 欢迎声明段解码：非对象值读作空段（视为未确认）。 */
    function decodeWelcomeSection(section) {
      return typeof section === 'object' && section !== null && !Array.isArray(section) ? section : {}
    }

    /** 纯函数导出面（test/ 单测在 vm 沙箱内断言，生产运行时零消费）。 */
    exports.pure = {
      apiKeyFailure,
      parseCapacity,
      formatCapacity,
      capacitySpelling,
      modalityChoiceOf,
      modalitiesFromChoice,
      modelDrafts,
      validateDeepSeekModels,
      joinProviderDirectory,
      deriveKeyRef,
      protocolChoices,
      apiKeyEnvOf,
      providerUsable,
      onboardingReadiness,
      isHttpUrl,
      pathOps,
      layoutOf,
      refFor,
      isOpencodeGateway,
      headerRows,
      hasHeader,
      headerRowFailure,
      firstHeaderFailure,
      newSessionId,
      needsSetup,
      keyConfiguredOf,
      targetOf,
      providerTargetLabel,
      providerCopy,
      adopt,
      decodeWelcomeSection,
    }

    // ── host 操作面（卡片只拿回调，拿不到 ctx）────────────────────────────

    /**
     * 把页面要做的 host 读写绑成回调。卡片渲染的是「结果语义」
     * （写入视图 / 冲突 / 拒绝文案 / 探测候选），错误码与 Remote 命名空间留在 apply 世界。
     * @param ctx 插件上下文。
     * @returns 操作面。
     */
    function createModelsOperations(ctx) {
      return {
        describeCredential: async (ref) => {
          const response = await ctx.remote.credentials.describe([ref])
          return response.ok ? response.value[ref] : undefined
        },
        storeCredential: async (ref, value) => {
          const response = await ctx.remote.credentials.set(ref, value)
          return response.ok ? undefined : response.error.message
        },
        removeCredential: async (ref) => {
          const response = await ctx.remote.credentials.unset(ref)
          return response.ok ? undefined : response.error.message
        },
        writeSettings: async (ns, ops, expectedRevision) => {
          const response = await ctx.remote.settings.mutate(ns, ops, expectedRevision)
          if (response.ok) return { kind: 'written', view: response.value }
          const { code, message } = response.error
          return code === 'settings/conflict' ? { kind: 'conflict', message } : { kind: 'refused', message }
        },
        discoverModels: async (settingsNs, request) => {
          const response = await ctx.remote.llm.discoverModels(settingsNs, request)
          return response.ok ? { kind: 'found', models: response.value } : { kind: 'refused', message: response.error.message }
        },
      }
    }

    /** 把 settings 的 schema 服务收成纯回调（不把服务上下文泄进 React 组件）。 */
    function createSettingsSchemaOperations(service) {
      return {
        rehydrate: (serialized) => service.rehydrate(serialized),
        validate: (schema, draft) => service.validate(schema, draft),
        nodeAtPath: (root, path) => service.nodeAtPath(root, path),
        getPath: (value, path) => service.getPath(value, path),
        hasPath: (value, path) => service.hasPath(value, path),
        setPath: (root, path, value) => service.setPath(root, path, value),
        deletePath: (root, path) => service.deletePath(root, path),
      }
    }

    // ── 页面 store（uSES 快照面）────────────────────────────────────────

    /**
     * 模型设置页控制器：provider 目录（`llm/listProviders` ∪ `llm/listConfigurableProviders`）
     * + 设置命名空间镜像 + 被引用凭据（`credentials/describe`）的一份快照。host 是唯一事实源：
     * 每次写入都过 wire，页面由下一次 describe（推送或重载）重渲染。
     */
    class ModelsSettingsStore {
      /**
       * @param ctx 页面插件上下文（`remote.llm` / `remote.credentials`）。
       * @param schema settings 的 schema 与不可变路径操作。
       * @param describeFace 共享镜像的 describe 面（命名空间视图与可写性）。
       */
      constructor(ctx, schema, describeFace) {
        this.ctx = ctx
        this.schema = schema
        this.describeFace = describeFace
        this.store = createSnapshotStore({
          status: 'idle',
          error: null,
          credentialError: null,
          writable: false,
          rows: [],
          namespaces: new Map(),
        })
        /** 后来者胜：旧响应永不覆盖新响应。 */
        this.generation = 0
      }

      /**
       * 刷新整页快照：provider 目录与镜像的 settings 答案并行取，再对全部被引用 ref 做一次
       * 批量 credential describe。provider 失败或首次 settings 无答案时保留上次好行并给出错误；
       * settings 刷新失败则复用镜像持有的视图。
       */
      async load() {
        const generation = ++this.generation
        this.store.update((s) => {
          s.status = 'loading'
          s.error = null
        })
        const [registered, declared] = await Promise.all([
          this.ctx.remote.llm.listProviders(),
          this.ctx.remote.llm.listConfigurableProviders(),
          this.describeFace.ensure(),
        ])
        if (!registered.ok) {
          this.failLoad(generation, registered.error.message)
          return
        }
        if (!declared.ok) {
          this.failLoad(generation, declared.error.message)
          return
        }
        const mirrored = this.describeFace.getSnapshot()
        if (mirrored.view === undefined) {
          this.failLoad(generation, mirrored.error ?? 'settings are unavailable in this browser')
          return
        }
        const providers = joinProviderDirectory(registered.value, declared.value)
        const writable = mirrored.view.writable
        const namespaces = new Map(mirrored.view.namespaces.map((view) => [view.ns, view]))
        const rows = providers.map((entry) => {
          const namespace = namespaces.get(entry.settingsNs)
          return {
            entry,
            configured: namespace !== undefined && (entry.settingsPath.length === 0 || this.schema.getPath(namespace.value, entry.settingsPath) !== undefined),
            removable: namespace !== undefined && entry.settingsPath.length > 0 && this.schema.hasPath(namespace.user, entry.settingsPath) && !this.schema.hasPath(namespace.base, entry.settingsPath),
            apiKeyEnv: apiKeyEnvOf(namespace, entry.settingsPath, this.schema),
            credential: undefined,
          }
        })
        const refs = [...new Set(rows.map((row) => row.apiKeyEnv ?? deriveKeyRef(row.entry.provider)))]
        let credentials = {}
        let credentialError = null
        if (refs.length > 0) {
          const response = await this.ctx.remote.credentials.describe(refs)
          if (response.ok) credentials = response.value
          else credentialError = response.error.message
        }
        if (generation !== this.generation) return
        this.store.update((s) => {
          s.status = 'ready'
          s.error = null
          s.credentialError = credentialError
          s.writable = writable
          s.rows = rows.map((row) => {
            const named = row.apiKeyEnv === undefined ? undefined : credentials[row.apiKeyEnv]
            const derived = row.apiKeyEnv !== undefined ? undefined : credentials[deriveKeyRef(row.entry.provider)]
            return {
              ...row,
              ...(named === undefined ? {} : { credential: named }),
              ...(derived === undefined ? {} : { derivedCredential: derived }),
            }
          })
          s.namespaces = namespaces
        })
      }

      /** 发布一次加载的失败文案，除非更新的加载已接手。 */
      failLoad(generation, message) {
        if (generation !== this.generation) return
        this.store.update((s) => {
          s.status = 'error'
          s.error = message
        })
      }
    }

    /**
     * 欢迎声明状态：由 welcome settings scope 推导。scope 是传输层——本机浏览器跟随
     * 持久 host 段，而远端浏览器的 memory 模式 scope 永不作答，确认只留在本进程内。
     */
    class WelcomeNoticeStore {
      /** @param scope welcome 命名空间 scope。 */
      constructor(scope) {
        this.scope = scope
        this.store = createSnapshotStore({ status: 'idle', acknowledged: false, error: null })
        this.localAcknowledged = false
        this.saving = false
        this.following = undefined
      }

      /** 开始跟随绑定的 scope（幂等）并发布当前答案。 */
      load() {
        this.following = this.following ?? this.scope.subscribe(() => {
          this.derive()
        })
        this.derive()
        return Promise.resolve()
      }

      /**
       * 持久化本版本文案，或在远端浏览器上只推进本进程。
       * @returns 所选持久模式是否真的握住了这次确认。
       */
      async acknowledge() {
        if (this.scope.getSnapshot().mode === 'memory') {
          this.localAcknowledged = true
          this.derive()
          return true
        }
        this.saving = true
        this.store.update((state) => {
          state.status = 'saving'
          state.error = null
        })
        try {
          await this.scope.set(WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_VERSION)
        } finally {
          this.saving = false
        }
        this.derive()
        const { acknowledged } = this.store.getSnapshot()
        if (!acknowledged) {
          this.store.update((state) => {
            state.status = 'error'
            state.error = 'the acknowledgement did not persist'
          })
        }
        return acknowledged
      }

      /** 停止跟随 scope。 */
      dispose() {
        if (this.following !== undefined) this.following()
        this.following = undefined
      }

      /** 由 scope 快照推导确认状态。 */
      derive() {
        if (this.saving) return
        const scope = this.scope.getSnapshot()
        if (scope.mode === 'memory') {
          this.store.update((state) => {
            state.status = 'ready'
            state.acknowledged = this.localAcknowledged
            state.error = null
          })
          return
        }
        if (scope.status === 'loading') {
          this.store.update((state) => {
            state.status = 'loading'
            state.error = null
          })
          return
        }
        if (scope.status === 'unavailable') {
          this.store.update((state) => {
            state.status = 'error'
            state.acknowledged = false
            state.error = 'welcome acknowledgement settings are unavailable'
          })
          return
        }
        const acknowledged = scope.value !== undefined && scope.value !== null && scope.value[WELCOME_NOTICE_ACK_FIELD] === WELCOME_NOTICE_VERSION
        this.store.update((state) => {
          state.status = 'ready'
          state.acknowledged = acknowledged
          state.error = null
        })
      }
    }

    // ── 基础钩子与小组件 ────────────────────────────────────────────────

    /** 订阅快照 store（显式 uSES，不依赖 slots 引擎的 hooks 注入约定）。 */
    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot)
    }

    /** 编辑器底部动作行（取消 / 提交）。 */
    function EditorFooter(props) {
      const { t } = props
      return h('div', { className: 'dsfm-editorActions' },
        h('button', {
          type: 'button',
          className: 'dsfm-btn dsfm-btnSecondary',
          disabled: props.busy,
          onClick: props.onCancel,
        }, t(props.cancelLabelKey ?? 'cancel')),
        h('button', {
          type: 'button',
          className: 'dsfm-btn dsfm-btnPrimary',
          disabled: props.submitDisabled,
          onClick: props.onSubmit,
        }, props.busy ? t(props.submitBusyLabelKey) : t(props.submitLabelKey)),
      )
    }

    /** 容量字段（行内折叠区里的一项）。 */
    function CapacityField(props) {
      const { model, index, field, labelKey, placeholder, t, disabled, capacityText, onEdit, onSettle } = props
      const label = t(labelKey)
      return h('label', { className: 'dsfm-modelField' },
        h('span', { className: 'dsfm-modelFieldLabel' }, label),
        h('input', {
          className: 'dsfm-input',
          type: 'text',
          inputMode: 'numeric',
          value: capacityText(model, index, field),
          placeholder,
          'aria-label': `${label} ${String(index + 1)}`,
          disabled,
          onChange: (event) => onEdit(index, field, event.target.value),
          onBlur: () => onSettle(index, field),
        }),
      )
    }

    /**
     * 输入模态选择器（模型 `input` 与路由 `defaultInput` 共用）。
     *
     * 三态 + 一个"原样保留"态，语义见 {@link modalityChoiceOf}。`onChange` 只在用户真的
     * 选了另一档时触发，并统一回传数组或 undefined（undefined = 删除该键，回到继承）；
     * `raw` 档是既有非法组合的只读展示，选中它不会改写任何值。
     */
    function ModalitySelect(props) {
      const { value, onChange, label, disabled, t } = props
      const choice = modalityChoiceOf(value)
      return h('select', {
        className: 'dsfm-input',
        value: choice,
        'aria-label': label,
        disabled,
        onChange: (event) => {
          const next = event.target.value
          if (next === 'raw') return
          onChange(modalitiesFromChoice(next))
        },
      },
        choice !== 'raw'
          ? null
          : h('option', { value: 'raw' }, `${t('inputRaw')}: ${(Array.isArray(value) ? value : []).join(', ')}`),
        h('option', { value: 'inherit' }, t('inputInherit')),
        h('option', { value: 'text' }, t('inputText')),
        h('option', { value: 'both' }, t('inputBoth')),
      )
    }

    /**
     * 直接 DeepSeek 适配器的建议模型目录编辑器：每行 id + 显示名，容量藏在行内折叠区。
     * settings 层以整数组替换 `models`，故首次编辑才落成用户覆盖；重置是移除覆盖而非抄默认值。
     */
    function DeepSeekModelsEditor(props) {
      const { models, t, disabled } = props
      const [editing, setEditing] = React.useState(() => new Map())
      const [expanded, setExpanded] = React.useState(() => new Set())
      const update = (index, key, value) => {
        props.onChange(models.map((model, at) => {
          const copy = { ...model }
          if (at !== index) return copy
          if (value === undefined) Reflect.deleteProperty(copy, key)
          else copy[key] = value
          return copy
        }))
      }
      const remove = (index) => {
        setEditing((current) => {
          const next = new Map()
          for (const [key, text] of current) {
            const at = rowOf(key)
            if (at === index) continue
            next.set(at > index ? key.replace(/^\d+/, String(at - 1)) : key, text)
          }
          return next
        })
        setExpanded((current) => {
          const next = new Set()
          for (const at of current) {
            if (at === index) continue
            next.add(at > index ? at - 1 : at)
          }
          return next
        })
        props.onChange(models.filter((_model, at) => at !== index).map((model) => ({ ...model })))
      }
      const reset = () => {
        setEditing(new Map())
        setExpanded(new Set())
        props.onReset()
      }
      const toggle = (index) => {
        setExpanded((current) => {
          const next = new Set(current)
          if (!next.delete(index)) next.add(index)
          return next
        })
      }
      /** 字段文本：正在敲的字，否则存量的短写法。 */
      const capacityText = (model, index, field) => {
        const typed = editing.get(`${String(index)}:${field}`)
        if (typed !== undefined) return typed
        const value = model[field]
        return typeof value === 'number' ? formatCapacity(value) : ''
      }
      const editCapacity = (index, field, text) => {
        setEditing((current) => new Map(current).set(`${String(index)}:${field}`, text))
        update(index, field, parseCapacity(text))
      }
      const settleCapacity = (index, field) => {
        const key = `${String(index)}:${field}`
        const typed = editing.get(key)
        if (typed === undefined) return
        const parsed = parseCapacity(typed)
        if (parsed !== undefined && Number.isNaN(parsed)) return
        setEditing((current) => {
          const next = new Map(current)
          next.delete(key)
          return next
        })
      }
      const overridden = props.overridden === true
      return h('section', { className: 'dsfm-catalog', 'aria-label': t('models') },
        h('div', { className: 'dsfm-catalogHead' },
          h('span', { className: 'dsfm-catalogTitle' }, t('models')),
          h('span', { className: 'dsfm-catalogMeta' }, overridden ? t('modelsCustomized') : t('modelsInherited')),
          overridden ? h('button', { type: 'button', className: 'dsfm-linkBtn', disabled, onClick: reset }, t('resetModels')) : null,
        ),
        models.length === 0
          ? h('p', { className: 'dsfm-modelEmpty' }, t('modelsEmpty'))
          : h('div', { className: 'dsfm-modelList' }, models.map((model, index) => h('div', { className: 'dsfm-modelEntry', key: index },
              h('div', { className: 'dsfm-modelRow' },
                h('input', {
                  className: 'dsfm-input',
                  type: 'text',
                  value: typeof model.id === 'string' ? model.id : '',
                  placeholder: t('modelId'),
                  'aria-label': `${t('modelId')} ${String(index + 1)}`,
                  disabled,
                  onChange: (event) => update(index, 'id', event.target.value),
                  onBlur: (event) => {
                    const trimmed = event.target.value.trim()
                    if (trimmed !== event.target.value) update(index, 'id', trimmed)
                  },
                }),
                h('input', {
                  className: 'dsfm-input',
                  type: 'text',
                  value: typeof model.name === 'string' ? model.name : '',
                  placeholder: t('modelName'),
                  'aria-label': `${t('modelName')} ${String(index + 1)}`,
                  disabled,
                  onChange: (event) => update(index, 'name', event.target.value === '' ? undefined : event.target.value),
                }),
                h('button', {
                  type: 'button',
                  className: 'dsfm-iconBtn',
                  'aria-label': `${t('modelAdvanced')} ${String(index + 1)}`,
                  'aria-expanded': expanded.has(index),
                  title: t('modelAdvanced'),
                  onClick: () => toggle(index),
                }, expanded.has(index) ? h(primitives.IconChevronDownOutline14, {}) : h(primitives.IconChevronRightOutline14, {})),
                h('button', {
                  type: 'button',
                  className: 'dsfm-iconBtn',
                  'aria-label': `${t('removeModel')} ${String(index + 1)}`,
                  title: t('removeModel'),
                  disabled,
                  onClick: () => remove(index),
                }, h(primitives.IconTrashOutline16, { size: 14 })),
              ),
              expanded.has(index)
                ? h('div', { className: 'dsfm-modelFields' },
                    h(CapacityField, {
                      model,
                      index,
                      field: 'contextWindow',
                      labelKey: 'contextWindow',
                      placeholder: props.defaultContextWindow === undefined ? t('contextWindowPlaceholder') : formatCapacity(props.defaultContextWindow),
                      t,
                      disabled,
                      capacityText,
                      onEdit: editCapacity,
                      onSettle: settleCapacity,
                    }),
                    h(CapacityField, {
                      model,
                      index,
                      field: 'maxTokens',
                      labelKey: 'maxTokens',
                      placeholder: props.defaultMaxTokens === undefined ? t('maxTokensPlaceholder') : formatCapacity(props.defaultMaxTokens),
                      t,
                      disabled,
                      capacityText,
                      onEdit: editCapacity,
                      onSettle: settleCapacity,
                    }),
                  )
                : null,
            ))),
        h('button', {
          type: 'button',
          className: 'dsfm-btn dsfm-btnAdd',
          disabled,
          onClick: () => props.onChange([...models.map((model) => ({ ...model })), { id: '' }]),
        }, h(primitives.IconPlusOutline16, { size: 14 }), t('addModel')),
      )
    }

    /**
     * pi-ai 提供方 profile 的模型列表 + 「询问提供方有哪些模型」动作。
     *
     * 列表就是卡片持有的 `models` 数组：空数组=用该路由内置目录，任何条目都覆盖它，故每行都是
     * 有意添加。获取询问的是**表单当前显示的端点**（包括刚输入、尚未保存的密钥），所以新增
     * 提供方一趟完成；回包是让用户挑选的候选，绝不在背后写配置。
     */
    function ModelListEditor(props) {
      const { models, onChange, probe, operations, t, disabled } = props
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(undefined)
      const [candidates, setCandidates] = React.useState(undefined)
      const [picked, setPicked] = React.useState(() => new Set())
      const [candidateQuery, setCandidateQuery] = React.useState('')
      const [expanded, setExpanded] = React.useState(() => new Set())
      const [editing, setEditing] = React.useState(() => new Map())
      const bufferKey = (index, field) => `${String(index)}:${field}`
      const capacityText = (model, index, field) => {
        const buffered = editing.get(bufferKey(index, field))
        return buffered ?? capacitySpelling(numberOf(model, field))
      }
      const patch = (index, next) => {
        onChange(models.map((model, at) => {
          if (at !== index) return model
          const cleared = new Set(Object.entries(next).filter(([, value]) => value === undefined || value === '').map(([key]) => key))
          return Object.fromEntries(Object.entries({ ...model, ...next }).filter(([key]) => !cleared.has(key)))
        }))
      }
      const editCapacity = (index, field, text) => {
        setEditing((current) => new Map(current).set(bufferKey(index, field), text))
        patch(index, { [field]: parseCapacity(text) })
      }
      const settleCapacity = (index, field) => {
        const key = bufferKey(index, field)
        const typed = editing.get(key)
        if (typed === undefined) return
        const parsed = parseCapacity(typed)
        if (parsed !== undefined && Number.isNaN(parsed)) return
        setEditing((current) => {
          const next = new Map(current)
          next.delete(key)
          return next
        })
      }
      const reindexOnRemove = (current, index) => {
        const next = new Map()
        for (const [key, value] of current) {
          const at = Number(key.slice(0, key.indexOf(':')))
          if (at === index) continue
          next.set(at > index ? key.replace(/^\d+/, String(at - 1)) : key, value)
        }
        return next
      }
      const remove = (index) => {
        setEditing((current) => reindexOnRemove(current, index))
        setExpanded((current) => {
          const next = new Set()
          for (const at of current) {
            if (at === index) continue
            next.add(at > index ? at - 1 : at)
          }
          return next
        })
        onChange(models.filter((_model, at) => at !== index).map((model) => ({ ...model })))
      }
      const toggleExpanded = (index) => {
        setExpanded((current) => {
          const next = new Set(current)
          if (!next.delete(index)) next.add(index)
          return next
        })
      }
      const fetchModels = async () => {
        setBusy(true)
        setFailure(undefined)
        /**
         * 一次失败的探测不能把上一次的回包留在弹窗里：用户改了端点/协议再点一次，
         * 看到"没变化"的候选会以为新端点就是这个列表（陈旧候选是实机误判的常见来源）。
         */
        const dropStale = () => {
          setCandidates(undefined)
          setPicked(new Set())
          setCandidateQuery('')
        }
        try {
          const answer = await operations.discoverModels(probe.settingsNs, {
            ...(probe.provider === undefined ? {} : { provider: probe.provider }),
            ...(probe.baseURL === undefined || probe.baseURL.length === 0 ? {} : { baseURL: probe.baseURL }),
            ...(probe.api === undefined ? {} : { api: probe.api }),
            ...(probe.apiKey === undefined ? {} : { apiKey: probe.apiKey }),
          })
          if (answer.kind === 'refused') {
            dropStale()
            setFailure(answer.message)
            return
          }
          const found = answer.models
          if (found.length === 0) {
            dropStale()
            setFailure(t('fetchEmpty'))
            return
          }
          const known = new Set(models.map((model) => textOf(model, 'id')))
          setCandidateQuery('')
          setCandidates(found)
          setPicked(new Set(found.filter((model) => !known.has(model.id)).map((model) => model.id)))
        } finally {
          setBusy(false)
        }
      }
      const closePicker = () => {
        setCandidates(undefined)
        setPicked(new Set())
        setCandidateQuery('')
      }
      const adoptPicked = () => {
        if (candidates === undefined) return
        const byId = new Map(models.map((model) => [textOf(model, 'id'), model]))
        for (const candidate of candidates) {
          if (!picked.has(candidate.id)) continue
          byId.set(candidate.id, byId.get(candidate.id) ?? adopt(candidate))
        }
        onChange([...byId.values()])
        closePicker()
      }
      const togglePicked = (id) => {
        setPicked((current) => {
          const next = new Set(current)
          if (!next.delete(id)) next.add(id)
          return next
        })
      }
      const activeCandidates = candidates ?? []
      const normalizedQuery = candidateQuery.trim().toLowerCase()
      const visibleCandidates = normalizedQuery.length === 0
        ? activeCandidates
        : activeCandidates.filter((candidate) => candidate.id.toLowerCase().includes(normalizedQuery) || (candidate.name !== undefined && candidate.name.toLowerCase().includes(normalizedQuery)))
      const allVisiblePicked = visibleCandidates.length > 0 && visibleCandidates.every((candidate) => picked.has(candidate.id))
      const toggleVisible = () => {
        setPicked((current) => {
          if (visibleCandidates.every((candidate) => current.has(candidate.id))) return new Set()
          const next = new Set(current)
          for (const candidate of visibleCandidates) next.add(candidate.id)
          return next
        })
      }
      const askable = probe.provider !== undefined || (probe.baseURL !== undefined && probe.baseURL.length > 0)
      /**
       * 该路由是否由 pi-ai 内置目录拥有（目录路由）：`declared !== true` 与
       * `catalogModels(provider)` 非空是同一件事，故这类路由的探测必然命中目录短路。
       */
      const catalogOwned = props.catalogOwned === true
      /**
       * 回包来源判定（用于给候选框标注"实时"还是"内置目录"）：目录路由 + 探测带 `provider`
       * ⇒ `discoverModels` 第一段直接返回本地快照，永远不会走到网络。这条等价关系是硬推理，
       * 不是启发式——目录路由的定义就是"pi-ai 目录里有它"。
       */
      const catalogAnswer = catalogOwned && probe.provider !== undefined
      const overridden = props.overridden === true
      return h('section', { className: 'dsfm-catalog', 'aria-label': t('models') },
        h('div', { className: 'dsfm-catalogHead' },
          h('span', { className: 'dsfm-catalogTitle' }, t('models')),
          props.overridden === undefined ? null : h('span', { className: 'dsfm-catalogMeta' }, overridden ? t('modelsCustomized') : t('modelsInherited')),
          overridden && props.onReset !== undefined
            ? h('button', { type: 'button', className: 'dsfm-linkBtn', disabled, onClick: props.onReset }, t('resetModels'))
            : null,
          h('button', {
            type: 'button',
            className: 'dsfm-linkBtn',
            disabled: disabled || busy || !askable || props.probeBlocked !== undefined,
            title: props.probeBlocked !== undefined ? t(props.probeBlocked) : askable ? undefined : t('fetchNeedsBaseUrl'),
            onClick: () => {
              fetchModels()
            },
          }, busy ? t('fetching') : t('fetchModels')),
        ),
        models.length === 0 ? h('p', { className: 'dsfm-modelEmpty' }, t('modelsEmpty')) : null,
        // 目录路由一旦自己列了模型，服务面就整体替换内置目录（pi-ai 的
        // `configured.length > 0 ? configured : defaults`）——不提醒的话，为了加一个新模型
        // 而在这张卡上填一行，会让其余几十个模型静默消失。
        catalogOwned && models.length > 0 ? h('p', { className: 'dsfm-hint' }, t('catalogReplacedHint')) : null,
        models.length === 0 ? null : h('div', { className: 'dsfm-modelList' }, models.map((model, index) => h('div', { className: 'dsfm-modelEntry', key: index },
          h('div', { className: 'dsfm-modelRow' },
            h('input', {
              className: 'dsfm-input',
              type: 'text',
              value: textOf(model, 'id'),
              placeholder: t('modelId'),
              'aria-label': `${t('modelId')} ${String(index + 1)}`,
              disabled,
              onChange: (event) => patch(index, { id: event.target.value }),
              onBlur: (event) => {
                const trimmed = event.target.value.trim()
                if (trimmed !== event.target.value) patch(index, { id: trimmed })
              },
            }),
            h('input', {
              className: 'dsfm-input',
              type: 'text',
              value: textOf(model, 'name'),
              placeholder: t('modelName'),
              'aria-label': `${t('modelName')} ${String(index + 1)}`,
              disabled,
              onChange: (event) => patch(index, { name: event.target.value }),
            }),
            h('button', {
              type: 'button',
              className: 'dsfm-iconBtn',
              'aria-label': `${t('modelAdvanced')} ${String(index + 1)}`,
              'aria-expanded': expanded.has(index),
              title: t('modelAdvanced'),
              onClick: () => toggleExpanded(index),
            }, expanded.has(index) ? h(primitives.IconChevronDownOutline14, {}) : h(primitives.IconChevronRightOutline14, {})),
            h('button', {
              type: 'button',
              className: 'dsfm-iconBtn',
              'aria-label': `${t('removeModel')} ${String(index + 1)}`,
              title: t('removeModel'),
              disabled,
              onClick: () => remove(index),
            }, h(primitives.IconTrashOutline16, { size: 14 })),
          ),
          expanded.has(index)
            ? h('div', { className: 'dsfm-modelFields' },
                h(CapacityField, {
                  model,
                  index,
                  field: 'contextWindow',
                  labelKey: 'modelContextWindow',
                  placeholder: CAPACITY_HINT.contextWindow,
                  t,
                  disabled,
                  capacityText,
                  onEdit: editCapacity,
                  onSettle: settleCapacity,
                }),
                h(CapacityField, {
                  model,
                  index,
                  field: 'maxTokens',
                  labelKey: 'modelMaxTokens',
                  placeholder: CAPACITY_HINT.maxTokens,
                  t,
                  disabled,
                  capacityText,
                  onEdit: editCapacity,
                  onSettle: settleCapacity,
                }),
                h('label', { className: 'dsfm-modelField' },
                  h('span', { className: 'dsfm-modelFieldLabel' }, t('modelInput')),
                  h(ModalitySelect, {
                    value: model.input,
                    label: `${t('modelInput')} ${String(index + 1)}`,
                    t,
                    disabled,
                    onChange: (next) => patch(index, { input: next }),
                  }),
                ),
              )
            : null,
        ))),
        h('button', {
          type: 'button',
          className: 'dsfm-btn dsfm-btnAdd',
          disabled,
          onClick: () => onChange([...models.map((model) => ({ ...model })), { id: '' }]),
        }, h(primitives.IconPlusOutline16, { size: 14 }), t('addModel')),
        failure === undefined ? null : h('p', { className: 'dsfm-error' }, failure),
        h(primitives.Modal, {
          open: candidates !== undefined,
          onClose: closePicker,
          title: t('fetchTitle'),
          closeLabel: t('close'),
          description: t('fetchDescription'),
          footer: h(React.Fragment, null,
            h(primitives.Button, { variant: 'outline', onClick: closePicker }, t('cancel')),
            h(primitives.Button, { variant: 'primary', disabled: picked.size === 0, onClick: adoptPicked }, t('fetchAdopt')),
          ),
        },
          h('p', { className: 'dsfm-hint' }, t(catalogAnswer ? 'fetchSourceCatalog' : 'fetchSourceEndpoint')),
          h('div', { className: 'dsfm-pickerToolbar' },
            h('input', {
              className: 'dsfm-input',
              type: 'text',
              value: candidateQuery,
              placeholder: t('fetchSearch'),
              'aria-label': t('fetchSearch'),
              onChange: (event) => setCandidateQuery(event.target.value),
            }),
            h('button', { type: 'button', className: 'dsfm-btn dsfm-btnSecondary dsfm-btnSm', onClick: toggleVisible }, allVisiblePicked ? t('fetchDeselectAll') : t('fetchSelectAll')),
          ),
          visibleCandidates.length === 0
            ? h('p', { className: 'dsfm-candidateEmpty' }, t('fetchNoMatches'))
            : h('div', { className: 'dsfm-candidateList' }, visibleCandidates.map((candidate) => h('label', { className: 'dsfm-candidate', key: candidate.id },
                h('input', {
                  type: 'checkbox',
                  checked: picked.has(candidate.id),
                  onChange: () => togglePicked(candidate.id),
                }),
                h('span', { className: 'dsfm-candidateId' }, candidate.id),
                candidate.name === undefined || candidate.name === candidate.id ? null : h('span', { className: 'dsfm-candidateLabel' }, candidate.name),
              ))),
        ),
      )
    }

    /**
     * 声明一个 pi-ai 未随包的提供方（OpenAI 兼容网关、自建服务、比已装目录更新的提供方）。
     *
     * 这是「创建」而非「编辑」，所以是独立卡片：路由 id 在此**被选定**，settings 地址在选定前
     * 并不存在。一次 `settings.mutate` 在 `providers.<route>` 写整段 profile；密钥另经
     * `credentials/set` 走 profile 记录的引用。手声明路由无法默认的三项（端点、协议、至少一个
     * 模型）在此必填，失败就地指名到字段。
     */
    function CustomProviderCard(props) {
      const { taken, protocols, operations, t } = props
      const [openedAt] = React.useState(() => props.revision)
      const [route, setRoute] = React.useState('')
      const [displayName, setDisplayName] = React.useState('')
      const [baseURL, setBaseURL] = React.useState('')
      const [protocol, setProtocol] = React.useState(protocols[0] ?? '')
      const [keyDraft, setKeyDraft] = React.useState('')
      const [models, setModels] = React.useState([])
      /** 路由级默认输入模态：undefined = 不声明（host 默认仅文本）。 */
      const [defaultInput, setDefaultInput] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(undefined)
      /** profile 写入已落地：只剩密钥写入可悬置，重试路径仅剩凭据。 */
      const [committed, setCommitted] = React.useState(false)
      const disabled = props.readOnly === true || busy
      const profileDisabled = disabled || committed
      const routeInvalid = route.length > 0 && !ROUTE_PATTERN.test(route)
      const routeTaken = taken.includes(route)
      const normalizedBaseURL = baseURL.trim()
      const baseUrlInvalid = baseURL.length > 0 && !isHttpUrl(normalizedBaseURL)
      const modelFailure = validateDeepSeekModels(models)
      const keyFailure = apiKeyFailure(keyDraft)
      const keyValue = keyDraft.trim()
      const ready = route.length > 0 && !routeInvalid && !routeTaken && normalizedBaseURL.length > 0 && !baseUrlInvalid && models.length > 0 && modelFailure === undefined && keyFailure === undefined
      const hint = failure !== undefined || ready || keyFailure !== undefined || route.length === 0 || routeInvalid || routeTaken || baseUrlInvalid
        ? undefined
        : normalizedBaseURL.length === 0
          ? t('customNeedsBaseUrl')
          : modelFailure !== undefined
            ? `${t('model')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`
            : t('customNeedsModels')
      /** 执行创建；返回失败文案或 undefined。 */
      const createOnce = async () => {
        const keyRef = deriveKeyRef(route)
        const storesKey = keyValue.length > 0
        if (!committed) {
          const profile = {
            ...(displayName.length === 0 ? {} : { displayName }),
            ...(storesKey ? { apiKeyEnv: keyRef } : {}),
            api: protocol,
            baseURL: normalizedBaseURL,
            // 手声明路由的模型在 pi-ai 目录里查不到，模态只能靠这一层给出；
            // 不声明 = schema 默认 ["text"]，多模态网关会被自己的闸门挡住贴图。
            ...(defaultInput === undefined ? {} : { defaultInput }),
            models: models.map((model) => ({ ...model })),
          }
          const written = await operations.writeSettings(PI_AI_NS, [{ op: 'set', path: ['providers', route], value: profile }], openedAt)
          if (written.kind !== 'written') return written.kind === 'conflict' ? t('conflict') : written.message
          setCommitted(true)
        }
        if (storesKey) {
          const stored = await operations.storeCredential(keyRef, keyValue)
          if (stored !== undefined) return stored
        }
        return undefined
      }
      const create = async () => {
        setBusy(true)
        setFailure(undefined)
        try {
          const outcome = await createOnce()
          if (outcome !== undefined) {
            setFailure(outcome)
            return
          }
          props.onClose(true)
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'dsfm-editor' },
        h('div', { className: 'dsfm-editorHead' }, h('span', { className: 'dsfm-editorTitle' }, t('customTitle'))),
        h('div', { className: 'dsfm-field' },
          h('span', { className: 'dsfm-fieldLabel' }, t('customRoute')),
          h('input', {
            className: 'dsfm-input',
            type: 'text',
            value: route,
            placeholder: 'acme-gateway',
            'aria-label': t('customRoute'),
            disabled: profileDisabled,
            onChange: (event) => setRoute(event.target.value),
          }),
        ),
        routeInvalid || routeTaken
          ? h('p', { className: 'dsfm-error' }, t(routeInvalid ? 'customRouteInvalid' : 'customRouteTaken'))
          : h('p', { className: 'dsfm-hint' }, t('customRouteHint')),
        h('div', { className: 'dsfm-field' },
          h('span', { className: 'dsfm-fieldLabel' }, t('customDisplayName')),
          h('input', {
            className: 'dsfm-input',
            type: 'text',
            value: displayName,
            placeholder: route.length === 0 ? t('customDisplayName') : route,
            'aria-label': t('customDisplayName'),
            disabled: profileDisabled,
            onChange: (event) => setDisplayName(event.target.value),
          }),
        ),
        h('div', { className: 'dsfm-field' },
          h('span', { className: 'dsfm-fieldLabel' }, t('baseUrl')),
          h('input', {
            className: 'dsfm-input',
            type: 'text',
            value: baseURL,
            placeholder: t('customBaseUrlPlaceholder'),
            'aria-label': t('baseUrl'),
            'aria-invalid': baseUrlInvalid,
            disabled: profileDisabled,
            onChange: (event) => setBaseURL(event.target.value),
          }),
        ),
        baseUrlInvalid ? h('p', { className: 'dsfm-error' }, t('customBaseUrlInvalid')) : null,
        h('div', { className: 'dsfm-field' },
          h('span', { className: 'dsfm-fieldLabel' }, t('customApi')),
          h('select', {
            className: 'dsfm-input',
            value: protocol,
            'aria-label': t('customApi'),
            disabled: profileDisabled,
            onChange: (event) => setProtocol(event.target.value),
          }, protocols.map((choice) => h('option', { value: choice, key: choice }, choice))),
        ),
        h('div', { className: 'dsfm-field' },
          h('span', { className: 'dsfm-fieldLabel' }, t('defaultInput')),
          h(ModalitySelect, {
            value: defaultInput,
            label: t('defaultInput'),
            t,
            disabled: profileDisabled,
            onChange: setDefaultInput,
          }),
          h('p', { className: 'dsfm-hint' }, t('defaultInputHint')),
        ),
        h('div', { className: 'dsfm-field' },
          h('span', { className: 'dsfm-fieldLabel' }, t('keyInput')),
          h('input', {
            className: 'dsfm-input',
            type: 'password',
            autoComplete: 'off',
            value: keyDraft,
            placeholder: t('keyPlaceholder'),
            'aria-label': t('keyInput'),
            disabled,
            onChange: (event) => setKeyDraft(event.target.value),
          }),
          keyFailure === undefined ? null : h('p', { className: 'dsfm-error' }, t(keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure)),
        ),
        h(ModelListEditor, {
          models,
          onChange: setModels,
          probe: {
            settingsNs: PI_AI_NS,
            baseURL: normalizedBaseURL,
            api: protocol,
            ...(keyValue.length === 0 ? {} : { apiKey: keyValue }),
          },
          probeBlocked: baseUrlInvalid ? 'customBaseUrlInvalid' : keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure,
          operations,
          t,
          disabled: profileDisabled,
        }),
        failure === undefined ? null : h('p', { className: 'dsfm-error' }, failure),
        hint === undefined ? null : h('p', { className: 'dsfm-hint' }, hint),
        h(EditorFooter, {
          t,
          busy,
          submitDisabled: disabled || !ready,
          submitLabelKey: 'create',
          submitBusyLabelKey: 'creating',
          onCancel: () => {
            props.onClose(committed)
          },
          onSubmit: () => {
            create()
          },
        }),
      )
    }

    /**
     * 单个提供方的编辑卡片，按适配器家族手写：主字段是一个只写的 **API 密钥** 输入框
     * （本页从不询问环境变量名——输入的密钥经 `credentials/set` 存在 profile 记录的引用下，
     * profile 没有引用时推导 `<ROUTE>_API_KEY`；密钥留空则落成无引用的 profile，交由提供方
     * 自身的鉴权链）。折叠的「自定义设置」区承载家族附加项（两个家族都有 `baseURL`，
     * DeepSeek 额外有 id/name/context-window 模型目录，pi-ai 手声明路由额外有显示名与传输协议）。
     * 推理强度刻意缺席：它是**每模型**能力，同一提供方下各模型不一致，提供方级控件只能被部分
     * 模型拒绝——交回输入区的模型选择器与 settings.yaml。
     * profile 编辑一律落成针对存量段的最小 `settings.mutate` 路径操作，卡片只命名它看得见的字段。
     */
    function ProviderEditor(props) {
      const { namespace, schema, settingsPath, operations, t } = props
      const [draft, setDraft] = React.useState(() => draftAt(schema, namespace, settingsPath))
      const [keyDraft, setKeyDraft] = React.useState('')
      const [keyState, setKeyState] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(undefined)
      const [committedOriginal, setCommittedOriginal] = React.useState(() => schema.getPath(namespace.user, settingsPath))
      const [expectedRevision, setExpectedRevision] = React.useState(() => namespace.revision)
      /** 请求头编辑行表（挂载时从 draft 快照；写回 draft 见 commitHeaders）。 */
      const [headerDrafts, setHeaderDrafts] = React.useState(() => headerRows(schema.getPath(draft, ['headers'])))
      const root = React.useMemo(() => schema.rehydrate(namespace.schema), [namespace.schema, schema])
      const node = React.useMemo(() => schema.nodeAtPath(root, settingsPath), [root, schema, settingsPath])
      const fallback = schema.getPath(namespace.value, settingsPath)
      const disabled = props.readOnly === true || busy
      const layout = layoutOf(namespace.ns)
      const keyRef = refFor(schema, namespace, settingsPath, props.provider)
      const protocols = React.useMemo(() => (layout === 'pi-ai' ? protocolChoices(namespace, schema) : []), [layout, namespace, schema])
      React.useEffect(() => {
        let stale = false
        setKeyState(undefined)
        operations.describeCredential(keyRef).then((described) => {
          if (stale) return
          setKeyState(described)
        })
        return () => {
          stale = true
        }
      }, [operations, keyRef])
      const stringAt = (source, key) => {
        const value = schema.getPath(source, [key])
        return typeof value === 'string' && value.trim().length > 0 ? value : undefined
      }
      const setField = (key, next) => {
        const value = next === undefined || next.trim().length === 0 ? undefined : next
        setDraft((current) => (value === undefined ? schema.deletePath(current, [key]) : schema.setPath(current, [key], value)))
      }
      /** 数组字段（模态）的写入：undefined = 删除该键（回到继承），不做字符串归一。 */
      const setArrayField = (key, next) => {
        setDraft((current) => (next === undefined ? schema.deletePath(current, [key]) : schema.setPath(current, [key], next)))
      }
      const modelFailure = validateDeepSeekModels(schema.getPath(draft, ['models']))
      const keyFailure = apiKeyFailure(keyDraft)
      const keyValue = keyDraft.trim()
      const shownKeyFailure = (props.credentialRequired === true && keyDraft.length > 0 && keyValue.length === 0 ? 'keyRequired' : undefined) ?? keyFailure
      const probeApi = stringAt(draft, 'api') ?? stringAt(fallback, 'api')
      const probeBaseURL = stringAt(draft, 'baseURL') ?? stringAt(fallback, 'baseURL')
      const probe = {
        settingsNs: namespace.ns,
        provider: props.provider,
        ...(probeBaseURL === undefined ? {} : { baseURL: probeBaseURL }),
        ...(probeApi === undefined ? {} : { api: probeApi }),
        ...(keyValue.length === 0 ? {} : { apiKey: keyValue }),
      }
      /** 生效的请求头（用户层优先，否则下层/默认层）——用于 opencode 会话头是否已配的判定。 */
      const effectiveHeaders = schema.getPath(draft, ['headers']) ?? schema.getPath(fallback, ['headers'])
      /**
       * 本卡片的写入；返回失败文案或 undefined。所有编辑都以路径操作落到**存量段**上：
       * draft 来自脱敏描述符，用它整段替换会连带删掉卡片之外的字段；路径操作只命名看得见的字段。
       */
      const applyOnce = async () => {
        const ns = namespace.ns
        const next = layout === 'pi-ai' && stringAt(draft, 'apiKeyEnv') === undefined && stringAt(fallback, 'apiKeyEnv') === undefined && keyValue.length > 0
          ? schema.setPath(draft, ['apiKeyEnv'], keyRef)
          : draft
        if (props.credentialOnly !== true) {
          const failure = validateDeepSeekModels(schema.getPath(next, ['models']))
          if (failure !== undefined) return `${t('model')} ${String(failure.index + 1)}: ${t(failure.key)}`
          if (node !== undefined && settingsPath.length === 0) {
            const sectionError = schema.validate(node, next)
            if (sectionError !== undefined) return sectionError
          }
        }
        const materializesNativeProfile = layout === 'pi-ai' && fallback === undefined && committedOriginal === undefined && Object.keys(next).length === 0
        const ops = props.credentialOnly === true
          ? []
          : materializesNativeProfile
            ? [{ op: 'set', path: [...settingsPath], value: {} }]
            : pathOps(settingsPath, committedOriginal, next)
        if (ops.length > 0) {
          const written = await operations.writeSettings(ns, ops, expectedRevision)
          if (written.kind !== 'written') return written.kind === 'conflict' ? t('conflict') : written.message
          setCommittedOriginal(schema.getPath(written.view.user, settingsPath))
          setExpectedRevision(written.view.revision)
          setDraft(next)
        }
        if (keyValue.length > 0) {
          const stored = await operations.storeCredential(keyRef, keyValue)
          if (stored !== undefined) return stored
        }
        setKeyDraft('')
        return undefined
      }
      const apply = async () => {
        setBusy(true)
        setFailure(undefined)
        try {
          const outcome = await applyOnce()
          if (outcome !== undefined) {
            setFailure(outcome)
            return
          }
          props.onClose(true)
        } finally {
          setBusy(false)
        }
      }
      if (node === undefined) {
        return h('p', { className: 'dsfm-error' }, props.provider, ': ', t('settingsPathUnresolvable'))
      }
      const keyLocked = keyState !== undefined && keyState.writable === false
      /**
       * 请求头编辑能力探测：先认已知支持的家族（`llm-pi-ai` 的 profile schema 明确定义了
       * `headers: z.dict(z.string())`，是本能力的存在依据），再用 schema 探测兜底其它命名空间
       * ——避免写进 host schema 不认的字段。schema 探测走动态 dict 键，异常时按家族判定。
       */
      let supportsHeaders = layout === 'pi-ai'
      if (!supportsHeaders) {
        try {
          supportsHeaders = schema.nodeAtPath(root, [...settingsPath, 'headers']) !== undefined
        } catch {
          supportsHeaders = false
        }
      }
      const headerFailure = firstHeaderFailure(headerDrafts)
      /** 把本地行表写回 draft（空表落成 unset；空白名行丢弃，避免污染 pathOps）。 */
      const commitHeaders = (next) => {
        setHeaderDrafts(next)
        const record = {}
        for (const row of next) {
          const name = row.name.trim()
          if (name.length === 0) continue
          record[name] = row.value
        }
        setDraft((current) => (Object.keys(record).length === 0 ? schema.deletePath(current, ['headers']) : schema.setPath(current, ['headers'], record)))
      }
      const updateHeader = (index, patch) => commitHeaders(headerDrafts.map((row, at) => (at === index ? { ...row, ...patch } : row)))
      const removeHeader = (index) => commitHeaders(headerDrafts.filter((_row, at) => at !== index))
      const addHeader = () => commitHeaders([...headerDrafts, { name: '', value: '' }])
      /** 写入/替换一行请求头（大小写不敏感地匹配已有名称）。 */
      const setHeaderValue = (name, value) => {
        const target = name.toLowerCase()
        const found = headerDrafts.findIndex((row) => row.name.trim().toLowerCase() === target)
        if (found === -1) commitHeaders([...headerDrafts, { name, value }])
        else commitHeaders(headerDrafts.map((row, at) => (at === found ? { name, value } : row)))
      }
      /**
       * 用户层之下的目录：composition 段钉的值，否则 schema 默认。不能用生效值回答——它仍带着
       * 存量覆盖，重置刚落下时会把它原样读回来，导致行在重载前不变。
       */
      const inheritedModels = () => schema.getPath(namespace.base, [...settingsPath, 'models']) ?? (schema.nodeAtPath(root, [...settingsPath, 'models']) ?? {}).meta?.default
      /** 已知适配器家族的受控字段（家族已收窄，未知命名空间走提示分支）。 */
      const curatedFields = (family) => {
        const ownsIdentity = family === 'pi-ai' && props.declared === true
        const customModels = schema.getPath(draft, ['models'])
        const modelsOverridden = schema.hasPath(draft, ['models'])
        const models = modelDrafts(modelsOverridden ? customModels : inheritedModels())
        const defaultContextWindow = schema.getPath(fallback, ['defaultContextWindow'])
        const defaultMaxTokens = schema.getPath(fallback, ['maxTokens'])
        const keyPlaceholder = keyLocked
          ? t('keyEnvLocked')
          : keyState !== undefined && keyState.configured === true && props.credentialRequired !== true
            ? t('keyStored')
            : family === 'pi-ai'
              ? t('keyPlaceholderNative')
              : t('keyPlaceholder')
        const catalogProps = {
          models,
          overridden: modelsOverridden,
          t,
          disabled,
          onChange: (next) => {
            setDraft((current) => schema.setPath(current, ['models'], next))
          },
          onReset: () => {
            setDraft((current) => schema.deletePath(current, ['models']))
          },
        }
        return h(React.Fragment, null,
          h('div', { className: 'dsfm-field' },
            h('span', { className: 'dsfm-fieldLabel' }, t('keyInput')),
            h('input', {
              className: 'dsfm-input',
              type: 'password',
              autoComplete: 'off',
              value: keyDraft,
              placeholder: keyPlaceholder,
              'aria-label': t('keyInput'),
              'aria-invalid': shownKeyFailure !== undefined,
              required: props.credentialRequired === true,
              autoFocus: props.autoFocusCredential === true,
              disabled: disabled || keyLocked,
              onChange: (event) => setKeyDraft(event.target.value),
            }),
            shownKeyFailure === undefined ? null : h('p', { className: 'dsfm-error' }, t(shownKeyFailure)),
          ),
          props.credentialOnly === true
            ? null
            : h('details', { className: 'dsfm-customized' },
                h('summary', null, t('customized')),
                h('div', { className: 'dsfm-customizedBody' },
                  ownsIdentity
                    ? h('div', { className: 'dsfm-field' },
                        h('span', { className: 'dsfm-fieldLabel' }, t('customDisplayName')),
                        h('input', {
                          className: 'dsfm-input',
                          type: 'text',
                          value: stringAt(draft, 'displayName') ?? '',
                          placeholder: stringAt(schema.getPath(namespace.base, settingsPath), 'displayName') ?? props.provider,
                          'aria-label': t('customDisplayName'),
                          disabled,
                          onChange: (event) => setField('displayName', event.target.value),
                        }),
                      )
                    : null,
                  h('div', { className: 'dsfm-field' },
                    h('span', { className: 'dsfm-fieldLabel' }, t('baseUrl')),
                    h('input', {
                      className: 'dsfm-input',
                      type: 'text',
                      value: stringAt(draft, 'baseURL') ?? '',
                      placeholder: family === 'deepseek' ? DEEPSEEK_PUBLIC_BASE_URL : stringAt(fallback, 'baseURL') ?? t('baseUrlDefault'),
                      'aria-label': t('baseUrl'),
                      disabled,
                      onChange: (event) => setField('baseURL', event.target.value === '' ? undefined : event.target.value),
                    }),
                  ),
                  family === 'pi-ai'
                    ? h('div', { className: 'dsfm-field' },
                        h('span', { className: 'dsfm-fieldLabel' }, t('customApi')),
                        h('select', {
                          className: 'dsfm-input',
                          value: probeApi ?? '',
                          'aria-label': t('customApi'),
                          disabled,
                          onChange: (event) => setField('api', event.target.value),
                        },
                          probeApi === undefined ? h('option', { value: '' }, t('customApiUnset')) : null,
                          protocols.map((choice) => h('option', { value: choice, key: choice }, choice)),
                        ),
                        // 目录路由的协议默认由 pi-ai 目录提供；但目录**未收录**的手填模型没有
                        // 可继承的协议，host 会要求本路由显式声明（否则保存被拒：needs an api）。
                        // 因此这一栏对目录路由同样开放——原实现只在 declared=true 时渲染，
                        // 等于把"目录外模型"这条路堵死了。
                        ownsIdentity ? null : h('p', { className: 'dsfm-hint' }, t('customApiCatalogHint')),
                      )
                    : null,
                  family === 'pi-ai'
                    ? h('div', { className: 'dsfm-field' },
                        h('span', { className: 'dsfm-fieldLabel' }, t('defaultInput')),
                        h(ModalitySelect, {
                          value: schema.getPath(draft, ['defaultInput']) ?? schema.getPath(fallback, ['defaultInput']),
                          label: t('defaultInput'),
                          t,
                          disabled,
                          onChange: (next) => setArrayField('defaultInput', next),
                        }),
                        h('p', { className: 'dsfm-hint' }, t('defaultInputHint')),
                      )
                    : null,
                  supportsHeaders
                    ? h('div', { className: 'dsfm-field' },
                        h('span', { className: 'dsfm-fieldLabel' }, t('headers')),
                        headerDrafts.length === 0
                          ? h('p', { className: 'dsfm-hint' }, t('headerEmpty'))
                          : h('div', { className: 'dsfm-headerList' }, headerDrafts.map((row, index) => h('div', { className: 'dsfm-headerRow', key: index },
                              h('input', {
                                className: 'dsfm-input',
                                type: 'text',
                                value: row.name,
                                placeholder: t('headerName'),
                                'aria-label': `${t('headerName')} ${String(index + 1)}`,
                                disabled,
                                onChange: (event) => updateHeader(index, { name: event.target.value }),
                              }),
                              h('input', {
                                className: 'dsfm-input',
                                type: 'text',
                                value: row.value,
                                placeholder: t('headerValue'),
                                'aria-label': `${t('headerValue')} ${String(index + 1)}`,
                                disabled,
                                onChange: (event) => updateHeader(index, { value: event.target.value }),
                              }),
                              h('button', {
                                type: 'button',
                                className: 'dsfm-iconBtn',
                                'aria-label': `${t('removeHeader')} ${String(index + 1)}`,
                                title: t('removeHeader'),
                                disabled,
                                onClick: () => removeHeader(index),
                              }, h(primitives.IconTrashOutline16, { size: 14 })),
                            ))),
                        h('button', {
                          type: 'button',
                          className: 'dsfm-btn dsfm-btnAdd dsfm-btnSm',
                          disabled,
                          onClick: addHeader,
                        }, h(primitives.IconPlusOutline16, { size: 14 }), t('addHeader')),
                        h('p', { className: 'dsfm-hint' }, t('headersHint')),
                        headerFailure === undefined
                          ? null
                          : h('p', { className: 'dsfm-error' }, `${t('headerName')} ${String(headerFailure.index + 1)}: ${t(headerFailure.key)}`),
                      )
                    : null,
                  supportsHeaders && isOpencodeGateway(props.provider, probeBaseURL)
                    ? h('div', { className: 'dsfm-field' },
                        h('p', { className: 'dsfm-hint' }, t('opencodeHint')),
                        hasHeader(effectiveHeaders, 'x-opencode-session')
                          ? h('p', { className: 'dsfm-hint' }, t('opencodeStaticNote'))
                          : h('button', {
                              type: 'button',
                              className: 'dsfm-btn dsfm-btnAdd dsfm-btnSm',
                              disabled,
                              onClick: () => setHeaderValue('x-opencode-session', newSessionId()),
                            }, t('opencodeGenerate')),
                      )
                    : null,
                  family === 'deepseek'
                    ? h(DeepSeekModelsEditor, {
                        ...catalogProps,
                        defaultContextWindow: typeof defaultContextWindow === 'number' ? defaultContextWindow : undefined,
                        defaultMaxTokens: typeof defaultMaxTokens === 'number' ? defaultMaxTokens : undefined,
                      })
                    : h(ModelListEditor, { ...catalogProps, probe, probeBlocked: keyFailure, operations, catalogOwned: family === 'pi-ai' && !ownsIdentity }),
                ),
              ),
        )
      }
      return h('div', { className: props.credentialOnly === true ? 'dsfm-addBlock' : 'dsfm-editor' },
        props.hideTitle === true
          ? null
          : h('div', { className: 'dsfm-editorHead' },
              h('span', { className: 'dsfm-editorTitle' }, props.displayName),
              props.provider === props.displayName ? null : h('span', { className: 'dsfm-editorRoute' }, props.provider),
            ),
        layout === 'unknown'
          ? h('p', { className: 'dsfm-hint' }, `${t('advancedHint')} (${namespace.ns})`)
          : curatedFields(layout),
        failure === undefined ? null : h('p', { className: 'dsfm-error' }, failure),
        props.credentialOnly !== true && modelFailure !== undefined
          ? h('p', { className: 'dsfm-hint' }, `${t('model')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`)
          : null,
        h(EditorFooter, {
          t,
          busy,
          submitDisabled: disabled || layout === 'unknown' || (props.credentialOnly !== true && modelFailure !== undefined) || shownKeyFailure !== undefined || (props.credentialRequired === true && keyValue.length === 0) || headerFailure !== undefined,
          submitLabelKey: props.submitLabelKey ?? 'apply',
          submitBusyLabelKey: props.submitBusyLabelKey ?? 'applying',
          ...(props.cancelLabelKey === undefined ? {} : { cancelLabelKey: props.cancelLabelKey }),
          onCancel: () => {
            props.onClose(false)
          },
          onSubmit: () => {
            apply()
          },
        }),
      )
    }

    /** 为「首次配置姿态」或「展开的行」渲染同一张编辑器。 */
    function renderProviderEditor(target, rest) {
      return h(ProviderEditor, {
        provider: target.provider,
        displayName: target.displayName,
        settingsPath: target.settingsPath,
        ...(target.declared === true ? { declared: true } : {}),
        ...rest,
      })
    }

    /**
     * 模型设置分区：可配置目录 + settings 命名空间 + 凭据状态 join 出的 provider 行，
     * 同一时刻只开一张编辑卡片。行只用无障碍的实心点暴露**已确认**的密钥状态。
     * 整段式提供方在确认密钥缺失且是首次姿态（页面上无任何可用提供方）时渲染为展开的配置卡，
     * 用户关掉后本会话降级为普通行；添加流是一张带休眠提供方下拉的卡片。每类卡片各自持有打开
     * 状态，关一张不会丢弃另一张的草稿。每次改动都过 wire，页面由推送失效或写入后重载重渲染。
     */
    function ModelsSection(props) {
      const { controller, operations, schema, t, renderSlot } = props
      if (controller === undefined || operations === undefined || schema === undefined || t === undefined) return null
      const state = useStore(controller.store)
      const [editing, setEditing] = React.useState(undefined)
      const [adding, setAdding] = React.useState(false)
      const [declaring, setDeclaring] = React.useState(false)
      const [deleteTarget, setDeleteTarget] = React.useState(undefined)
      const [deleting, setDeleting] = React.useState(false)
      const [deleteFailure, setDeleteFailure] = React.useState(undefined)
      const [savedTarget, setSavedTarget] = React.useState(undefined)
      const [dismissedSetup, setDismissedSetup] = React.useState(() => new Set())
      const announceSaved = (target) => {
        controller.load().then(() => {
          setSavedTarget(target)
        })
      }
      const closeEditor = (changed, target) => {
        setEditing(undefined)
        setAdding(false)
        setDeclaring(false)
        if (changed) announceSaved(target)
      }
      /**
       * 关闭首次配置卡：它不持有上面那些状态（行编辑器/添加/声明各持一个），在这里清空会丢掉
       * 用户并排开着的草稿。关闭是这张卡自己的事——该提供方本会话回落到普通行，可再经「编辑」打开。
       */
      const closeSetup = (changed, target) => {
        setDismissedSetup((previous) => new Set([...previous, target.provider]))
        if (changed) announceSaved(target)
      }
      const closeDelete = () => {
        if (deleting) return
        setDeleteTarget(undefined)
        setDeleteFailure(undefined)
      }
      const confirmDelete = () => {
        if (deleteTarget === undefined || deleting) return
        setDeleting(true)
        setDeleteFailure(undefined)
        removeProviderProfile(operations, controller, deleteTarget).then((failure) => {
          if (failure !== undefined) {
            setDeleteFailure(failure)
            return
          }
          setDeleteTarget(undefined)
        }).finally(() => {
          setDeleting(false)
        })
      }
      React.useEffect(() => {
        if (state.status === 'idle') controller.load()
      }, [controller, state.status])
      if (state.status === 'error') {
        const errorText = state.error ?? ''
        return h('div', { className: 'dsfm-section' },
          h('p', { className: 'dsfm-error' }, `${t('loadFailed')}: ${errorText}`),
          h('button', {
            type: 'button',
            className: 'dsfm-btn dsfm-btnSecondary',
            onClick: () => {
              controller.load()
            },
          }, t('retry')),
        )
      }
      const savedRow = savedTarget === undefined ? undefined : state.rows.find((row) => row.entry.provider === savedTarget.provider)
      const savedIdentity = savedRow === undefined ? savedTarget : { provider: savedRow.entry.provider, displayName: savedRow.entry.displayName }
      const anyUsable = state.rows.some(providerUsable)
      const configured = state.rows.filter((row) => row.configured)
      const configurable = state.rows.filter((row) => state.namespaces.has(row.entry.settingsNs))
      const addable = configurable.filter((row) => !row.configured)
      const addTarget = adding ? editing : undefined
      const addNamespace = addTarget === undefined ? undefined : state.namespaces.get(addTarget.settingsNs)
      const addRow = addTarget === undefined ? undefined : state.rows.find((row) => row.entry.provider === addTarget.provider)
      const protocols = protocolChoices(state.namespaces.get(PI_AI_NS), schema)
      const providerCardProps = (row) => ({
        provider: row.entry,
        configured: row.configured,
        keyConfigured: keyConfiguredOf(row),
      })
      return h('div', { className: 'dsfm-section' },
        h('h2', { className: 'dsfm-title' }, t('title')),
        h('p', { className: 'dsfm-intro' }, t('intro')),
        !state.writable && state.status === 'ready' ? h('p', { className: 'dsfm-notice' }, t('readOnly')) : null,
        savedIdentity === undefined
          ? null
          : h('p', { className: 'dsfm-savedNotice', role: 'status', 'aria-live': 'polite' }, providerCopy(t('savedProvider'), savedIdentity)),
        h('ul', { className: 'dsfm-rows' }, configured.map((row) => {
          const target = targetOf(row)
          const namespace = state.namespaces.get(target.settingsNs)
          if (namespace === undefined) return null
          const error = row.entry.error === undefined ? null : h('p', { role: 'alert', className: 'dsfm-error' }, row.entry.error)
          if (needsSetup(row, anyUsable) && !dismissedSetup.has(row.entry.provider)) {
            return h('li', { className: 'dsfm-rowCard', key: row.entry.provider },
              error,
              renderProviderEditor(target, {
                namespace,
                schema,
                operations,
                t,
                readOnly: !state.writable,
                onClose: (changed) => {
                  closeSetup(changed, target)
                },
              }),
              renderSlot('settings.models.provider-card', providerCardProps(row), { entryKey: row.entry.settingsNs }),
            )
          }
          const open = !adding && editing !== undefined && editing.provider === row.entry.provider
          const credentialConfigured = row.credential !== undefined && row.credential.configured === true
          const credentialMissing = !credentialConfigured && row.apiKeyEnv !== undefined && row.credential !== undefined && row.credential.configured === false
          return h('li', { className: 'dsfm-rowCard', key: row.entry.provider },
            h('div', { className: 'dsfm-rowHead' },
              h('span', { className: 'dsfm-rowIdentity' },
                h('span', { className: 'dsfm-rowName' }, row.entry.displayName),
                row.entry.declared === true ? h('span', { className: 'dsfm-rowTag' }, t('customTag')) : null,
                credentialConfigured
                  ? h('span', { className: 'dsfm-dot dsfm-dotOn', role: 'img', 'aria-label': t('credentialConfigured'), title: t('credentialConfigured') })
                  : credentialMissing
                    ? h('span', { className: 'dsfm-dot dsfm-dotOff', role: 'img', 'aria-label': t('credentialMissing'), title: t('credentialMissing') })
                    : null,
              ),
              h('span', { className: 'dsfm-rowActions' },
                h('button', {
                  type: 'button',
                  className: 'dsfm-btn dsfm-btnSecondary dsfm-btnSm',
                  'aria-label': providerCopy(t('editProvider'), target),
                  onClick: () => {
                    setSavedTarget(undefined)
                    setDeclaring(false)
                    setAdding(false)
                    setEditing(open ? undefined : target)
                  },
                }, t('edit')),
                row.removable
                  ? h('button', {
                      type: 'button',
                      className: 'dsfm-btn dsfm-btnDanger dsfm-btnSm',
                      'aria-label': providerCopy(t('removeProvider'), target),
                      disabled: !state.writable,
                      onClick: () => {
                        setSavedTarget(undefined)
                        setDeleteFailure(undefined)
                        setDeleteTarget(target)
                      },
                    }, t('remove'))
                  : null,
              ),
            ),
            error,
            renderSlot('settings.models.provider-card', providerCardProps(row), { entryKey: row.entry.settingsNs }),
            open
              ? renderProviderEditor(target, {
                  namespace,
                  schema,
                  operations,
                  t,
                  readOnly: !state.writable,
                  onClose: (changed) => {
                    closeEditor(changed, target)
                  },
                })
              : null,
          )
        })),
        h('div', { className: 'dsfm-addBlock' },
          addTarget !== undefined && addNamespace !== undefined
            ? h('div', { className: 'dsfm-addCard' },
                h('div', { className: 'dsfm-field' },
                  h('span', { className: 'dsfm-fieldLabel' }, t('provider')),
                  h('select', {
                    className: 'dsfm-input',
                    value: addTarget.provider,
                    'aria-label': t('provider'),
                    onChange: (event) => {
                      const row = addable.find((candidate) => candidate.entry.provider === event.target.value)
                      if (row === undefined) return
                      setEditing(targetOf(row))
                    },
                  }, addable.map((row) => h('option', { value: row.entry.provider, key: row.entry.provider }, row.entry.displayName))),
                ),
                h(ProviderEditor, {
                  provider: addTarget.provider,
                  displayName: addTarget.displayName,
                  hideTitle: true,
                  namespace: addNamespace,
                  schema,
                  settingsPath: addTarget.settingsPath,
                  operations,
                  t,
                  readOnly: !state.writable,
                  onClose: (changed) => {
                    closeEditor(changed, addTarget)
                  },
                }),
                addRow === undefined ? null : renderSlot('settings.models.provider-card', providerCardProps(addRow), { entryKey: addRow.entry.settingsNs }),
              )
            : declaring
              ? h('div', { className: 'dsfm-addCard' },
                  h(CustomProviderCard, {
                    taken: state.rows.map((row) => row.entry.provider),
                    protocols,
                    revision: (state.namespaces.get(PI_AI_NS) ?? {}).revision ?? 0,
                    operations,
                    t,
                    readOnly: !state.writable,
                    onClose: (changed) => {
                      setDeclaring(false)
                      if (changed) controller.load()
                    },
                  }),
                )
              : h('div', { className: 'dsfm-addActions' },
                  configurable.length > 0
                    ? h('button', {
                        type: 'button',
                        className: 'dsfm-btn dsfm-btnAdd',
                        disabled: addable.length === 0 || !state.writable,
                        onClick: () => {
                          const first = addable[0]
                          if (first === undefined) return
                          setSavedTarget(undefined)
                          setDeclaring(false)
                          setAdding(true)
                          setEditing(targetOf(first))
                        },
                      }, h(primitives.IconPlusOutline16, { size: 14 }), t('add'))
                    : null,
                  state.namespaces.has(PI_AI_NS)
                    ? h('button', {
                        type: 'button',
                        className: 'dsfm-btn dsfm-btnAdd',
                        disabled: protocols.length === 0 || !state.writable,
                        onClick: () => {
                          setSavedTarget(undefined)
                          setAdding(false)
                          setEditing(undefined)
                          setDeclaring(true)
                        },
                      }, h(primitives.IconPlusOutline16, { size: 14 }), t('customAdd'))
                    : null,
                ),
        ),
        renderSlot('settings.models.footer', {}),
        h(primitives.Modal, {
          open: deleteTarget !== undefined,
          onClose: closeDelete,
          title: deleteTarget === undefined ? '' : providerCopy(t('deleteTitle'), deleteTarget),
          closeLabel: t('close'),
          description: deleteTarget === undefined ? '' : providerCopy(deleteTarget.credentialRef === undefined ? t('deleteDescription') : t('deleteDescriptionWithCredential'), deleteTarget),
          footer: h(React.Fragment, null,
            h(primitives.Button, { variant: 'outline', autoFocus: true, disabled: deleting, onClick: closeDelete }, t('cancel')),
            h(primitives.Button, { variant: 'outline', disabled: deleting, onClick: confirmDelete }, deleteTarget === undefined ? '' : providerCopy(deleting ? t('deleting') : t('deleteConfirm'), deleteTarget)),
          ),
        }, deleteFailure === undefined ? null : h('p', { className: 'dsfm-error' }, deleteFailure)),
      )
    }

    // ── 首次引导（settings.onboarding 两步）─────────────────────────────

    /** 步骤弹窗的单一关闭路径：只允许显式动作收尾（遮罩/Escape 不吞掉流程）。 */
    const ignoreImplicitDismiss = () => {}

    /**
     * 阻塞式引导弹窗，同时把应用根设为 inert。
     * @param props.title 可见与无障碍标题。
     * @param props.focusTitle 无表单控件时聚焦标题。
     * @param props.children 步骤自有的正文与动作。
     */
    function OnboardingModal({ title, focusTitle = false, children }) {
      const titleRef = React.useRef(null)
      React.useEffect(() => {
        const appRoot = document.getElementById('root')
        if (appRoot === null) return undefined
        const previous = appRoot.inert
        appRoot.inert = true
        return () => {
          appRoot.inert = previous
        }
      }, [])
      React.useEffect(() => {
        if (focusTitle && titleRef.current !== null) titleRef.current.focus()
      }, [focusTitle])
      return h(primitives.Modal, {
        open: true,
        title,
        onClose: ignoreImplicitDismiss,
        headless: true,
      },
        h('div', { className: 'dsfm-onbContent' },
          h('h2', { ref: titleRef, className: 'dsfm-onbTitle', tabIndex: focusTitle ? -1 : undefined }, title),
          h('div', { className: 'dsfm-onbBody' }, children),
        ),
      )
    }

    /** 产品级、带版本的内测声明：文案版本确认过才不再显示。 */
    function WelcomeNotice(props) {
      const { complete, controller, t } = props
      const state = useStore(controller.store)
      const finished = React.useRef(false)
      const finish = React.useCallback(() => {
        if (finished.current) return
        finished.current = true
        complete()
      }, [complete])
      React.useEffect(() => {
        if (state.status === 'idle') controller.load()
      }, [controller, state.status])
      React.useEffect(() => {
        if (state.acknowledged) finish()
      }, [finish, state.acknowledged])
      if (state.status === 'idle' || state.status === 'loading' || state.acknowledged) return null
      const acknowledge = async () => {
        if (await controller.acknowledge()) finish()
      }
      const paragraphs = t('welcomeBody').split('\n\n')
      return h(OnboardingModal, { title: t('welcomeTitle'), focusTitle: true },
        h('div', { className: 'dsfm-onbCopy' }, paragraphs.map((paragraph) => h('p', { key: paragraph }, paragraph))),
        state.error === null ? null : h('p', { className: 'dsfm-onbError', role: 'alert' }, t('welcomeError')),
        h('div', { className: 'dsfm-onbActions' },
          h(primitives.Button, {
            variant: 'primary',
            disabled: state.status === 'saving',
            onClick: () => {
              acknowledge()
            },
          }, t('welcomeContinue')),
        ),
      )
    }

    /**
     * DeepSeek 官方首次引导：就绪度来自与模型页同一份 provider/settings/credential join——
     * 任何已有可对话的提供方都结束该步骤，只有一条都没有的用户才被提供官方 DeepSeek 路线。
     * 步骤复用该页的凭据编辑器，密钥只输一次（credentialOnly：只写凭据、不动 settings）。
     */
    function DeepSeekOnboardingDialog(props) {
      const { complete, controller, operations, schema, t } = props
      const state = useStore(controller.store)
      const readiness = onboardingReadiness(state)
      React.useEffect(() => {
        if (state.status === 'idle') controller.load()
      }, [controller, state.status])
      React.useEffect(() => {
        if (readiness.kind === 'adapter-absent' || readiness.kind === 'provider-ready' || readiness.kind === 'unavailable') complete()
      }, [complete, readiness.kind])
      if (readiness.kind !== 'credential-missing') return null
      const row = state.rows.find((candidate) => candidate.entry.provider === DEEPSEEK_OFFICIAL_ROUTE && candidate.entry.settingsNs === DEEPSEEK_NS && candidate.entry.settingsPath.length === 0)
      const namespace = state.namespaces.get(DEEPSEEK_NS)
      if (row === undefined || namespace === undefined) return null
      const finishCredential = (changed) => {
        if (!changed) {
          complete()
          return
        }
        controller.load()
      }
      return h(OnboardingModal, { title: t('onboardingTitle') },
        h('p', { className: 'dsfm-hint' }, t('onboardingDescription')),
        h('div', { className: 'dsfm-onbBody' },
          h(ProviderEditor, {
            provider: row.entry.provider,
            displayName: row.entry.displayName,
            namespace,
            schema,
            settingsPath: row.entry.settingsPath,
            operations,
            t,
            readOnly: false,
            hideTitle: true,
            credentialOnly: true,
            credentialRequired: true,
            autoFocusCredential: true,
            cancelLabelKey: 'onboardingLater',
            submitLabelKey: 'onboardingSave',
            submitBusyLabelKey: 'onboardingSaving',
            onClose: finishCredential,
          }),
        ),
      )
    }

    // ── 注册（apply）───────────────────────────────────────────────────

    /** 已打开过才刷新：未打开的模型页不应被后台失效触发请求。 */
    function refreshIfLoaded(controller) {
      if (controller.store.getSnapshot().status === 'idle') return
      controller.load()
    }

    exports.inject = ['slots', 'locale', 'remote', 'remote.credentials', 'remote.llm', 'remote.settings', 'settingsScope', 'settingsSchema']

    exports.apply = (ctx) => {
      injectStyles()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-forge-settings-models: dictionaries')
      const t = ctx.locale.bind(NS)
      const schema = createSettingsSchemaOperations(ctx.settingsSchema)
      const operations = createModelsOperations(ctx)
      const controller = new ModelsSettingsStore(ctx, schema, ctx.settingsScope.describe())
      const welcomeController = new WelcomeNoticeStore(ctx.settingsScope.bind({ namespace: WELCOME_NOTICE_NS, decode: decodeWelcomeSection }))

      ctx.effect(() => {
        const disposeWelcome = () => {
          welcomeController.dispose()
        }
        const disposers = [
          ctx.remote.$on('settings/document-updated', () => {
            refreshIfLoaded(controller)
          }),
          ctx.remote.$on('credentials/reference-updated', () => {
            refreshIfLoaded(controller)
          }),
          ctx.remote.$on('llm/adapters-updated', () => {
            refreshIfLoaded(controller)
          }),
          ctx.on('connection/reset', () => {
            refreshIfLoaded(controller)
          }),
        ]
        return () => {
          disposeWelcome()
          for (const dispose of disposers) dispose()
        }
      }, 'dsh-forge-settings-models: pushed invalidations')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'models',
        order: 10,
        label: () => t('nav'),
        inject: () => ({ controller, operations, schema, t }),
        children: {
          'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
          'settings.models.footer': { kind: 'list', scope: 'root' },
        },
      }, ModelsSection))

      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
        name: 'settings.onboarding',
        id: 'welcome-notice',
        order: -100,
        inject: () => ({ controller: welcomeController, t }),
      }, WelcomeNotice))

      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
        name: 'settings.onboarding',
        id: 'deepseek-official',
        order: 0,
        inject: () => ({ controller, operations, schema, t }),
      }, DeepSeekOnboardingDialog))
    }

    return module.exports
  },
})
