import { imgUrl, LOCAL } from '../lib/api.ts'
import type { Content, Item, Media } from '../lib/types.ts'

/** first image url / video poster on a normalized item — the card cover */
function coverOf(content: Content): string | undefined {
  for (const m of content.media ?? []) {
    if (m.kind === 'image' && m.url) return m.url
    if (m.kind === 'video' && (m as Extract<Media, { kind: 'video' }>).poster) return (m as Extract<Media, { kind: 'video' }>).poster
  }
  return undefined
}

function isVideo(content: Content): boolean {
  return content.archetype === 'video' || (content.media ?? []).some((m) => m.kind === 'video')
}

export interface HarvestStreamPaneProps {
  items: Item[]
  done: boolean
}

/**
 * The live 采集 stream as a pure PANE (no modal chrome, no socket): compact cards that
 * appear as a recipe scrapes. Sits as the RIGHT column beside the post view inside one
 * modal (see PreviewModal — 左 post / 右 采集). The parent owns the WS subscription and
 * feeds both panes, so items show the instant they arrive (no blocking preview wait).
 */
export function HarvestStreamPane({ items, done }: HarvestStreamPaneProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      <div style={{ padding: '10px 4px', font: '600 13px/1.4 system-ui, sans-serif', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{done ? '采集完成' : '实时采集'} · {items.length} 条</span>
        {!done ? <span aria-hidden style={{ opacity: 0.55, font: '400 12px system-ui' }}>采集中…</span> : null}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {items.length === 0 ? (
          <div style={{ padding: '32px 8px', textAlign: 'center', opacity: 0.5, font: '400 12px system-ui' }}>等待抓取…</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 14 }}>
            {items.map((it) => {
              const cover = it.content ? coverOf(it.content) : undefined
              const video = it.content ? isVideo(it.content) : false
              return (
                <div key={it.id} data-slot="harvest-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ position: 'relative', aspectRatio: '3 / 4', borderRadius: 10, overflow: 'hidden', background: 'rgba(128,128,128,0.12)' }}>
                    {cover ? (
                      // Route through the no-Referer image proxy (same-origin): xhs's CDN 403s
                      // our Referer, and an https page blocks the raw http:// cover as mixed
                      // content — both render black. imgUrl serves the bytes from our own origin.
                      <img src={imgUrl(LOCAL.baseUrl, cover)} alt="" referrerPolicy="no-referrer" loading="lazy"
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    ) : null}
                    {video ? (
                      <div aria-label="视频" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.14)' }}>
                        <span style={{ width: 38, height: 38, borderRadius: '50%', background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 15, paddingLeft: 3 }}>▶</span>
                      </div>
                    ) : null}
                  </div>
                  <div style={{ font: '500 12px/1.3 system-ui, sans-serif', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {it.title || '无标题'}
                  </div>
                  {it.author ? <div style={{ font: '400 11px/1.2 system-ui, sans-serif', opacity: 0.6 }}>{it.author}</div> : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
