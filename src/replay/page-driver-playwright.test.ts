import { describe, it, expect } from 'vitest'
import { makePageDriver } from './browser-drive.ts'

/** Minimal Playwright-Page stand-in. openTarget targets the card with ONE selector
 *  (`<sel>[href*="<identity>"]:visible`) and confirms the open by the resulting URL — the
 *  in-feed click is a pushState nav to /explore/<id> — so the fake resolves the selector's
 *  href filter and moves its url on click. */
function fakePage(url: string, els: { href: string | null }[]) {
  const clicked: string[] = []
  let current = url
  const page = {
    url: () => current,
    waitForTimeout: async (_ms: number) => {},
    locator: (sel: string) => {
      const identity = sel.match(/\[href\*="([^"]+)"\]/)?.[1] ?? ''
      const matches = els.filter((e) => e.href && identity && e.href.includes(identity))
      return {
        first: () => ({
          count: async () => matches.length,
          click: async (_opts?: unknown) => {
            const href = matches[0]!.href!
            clicked.push(href)
            current = `https://x${href}` // the overlay opens; the URL now carries the note id
          },
        }),
      }
    },
  }
  return { page, clicked }
}

// makePageDriver is the Playwright arm of PageDriver — used by the authoring replay
// (`record validate`, which drives a developer's own Chrome over CDP). Harvesting uses the ext
// driver. Both implement the same contract, which is what these assertions pin.
describe('makePageDriver — Playwright arm parity with the ext driver (currentUrl + openTarget)', () => {
  it('currentUrl returns the page url', async () => {
    const { page } = fakePage('https://x/explore', [])
    const d = makePageDriver(page as any)
    expect(await d.currentUrl!()).toBe('https://x/explore')
  })

  it('openTarget trusted-clicks the card whose href carries the identity, returns true', async () => {
    const { page, clicked } = fakePage('https://x/explore', [{ href: '/explore/AAA' }, { href: '/explore/BBB' }])
    const d = makePageDriver(page as any)
    expect(await d.openTarget!('a.cover', 'BBB')).toBe(true)
    expect(clicked).toEqual(['/explore/BBB'])
  })

  it('openTarget returns false and clicks nothing when no href matches', async () => {
    const { page, clicked } = fakePage('https://x/explore', [{ href: '/explore/AAA' }])
    const d = makePageDriver(page as any)
    expect(await d.openTarget!('a.cover', 'ZZZ')).toBe(false)
    expect(clicked).toEqual([])
  })
})
