/**
 * 更新渠道规则（纯逻辑，不依赖 Electron —— 便于单测，见 `test/updater-channel.test.cjs`）。
 *
 * 背景（坑 75）：`electron-updater` 的 `allowPrerelease` 默认由**当前安装版本**推导
 * （`AppUpdater.js:218` `allowPrerelease = hasPrereleaseComponents(currentVersion)`），
 * 于是「正式版装机 + 选预发布渠道」永远看不到 `-rc.N`：provider 只读官方最新正式版、
 * 再与已装版本比较，结果恒为「已是最新」。DSH Forge 的渠道是三态开关，语义应由**渠道**决定，
 * 故此处显式回答「该渠道要不要把预发布版纳入候选」，由 `auto-updater.ts` 写进 updater。
 *
 * 渠道与描述符（`Provider.getCustomChannelName`：win 无平台后缀、mac 为 `-mac`）：
 *   - `stable` → `channel = null` → 描述符 `latest.yml`；不纳入预发布；
 *   - `rc`     → `channel = 'rc'` → 描述符 `rc.yml`；**纳入预发布**（且 provider 按 tag 的
 *     预发布段匹配，只认 `-rc.N`）；
 *   - `off`    → 完全关闭（不检查，也不改 feed）。
 */

/** 更新渠道：stable（正式）/ rc（预发布）/ off（完全关闭）。 */
export type UpdaterChannel = 'stable' | 'rc' | 'off'

/**
 * 渠道 → electron-updater `channel` 值（`null` = 默认 `latest.yml`）。
 * `off` 不在此表内（调用方在 off 时直接跳过同步）。
 */
export const CHANNEL_FEED: Readonly<Record<Exclude<UpdaterChannel, 'off'>, string | null>> = {
  stable: null,
  rc: 'rc',
}

/**
 * 该渠道是否把预发布版纳入更新候选。
 *
 * 只有 `rc` 为真：正式渠道应严格只看正式版（否则「正式」名不副实）；关闭渠道无检查语义。
 *
 * @param channel 当前渠道。
 * @returns 是否允许预发布版参与比较。
 */
export function allowPrereleaseFor(channel: UpdaterChannel): boolean {
  return channel === 'rc'
}
