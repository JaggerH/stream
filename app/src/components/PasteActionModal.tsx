// app/src/components/PasteActionModal.tsx
//
// 粘贴一条被认领的媒体链接后的确认框。面板是工具不是 AI：粘贴这一个动作说的可以是
// 「我想看」「我想下」「我想转成文字」三种里的任何一种，这里不做意图猜测——把抓到的
// 信息摆出来，让用户点一下（设计见 docs/superpowers/specs/2026-10-24-paste-to-transcript-design.md）。
//
// 三个出口，语义各不相同：
// - [转成文字] → onTranscribe：开详情 + autoExtract（转换由详情树里的转写档发起）。
// - [下载]     → 直接 triggerDownload（浏览器下载直链，不开详情）。
// - 点卡片 / 「查看详情」→ onOpenDetail：原来那条直接开详情的路。
// ESC / 点遮罩 / 关闭 = 取消，什么都不发生。
//
// **不 portal 到 document.body**：acrylic 的 Dialog（acrylic/dialog.tsx）把 DialogPortal
// 写死在 body 上、没透传 container，而 DSH 宿主里 body 不在我们这棵挂着 `.dark` 的子树，
// 一出去 token 全丢（StreamPanel 里 StreamSettingPage 用 absolute overlay 而不是 Sheet 是
// 同一个坑，见那边注释）。所以沿用 absolute inset-0、留在面板子树里，但表面照 acrylic
// Dialog 那一套画：遮罩 `--acr-overlay` + 磨砂，面板 `--acr-panel` + 环形描边阴影，媒体
// 条目用 acrylic 的 Item/ItemMedia。`data-state="open"` + `<ModalAcrylicBody />` 让这个
// 自绘 overlay 参与 modal-acrylic 涂层（观察器按 DOM 事实 `[role=dialog][data-state=open]`
// 判开态，见 use-modal-acrylic.ts；Detail.tsx 的全屏 overlay 同款做法）。
//
// 按钮可见性不自己嗅探：「转成文字」亮不亮读 useCanExtract（判定权威在
// shared/extract/plan.ts），「下载」亮不亮看 videoDownloadUrl 派不派得出直链
// （和详情页动作行同一个 `playableVideo`——两处各写一份就会出现一边能下一边不能）。
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, ExternalLink, FileText, X } from 'lucide-react'

import { Badge } from './acrylic/badge.tsx'
import { Button as AcrylicButton } from './acrylic/button.tsx'
import { Item, ItemContent, ItemMedia, ItemTitle } from './acrylic/item.tsx'
import { ModalAcrylicBody } from './acrylic/use-modal-acrylic.ts'
import { imgUrl, LOCAL } from '../lib/api.ts'
import { useCanExtract } from '../lib/extractCaps.tsx'
import { triggerDownload, videoDownloadUrl } from '../lib/feedPresent.ts'
import { playableVideo } from '../lib/videoPlan.ts'
import { sourceLabel } from '../lib/sourceLabel.ts'
import type { Item as StreamItem } from '../lib/types.ts'

export function PasteActionModal({
  item,
  onTranscribe,
  onOpenDetail,
  onClose,
}: {
  item: StreamItem
  /** 点「转成文字」：开详情并启动转写（autoExtract 意图）。 */
  onTranscribe: () => void
  /** 点卡片或「查看详情」：只开详情（原来的行为）。 */
  onOpenDetail: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const canExtract = useCanExtract()
  const canTranscribe = canExtract(item)
  const poster = (() => {
    for (const m of item.content?.media ?? []) {
      if (m.kind === 'video' && m.poster) return m.poster
      if (m.kind === 'image') return m.url
    }
    return undefined
  })()
  const videoDl = videoDownloadUrl(
    playableVideo(item.content?.media),
    LOCAL.baseUrl,
    item.title?.trim() || (typeof item.author === 'string' ? item.author : '') || 'download',
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-state="open"
      data-testid="paste-action-modal"
      className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--acr-overlay)] p-4 backdrop-blur-2xl"
      onClick={onClose}
    >
      <ModalAcrylicBody />
      <div
        data-testid="paste-action-panel"
        className="relative w-full max-w-md rounded-[20px] bg-[var(--acr-panel)] p-4 shadow-[0_0_0_1px_rgba(190,190,190,0.16),0_16px_48px_rgba(0,0,0,0.45)] backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <AcrylicButton
          variant="ghost"
          size="small"
          icon
          aria-label={t('paste.close')}
          className="absolute right-2 top-2 size-7"
          onClick={onClose}
        >
          <X className="size-4" />
        </AcrylicButton>
        <div className="mb-1 pr-8 text-xs text-muted-foreground">{t('paste.foundLink')}</div>
        {/* 点卡片 = 仅查看详情：三种意图里唯一不需要按钮确认的——「先看看是什么」。 */}
        <Item variant="muted" asChild data-testid="paste-action-card">
          <button type="button" onClick={onOpenDetail} className="w-full text-left">
            <ItemMedia variant="image">
              {poster ? (
                <img
                  src={imgUrl(LOCAL.baseUrl, poster)}
                  alt=""
                  loading="lazy"
                />
              ) : null}
            </ItemMedia>
            <ItemContent>
              {/* 标题两行截断是原确认框的排版：单行 truncate 会把长标题吞得只剩一句。 */}
              <ItemTitle className="whitespace-normal line-clamp-2">{item.title}</ItemTitle>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                {typeof item.author === 'string' && item.author ? <span className="truncate">{item.author}</span> : null}
                <Badge size="sm" className="shrink-0">{sourceLabel(item)}</Badge>
              </div>
            </ItemContent>
          </button>
        </Item>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <AcrylicButton
            variant="neutral"
            size="small"
            disabled={!canTranscribe}
            title={canTranscribe ? undefined : t('transcript.backendMissing')}
            onClick={onTranscribe}
            data-testid="paste-action-transcribe"
          >
            <FileText className="size-4" />
            {t('timeline.extract')}
          </AcrylicButton>
          {videoDl ? (
            <AcrylicButton
              variant="neutral"
              size="small"
              onClick={() => {
                triggerDownload(videoDl)
                onClose()
              }}
              data-testid="paste-action-download"
            >
              <Download className="size-4" />
              {t('timeline.download')}
            </AcrylicButton>
          ) : null}
          <button
            type="button"
            onClick={onOpenDetail}
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3" />
            {t('timeline.viewDetail')}
          </button>
        </div>
      </div>
    </div>
  )
}
