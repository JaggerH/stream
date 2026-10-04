import { describe, it, expect } from 'vitest'
import { STREAM_DECLARATION_KEYS } from '../packages/descriptor.ts'
import { FACILITY_KNOWLEDGE_FIELDS, declaresFacilityKnowledge } from './recipe-package.ts'
import type { StreamPackage } from '../packages/scan.ts'

/**
 * `declaresFacilityKnowledge` 决定一个**没有任何 recipe、也不出 source** 的内置包会不会被
 * recipe 层整个跳过。漏一格 = 那格声明从此不生效，而且不报错、不降级、没有一处会喊。
 *
 * 所以这张表不能靠人记。下面这条守卫把它反过来推：`package.json#stream` 受理的全部键
 * （从 zod schema 现取）减去一份**明确不属于 facility 知识**的白名单，剩下的必须恰好等于判据
 * 覆盖的那几格。往 schema 加一格声明 → 它既不在白名单里、也不在判据里 → 当场红，逼人回答
 * 「这一格该不该也算 facility 知识」。
 */
const NOT_FACILITY_KNOWLEDGE = new Set([
  // 身份与文案：谁都读得到，跳不跳过它们都在描述符里。
  'id', 'type', 'schemaVersion', 'name', 'tagline', 'description',
  'homepage', 'repository', 'docsUrl', 'required', 'author', 'hostVersion',
  // `facility` 是这个包的名字，不是它带的知识。
  'facility',
  // 插件槽位：由**插件路径**（`loadPlugins` / `activatePackages`）消费，与 recipe 层无关。
  'backend', 'credentials', 'code', 'capability', 'normalizer', 'presenter', 'sourceGrouping',
  // `sources` 由跳过判据自己那半条管（`!sources.length`），不归这张表。
  'sources',
  // 迁移期别名（spec 2026-09-26-link-recognition §6）：装载时翻译进 `links`，描述符上不留这两格，
  // 判据看的是翻译后的 `links`。
  'trackUrl', 'downloadPages',
])

describe('declaresFacilityKnowledge —— 判据与描述符的键同步', () => {
  it('schema 的全部键 − 非 facility 知识 = 判据覆盖的那几格', () => {
    const remainder = STREAM_DECLARATION_KEYS.filter((k) => !NOT_FACILITY_KNOWLEDGE.has(k))
    expect(remainder.slice().sort()).toEqual([...FACILITY_KNOWLEDGE_FIELDS].sort())
  })

  it('白名单里没有 schema 之外的死条目（删了一格声明就该跟着删）', () => {
    const known = new Set(STREAM_DECLARATION_KEYS)
    expect([...NOT_FACILITY_KNOWLEDGE].filter((k) => !known.has(k))).toEqual([])
  })

  const pkg = (extra: Partial<StreamPackage>) => ({ id: 'x', dir: '/tmp/x', ...extra }) as StreamPackage

  it('每一格单独出现都算数', () => {
    for (const field of FACILITY_KNOWLEDGE_FIELDS) {
      // 值本身不重要，只要"在"。用一个非空对象免得 falsy 值把断言演成假绿。
      expect(declaresFacilityKnowledge(pkg({ [field]: { any: 'value' } } as Partial<StreamPackage>)), field).toBe(true)
    }
  })

  it('states.json（盘上的文件，不是 package.json 的一格）也算', () => {
    expect(declaresFacilityKnowledge(pkg({}), { states: [], transitions: [] } as never)).toBe(true)
  })

  it('什么都没带 → false（那是插件包，recipe 层跳过它是对的）', () => {
    expect(declaresFacilityKnowledge(pkg({}))).toBe(false)
  })
})
