/**
 * `purchase_decide` —— 购买决策 job 的回执，也就是选品对比的**终稿**。
 * 产出是 `DecisionReceipt`（`src/agent/purchase/job.ts`）：
 * {constraints, products, frontier, dominated, unranked, unrankedCounts, coverage, residual, gaps, note}。
 *
 * 这张卡的读者是人，而回执是模型也在读的同一份数据——**卡上摆的每个数都在回执里**，
 * 没有渲染层自己算的东西。排版沿用「产品做列、维度做行」：斩杀摆最上面（可核对的结论），
 * 前沿列高亮（互不支配的那几台，差别是用户偏好）；覆盖率和残值口径摆在表的上下——它们是
 * 结论的一部分，不是页脚小字：一份 truncated 的清单不许看起来像"市面上就这些"。
 */
import type { ReactNode, CSSProperties } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { readToolCall, asRecord } from '../../tool-result.ts'
import { Badge, Card, FallbackText, Muted } from './frame.tsx'

interface Price { platform: string; price: string; note?: string | undefined; url?: string | undefined }
interface Evidence { source: string; url?: string | undefined; point?: string | undefined }
interface Product { name: string; image?: string | undefined; prices: Price[]; pros: string[]; cons: string[]; fit: string; evidence: Evidence[]; cost?: string | undefined }
/** 一条被斩的记录。后端算的(带数字),这里只负责摆出来——别在渲染层重算支配。 */
interface Killed { name: string; by: string; why: string }

/** href/src 只吃 http(s)——渲染端自己的兜底。 */
function httpUrl(v: unknown): string | undefined {
  return typeof v === 'string' && /^https?:\/\//i.test(v.trim()) ? v.trim() : undefined
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function readProduct(v: unknown): Product | null {
  const rec = asRecord(v)
  if (rec === null || typeof rec.name !== 'string') return null
  const prices = Array.isArray(rec.prices)
    ? rec.prices
        .map((p) => asRecord(p))
        .filter((p): p is Record<string, unknown> => p !== null && typeof p.platform === 'string' && typeof p.price === 'string')
        .map((p) => ({
          platform: p.platform as string,
          price: p.price as string,
          note: typeof p.note === 'string' ? p.note : undefined,
          url: httpUrl(p.url),
        }))
    : []
  const evidence = Array.isArray(rec.evidence)
    ? rec.evidence
        .map((e) => asRecord(e))
        .filter((e): e is Record<string, unknown> => e !== null && typeof e.source === 'string' && e.source !== '')
        .map((e) => ({
          source: e.source as string,
          url: httpUrl(e.url),
          point: typeof e.point === 'string' ? e.point : undefined,
        }))
    : []
  // 可比代价:后端折算好的数 + 单位。两个都在才显示——半个数没有意义。
  const cc = num(rec.comparable_cost)
  const cost =
    cc !== undefined && typeof rec.cost_unit === 'string'
      ? `${rec.cost_unit.startsWith('元/天') ? cc.toFixed(2) : String(Math.round(cc * 100) / 100)} ${rec.cost_unit}`
      : undefined
  return {
    name: rec.name,
    image: httpUrl(rec.image),
    prices,
    pros: asStrings(rec.pros),
    cons: asStrings(rec.cons),
    fit: typeof rec.fit === 'string' ? rec.fit : '',
    evidence,
    cost,
  }
}

function readKilled(v: unknown): Killed | null {
  const r = asRecord(v)
  if (r === null || typeof r.name !== 'string' || typeof r.by !== 'string') return null
  return { name: r.name, by: r.by, why: typeof r.why === 'string' ? r.why : '' }
}

const cellBase: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))',
  fontSize: 12,
  padding: '6px 8px',
  textAlign: 'left',
  verticalAlign: 'top',
}

/** 前沿列的高亮：细节全靠边框和一点点底色，别喧宾夺主。 */
const picked: CSSProperties = {
  background: 'var(--dsw-alias-fill-tsp-quaternary, rgba(74,144,217,0.08))',
}

/** 被斩的列：整列压暗。**它仍然留在表里**——「凭什么斩它」得看得见才可核对，
 *  删掉那一列就把结论变回了一句不可验证的断言。 */
const struck: CSSProperties = { opacity: 0.45 }

const linkStyle: CSSProperties = { color: 'var(--dsw-alias-label-link, #4a90d9)', fontSize: 12, textDecoration: 'none' }

function List({ items, mark }: { items: string[]; mark: string }): ReactNode {
  if (items.length === 0) return <Muted>—</Muted>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {items.map((s, i) => (
        <span key={i}>{mark} {s}</span>
      ))}
    </div>
  )
}

/**
 * `purchase_decide` 现在是**异步**的：立刻回 {runId, status}，回执要经 `get_agent_run` 取
 * （`AgentRunCard`）。这张卡只画"已发起"；回执那张表在 `ReceiptView`，两张卡共用。
 */
export function PurchaseDecideCard({ block }: { block: ToolCallBlock }): ReactNode {
  const call = readToolCall(block)
  if (call.running) return <Card title="选品对比" badge={<Badge text="进行中" />}>{null}</Card>
  const data = asRecord(call.data)
  if (data !== null && typeof data.runId === 'string' && asRecord(data.coverage) === null) {
    return (
      <Card title="选品对比" badge={<Badge text="已发起" />}>
        <Muted>决策 job 在后台跑（枚举 → 读横评 → 比价 → 斩杀），通常 2–3 分钟；结果会以对比卡的形式出现。</Muted>
      </Card>
    )
  }
  // 兼容：回执直接落在这里（同步形态的旧回执）也照画。
  return <ReceiptView data={call.data} text={call.text} isError={call.isError} />
}

/** 回执 → 对比卡。`data` 是 DecisionReceipt（或读不出来的任何东西——那就摆原文）。 */
export function ReceiptView({ data, text, isError }: { data: unknown; text: string; isError?: boolean }): ReactNode {
  const receipt = asRecord(data)
  const constraints = asRecord(receipt?.constraints)
  const category = asStrings(constraints?.category).join('、')
  const title = category !== '' ? `选品对比：${category}` : '选品对比'
  const products = Array.isArray(receipt?.products)
    ? (receipt.products as unknown[]).map(readProduct).filter((p): p is Product => p !== null)
    : []
  const coverage = asRecord(receipt?.coverage)

  if (receipt === null || coverage === null) {
    return (
      <Card title={title} badge={isError ? <Badge text="失败" tone="error" /> : undefined}>
        <FallbackText text={text} />
      </Card>
    )
  }

  const killed = Array.isArray(receipt.dominated)
    ? (receipt.dominated as unknown[]).map(readKilled).filter((k): k is Killed => k !== null)
    : []
  const killedNames = new Set(killed.map((k) => k.name))
  const frontier = asStrings(receipt.frontier)
  const frontierSet = new Set(frontier)
  const universe = num(coverage.universe) ?? 0
  const named = num(coverage.named) ?? 0
  const truncated = coverage.stopped === 'truncated'
  const interrupted = coverage.stopped === 'interrupted'
  const residual = asRecord(receipt.residual)
  const residualNote = typeof residual?.note === 'string' ? residual.note : undefined
  const purchaseOnly = residual?.mode === 'purchase_only'
  const counts = asRecord(receipt.unrankedCounts)
  const noMention = num(counts?.no_mention) ?? 0
  const noPrice = num(counts?.no_price) ?? 0
  const gaps = Array.isArray(receipt.gaps) ? receipt.gaps.length : 0

  const rows: Array<{ label: string; cell: (p: Product) => ReactNode }> = [
    {
      // 判支配用的就是这个数。摆在价格上面:它才是比较的口径,价格是给人对账的原文。
      label: '代价',
      cell: (p) => (p.cost === undefined ? <Muted>—</Muted> : <strong style={{ fontSize: 13 }}>{p.cost}</strong>),
    },
    {
      label: '价格',
      cell: (p) =>
        p.prices.length === 0 ? (
          <Muted>—</Muted>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {p.prices.map((pr, i) => (
              <span key={i}>
                {pr.url !== undefined ? (
                  // 平台名就是购买入口——外链新开一页,别把工作台顶掉
                  <a href={pr.url} target="_blank" rel="noreferrer" style={linkStyle}>
                    {pr.platform} ↗
                  </a>
                ) : (
                  <Muted>{pr.platform}</Muted>
                )}{' '}
                {pr.price}
                {pr.note !== undefined ? <Muted>（{pr.note}）</Muted> : null}
              </span>
            ))}
          </div>
        ),
    },
    { label: '优点', cell: (p) => <List items={p.pros} mark="+" /> },
    { label: '缺点', cell: (p) => <List items={p.cons} mark="−" /> },
    { label: '契合', cell: (p) => (p.fit === '' ? <Muted>—</Muted> : p.fit) },
    {
      label: '依据',
      // 来源是这张卡的立身之本:优缺点从哪读来的。
      cell: (p) =>
        p.evidence.length === 0 ? (
          <Muted>—</Muted>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {p.evidence.map((ev, i) => (
              <span key={i}>
                {ev.url !== undefined ? (
                  <a href={ev.url} target="_blank" rel="noreferrer" style={linkStyle}>
                    {ev.source} ↗
                  </a>
                ) : (
                  ev.source
                )}
                {ev.point !== undefined ? <Muted>：{ev.point}</Muted> : null}
              </span>
            ))}
          </div>
        ),
    },
  ]

  const colStyle = (name: string): CSSProperties => ({
    ...cellBase,
    ...(frontierSet.has(name) ? picked : {}),
    ...(killedNames.has(name) ? struck : {}),
  })

  // 不用 Card 的外框:表格自己的网格就是边界,再套一圈就是框中框。
  // 保留 data-stream-card 标识(测试与 DOM 巡检都认它)。
  return (
    <div data-stream-card={title} style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '4px 0' }}>
      <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
        <span style={{ color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 14, fontWeight: 500 }}>{title}</span>
        {/* 覆盖率是结论的一部分:这张表建立在多大一片候选上。 */}
        <Muted>枚举 {universe} 台 · 横评点名 {named} 台 · 进比较 {products.length} 台</Muted>
        {truncated ? <Badge text="清单不全" /> : null}
        {interrupted ? <Badge text="横评没读成" tone="error" /> : null}
      </div>
      {purchaseOnly && residualNote !== undefined ? (
        // 残值口径要大声说:表上的"元/天"没扣残值,不是持有成本的前沿。
        <div style={{ fontSize: 12 }}>
          <Badge text="未扣残值" /> <Muted>{residualNote}</Muted>
        </div>
      ) : null}
      {products.length === 0 ? (
        <div data-stream-empty="" style={{ fontSize: 12 }}>
          <Muted>
            没有一台进比较
            {noMention > 0 ? `：${noMention} 台没被横评点名` : ''}
            {noPrice > 0 ? `${noMention > 0 ? '，' : '：'}${noPrice} 台没拿到可算的价格` : ''}
            。
          </Muted>
        </div>
      ) : (
        <>
          {/* 主结论是「哪些已经不用考虑」——它可核对(两根轴都不劣),而「最优」是不可核对的断言。 */}
          {killed.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', fontSize: 13, gap: 2 }}>
              {killed.map((k) => (
                <div key={k.name}>
                  <Badge text="已排除" />{' '}
                  <span style={{ textDecoration: 'line-through' }}>{k.name}</span>{' '}
                  <Muted>被「{k.by}」{k.why}</Muted>
                </div>
              ))}
            </div>
          ) : null}
          {frontier.length > 1 ? (
            <div style={{ fontSize: 13 }}>
              <Badge text="仍需你定" /> <strong>{frontier.join(' · ')}</strong>{' '}
              <Muted>互不支配——它们之间的差别是你的偏好，不是客观优劣。</Muted>
            </div>
          ) : frontier.length === 1 ? (
            <div style={{ fontSize: 13 }}>
              <Badge text="前沿" /> <strong>{frontier[0]}</strong>
            </div>
          ) : null}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', minWidth: products.length > 2 ? 560 : 0, width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ ...cellBase, width: 44 }} />
                  {products.map((p) => (
                    <th key={p.name} style={{ ...colStyle(p.name), fontWeight: 600 }}>
                      {p.image !== undefined ? (
                        // no-referrer:电商 CDN 常按 Referer 拒外站热链,带着必挂。
                        // 不用 loading=lazy:lazy 在后台/隐藏 tab 里干脆不加载。
                        <img
                          src={p.image}
                          alt=""
                          referrerPolicy="no-referrer"
                          style={{ borderRadius: 8, display: 'block', height: 128, margin: '0 auto 6px', maxWidth: '100%', objectFit: 'contain', width: 128 }}
                        />
                      ) : null}
                      <span style={killedNames.has(p.name) ? { textDecoration: 'line-through' } : undefined}>{p.name}</span>
                      {frontierSet.has(p.name) ? <span title="前沿"> ★</span> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label}>
                    <td style={{ ...cellBase, color: 'var(--dsw-alias-label-tertiary, inherit)' }}>{row.label}</td>
                    {products.map((p) => (
                      <td key={p.name} style={colStyle(p.name)}>
                        {row.cell(p)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {noMention > 0 || noPrice > 0 || gaps > 0 ? (
        <Muted>
          {noMention > 0 ? `${noMention} 台没被横评点名（缺的是可核的依据，不是不合格）` : ''}
          {noPrice > 0 ? `${noMention > 0 ? '；' : ''}${noPrice} 台没拿到可算的价格` : ''}
          {gaps > 0 ? `${noMention > 0 || noPrice > 0 ? '；' : ''}${gaps} 处取数失败（见回执 gaps）` : ''}
        </Muted>
      ) : null}
    </div>
  )
}
