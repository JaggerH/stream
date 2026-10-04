import { describe, expect, it } from 'vitest'
import { loadRecipePackages } from './recipe-package.ts'
import { interpretHtml } from './interpret-html.ts'
import { makeHtmlFetch } from './html-fetch.ts'

/** The award roster only ever hands the pipeline an *identity*: the work's IMDb id, dug out of
 *  the work's own Wikipedia article. Which link on that article it takes is the whole game —
 *  an article routinely cites IMDb twice, and the two ids are different works:
 *
 *    <cite> … imdb.com/title/tt2861928  ← a footnote about ONE EPISODE
 *    <li>   … imdb.com/title/tt1436544  ← {{IMDb title}}, the article's own subject
 *
 *  Document order hands back the footnote, and TMDb's /find then answers with a tv_episode
 *  (or nothing) — the row silently keeps no cover, or worse, gets a different work's. Hence the
 *  ordered selector list in the recipe: prefer a link outside any <cite>, fall back to any link
 *  at all for articles whose only IMDb reference IS a footnote. */
const ARTICLE = `<html><body><div class="mw-parser-output">
  <p>A British preschool series.<sup class="reference"><a href="#cite_note-1">[1]</a></sup></p>
  <h2>References</h2>
  <ol class="references"><li id="cite_note-1"><cite class="citation audio-visual cs1">
    <a class="external text" href="http://web.archive.org/web/20170211232215/http://www.imdb.com/title/tt2861928/">"Ben &amp; Holly's Little Kingdom" Redbeard the Elf Pirate (TV Episode 2009)</a>.
    Archived from <a class="external text" href="https://www.imdb.com/title/tt2861928/">the original</a> on 11 February 2017</cite></li></ol>
  <h2>External links</h2>
  <ul>
    <li><a class="external text" href="https://www.abc.net.au/x/">Ben &amp; Holly's Little Kingdom</a> on ABC</li>
    <li><a class="external text" href="https://www.imdb.com/title/tt1436544/">Ben &amp; Holly's Little Kingdom</a> at IMDb</li>
  </ul>
</div></body></html>`

/** Same shape, minus the external-links entry: the footnote is the only evidence there is. */
const FOOTNOTE_ONLY = `<html><body><div class="mw-parser-output">
  <ol class="references"><li><cite class="citation cs1">
    <a class="external text" href="https://www.imdb.com/title/tt5874704/">Digby Dragon</a></cite></li></ol>
</div></body></html>`

const LIST_PAGE = (href: string) => `<html><body><table class="wikitable"><tbody>
  <tr><th>Year</th><th>Show</th></tr>
  <tr><td>2010</td><td><i><a href="${href}">Ben &amp; Holly's Little Kingdom</a></i></td><td>Nick Jr.</td></tr>
</tbody></table></body></html>`

const recipe = () => {
  const found = loadRecipePackages('packages').recipes.get('@streamapp/wikipedia/wikipedia-award-list')
  if (found?.kind !== 'html') throw new Error('wikipedia-award-list is not a kind:html recipe')
  return found
}

const fetchFrom = (pages: Record<string, string>) => async ({ url }: { url: string }) => {
  const body = pages[url]
  if (body == null) throw new Error(`unexpected fetch: ${url}`)
  return body
}

describe('wikipedia-award-list recipe', () => {
  it('takes the article’s own IMDb link, not the one cited in a footnote', async () => {
    const article = 'https://en.wikipedia.org/wiki/Ben_%26_Holly'
    const { items } = await interpretHtml(recipe(), {
      fetchHtml: fetchFrom({
        'https://en.wikipedia.org/wiki/Awards': LIST_PAGE(article),
        [article]: ARTICLE,
      }),
    }, { page: 'Awards' })
    expect(items).toHaveLength(1)
    expect(String(items[0].imdb_id)).toContain('tt1436544')
    expect(String(items[0].imdb_id)).not.toContain('tt2861928')
  })

  it('still falls back to a footnote when that is the only IMDb link on the article', async () => {
    const article = 'https://en.wikipedia.org/wiki/Digby_Dragon'
    const { items } = await interpretHtml(recipe(), {
      fetchHtml: fetchFrom({
        'https://en.wikipedia.org/wiki/Awards': LIST_PAGE(article),
        [article]: FOOTNOTE_ONLY,
      }),
    }, { page: 'Awards' })
    expect(String(items[0].imdb_id)).toContain('tt5874704')
  })

  // The Wikidata id-exchange rides the harvest now (the recipe's hops), not the canonical
  // resolver: the article's footer always links the work's Wikidata entity, and that entity
  // registers the ids TMDb actually knows. Star Wars: Young Jedi Adventures is the motivating
  // case — the article cites tt20721750 while TMDb's record says tt20674124; Wikidata's P345
  // carries the right one and must WIN over the article's link.
  it('follows the Wikidata entity and lets its ids beat the article’s own IMDb link', async () => {
    const article = 'https://en.wikipedia.org/wiki/Young_Jedi'
    const withWikidata = `<html><body><div class="mw-parser-output">
      <ul><li><a class="external text" href="https://www.imdb.com/title/tt20721750/">Young Jedi</a> at IMDb</li></ul>
      <a href="https://www.wikidata.org/wiki/Special:EntityPage/Q116763978#sitelinks-wikipedia">Wikidata item</a>
    </div></body></html>`
    const claims = (prop: string, value?: string) => JSON.stringify(
      value === undefined ? { claims: {} } : { claims: { [prop]: [{ mainsnak: { datavalue: { value } } }] } })
    const wd = (prop: string) => `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=Q116763978&property=${prop}&format=json`
    const { items } = await interpretHtml(recipe(), {
      fetchHtml: fetchFrom({
        'https://en.wikipedia.org/wiki/Awards': LIST_PAGE(article),
        [article]: withWikidata,
        [wd('P4947')]: claims('P4947'),
        [wd('P4983')]: claims('P4983', '202998'),
        [wd('P345')]: claims('P345', 'tt20674124'),
      }),
    }, { page: 'Awards' })
    expect(items[0]).toMatchObject({ tmdb_tv_id: '202998', imdb_id: 'tt20674124' })
    expect(items[0].tmdb_movie_id).toBeUndefined()
  })

  it('an article without a Wikidata link keeps its own IMDb evidence and skips the hops', async () => {
    const article = 'https://en.wikipedia.org/wiki/Digby_Dragon'
    const { items } = await interpretHtml(recipe(), {
      fetchHtml: fetchFrom({
        'https://en.wikipedia.org/wiki/Awards': LIST_PAGE(article),
        [article]: FOOTNOTE_ONLY, // no wikidata link → hops skip, and fetchFrom would throw on any stray fetch
      }),
    }, { page: 'Awards' })
    expect(String(items[0].imdb_id)).toContain('tt5874704')
    expect(items[0].tmdb_tv_id).toBeUndefined()
  })

  // Live-only: the fixtures above are hand-cut, so this one proves the same two selectors still
  // land where they should in Wikipedia's real (Parsoid) markup. Skipped unless STREAM_LIVE=1.
  const live = process.env.STREAM_LIVE === '1' ? it : it.skip
  live('lands on the right link in the live article', async () => {
    const r = recipe()
    const fetchHtml = makeHtmlFetch(r)
    const both = await fetchHtml({ url: "https://en.wikipedia.org/wiki/Ben_&_Holly's_Little_Kingdom", method: 'GET', headers: { accept: 'text/html', 'accept-language': 'en' } })
    const only = await fetchHtml({ url: 'https://en.wikipedia.org/wiki/Digby_Dragon', method: 'GET', headers: { accept: 'text/html', 'accept-language': 'en' } })
    const { parseDoc, extractFields } = await import('./html-extract.ts')
    const pick = (html: string) => String(extractFields(parseDoc(html), r.detail!.fields, 'https://en.wikipedia.org/').imdb_id ?? '')
    expect(pick(both)).toContain('tt1436544')
    expect(pick(only)).toContain('tt5874704')
  }, 60_000)
})
