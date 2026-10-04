/**
 * Generate ad regression fixtures from the labeled corpus (the 广告 channel).
 *
 *   pnpm gen:ad-fixtures   (or: npx tsx scripts/gen-ad-fixtures.ts)
 *
 * Scans every muted item in the item-store, writes one positive fixture per
 * UNPROCESSED item (a fixture file absent for its id = unprocessed). For each
 * red-light item (current DEFAULT_AD_RULES fail to mute it) it prints candidate
 * rules for human review — it NEVER edits the rule set. Confirm a candidate by
 * hand-adding it to src/content/ad-rules.default.ts; the regression test goes
 * green when the rule lands.
 */
import { loadConfig } from '../src/bootstrap.ts'
import { ItemStore } from '../src/item-store.ts'
import { classifyAd } from '../src/content/ad-filter.ts'
import { DEFAULT_AD_RULES } from '../src/content/ad-rules.default.ts'
import { suggestRules } from '../src/content/ad-suggest.ts'
import { hasFixture, writeFixtureFromItem, streamItemToFields, loadNegativeFields } from '../src/content/ad-fixtures.ts'

const config = loadConfig()
const store = new ItemStore(config.item_db)
const muted = store.allMuted()
const negatives = loadNegativeFields()
const now = new Date().toISOString()

let written = 0
const reds: Array<{ id: string; title: string }> = []

for (const item of muted) {
  if (hasFixture(item.id)) continue
  writeFixtureFromItem(item, 'positive', now)
  written++

  const fields = streamItemToFields(item)
  if (!classifyAd(fields, DEFAULT_AD_RULES)) {
    reds.push({ id: item.id, title: item.title ?? '' })
    const candidates = suggestRules(fields, DEFAULT_AD_RULES, negatives)
    console.log(`\n  RED  ${item.id}  "${(item.title ?? '').slice(0, 50)}"`)
    if (candidates.length === 0) {
      console.log('       (no safe candidate — every option would hit a negative fixture; add a rule manually)')
    } else {
      console.log('       suggested rules — CONFIRM before adding to DEFAULT_AD_RULES:')
      for (const c of candidates) console.log(`         - ${c.kind}: ${c.value}   (${c.basis})`)
    }
  }
}

console.log(
  `\n[gen-ad-fixtures] scanned ${muted.length} muted item(s), wrote ${written} new fixture(s), ${reds.length} red-light (need a rule).`
)
store.close()
