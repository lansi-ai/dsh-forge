/**
 * @lansi-ai/dsh-forge-settings-shell —— 自研设置外壳（替换官方 ui-settings-general）。
 *
 * 契约 1:1 复刻官方外壳（slots.d.ts 语义）：占据 `sidebar.settings` 槽位，声明
 * trigger/header/action/close/section/onboarding 六个子槽位，投影 `settings.section`
 * 账本为左侧导航。官方注册者（General 六行、插件/Agent 预设分区、引导步骤、自研
 * 桌面/主题/关于分区）零改动继续工作。
 *
 * **契约扩展（图标下放）**：导航图标按「分区 id → 主题槽位」解析
 * （`theme/current/icons/settings-nav-<id>.svg`），主题包提供同名文件即随包切换；
 * 未提供时 onError 回退官方 primitives 同款图标（models/agent-presets/plugins 专属，
 * 其余齿轮）——永不裂图。`theme.icon-change` 下行事件驱动全部导航图标刷新。
 *
 * V1 范围：面板框架 + 导航投影 + General 分区 + 触发行/标题/关闭。
 * V2 已补：onboarding 投影（官方 ui-settings-general 的派发面随该包被排除而缺失，本包补齐——
 *   settings.onboarding 注册者挂载后自动工作：会话就绪且当前会话空白/无会话时按 order 展示第一步）。
 * V2 待补：连接恢复指示器、「打开配置文件」action。
 *
 * 注：本文件为浏览器侧 bundle（含 window 全局），不参与 Node 编译。
 */
window.__ModuleLoader__.load({
  id: '@lansi-ai/dsh-forge-settings-shell',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { resolveSlotLabel } = require('@deepseek-ai/dsh-client-ui-slots')

    /** 语言词典命名空间（与官方外壳一致，官方包已被互斥排除，无注册冲突）。 */
    const NS = 'settings'

    // ── 样式（复刻官方 SettingsRoot/chrome/GeneralSection module.css，类名 dss-*）──

    const css = `
.dss-triggerRow{flex:none;align-items:center;gap:8px;width:calc(100% + 4px);margin:4px -2px;display:flex}
.dss-triggerRow.dss-railRow{width:36px;margin:8px 0 10px}
.dss-trigger{box-sizing:border-box;cursor:pointer;width:auto;min-width:0;height:42px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;flex:1;align-items:center;gap:8px;margin:0;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}
.dss-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dss-trigger.dss-rail{border-radius:50%;flex:none;justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0}
.dss-triggerLabel{white-space:nowrap;overflow:hidden}
.dss-overlay{z-index:1000;justify-content:center;align-items:center;display:flex;position:fixed;inset:0}
.dss-mask{background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);position:absolute;inset:0}
.dss-panel{z-index:1;background:var(--dsw-alias-bg-layer-2);width:800px;max-width:calc(100vw - 48px);height:min(800px,100vh - 48px);box-shadow:var(--dsw-elevation-prominent);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:32px;display:flex;position:relative;overflow:hidden}
.dss-nav{box-sizing:border-box;flex-direction:column;flex:none;gap:18px;width:188px;padding:22px 12px 0;display:flex}
.dss-navTitle{color:var(--dsw-alias-label-primary);padding:0 12px;font-size:16px;font-weight:500;line-height:24px}
.dss-navList{flex-direction:column;gap:4px;display:flex}
.dss-navCell{box-sizing:border-box;cursor:pointer;height:40px;color:var(--dsw-alias-label-primary);text-align:left;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:9px 16px 9px 12px;font-family:inherit;font-size:14px;font-weight:400;line-height:22px;display:flex}
.dss-navCell:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}
.dss-navCell.dss-active{background:var(--dsw-specific-sidebar-nav-item-active)}
.dss-navIcon{flex:none}
.dss-navLabel{white-space:nowrap;text-overflow:ellipsis;flex:1;min-width:0;overflow:hidden}
.dss-content{flex-direction:column;flex:1;min-width:0;display:flex}
.dss-header{box-sizing:border-box;flex:none;justify-content:space-between;align-items:flex-start;gap:8px;height:54px;padding:20px 14px 8px 10px;display:flex}
.dss-actions{justify-content:flex-end;align-items:center;gap:8px;min-width:0;margin-left:auto;display:flex}
.dss-close{cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:0;display:inline-flex}
.dss-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dss-options{flex:1;min-height:0;padding:0 24px 24px;overflow-y:auto}
.dss-hiddenLabel{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}
.dss-section{flex-direction:column;width:100%;display:flex}
.dss-section>[data-slot="settings.general.item"]>:last-child{border-bottom:none}
`
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin="@lansi-ai/dsh-forge-settings-shell"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@lansi-ai/dsh-forge-settings-shell'
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ── 导航图标（图标下放）：分区 id → 主题槽位，内联渲染回退官方图标 ─────────

    /** 主题刷新破缓存 token（theme.icon-change 时更新）。 */
    let iconBustToken = Date.now()
    /** 组件侧刷新事件（外壳转发下行桌面事件）。 */
    const ICON_REFRESH_EVENT = 'dsh-settings-shell:icon-refresh'
    /** 主题图标内联渲染服务（apply 时从 ctx 注入；未就绪时回退官方图标）。 */
    let themeIconSvc = null

    /** 官方默认图标映射（主题槽位缺失时的回退；未知 id 回退齿轮）。 */
    const NAV_FALLBACK_ICONS = {
      models: 'IconDataOutline16',
      'agent-presets': 'IconAgentPresetOutline16',
      plugins: 'IconPersonalizationOutline16',
    }

    function fallbackNavIcon(sectionId, className) {
      const name = NAV_FALLBACK_ICONS[sectionId] ?? 'IconSettingsOutline16'
      const Icon = primitives[name]
      return Icon ? h(Icon, { className, size: 16 }) : null
    }

    /**
     * 设置触发按钮图标：优先主题包槽位 `settings-trigger.svg`（宽栏 16 / 窄栏 18），
     * 加载失败（未提供/404）回退官方 primitives 齿轮。主题刷新事件驱动重取。
     */
    function TriggerIcon({ size }) {
      const [bust, setBust] = React.useState(iconBustToken)
      const [html, setHtml] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      React.useEffect(() => {
        const onChange = () => setBust(iconBustToken)
        window.addEventListener(ICON_REFRESH_EVENT, onChange)
        return () => window.removeEventListener(ICON_REFRESH_EVENT, onChange)
      }, [])
      React.useEffect(() => {
        let disposed = false
        setFailed(false)
        setHtml(null)
        if (themeIconSvc === null) {
          setFailed(true)
          return
        }
        themeIconSvc.renderSvg(`dsh-ui://app/theme/current/icons/settings-trigger.svg?t=${bust}`, size)
          .then((value) => {
            if (!disposed) setHtml(value)
          })
          .catch(() => {
            if (!disposed) setFailed(true)
          })
        return () => {
          disposed = true
        }
      }, [size, bust])
      if (failed) return h(primitives.IconSettingsOutline16, { size })
      if (html === null) return null
      return h('span', {
        'aria-hidden': 'true',
        style: { display: 'inline-flex', flexShrink: 0 },
        dangerouslySetInnerHTML: { __html: html },
      })
    }

    /**
     * 导航图标：优先主题包槽位 settings-nav-<id>.svg（内联渲染，单色线条随明暗自适应），
     * 加载失败（未提供/404）回退官方 primitives 图标。主题刷新事件触发重取。
     */
    function NavIcon({ sectionId }) {
      const [bust, setBust] = React.useState(iconBustToken)
      const [html, setHtml] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      React.useEffect(() => {
        const onChange = () => setBust(iconBustToken)
        window.addEventListener(ICON_REFRESH_EVENT, onChange)
        return () => window.removeEventListener(ICON_REFRESH_EVENT, onChange)
      }, [])
      React.useEffect(() => {
        let disposed = false
        setFailed(false)
        setHtml(null)
        if (themeIconSvc === null) {
          setFailed(true)
          return
        }
        themeIconSvc.renderSvg(`dsh-ui://app/theme/current/icons/settings-nav-${sectionId}.svg?t=${bust}`, 16)
          .then((value) => {
            if (!disposed) setHtml(value)
          })
          .catch(() => {
            if (!disposed) setFailed(true)
          })
        return () => {
          disposed = true
        }
      }, [sectionId, bust])
      if (failed) return fallbackNavIcon(sectionId, 'dss-navIcon')
      if (html === null) return null
      return h('span', {
        className: 'dss-navIcon',
        'aria-hidden': 'true',
        dangerouslySetInnerHTML: { __html: html },
      })
    }

    // ── 语言词典（复刻官方 settings NS；connection/openDocument 供 V2 使用）────

    const zh = {
      trigger: '设置',
      title: '设置',
      close: '关闭',
      openDocument: '打开配置文件',
      'openDocument.error': '无法打开配置文件',
      'general.nav': '通用设置',
      'connection.error': '连接异常',
      'connection.retry': '立即重连',
      'connection.connecting': '连接中',
      'connection.connected': '连接成功',
      'connection.reconnect': '连接异常，点击立即重连',
      'connection.restart': '连接中，点击立即重连',
    }
    const en = {
      trigger: 'Settings',
      title: 'Settings',
      close: 'Close',
      openDocument: 'Open configuration file',
      'openDocument.error': 'Could not open configuration file',
      'general.nav': 'General',
      'connection.error': 'Disconnected',
      'connection.retry': 'Reconnect now',
      'connection.connecting': 'Connecting',
      'connection.connected': 'Connected',
      'connection.reconnect': 'Disconnected, reconnect now',
      'connection.restart': 'Connecting, restart now',
    }

    // ── 组件 ─────────────────────────────────────────────────────

    /** 触发行内容：宽列 = 图标 + 文案；窄栏 = 仅图标。 */
    function TriggerContent({ wide, t }) {
      return h(React.Fragment, null,
        h(TriggerIcon, { size: wide ? 16 : 18 }),
        wide && h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden' } }, t('trigger')),
      )
    }

    /** 面板标题文字。 */
    function HeaderContent({ t }) {
      return h(React.Fragment, null, t('title'))
    }

    /** 关闭按钮的视障可读文案。 */
    function CloseLabel({ t }) {
      return h(React.Fragment, null, t('close'))
    }

    /** General 分区内容列（行由各功能包经 settings.general.item 贡献）。 */
    function GeneralSection({ renderSlot }) {
      return h('div', { className: 'dss-section' }, renderSlot('settings.general.item', {}))
    }

    /**
     * 设置面板：全屏遮罩 + 居中面板（导航列 + 内容列）。
     * 关闭路径：头部按钮 / 遮罩点击 / Escape（监听生命周期 = 面板挂载期）。
     */
    function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }) {
      const active = rows.find((row) => row.id === activeId)?.id ?? rows[0]?.id
      const titleId = React.useId()
      React.useEffect(() => {
        const onKeyDown = (e) => {
          if (e.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [onClose])
      const closeButton = React.useRef(null)
      React.useEffect(() => {
        closeButton.current?.focus()
      }, [])
      return h('div', { className: 'dss-overlay', role: 'presentation' },
        h('div', { className: 'dss-mask', 'aria-hidden': 'true', onClick: onClose }),
        h('div', { className: 'dss-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
          h('nav', { className: 'dss-nav' },
            h('div', { className: 'dss-navTitle', id: titleId }, renderSlot('settings.header', {})),
            h('div', { className: 'dss-navList' },
              rows.map((row) => h('button', {
                key: row.id,
                type: 'button',
                className: `dss-navCell${row.id === active ? ' dss-active' : ''}`,
                'aria-current': row.id === active ? 'true' : undefined,
                onClick: () => onSelect(row.id),
              },
                h(NavIcon, { sectionId: row.id }),
                h('span', { className: 'dss-navLabel' }, row.label),
              )),
            ),
          ),
          h('div', { className: 'dss-content' },
            h('div', { className: 'dss-header' },
              h('div', { className: 'dss-actions' }, renderSlot('settings.action', {})),
              h('button', {
                ref: closeButton,
                type: 'button',
                className: 'dss-close',
                onClick: onClose,
              },
                h(primitives.IconCloseOutline16, { size: 14 }),
                h('span', { className: 'dss-hiddenLabel' }, renderSlot('settings.close', {})),
              ),
            ),
            h('div', { className: 'dss-options' },
              active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active }),
            ),
          ),
        ),
      )
    }

    /**
     * 外壳根：侧栏底部触发行 + 居中模态面板 + 引导步骤投影。
     * V2 已补：settings.onboarding 投影（官方语义 1:1——会话就绪且当前会话缺失或为空白会话时，
     * 按 order 取第一个未完成的步骤，经 settings.onboarding 槽位派发 `{stepId, complete, openSection}`，
     * 并以 `{only: stepId}` 只渲染该步；步骤完成后本会话不再显示，退出引导态时清空完成集）。
     * 仍未补：连接恢复指示器、「打开配置文件」action。
     */
    function SettingsRoot(props) {
      const { wide, renderSlot } = props
      const [open, setOpen] = React.useState(false)
      const [activeId, setActiveId] = React.useState(undefined)
      const [completedOnboarding, setCompletedOnboarding] = React.useState(() => new Set())
      const triggerButton = React.useRef(null)
      const wasOpen = React.useRef(open)
      const close = React.useCallback(() => {
        setOpen(false)
        setActiveId(undefined)
      }, [])
      const openSection = React.useCallback((id) => {
        setActiveId(id)
        setOpen(true)
      }, [])
      React.useEffect(() => {
        if (wasOpen.current && !open) triggerButton.current?.focus()
        wasOpen.current = open
      }, [open])
      const rows = React.useSyncExternalStore(sectionsFace.subscribe, sectionsFace.getSnapshot)
      const steps = React.useSyncExternalStore(onboardingFace.subscribe, onboardingFace.getSnapshot)
      // 官方口径：`useSessions` 是 slots 标准 prop（renderer 作用域提供，官方 ui-settings-general 同款用法
      // ——它自己也不硬 inject `sessions`）。缺席时退回自有 store 订阅（`ctx.get('sessions').list`）；
      // 两者都没有则用空 store → 引导永不激活，设置面板其余部分照常（不因引导失败拖垮外壳）。
      const sessionsHook = props.useSessions
      const sessionState = sessionsHook !== undefined
        ? sessionsHook((state) => state)
        : React.useSyncExternalStore((sessionsList ?? EMPTY_STORE).subscribe, (sessionsList ?? EMPTY_STORE).getSnapshot)
      // 引导态 = 会话已就绪且当前会话缺失或为空白会话（官方口径）。
      const onboardingActive = sessionState.phase === 'ready' && (sessionState.current === undefined || sessionState.byId[sessionState.current]?.blank === true)
      React.useEffect(() => {
        if (onboardingActive) return
        setCompletedOnboarding(new Set())
      }, [onboardingActive])
      const onboardingStep = onboardingActive ? steps.find((step) => !completedOnboarding.has(step.id)) : undefined
      const completeOnboardingStep = React.useCallback((id) => {
        setCompletedOnboarding((previous) => new Set([...previous, id]))
      }, [])
      return h(React.Fragment, null,
        h('div', { className: `dss-triggerRow${wide ? '' : ' dss-railRow'}` },
          h('button', {
            ref: triggerButton,
            type: 'button',
            className: `dss-trigger${wide ? '' : ' dss-rail'}`,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            onClick: () => setOpen(true),
          }, renderSlot('settings.trigger', { wide })),
        ),
        open && h(SettingsPanel, { rows, renderSlot, activeId, onSelect: setActiveId, onClose: close }),
        onboardingStep === undefined
          ? null
          : renderSlot('settings.onboarding', {
              stepId: onboardingStep.id,
              complete: () => completeOnboardingStep(onboardingStep.id),
              openSection,
            }, { only: onboardingStep.id }),
      )
    }

    // ── settings.section 账本投影（导航行：id/order/label，按 order 升序）──────

    let sectionsFace = null
    let rowsVersion = -1
    let rowsRevision = -1
    let rowsCache = []

    /** settings.onboarding 账本投影（id/order，按 order 升序）——引导步骤的开关面。 */
    let onboardingFace = null
    /** 降级用 session 清单 store（`ctx.get('sessions').list`；正常路径走 props.useSessions）。 */
    let sessionsList = null

    /** 空会话快照（sessions 服务缺席时的稳定兜底：引导永不激活）。 */
    const EMPTY_SESSION_STATE = { phase: 'pending', current: undefined, byId: {} }
    /** 空 store：subscribe 返回 no-op 退订，getSnapshot 返回稳定空态（uSES 要求引用稳定）。 */
    const EMPTY_STORE = { subscribe: () => () => {}, getSnapshot: () => EMPTY_SESSION_STATE }

    /** 建立 settings.section 账本 + locale 修订的快照面（apply 时绑定 ctx）。 */
    function bindSectionsFace(ctx) {
      rowsCache = []
      sectionsFace = {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.section')
          const revision = ctx.locale.getSnapshot().revision
          if (version !== rowsVersion || revision !== rowsRevision) {
            rowsVersion = version
            rowsRevision = revision
            rowsCache = ctx.slots.entries('settings.section')
              .map((entry) => ({
                id: entry.options.id ?? '',
                order: entry.options.order ?? 0,
                label: resolveSlotLabel(entry.options.label) ?? '',
              }))
              .sort((a, b) => a.order - b.order)
          }
          return rowsCache
        },
        subscribe: (listener) => {
          const offLedger = ctx.slots.subscribe('settings.section', listener)
          const offLocale = ctx.locale.subscribe(listener)
          return () => {
            offLedger()
            offLocale()
          }
        },
      }
    }

    /**
     * 建立 settings.onboarding 账本投影（V2 补齐官方 ui-settings-general 的引导投影：
     * 该投影原先在被排除的官方包里，故 forge 外壳此前声明了槽位却不派发，任何注册者都不显示）。
     */
    function bindOnboardingFace(ctx) {
      let stepsVersion = -1
      let stepsCache = []
      onboardingFace = {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.onboarding')
          if (version !== stepsVersion) {
            stepsVersion = version
            stepsCache = ctx.slots.entries('settings.onboarding')
              .map((entry) => ({ id: entry.options.id ?? '', order: entry.options.order ?? 0 }))
              .sort((a, b) => a.order - b.order)
          }
          return stepsCache
        },
        subscribe: (listener) => ctx.slots.subscribe('settings.onboarding', listener),
      }
    }

    // ── 注册（apply）──────────────────────────────────────────────

    exports.inject = ['slots', 'locale', 'themeIcon']

    exports.apply = (ctx) => {
      bindSectionsFace(ctx)
      bindOnboardingFace(ctx)
      // 引导态判定的降级数据源：sessions 服务由客户端运行时提供（**不硬 inject**——硬注入失败会让
      // 整个设置外壳 pending，代价远大于「引导不显示」）。正常路径走 slots 标准 prop `useSessions`。
      sessionsList = (() => {
        try {
          return ctx.get('sessions')?.list ?? null
        } catch {
          return null
        }
      })()
      // 主题图标内联渲染服务（无依赖自身可选；未提供时导航回退官方图标）
      themeIconSvc = ctx.get('themeIcon') ?? null
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-settings-shell: dictionaries')
      const t = ctx.locale.bind(NS)

      // 占据 sidebar.settings（六子槽位声明与官方契约一致；桌面侧栏壳零改动继续投影）
      ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
        name: 'sidebar.settings',
        locale: NS,
        children: {
          'settings.trigger': { kind: 'single', scope: 'root' },
          'settings.header': { kind: 'single', scope: 'root' },
          'settings.action': { kind: 'list', scope: 'root' },
          'settings.close': { kind: 'single', scope: 'root' },
          'settings.section': { kind: 'list', scope: 'root' },
          'settings.onboarding': { kind: 'list', scope: 'root' },
        },
      }, SettingsRoot))

      ctx.slots.inject('settings.trigger', () => ctx.slots.register({ name: 'settings.trigger', locale: NS }, TriggerContent))
      ctx.slots.inject('settings.header', () => ctx.slots.register({ name: 'settings.header', locale: NS }, HeaderContent))
      ctx.slots.inject('settings.close', () => ctx.slots.register({ name: 'settings.close', locale: NS }, CloseLabel))

      // General 分区（order 0；行由各功能包经 settings.general.item 贡献）
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'general',
        order: 0,
        label: () => t('general.nav'),
        locale: NS,
        children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
      }, GeneralSection))

      // 主题切换下行事件 → 导航图标刷新（破缓存 token + 组件侧事件）
      window.desktopBridge?.onDesktopEvent?.((event) => {
        if (event?.action === 'theme.icon-change') {
          iconBustToken = Date.now()
          window.dispatchEvent(new CustomEvent(ICON_REFRESH_EVENT))
        }
      })
    }

    return module.exports
  },
})
