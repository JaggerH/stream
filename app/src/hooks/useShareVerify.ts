import { useEffect, useRef, useState } from 'react'
import { api, type Connection } from '../lib/api.ts'
import type { VideoSourceType } from '../lib/types.ts'

/** What we know about one share link.
 *
 *  Two of these mean "no verdict", and neither may ever render as 已失效:
 *  - `unsupported` — this netdisk has no verify Provider yet (the backend says 501).
 *  - `unknown` — the backend tried and could not tell (upstream 5xx / rate-limit / network).
 *  They differ only in where the failure happened; our ignorance about the link is identical. */
export type ShareState =
  | { kind: 'checking' }
  | { kind: 'alive'; files: string[] }
  | { kind: 'dead' }
  | { kind: 'needs-login' }
  | { kind: 'unknown' }
  | { kind: 'unsupported' }

/** Netdisk share links are the only thing worth verifying: a magnet has no liveness to check
 *  from here. Deliberately NOT a quark-only list — when the backend gains a baidu row this
 *  starts working with no frontend change (an unsupported one just answers 501). */
const VERIFIABLE: ReadonlySet<VideoSourceType> = new Set<VideoSourceType>(['quark', 'baidu', 'aliyun'])

export const isVerifiable = (t: VideoSourceType): boolean => VERIFIABLE.has(t)

/** Bounded fan-out: a search can return 50+ links; the backend verifies in ~300ms each and
 *  10 in parallel cost ~480ms, so a small pool keeps a whole screen honest in under a second
 *  without hammering the upstream. */
const POOL = 6

async function pooled<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      await run(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/**
 * Verify share links as they arrive, once each.
 *
 * Why automatic rather than on-demand: a returned link that is already dead is the normal
 * case, not the exception (search indexes outlive the shares they point at), and copying a
 * dead link is a wasted round-trip through the user's clipboard. Verification is a plain
 * HTTP probe — no browser, no login — so it is cheap enough to just do.
 */
export function useShareVerify(conn: Connection, links: Array<{ link: string; sourceType: VideoSourceType; password?: string }>) {
  const [states, setStates] = useState<Record<string, ShareState>>({})
  // Which links we've already started: the list grows as results stream in, and re-running for
  // the whole list on every batch would re-probe everything seen so far.
  const started = useRef<Set<string>>(new Set())
  // A probe is voided only by unmount or a connection change — NEVER by `links` changing.
  // `links` gets a new identity on every streamed batch, so tying the void to this effect's
  // lifetime would orphan every in-flight probe the moment the next batch lands; `started`
  // already bars a re-probe, so those links would sit at `checking` forever.
  const generation = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    generation.current += 1
    started.current = new Set()
    setStates({})
  }, [conn])

  useEffect(() => {
    const fresh = links.filter((l) => isVerifiable(l.sourceType) && !started.current.has(l.link))
    if (!fresh.length) return
    const mine = generation.current
    const usable = (): boolean => mounted.current && generation.current === mine
    for (const l of fresh) started.current.add(l.link)
    setStates((prev) => {
      const next = { ...prev }
      for (const l of fresh) next[l.link] = { kind: 'checking' }
      return next
    })

    void pooled(fresh, POOL, async (l) => {
      if (!usable()) return
      try {
        // 提取码必须带上：百度几乎每条分享都锁着，没有它只能判「链接是否存在」——
        // 一屏结果里最有价值的那部分（文件名）就全丢了。
        const r = await api.netdisk.verifyShare(conn, { link: l.link, passcode: l.password })
        if (!usable()) return
        const state: ShareState =
          r.validity === 'alive' ? { kind: 'alive', files: r.files.map((f) => f.name) }
          : r.validity === 'needs-login' ? { kind: 'needs-login' }
          : r.validity === 'unknown' ? { kind: 'unknown' }
          : { kind: 'dead' }
        setStates((prev) => ({ ...prev, [l.link]: state }))
      } catch (e) {
        if (!usable()) return
        // 501 = no Provider row for this netdisk yet. Anything else (network, 5xx) is OUR
        // failure, not a verdict on the link — either way we must not call it dead.
        setStates((prev) => ({ ...prev, [l.link]: { kind: 'unsupported' } }))
        void e
      }
    })
  }, [conn, links])

  return states
}
