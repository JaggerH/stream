import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from './acrylic/sonner.tsx'
import { api, ApiError, type Connection } from '../lib/api.ts'

/**
 * 「从手机/别的设备访问 Stream」。
 *
 * 后端绑 0.0.0.0（局域网访问是有意保留的能力），所以 `/api/*` 与 `/ws` 有一道门：
 * **本机 loopback 免密，其余来源要出示令牌**（判据 src/http/access-guard.ts）。这一节就是
 * 令牌的取处——而且它**只在本机看得到**（后端对非 loopback 请求这一口直接 403），
 * 所以别的设备没法靠"访问一下设置页"把自己放进来。
 *
 * 给的是链接不是令牌串：手机上要用的是一条能点开的地址，不是 64 位十六进制手抄。
 */
export function RemoteAccessSettings({ conn }: { conn: Connection }) {
  const [data, setData] = useState<{ token: string; urls: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    api.accessToken
      .get(conn)
      .then((d) => { setData(d); setError(null) })
      .catch((e) => setError(e instanceof ApiError ? e.message : '后端未响应'))
  }, [conn])

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500)
    } catch {
      toast.error('复制失败', { description: '手动选中复制吧' })
    }
  }

  if (error) return <div className="text-[12px] text-muted-foreground">{error}</div>
  if (!data) return <div className="text-[12px] text-muted-foreground">读取中…</div>

  return (
    <div className="space-y-2.5">
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        在这台机器上访问不需要令牌。从手机或别的设备访问时，用下面的链接打开一次即可——
        令牌会存在那台设备的浏览器里。
      </p>

      {data.urls.length === 0 ? (
        <p className="rounded-md bg-amber-400/10 px-2.5 py-2 text-[12px] leading-relaxed text-amber-300">
          这台机器现在没有局域网地址（没接网，或只有回环接口），别的设备够不着它。
        </p>
      ) : (
        <div className="space-y-1.5">
          {data.urls.map((url) => (
            <button
              key={url}
              type="button"
              onClick={() => copy(url, url)}
              className="flex w-full items-center gap-2 rounded-md border border-[var(--acr-border-soft)] px-2.5 py-1.5 text-left transition-colors hover:border-foreground/40"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{url}</span>
              {copied === url
                ? <Check className="size-3.5 shrink-0 text-emerald-400" />
                : <Copy className="size-3.5 shrink-0 text-muted-foreground" />}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-1">
        <span className="text-[12px] text-muted-foreground">令牌（需要手输时用）</span>
        <button
          type="button"
          onClick={() => copy(data.token, 'token')}
          className="flex w-full items-center gap-2 rounded-md border border-[var(--acr-border-soft)] px-2.5 py-1.5 text-left transition-colors hover:border-foreground/40"
        >
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{data.token}</span>
          {copied === 'token'
            ? <Check className="size-3.5 shrink-0 text-emerald-400" />
            : <Copy className="size-3.5 shrink-0 text-muted-foreground" />}
        </button>
      </div>
    </div>
  )
}
