import type { ReactNode } from 'react'
import { rsshubDocsBlocks, type DocsBlocksOptions, type RsshubDocsBlock } from '../../lib/source.ts'

// Minimal inline-markdown renderer (bold / code / links) for RSSHub route docs.
function renderMarkdownInline(text = ''): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(<code key={`${match.index}-code`} className="rounded bg-[var(--acr-card-nested)] px-1 py-0.5 font-mono text-[12px] text-foreground">{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={`${match.index}-strong`} className="font-semibold text-foreground">{token.slice(2, -2)}</strong>)
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      const href = link?.[2]?.trim()
      nodes.push(href && link ? (
        <a key={`${match.index}-link`} href={href} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
          {link[1]}
        </a>
      ) : token)
    }
    lastIndex = match.index + token.length
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

/** Parse an arbitrary markdown string and render it — for field/source descriptions
 *  that may contain markdown (bold, code, links, lists, tables). */
export function Markdown({ text, headingBase }: { text: string } & DocsBlocksOptions) {
  return <RsshubRouteMarkdown blocks={rsshubDocsBlocks(text, { headingBase })} />
}

/** Renders parsed RSSHub route-doc blocks (headings, callouts, lists, code, tables, …).
 *  Explains what a source does and how to fill its params — shown in the config Sheet. */
export function RsshubRouteMarkdown({ blocks }: { blocks: RsshubDocsBlock[] }) {
  return (
    <div className="space-y-3 text-[13px] leading-relaxed text-muted-foreground">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          // 真实语义标签(h1..h4),不再是同款 div——研究页面的 text view 靠 <h1> 识别标题。
          const className = block.level === 1
            ? 'pt-2 text-[18px] font-bold text-foreground'
            : block.level === 2
              ? 'pt-2 text-[16px] font-semibold text-foreground'
              : 'pt-1 text-[14px] font-semibold text-foreground'
          const Tag = (`h${block.level}` as const)
          return <Tag key={index} className={className}>{renderMarkdownInline(block.text)}</Tag>
        }
        if (block.type === 'callout') {
          return (
            <div key={index} className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-[13px] text-foreground/90">
              <div className="mb-1 text-[11px] font-semibold uppercase text-primary/80">{block.tone || 'tip'}</div>
              <div className="whitespace-pre-wrap">{renderMarkdownInline(block.text)}</div>
            </div>
          )
        }
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul'
          return (
            <ListTag key={index} className={`${block.ordered ? 'list-decimal' : 'list-disc'} space-y-1 pl-5`}>
              {block.items.map((item, itemIndex) => <li key={itemIndex}>{renderMarkdownInline(item)}</li>)}
            </ListTag>
          )
        }
        if (block.type === 'code') {
          return (
            <pre key={index} className="overflow-x-auto rounded-lg bg-[var(--acr-card-nested)] px-3 py-2 font-mono text-[12px] text-foreground/90">
              <code>{block.text}</code>
            </pre>
          )
        }
        if (block.type === 'blockquote') {
          return <blockquote key={index} className="border-l-2 border-[var(--acr-border)] pl-3 text-foreground/80">{renderMarkdownInline(block.text)}</blockquote>
        }
        if (block.type === 'table') {
          const [head, ...body] = block.rows
          return (
            <div key={index} className="overflow-x-auto rounded-lg border border-[var(--acr-border-soft)]">
              <table className="w-full min-w-[28rem] border-collapse text-left text-[12px]">
                {head ? (
                  <thead className="bg-[var(--acr-card-nested)] text-foreground">
                    <tr>{head.map((cell, cellIndex) => <th key={cellIndex} className="border-b border-[var(--acr-border-soft)] px-3 py-2 font-semibold">{renderMarkdownInline(cell)}</th>)}</tr>
                  </thead>
                ) : null}
                <tbody>
                  {body.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t border-[var(--acr-border-soft)] first:border-t-0">
                      {row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2 align-top">{renderMarkdownInline(cell)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        return <p key={index}>{renderMarkdownInline(block.text)}</p>
      })}
    </div>
  )
}
