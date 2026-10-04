import type { SourceHealth } from '../source-health-store.ts'
import type { SourceManifest } from '../manifest/types.ts'
import { isSessionAuth } from '../manifest/types.ts'
import { canonicalSourceId } from '../streams/store.ts'

export interface FacilityAuthInput {
  manifest: Pick<SourceManifest, 'id' | 'facility' | 'auth'>
  health?: Pick<SourceHealth, 'lastOutcome' | 'lastErrorCategory' | 'lastAt' | 'lastError'>
}
export interface FacilityAuthNeed {
  facility: string
  label: string
  /** 哪一支登录 provider 来接这一格。面板据此决定画什么：`qr` 画二维码，`oauth` 只画一个
   *  「开始登录」+ 等 provider 的引导语（它中途需要人时发 `login-needsHuman`）。 */
  login: 'qr' | 'oauth'
  since: string
  lastReason: string
}

/**
 * 哪几种 `login:` 值该在重登面板里露面。
 *
 * **判据要有名字**：这份名单曾经是 `facilityAuthView` 里内联的一句 `auth.login !== 'qr'`，
 * 于是加了 `login:'oauth'` 那一支之后，provider 注册了、能跑，但它的 facility **永远不会
 * 出现在面板里**——横幅不亮、没有入口、一个字都不报错，整条能力静默地是死代码。
 *
 * 往 `SessionAuthSpec` 加第四种 login 时，来这里回答一次"它需不需要 Stream 出面"。
 */
export const PANEL_LOGIN_KINDS = ['qr', 'oauth'] as const

function surfacesInPanel(login: string): login is FacilityAuthNeed['login'] {
  return (PANEL_LOGIN_KINDS as readonly string[]).includes(login)
}

/** Project per-source health into "which facilities are showing the login wall now".
 *  Pure: no store, no clock. A facility needs login iff one of its `type:'session'`
 *  sources' LATEST outcome is an `auth`-category error. First flagged source per
 *  facility wins (they share one session, so any one is representative). */
export function facilityAuthView(sources: FacilityAuthInput[]): FacilityAuthNeed[] {
  const out = new Map<string, FacilityAuthNeed>()
  for (const { manifest, health } of sources) {
    const auth = manifest.auth
    if (!auth || !isSessionAuth(auth)) continue
    // 只有「Stream 出面替他登」的那几支在这里露面（见 PANEL_LOGIN_KINDS）。cookie 注入那支
    // 的会话住在用户自己的 Chrome 里，过期了他自己重登就行，弹面板没有意义。
    if (!surfacesInPanel(auth.login)) continue
    if (!health || health.lastOutcome !== 'error' || health.lastErrorCategory !== 'auth') continue
    const key = manifest.facility?.key ?? auth.facility
    if (out.has(key)) continue
    out.set(key, {
      facility: key,
      label: manifest.facility?.label ?? key,
      login: auth.login,
      since: health.lastAt,
      lastReason: health.lastError ?? 'needs re-login',
    })
  }
  return [...out.values()]
}

/** Wrap a live snapshot supplier so the route always projects current health. */
export function buildAuthFacilities(snapshot: () => FacilityAuthInput[]): () => FacilityAuthNeed[] {
  return () => facilityAuthView(snapshot())
}

/** Build the auth snapshot from registered manifests, pairing each with its health via
 *  the SAME key the scheduler records under: `canonicalSourceId(pluginId, id)` (e.g.
 *  "replay:xhs-home"), NOT the bare manifest id — which never matches for a plugin-owned
 *  source, so the login wall would go unseen and the re-login panel never appears. Falls
 *  back to the bare id defensively (custom/unprefixed sources already canonicalize to it). */
export function authInputs(
  manifests: Array<Pick<SourceManifest, 'id' | 'facility' | 'auth'> & { pluginId?: string }>,
  getHealth: (key: string) => FacilityAuthInput['health'],
): FacilityAuthInput[] {
  return manifests.map((m) => ({
    manifest: { id: m.id, facility: m.facility, auth: m.auth },
    health: getHealth(canonicalSourceId(m.pluginId ?? 'custom', m.id)) ?? getHealth(m.id),
  }))
}
