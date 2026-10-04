// src/agent/search/verify.ts
import type { NetdiskHit } from './types.ts'

/** What the flow needs from the netdisk.share.verify callsite. Narrow on purpose: the agent
 *  must not know what a quark is — only "ask about this link, get back what's inside". */
export type VerifyShare = (
  netdisk: string,
  pwdId: string,
  opts?: { passcode?: string },
) => Promise<{ validity: string; files: { name: string }[] } | null>

/** Link → (netdisk, pwd_id). Injected rather than imported so this module stays testable and
 *  the agent keeps depending on the same parser the rest of the app uses, not a second one. */
export type ParseShareLink = (link: string) => { netdisk: string; pwd_id: string } | null

export interface VerifyResult {
  /** links worth returning: verified alive (carrying their real file names), plus the ones we
   *  could not check (unverifiable netdisk / probe failed) — see `kept unchecked` below. */
  hits: NetdiskHit[]
  alive: number
  dead: number
  /** couldn't check: no Provider for that netdisk, an unparseable link, or the probe itself failed */
  unchecked: number
}

/** Bounded fan-out. Verification is a plain HTTP probe (~300ms), so a pool this size clears a
 *  round's links in a second or two without hammering the netdisk. */
const POOL = 6

async function pooled<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await run(items[next++])
    }),
  )
}

/**
 * Verify extracted links, dropping the dead and attaching what the living actually contain.
 *
 * Runs BEFORE scoring on purpose, and that ordering is the whole point:
 *  - the LLM then judges on real file names instead of a snippet that merely sat near the link;
 *  - the dead are gone before the expensive batch scoring, which shrinks that call.
 * Scoring first and verifying later loses on both counts.
 *
 * A dead share is dropped rather than sunk to 0: it is not a weak answer, it is no answer —
 * nothing a caller can do with it. What could NOT be checked is kept untouched (with no `files`),
 * because "we didn't look" must never be returned as "we looked and it's fine" — nor as dead.
 */
export async function verifyHits(
  hits: NetdiskHit[],
  deps: { verifyShare: VerifyShare; parseShareLink: ParseShareLink },
): Promise<VerifyResult> {
  const out: NetdiskHit[] = []
  let alive = 0
  let dead = 0
  let unchecked = 0

  await pooled(hits, POOL, async (hit) => {
    const ref = deps.parseShareLink(hit.link)
    if (!ref) {
      unchecked++
      out.push(hit)
      return
    }
    let r: Awaited<ReturnType<VerifyShare>>
    try {
      // The passcode the hub post carried is what unlocks a baidu share — without it we'd only
      // learn "the link exists", which is most of the value thrown away.
      r = await deps.verifyShare(ref.netdisk, ref.pwd_id, { passcode: hit.password })
    } catch {
      // The probe failed (network, upstream hiccup). That says nothing about the link — keep it.
      unchecked++
      out.push(hit)
      return
    }
    if (!r) {
      // No verify Provider for this netdisk (baidu today). Unknown, not dead.
      unchecked++
      out.push(hit)
      return
    }
    if (r.validity === 'alive') {
      alive++
      out.push({ ...hit, files: r.files.map((f) => f.name) })
      return
    }
    if (r.validity !== 'not-usable') {
      // 'needs-login' (our session expired) / 'unknown' (locked, probe failed, upstream noise):
      // all mean we could not see inside. Keep the link, unenriched — throwing away a link we
      // never managed to look at would be inventing a verdict.
      unchecked++
      out.push(hit)
      return
    }
    dead++ // 'not-usable' — expired / banned / empty
  })

  return { hits: out, alive, dead, unchecked }
}
