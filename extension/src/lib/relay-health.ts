/**
 * 「此刻连没连上、为什么没连上、我该干什么」——弹窗顶上那颗点背后的唯一判据。
 *
 * 纯函数，不碰 chrome.*、不发请求：两个输入（**我们这个 SW** 的中继现状 + **后端**对
 * 浏览器采集能力的快判）进来，一个可直接渲染的视图出去。
 *
 * 为什么必须合两个来源，不能只信 SW 那一个布尔：`connected:false` 在扩展这侧是个**歧义**
 * 答案，至少罩着三种下一步完全不同的处境——
 *   1. 以前连上过、后端此刻也没有别人 → 掉线了，等退避重连 / 点一下立刻重连；
 *   2. 后端说它此刻**正连着**别人 → 中继被另一个浏览器（另一个 profile / 另一台机器上的
 *      Chrome）占着，在这个 Chrome 里怎么点都不会好，得去那边或者改配置；
 *   3. 后端说**从来没有任何扩展连上过** → 这个 Stream 压根没被配过浏览器采集，用户要做的
 *      是装扩展 / 换那个装了扩展的 Chrome，而不是等重连。
 * 只报一句"未连接"，用户在这三种里得自己猜，而它们之间没有任何可观察的差别。
 */

/** 后端 `GET /api/browser-capability` 的返回里，弹窗用得上的那几格。 */
export interface CapabilitySnapshot {
  state: 'ready' | 'disconnected' | 'never-seen'
  connected: boolean
  everSeen: boolean
  lastSeenAt?: string
}

export type RelayHealthKind =
  /** 我们这个 SW 的中继连着——现在就能采。 */
  | 'ready'
  /** 连过、现在断了。可以一键立刻重连（否则等退避，最坏 30s）。 */
  | 'offline'
  /** 中继被**别的**浏览器占着——在这个 Chrome 里点什么都没用。 */
  | 'other-browser'
  /** 这个 Stream 从没有任何扩展连上过。 */
  | 'never-seen'
  /** 后端本身够不着（没配地址 / 没起 / 口易主）。 */
  | 'backend-unreachable'

export interface RelayHealth {
  kind: RelayHealthKind
  /** 顶上那颗点的成色。 */
  tone: 'ok' | 'warn' | 'bad'
  /** 徽章上的字，越短越好。 */
  label: string
  /** 一句话说清处境（`ready` 时为空——没事就别说话）。 */
  detail: string
  /** 「立刻重连」这个按钮该不该出现。只在**我们自己**该连而没连上时才有意义。 */
  canReconnect: boolean
}

/**
 * @param swConnected 本扩展 SW 的中继是否在线（`relay-status` 消息的回答）；SW 不可达算 false。
 * @param cap 后端快判；取不到（后端够不着）传 null。
 */
export function relayHealth(swConnected: boolean, cap: CapabilitySnapshot | null): RelayHealth {
  if (swConnected) {
    return { kind: 'ready', tone: 'ok', label: 'connected', detail: '', canReconnect: false }
  }
  if (!cap) {
    return {
      kind: 'backend-unreachable',
      tone: 'bad',
      label: 'no Stream',
      detail: "Can't reach Stream at this address — check that it's running, or fix the URL above.",
      canReconnect: false,
    }
  }
  // 后端此刻连着别人：我们这条没连不是"掉线"，是中继被占。**先于 everSeen 判**——
  // 这种情形下 everSeen 必然为 true，按 everSeen 走就会给出一个在这里永远点不好的重连按钮。
  if (cap.connected) {
    return {
      kind: 'other-browser',
      tone: 'warn',
      label: 'other browser',
      detail: 'Stream is connected to a different browser. This Chrome will stay idle until that one disconnects.',
      canReconnect: false,
    }
  }
  if (!cap.everSeen) {
    return {
      kind: 'never-seen',
      tone: 'bad',
      label: 'never connected',
      detail: 'This Stream has never seen the extension. Make sure this Chrome is the one Stream harvests with, then reload the extension.',
      canReconnect: true,
    }
  }
  return {
    kind: 'offline',
    tone: 'warn',
    label: 'offline',
    detail: lastSeenDetail(cap.lastSeenAt),
    canReconnect: true,
  }
}

function lastSeenDetail(lastSeenAt: string | undefined, now: number = Date.now()): string {
  const base = 'Disconnected from Stream. Reconnecting automatically'
  const t = lastSeenAt ? Date.parse(lastSeenAt) : NaN
  if (Number.isNaN(t)) return `${base}.`
  return `${base} — last connected ${humanAgo(Math.max(0, now - t))} ago.`
}

/** 「多久以前」的粗粒度说法。秒/分/小时/天，不做本地化——弹窗其余文案也都是英文。 */
export function humanAgo(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}
