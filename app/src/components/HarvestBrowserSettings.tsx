import { useEffect, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { toast } from './acrylic/sonner.tsx'
import { api, type Connection } from '../lib/api.ts'
import { ExtensionOnboardingCard, extensionActions } from './extension/ExtensionOnboardingCard.tsx'
import type { ChromeCandidate, HarvestBrowserStatus } from '../lib/types.ts'

const sideLabel = (side: ChromeCandidate['side']) => (side === 'windows' ? 'Windows 侧' : 'Linux 侧')
const sourceLabel = (source: ChromeCandidate['source']) =>
  source === 'user-install' ? '用户级安装' : source === 'path' ? 'PATH' : '系统安装'

/**
 * 「采集用哪个 Chrome」的 web/app 那张面（spec 2026-07-29 §4）。后端只列候选、永不自动挑：
 * WSL 和 Windows 都装了 Chrome 是合法状态，而选错的后果很重且很隐蔽——选了 Linux 侧那个，
 * 采集全程游客态，但一切"正常运行"，只是采不到东西。
 *
 * 同一个字段三种面：这里、桌面端启动引导、以及 config.yaml 的 `harvest_browser.exe`（mcp 那张）。
 * **扩展要装在被选中的那一侧**——装在另一侧的症状是"扩展装了但一直没连上"，最难查的一类。
 */
export function HarvestBrowserSettings({ conn }: { conn: Connection }) {
  const [st, setSt] = useState<HarvestBrowserStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    api.harvestBrowser
      .get(conn)
      .then(setSt)
      .catch(() => setSt(null))
  }, [conn])

  const choose = async (exe: string) => {
    setBusy(exe)
    try {
      setSt(await api.harvestBrowser.set(conn, exe))
      toast.success('采集浏览器已切换', { description: '下一轮采集生效；扩展要装在这一侧' })
    } catch (e) {
      toast.error('切换失败', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  if (!st) return <p className="text-[11px] text-muted-foreground">读取中…</p>

  return (
    <div className="space-y-2">
      {st.mustChoose && (
        <p className="text-[11px] leading-relaxed text-amber-500">
          发现多个 Chrome，<span className="font-medium">请选一个</span>
          ——选错不会报错，只会让采集全程处于未登录状态。
        </p>
      )}
      {st.candidates.length === 0 && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          没发现 Chrome。采集需要你自己那个装了 Stream 扩展的 Chrome（Stream 不自带浏览器）。
        </p>
      )}
      <ul className="space-y-1">
        {st.candidates.map((c) => {
          const active = st.selected === c.exe
          return (
            <li key={c.exe}>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => choose(c.exe)}
                className="flex w-full items-center gap-2 rounded-md border border-[var(--acr-border-soft)] px-2.5 py-1.5 text-left transition-colors hover:border-foreground/40 disabled:opacity-60"
              >
                <span className="w-4 shrink-0">
                  {busy === c.exe ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : active ? (
                    <Check className="size-3.5" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px]">{c.exe}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {sideLabel(c.side)} · {sourceLabel(c.source)}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {/* 那个「永远在」的固定入口（spec §4.2 防烦第二条）：**无条件画**，不看三态。
          首启横幅拒绝一次就不再出现、现场提示一天只提一次，用户后来改主意时得有个地方去；
          "已经装好了的人也看得到"是刻意的——扩展被停用/换了 Chrome 都要从这里重来。 */}
      <div className="pt-1">
        <ExtensionOnboardingCard variant="inline" actions={extensionActions(conn)} />
      </div>
      {st.selected && !st.candidates.some((c) => c.exe === st.selected) && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          当前：<code>{st.selected}</code>
          （不在自动发现的候选里——自定义安装路径，来自 {st.origin === 'config' ? 'config.yaml' : '手工设置'}）
        </p>
      )}
    </div>
  )
}
