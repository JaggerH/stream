import type { EventSourceRelay } from './relay.ts'

interface CookieLike {
  name: string
  value: string
}

export function wireCookiesFeed(
  relay: EventSourceRelay,
  deps: { cookiesFor(domain: string): Promise<CookieLike[]> },
) {
  return {
    async onHello(domains: string[]): Promise<void> {
      const all: string[] = []
      for (const d of domains) {
        for (const c of await deps.cookiesFor(d)) {
          if (c.name) all.push(`${c.name}=${c.value}`)
        }
      }
      relay.sendCookies(all.join('; '))
    },
  }
}
