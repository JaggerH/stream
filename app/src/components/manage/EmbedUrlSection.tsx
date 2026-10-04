/**
 * `embed`（外接面板）频道的专属配置区：一个 URL 输入，失焦 / 回车存进 `options.url`。
 * 经 `PRESENT_EXTRAS.embed` 挂进 `ChannelConfigPanel`——配置面本体不认识 embed，只认识"这个
 * Present 有没有专属区块"。走 `useChannels().patchChannel`，与槽位那一格同一条写路径，
 * 后端拒掉非 http(s) 的地址时错误就地显示（不 toast：错在这一格，就该在这一格看见）。
 */
import { useState, type ReactElement } from 'react'
import type { Connection } from '../../lib/api.ts'
import { Input } from '../acrylic/input.tsx'
import { useChannels } from '../../lib/channels.tsx'
import type { ChannelView } from '../../lib/types.ts'

export function EmbedUrlSection({ channel }: { conn: Connection; channel: ChannelView }): ReactElement {
  const { patchChannel } = useChannels()
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const current = typeof channel.options?.url === 'string' ? channel.options.url : ''

  const commit = async (raw: string): Promise<void> => {
    const url = raw.trim()
    if (url === current || saving) return
    setSaving(true)
    setErr(null)
    try {
      // 清空 = 删掉这一键，不存一个空串——空串在面板里和"没填"是同一档，库里却多一个坏值。
      const { url: _dropped, ...rest } = channel.options ?? {}
      await patchChannel(channel.id, { options: url ? { ...rest, url } : rest })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[12px] font-semibold text-muted-foreground">面板地址</h3>
      <Input
        key={current}
        size="xl"
        type="url"
        defaultValue={current}
        placeholder="https://…"
        disabled={saving}
        onBlur={(e) => void commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void commit((e.target as HTMLInputElement).value) }
        }}
        aria-label="面板地址"
      />
      <p className="text-[12px] text-muted-foreground">整个主窗格装这张网页。对方得允许被嵌入（没有 X-Frame-Options / frame-ancestors 限制）。</p>
      {err ? <p className="text-[12px] text-destructive">{err}</p> : null}
    </section>
  )
}
