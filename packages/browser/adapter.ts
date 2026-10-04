import type { Adapter, AdapterFetchResult } from '../../src/adapters/types.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

/** A rendered web page, the raw shape the browser adapter emits (one item per page). */
export interface RenderedPage {
  url: string
  title: string
  text: string
  html: string
}

/** Renders a URL to its loaded DOM. Injected so tests don't launch a real browser. */
export interface PageRenderer {
  render(url: string): Promise<RenderedPage>
}

/**
 * `browser` adapter — the universal failover last rung. A source with `adapter: browser`
 * and a `url` param renders that page and returns it as a single raw item. Just another
 * adapter, so creds/cache/dedup wiring is unchanged.
 *
 * The renderer is INJECTED and there is no default. Stream owns no browser of its own to fall
 * back on: rendering happens in the user's Chrome over the extension relay, wired in bootstrap
 * (which is also where "is that browser even up?" is answered). An adapter that quietly
 * launched its own second browser is exactly what this rung must not do.
 */
export class BrowserAdapter implements Adapter {
  readonly id = 'browser'
  constructor(private readonly renderer: PageRenderer) {}

  async init(_env: Record<string, string>): Promise<void> {}

  async fetch(params: Record<string, unknown>, _manifest: SourceManifest): Promise<AdapterFetchResult> {
    const url = String(params.url ?? '').trim()
    if (!url) throw new Error('[browser] fetch needs a `url` param')
    const page = await this.renderer.render(url)
    return {
      items: [{ guid: page.url, url: page.url, title: page.title, text: page.text }],
      // 这条流 = 这一个页面，所以页面标题就是流的名字。报上去，订阅时名字自动填好
      // （scheduler → backfillLabel）；空标题不报，占位名比空名字好。
      title: page.title.trim() || undefined,
    }
  }
}
