import { useCallback, useEffect, useState } from 'react'
import { Plus, Radar, Cookie, Check, Radio, RefreshCw, Link2 } from 'lucide-react'
import { getConfig, setConfig, PROBE_CANDIDATES, syncableDomains, type Config } from '../../lib/config.ts'
import { getRadar, getBrowserCapability, type RadarResult } from '../../lib/stream-api.ts'
import { relayHealth, type CapabilitySnapshot, type RelayHealth } from '../../lib/relay-health.ts'
import { bindingBadge, isActiveBinding, type BindingOnlineState } from '../../lib/binding-badge.ts'
import {
  extTransport, toCandidates, toChannelSummaries, getChannels, createChannel, type RawChannel,
} from '../../lib/subscribe-shell.ts'
import { subscribe, unsubscribe } from '@subscribe/subscribe.ts'
import { computeStates } from '@subscribe/state.ts'
import type { SyncResult } from '../../lib/sync.ts'
import { syncFromPopup } from '../../lib/sync-now.ts'
import { findPairedPeer } from '../../lib/pairing.ts'
import { nativeHostToken, nativeHostStatus } from '../../lib/native-host.ts'
import { verifyBackend } from '../../lib/backend-identity.ts'
import { CookiePanel } from './CookiePanel.tsx'
import { BindingsPanel } from './BindingsPanel.tsx'
import { CookieGapBanner } from './CookieGapBanner.tsx'
import { readProfileLine, type ProfileLine } from '../../lib/profile-line.ts'
import { Backdrop } from '@/components/acrylic/backdrop.tsx'
import { Card } from '@/components/acrylic/card.tsx'
import { Item, ItemContent, ItemTitle, ItemDescription, ItemActions } from '@/components/acrylic/item.tsx'
import { Button } from '@/components/acrylic/button.tsx'
import { Badge } from '@/components/acrylic/badge.tsx'
import { Separator } from '@/components/acrylic/separator.tsx'
import { Combobox } from '@/components/acrylic/combobox.tsx'

/**
 * 弹窗里自动填一个候选地址，纯粹是省得用户手打——**不是信任判据**。真正决定连不连的还是
 * background 自己那次独立的 `findPairedPeer`（`lib/driver.ts` 的 `start()`）：background
 * 每次启动都会自己按候选表配对，就算这里探错了、或者压根没探，也不影响它的判断。
 *
 * 但它现在也走 `findPairedPeer`，而不是随便探一个答话的地址——理由不是安全（这里本来就在
 * 信任边界外），是**诚实**：只有真配对成功的地址才会出现在输入框里，意味着"它一出现就连得上"；
 * 反之，一个能答 HTTP 但没有这把 secret 的本地进程（旧后端、别的服务）以前会被填进去，
 * 用户看到"有地址了"却连不上，比空着更难排查。返回的 token 弃而不用——连接路径每次都自己
 * 重新取一遍，这里只要地址。
 */
async function probeDefaultUrl(candidates: string[] = PROBE_CANDIDATES): Promise<string> {
  // 不传 log 就是没有任何诊断：pairing.ts 只经 `deps.log?.` 记录，没有它，一次失败的探测
  // 在这个弹窗里连一行 console 都留不下——用户看到的只是空输入框，猜不出原因。这里的
  // console.warn 至少能在弹窗自己的 devtools 里看到（background 那份诊断走 debugLog，
  // 各自独立，互不替代）。
  const peer = await findPairedPeer(candidates, {
    token: nativeHostToken,
    verify: verifyBackend,
    // 详情**折进消息字符串**，不只作为第二个参数：console 的第二个参数在 DevTools 里是一个
    // 要手点才展开的箭头，复制出来只剩 `[object Object]`——而这行日志的全部价值就是那个
    // `reason`（"native host 没登记" 之类）。活体 2026-09-08 撞到过：用户贴来的正是
    // `pairing-no-token [object Object]`，唯一说得出原因的地方什么都没说。
    log: (event, detail) => console.warn(`[popup pairing] ${event} ${JSON.stringify(detail)}`, detail),
  })
  return peer?.baseUrl ?? ''
}

/** 一条绑定的在线状态；`id` 用来单独认出本机那条（下面的不 ready 提示只对它有意义）。 */
type BindingOnline = BindingOnlineState & { id: string }

/** 问 SW「每条绑定的中继连没连上」。SW 不可达也算全离线——而这次询问本身就会把它唤醒并重走连接流程。 */
async function queryBindings(): Promise<BindingOnline[]> {
  try {
    const r = (await chrome.runtime.sendMessage({ type: 'bindings-status' })) as { bindings?: BindingOnline[] } | undefined
    return r?.bindings ?? []
  } catch {
    return []
  }
}

type Tab = 'radar' | 'cookie' | 'streams'

export default function App() {
  const [cfg, setCfg] = useState<Config | null>(null)
  const [url, setUrl] = useState('')
  const [radar, setRadar] = useState<RadarResult | null>(null)
  const [channels, setChannels] = useState<RawChannel[]>([])
  const [currentId, setCurrentId] = useState<string>('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [sync, setSync] = useState<SyncResult | { error: string } | null>(null)
  const [tab, setTab] = useState<Tab>('radar')
  // 全部绑定的中继在线状态：null=还在查（徽标画 checking…）。**不许默认画成 connected**：
  // 查询要走一次 SW 往返（SW 睡着时还得等它醒），先亮一颗绿点再翻黄，比诚实地说 "checking…"
  // 更容易被读成"好着呢"。徽标按它汇总（lib/binding-badge.ts）；本机那条的在线与否另外
  // 喂给下面的不 ready 提示。
  const [bindings, setBindings] = useState<BindingOnline[] | null>(null)
  const relayUp = bindings === null ? null : Boolean(bindings.find((b) => b.id === 'local')?.connected)
  // 后端对浏览器采集能力的快判。**只在我们这条没连上时才需要**——它存在的意义是把
  // "没连上"这个歧义答案拆成掉线 / 被别的浏览器占着 / 从没连上过（见 lib/relay-health.ts）。
  // null = 还没查 / 查不到（老后端没这一口、或后端够不着），两者都按"读不到"处理。
  const [cap, setCap] = useState<CapabilitySnapshot | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  // 启动那一段抛了什么。非空 ⇒ 不再画那个永远转不完的 "Loading…"，直接把错误摆出来。
  const [bootError, setBootError] = useState('')
  // 「没配对上」的三种病因（native host 未注册 / 后端没起 / 端口被别的进程占了）里，只有
  // 第一种能在这里查得出来——它是纯 native messaging 往返，不需要后端在跑。只在探测失败
  // （仍没有 baseUrl）时才查，成功了就不必知道原因。null=还没查/不需要查。
  const [hostStatus, setHostStatus] = useState<{ paired: boolean; reason?: string } | null>(null)
  // 这个扩展在哪个 profile、哪个环境（browser-identity D12）。null = 还没读到 / SW 还没生成过 nodeId：不画。
  const [profile, setProfile] = useState<ProfileLine | null>(null)
  useEffect(() => {
    let cancelled = false
    readProfileLine(cfg?.baseUrl ?? '')
      .then((p) => { if (!cancelled) setProfile(p) })
      .catch(() => { /* 读不到就不画这一行 */ })
    return () => { cancelled = true }
  }, [cfg?.baseUrl])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let states = await queryBindings()
      // 还有可连的绑定没连上 ⇒ 2s 后复查一次：这次询问会唤醒 SW 触发重连，
      // 捕捉「唤醒后刚连上」的窗口。
      if (states.some((b) => isActiveBinding(b) && !b.connected)) {
        await new Promise((r) => setTimeout(r, 2000))
        if (cancelled) return
        states = await queryBindings()
      }
      if (!cancelled) setBindings(states)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 没连上 ⇒ 去问后端「你那边是什么情况」。连上了就不问：`ready` 不需要病因，多打一次
  // 往返也没有任何人会读。
  useEffect(() => {
    if (relayUp !== false || !cfg?.baseUrl) return
    let cancelled = false
    getBrowserCapability(cfg)
      .then((c) => {
        if (!cancelled) setCap(c)
      })
      .catch(() => {
        // 读不到就是读不到（老后端 404 / 后端够不着），保持 null —— relayHealth 会把它
        // 报成 backend-unreachable，而不是编一个病因出来。
      })
    return () => {
      cancelled = true
    }
  }, [relayUp, cfg?.baseUrl])

  const reconnect = useCallback(async () => {
    setReconnecting(true)
    try {
      try {
        await chrome.runtime.sendMessage({ type: 'relay-reconnect' })
      } catch {
        // SW 不可达——这条消息本身就会把它唤醒，唤醒即重走连接流程，所以照样往下复查。
      }
      // 复查，别报"已重连"：`forceReconnect` 只保证"这就去试"。握手要走 native host 取
      // token + 验身份，本机实测在百毫秒量级，这里给到 6s 再放弃。
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        const states = await queryBindings()
        if (states.some((b) => b.id === 'local' && b.connected)) {
          setBindings(states)
          return
        }
      }
      setBindings(await queryBindings())
      if (cfg?.baseUrl) await getBrowserCapability(cfg).then(setCap).catch(() => {})
    } finally {
      setReconnecting(false)
    }
  }, [cfg?.baseUrl])

  useEffect(() => {
    ;(async () => {
      try {
      // 不给新装的扩展种任何默认域：要同步哪些域由 Stream 经 sync-config 的 `requiredDomains`
      // 下发（在同步时并进来），`domains` 只放用户自己加的。手写一份默认表只会过期，
      // 而且等于让扩展认识一批具体站点。
      let c = await getConfig()
      if (!c.baseUrl) {
        const found = await probeDefaultUrl()
        if (found) {
          await setConfig({ baseUrl: found })
          c = await getConfig()
        } else {
          // 探测一个都没成 —— 这是 `nativeHostStatus()` 唯一有活干的时候：它是零依赖后端的
          // native messaging 往返，能在"后端没起"这类原因之外单独把"host 压根没注册"这个
          // 病因指出来（此前它 `zero callers`，这条诊断信息在弹窗里从来没被用过）。
          setHostStatus(await nativeHostStatus())
        }
      }
      setCfg(c)
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const u = tab?.url ?? ''
      setUrl(u)
      if (c.baseUrl) {
        // One round-trip on open: candidates for this page + the channels (with their members'
        // keys). Subscription state is computed client-side and recomputed locally on channel
        // switch — no further requests until the user acts.
        try {
          const [chs, rad] = await Promise.all([getChannels(c), u ? getRadar(c, u) : Promise.resolve(null)])
          setChannels(chs)
          setCurrentId(chs.find((x) => x.id === 'default-timeline')?.id ?? chs[0]?.id ?? '')
          if (rad) {
            setRadar(rad)
            // Nudge the login domains of this page's candidates into the sync set, so a
            // login-gated source (e.g. 雪球) gets its cookie synced once it's on screen.
            const next = syncableDomains(c.domains, rad.matches)
            if (next.length !== c.domains.length) {
              await setConfig({ domains: next })
              c = await getConfig()
              setCfg(c)
            }
          }
        } catch (e) {
          setMsg(String(e))
        }
      }
      } catch (e) {
        // 这一段里任何一步抛出（读配置、探地址、查 native host…），`cfg` 就永远是 null，
        // 弹窗于是**永久停在 "Loading…"**——一个不会自己变的加载态，和白屏一样没有信息量，
        // 而且没有任何一处会喊。抓住它，把它画出来（下面 `bootError` 那一支）。
        setBootError(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
      }
    })()
  }, [])

  // `relayUp === null`（还在查）时不渲染它——理由同上面 `bindings` 那行注释。
  const health = relayHealth(relayUp === true, cap)
  const badge = bindingBadge(bindings)

  const shell = 'relative w-[340px] overflow-hidden text-[13px] text-foreground'
  if (!cfg)
    return (
      <div className={shell}>
        <Backdrop />
        <Card className="flex flex-col gap-2 rounded-none p-4">
          {bootError ? (
            <>
              <span className="font-semibold text-[var(--acr-orange)]">Stream Companion failed to start</span>
              <span className="whitespace-pre-line break-all font-mono text-[11px] leading-relaxed text-foreground/80">{bootError}</span>
              <span className="text-xs text-muted-foreground">Reload the extension at chrome://extensions, then reopen this popup.</span>
            </>
          ) : (
            <span className="text-muted-foreground">Loading…</span>
          )}
        </Card>
      </div>
    )

  async function saveUrl(next: string) {
    await setConfig({ baseUrl: next.replace(/\/$/, '') })
    setCfg(await getConfig())
    // 本机绑定刚有地址：徽标立刻把它算进去，别等下次打开弹窗。
    setBindings(await queryBindings())
  }

  async function applyConfig(patch: Partial<Config>) {
    await setConfig(patch)
    setCfg(await getConfig())
  }

  async function syncNow() {
    setSyncing(true)
    setSync(null)
    try {
      // 后台不可达、以及"重跑完要重读配置"两件事都在 syncFromPopup 里（有测试钉着，
      // 见 lib/sync-now.ts 的头注：不重读的话按钮旁边那行时间戳永远不动）。
      const { outcome, config } = await syncFromPopup({ send: (m) => chrome.runtime.sendMessage(m) })
      setSync(outcome)
      setCfg(config)
    } finally {
      setSyncing(false)
    }
  }

  // Derived subscription view: channels → summaries → the current channel's member-key set →
  // per-candidate {subscribed} state. All local; switching `currentId` re-derives with no fetch.
  const summaries = toChannelSummaries(channels)
  const current = summaries.find((c) => c.id === currentId) ?? null
  const states = radar
    ? computeStates(toCandidates(radar), new Set(current?.members.map((m) => m.key) ?? []))
    : []

  async function toggle(key: string, candidate: { sourceId: string; params: Record<string, unknown>; title: string }, subscribed: boolean) {
    if (!cfg || !current) return
    setBusyKey(key)
    setMsg('')
    try {
      const t = extTransport(cfg)
      if (subscribed) await unsubscribe(t, candidate, current, summaries)
      else await subscribe(t, candidate, current, summaries)
      setChannels(await getChannels(cfg)) // re-read → state re-derives
    } catch (e) {
      setMsg(`Failed: ${String(e)}`)
    } finally {
      setBusyKey(null)
    }
  }

  async function addChannel(label: string) {
    if (!cfg || !label.trim()) return
    try {
      const ch = await createChannel(cfg, label.trim())
      setChannels(await getChannels(cfg))
      setCurrentId(ch.id)
    } catch (e) {
      setMsg(`Failed: ${String(e)}`)
    }
  }

  return (
    <div className={shell}>
      <Backdrop />
      <Card className="flex flex-col rounded-none">
        {/* Header band */}
        <header className="flex items-center gap-2 border-b border-[var(--acr-border-soft)] px-3.5 py-3">
          <Radio className="size-4 text-[var(--acr-blue)]" />
          <span className="font-semibold">Stream</span>
          <span className="ml-auto">
            <Badge variant="secondary" size="sm" className="gap-1">
              <span className={`size-1.5 rounded-full ${TONE_DOT[badge.tone]}`} /> {badge.label}
            </Badge>
          </span>
        </header>

        {profile && (
          <div className="flex flex-col gap-0.5 border-b border-[var(--acr-border-soft)] px-3.5 py-2 text-xs">
            <span className={profile.claimed ? 'font-medium' : 'text-[var(--acr-orange)]'}>{profile.title}</span>
            {profile.hint && <span className="text-[11px] text-muted-foreground">{profile.hint}</span>}
          </div>
        )}

        <div className="flex flex-col gap-3 p-3.5">
        {/* 连接状态。**只在不 ready 时出现**，而不 ready 时一定出现：以前这里唯一的信号是
            右上角一颗黄点加两个字（"ws off"），它说了"坏了"却没说"坏在哪、我该干什么"，
            而那三种病因的下一步互相之间毫无关系（见 lib/relay-health.ts 的头注）。 */}
        {cfg.baseUrl && relayUp !== null && health.kind !== 'ready' && (
          <StatusBanner health={health} busy={reconnecting} onReconnect={() => void reconnect()} />
        )}

        {/* 这个 profile 没给 Stream 的登录态域（同步范围 / 站点权限），一键补上。没缺口不画。 */}
        {cfg.baseUrl && <CookieGapBanner onFixed={() => void syncNow()} />}

        {cfg.baseUrl && (
          <>
            <Separator />

            {/* Page toggle: radar (this page) ⇄ cookie (sync) */}
            <div className="flex gap-1 rounded-[9px] bg-[var(--acr-card-nested)] p-1">
              <Button
                size="small"
                variant={tab === 'radar' ? 'default' : 'ghost'}
                className="h-6 flex-1"
                onClick={() => setTab('radar')}
              >
                <Radar /> Radar
              </Button>
              <Button
                size="small"
                variant={tab === 'cookie' ? 'default' : 'ghost'}
                className="h-6 flex-1"
                onClick={() => setTab('cookie')}
              >
                <Cookie /> Cookies
              </Button>
              <Button
                size="small"
                variant={tab === 'streams' ? 'default' : 'ghost'}
                className="h-6 flex-1"
                onClick={() => setTab('streams')}
              >
                <Link2 /> Streams
              </Button>
            </div>

            {tab === 'streams' ? (
              <BindingsPanel hostStatus={hostStatus} onSaveUrl={saveUrl} />
            ) : tab === 'radar' ? (
            /* Radar */
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Radar className="size-3.5" /> This page
              </div>
              <div className="truncate text-[11px] text-muted-foreground/70">{url || '—'}</div>
              {states.length > 0 ? (
                <>
                  {/* Subscribe target — the current channel. Switching recomputes ✓ states
                      locally; typing a new name in the combo box creates a channel inline. */}
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="shrink-0">Add to</span>
                    <div className="min-w-0 flex-1">
                      <Combobox
                        options={channels.map((c) => ({ value: c.id, label: c.label }))}
                        value={currentId}
                        onValueChange={setCurrentId}
                        onCreate={(label) => void addChannel(label)}
                        placeholder="Select channel…"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    {states.map(({ candidate, key, subscribed }) => (
                      <Item key={key} variant="muted" size="sm" className="items-center">
                        <ItemContent>
                          <ItemTitle className="text-[13px]">{candidate.title}</ItemTitle>
                          <ItemDescription>
                            {Object.entries(candidate.params).map(([k, v]) => `${k}=${v}`).join(' · ') || candidate.sourceId}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Button
                            size="small"
                            variant={subscribed ? 'neutral' : 'default'}
                            disabled={busyKey === key || !current}
                            onClick={() => void toggle(key, candidate, subscribed)}
                          >
                            {subscribed ? <><Check /> Subscribed</> : <><Plus /> Add</>}
                          </Button>
                        </ItemActions>
                      </Item>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {radar?.fallback === 'generic-url'
                    ? 'No Stream source matches — the browser fallback will handle it.'
                    : 'No Stream source matches this page.'}
                </p>
              )}
            </div>
            ) : (
              <CookiePanel cfg={cfg} onConfig={applyConfig} syncing={syncing} onSyncNow={syncNow} syncResult={sync} />
            )}
          </>
        )}

        {/* 本机没有 Stream 的机器（NAS 上的 Chrome）照样要能配对远处那个——上面的页签只在本机
            Stream 找到时才出现，所以这里单独给一份。 */}
        {!cfg.baseUrl && (
          <>
            <Separator />
            <BindingsPanel hostStatus={hostStatus} onSaveUrl={saveUrl} />
          </>
        )}

        {msg && (
          <>
            <Separator />
            <p className="whitespace-pre-line break-all font-mono text-[11px] leading-relaxed text-foreground/80">{msg}</p>
          </>
        )}
        </div>
      </Card>
    </div>
  )
}

const TONE_DOT: Record<RelayHealth['tone'], string> = {
  ok: 'bg-[var(--acr-green)]',
  warn: 'bg-[var(--acr-yellow,var(--acr-orange))]',
  bad: 'bg-[var(--acr-red,var(--acr-orange))]',
}

function StatusBanner({ health, busy, onReconnect }: { health: RelayHealth; busy: boolean; onReconnect: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-[9px] bg-[var(--acr-card-nested)] p-2.5">
      <p className={`text-xs leading-relaxed ${health.tone === 'bad' ? 'text-[var(--acr-orange)]' : 'text-muted-foreground'}`}>
        {health.detail}
      </p>
      {health.canReconnect && (
        <Button size="small" variant="default" className="h-6 self-start" disabled={busy} onClick={onReconnect}>
          <RefreshCw /> {busy ? 'Reconnecting…' : 'Reconnect now'}
        </Button>
      )}
    </div>
  )
}
