/**
 * The convergence harness. Two layers:
 *  1. GOLD cases — precise pairing/facet assertions (fail on regression).
 *  2. CORPUS sweep — 894 real items; asserts hard invariants (zero bad links, zero
 *     url-as-name) and prints a scoreboard so each iteration is measurable.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseItem, route } from '../registry.ts'
import type { RawDownloadItem } from '../types.ts'
import { GOLD_CASES } from './gold.ts'
import { reportCorpus, scoreItem, isValidLink, nameIsUrl } from './metrics.ts'
import { setLinkDeclarationSource } from '../../../links/recognize.ts'
import { linkTableOf } from '../../../replay/recipe-package.ts'
import { parseStreamDescriptor } from '../../../packages/descriptor.ts'

// 语料里有下载站中转页（paired 行要打 needsResolve / 类型标）：哪些 URL 是中转页由那个站的包声明，
// 所以这里挂上**真实包**的声明——语料和声明一起改才对得上。放在模块顶层：语料扫描在 describe
// 收集期就跑了，beforeAll 来不及。
const pkgDecl = parseStreamDescriptor(
  JSON.parse(readFileSync(new URL('../../../../packages/btbtla/package.json', import.meta.url), 'utf8')),
  'packages/btbtla/package.json',
)
setLinkDeclarationSource(() => linkTableOf([{ facility: pkgDecl.facility!, name: pkgDecl.pkgName, links: pkgDecl.links }]).entries)

const corpus: RawDownloadItem[] = JSON.parse(
  readFileSync(new URL('../__fixtures__/corpus.raw.json', import.meta.url), 'utf8'),
)

describe('gold cases (precise)', () => {
  for (const c of GOLD_CASES) {
    it(c.what, () => {
      const rows = parseItem(c.item)
      expect(rows.length).toBe(c.expectRows)
      for (const r of rows) {
        expect(isValidLink(r.link), `bad link: ${r.link}`).toBe(true)
        expect(nameIsUrl(r.name), `name is url: ${r.name}`).toBe(false)
      }
      const s = scoreItem(rows, c.gold)
      expect(s.matched, `pairing: matched ${s.matched}/${s.expected}`).toBe(c.gold.length)
      expect(s.facetHits, `facets: ${s.facetHits}/${s.facetTotal}`).toBe(s.facetTotal)
    })
  }
})

describe('corpus sweep (aggregate invariants + scoreboard)', () => {
  const perItem = corpus.map((item) => ({ parser: route(item).parser.id, rows: parseItem(item) }))
  const rep = reportCorpus(perItem)

  it('prints scoreboard', () => {
    // eslint-disable-next-line no-console
    console.log(
      `\n── content-parser scoreboard ──\n` +
        `items       ${rep.items}\n` +
        `rows        ${rep.rows}\n` +
        `routing     ${JSON.stringify(rep.byParser)}\n` +
        `badLinks    ${rep.badLinks} (${(rep.badLinkRate * 100).toFixed(2)}%)\n` +
        `emptyNames  ${rep.emptyNames} (${(rep.emptyNameRate * 100).toFixed(2)}%)\n` +
        `urlAsName   ${rep.urlAsName}\n`,
    )
    expect(rep.items).toBe(1660)
  })

  it('HARD: zero truncated/garbage links across the corpus', () => {
    expect(rep.badLinks).toBe(0)
  })

  it('HARD: no row displays a URL as its name', () => {
    expect(rep.urlAsName).toBe(0)
  })

  it('CONVERGE: zero empty names (mirror-collapse means every row is named)', () => {
    // ratcheted from <10% to hard 0 once the mirror-grouping refactor landed. A
    // regression here means a new blob shape produced a nameless row — investigate.
    expect(rep.emptyNames).toBe(0)
  })
})
