// run 详情：固定版式，按 manifest 自动铺。
// 「artifact 清单」不是一个单独的 UI——它就是这一页的骨架，所以清单不可能漏。这是接替上一版
// DataFrame 抽象的页面：那一版把每种 artifact 硬塞进一个固定 frame 形状，塞不进的直接不显示，
// 157 个 run、1158 个 artifact 里只有 109 个（9.4%）能看到。这一版没有 frame，只有清单——
// 遍历 manifest.artifacts，一个不漏地渲染，渲染不了的（UnknownView）也照样占一张卡。
import { useEffect, useState, type ReactNode } from 'react'
import { fetchArtifact, fetchRunManifest, type Artifact, type ArtifactRef, type RunManifest } from '../research/artifact.ts'
import { ArtifactView } from '../research/ArtifactView.tsx'
import type { Connection } from '../lib/api.ts'
import { appThemeToViewTheme, readStoredTheme } from '../lib/theme.ts'

const CARD: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18))',
  borderRadius: 8, padding: 12, marginBottom: 12,
}

/** 一张 artifact 卡：**自己拉自己的数**。
 *  单 run 最多 71 个 artifact，html 类的 data 是整张 base64 PNG——打包一次取回来
 *  会让详情页第一屏卡在一个几十 MB 的响应上。 */
function ArtifactCard({ conn, streamId, runId, info, theme }: {
  conn: Connection; streamId: string; runId: string; info: ArtifactRef; theme: 'light' | 'dark'
}): ReactNode {
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let dead = false
    setArtifact(null)
    setError(null)
    fetchArtifact(conn, streamId, runId, info.name)
      .then((a) => { if (!dead) setArtifact(a) })
      .catch((e: unknown) => { if (!dead) setError(e instanceof Error ? e.message : String(e)) })
    return () => { dead = true }
  }, [conn, streamId, runId, info.name])
  return (
    <div data-artifact-card style={CARD}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{info.name}</span>
        <span style={{ fontSize: 11, opacity: 0.6, fontFamily: 'monospace' }}>{info.view}</span>
      </div>
      {error !== null && <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #d33)' }}>{error}</div>}
      {error === null && artifact === null && <div style={{ fontSize: 12, opacity: 0.6 }}>载入中…</div>}
      {artifact !== null && <ArtifactView artifact={artifact} theme={theme} />}
    </div>
  )
}

export function ResearchRunDetail({ conn, streamId, runId, onBack }: {
  conn: Connection; streamId: string; runId: string; onBack: () => void
}): ReactNode {
  // 图表配色跟当前应用主题走。没有 prop——从来没有调用方传过它，留一个「看起来能传」的
  // 接缝只会让下一个人以为主题是外面给的。
  const theme = appThemeToViewTheme(readStoredTheme())
  const [manifest, setManifest] = useState<RunManifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let dead = false
    setManifest(null)
    setError(null)
    fetchRunManifest(conn, streamId, runId)
      .then((m) => { if (!dead) setManifest(m) })
      .catch((e: unknown) => { if (!dead) setError(e instanceof Error ? e.message : String(e)) })
    return () => { dead = true }
  }, [conn, streamId, runId])

  if (error !== null) return <div style={{ padding: 24, fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #d33)' }}>读不到这个 run：{error}</div>
  if (manifest === null) return <div style={{ padding: 24, fontSize: 13, opacity: 0.7 }}>载入中…</div>

  const metrics = Object.entries(manifest.metrics)
  return (
    <div style={{ padding: 16, overflow: 'auto', height: '100%' }}>
      <button type="button" onClick={onBack} style={{ marginBottom: 12, fontSize: 12, background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>← 返回列表</button>
      <div style={CARD}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{manifest.name}</div>
        <div style={{ fontSize: 11, opacity: 0.6, fontFamily: 'monospace' }}>{manifest.id}</div>
        <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 12, flexWrap: 'wrap' }}>
          <span>状态：{manifest.status}</span>
          <span>开始：{manifest.created_at}</span>
          <span>结束：{manifest.finished_at ?? '—'}</span>
          <span>artifact：{manifest.artifacts.length}</span>
          {manifest.tags.length > 0 && <span>#{manifest.tags.join(' #')}</span>}
        </div>
        {metrics.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8, marginTop: 12 }}>
            {metrics.map(([k, v]) => (
              <div key={k} style={{ border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.14))', borderRadius: 6, padding: 8 }}>
                <div style={{ fontSize: 11, opacity: 0.6 }}>{k}</div>
                <div style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{String(v)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      {manifest.artifacts.map((a) => (
        <ArtifactCard key={a.name} conn={conn} streamId={streamId} runId={runId} info={a} theme={theme} />
      ))}
      {manifest.artifacts.length === 0 && <div style={{ padding: 24, fontSize: 13, opacity: 0.7 }}>这个 run 没有 artifact。</div>}
    </div>
  )
}
