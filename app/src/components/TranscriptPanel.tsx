// app/src/components/TranscriptPanel.tsx
//
// 详情右栏的「转写」档——转写稿在前端的第一块固定渲染面（2026-08-12 从这里退役过一次，
// 那次的原因是对话抽屉接管了归宿；现在对话不再是唯一归宿，它回来，背后换成 /api/conversions
// 这套转换资源，见 docs/superpowers/specs/2026-10-24-paste-to-transcript-design.md）。
//
// 只管画：起 / 查 / 轮询 / 取消全在 `useExtractConversion` 那一份里，这里不碰 API。
// 五个状态一状态一面（排队 / 运行 / 完成 / 失败 / 未启动），别合并「运行中」和「排队」：
// 排队有位置号、没有阶段可言；运行有阶段进度、没有位置号——合了就只能画一个含混的 spinner。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, RotateCcw, X } from 'lucide-react'
import { segmentsIn, type TranscriptSegmentLike } from '@extract/transcript.ts'

import { Badge } from './acrylic/badge.tsx'
import { Button as AcrylicButton } from './acrylic/button.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible.tsx'
import { mmss } from '../lib/feedPresent.ts'
import type { ExtractConversionState } from '../lib/useExtractConversion.ts'
import type { Conversion } from '../lib/types.ts'

/** timing.stages 里的阶段名 → 给人看的名字。没映射到的原样显示——阶段名是后端
 * converter 自己起的，前端映射表只覆盖已知的，宁可显示英文也不猜一个错的。 */
const STAGE_LABELS: Record<string, string> = {
  'stt:media': '取音频',
  'stt:asr': '语音转写',
  'stt:diarize': '识别说话人',
  'ocr:fetch': '取图',
  'ocr:recognize': '图文识别',
  'article:fetch': '取网页',
  'article:extract': '抽正文',
  'inline:fetch': '取正文',
}

/** extract 记录里转写档要读的那几格（result 按 kind 判别，这里只 cast 不验证——
 *  分支判据走 segmentsIn 那份权威，不在这里再写一份）。 */
interface ExtractResult {
  text?: string
  format?: string
  branch?: string
}

const BRANCH_LABELS: Record<string, string> = { stt: '转写', ocr: '图文识别', article: '网页正文', inline: '正文' }

function stageLabel(name: string): string {
  return STAGE_LABELS[name] ?? name
}

function QueuedFace({ rec, conv, t }: { rec: Conversion; conv: ExtractConversionState; t: (key: string, opts?: Record<string, unknown>) => string }) {
  return (
    <div className="flex flex-col items-start gap-3 py-8 text-sm text-muted-foreground">
      <div data-testid="transcript-queued">
        {t('transcript.queued')}
        {rec.queuePos !== undefined && rec.queuePos > 0 ? ` · ${t('transcript.queuePos', { n: rec.queuePos })}` : ''}
      </div>
      <AcrylicButton variant="neutral" size="small" onClick={conv.remove}>
        <X className="size-4" />
        {t('transcript.cancel')}
      </AcrylicButton>
    </div>
  )
}

function RunningFace({ rec, conv, t }: { rec: Conversion; conv: ExtractConversionState; t: (key: string, opts?: Record<string, unknown>) => string }) {
  const stages = rec.timing?.stages ?? []
  return (
    <div className="flex flex-col items-start gap-3 py-8 text-sm">
      <div data-testid="transcript-running" className="text-muted-foreground">{t('transcript.running')}</div>
      {stages.length > 0 ? (
        <ul className="w-full space-y-1 text-xs text-muted-foreground">
          {stages.map((s) => (
            <li key={s.name} className="flex justify-between tabular-nums">
              <span>{stageLabel(s.name)}</span>
              <span>{(s.ms / 1000).toFixed(1)}s</span>
            </li>
          ))}
        </ul>
      ) : null}
      <AcrylicButton variant="neutral" size="small" onClick={conv.remove}>
        <X className="size-4" />
        {t('transcript.cancel')}
      </AcrylicButton>
    </div>
  )
}

function SegmentsBlock({ rec, t }: { rec: Conversion; t: (key: string, opts?: Record<string, unknown>) => string }) {
  const segs = segmentsIn(rec)
  if (segs === undefined) return null // 不是转写分支：没有时间轴这回事
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-xs text-muted-foreground hover:text-foreground">
        {t('transcript.segments', { n: segs.length })}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-2 space-y-1.5 border-t pt-2">
          {segs.map((s: TranscriptSegmentLike, i: number) => (
            <li key={i} className="flex gap-2 text-xs leading-relaxed">
              <span className="shrink-0 tabular-nums text-muted-foreground">{mmss(s.start)}</span>
              <span className="min-w-0 break-words">{s.text}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

function DoneFace({ rec, conv, t }: { rec: Conversion; conv: ExtractConversionState; t: (key: string, opts?: Record<string, unknown>) => string }) {
  const r = (rec.result ?? {}) as ExtractResult
  const branch = r.branch ? (BRANCH_LABELS[r.branch] ?? r.branch) : undefined
  return (
    <div className="flex flex-col gap-3" data-testid="transcript-done">
      <div className="flex flex-wrap items-center gap-2">
        {branch ? <Badge variant="secondary" size="sm">{branch}</Badge> : null}
        {r.text ? <span className="text-xs text-muted-foreground">{t('transcript.words', { n: r.text.length })}</span> : null}
        <AcrylicButton
          variant="ghost"
          size="small"
          className="ml-auto"
          onClick={() => conv.start({ force: true })}
          title={t('transcript.rerunHint')}
        >
          <RotateCcw className="size-3.5" />
          {t('transcript.rerun')}
        </AcrylicButton>
      </div>
      {r.text ? (
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{r.text}</div>
      ) : (
        <div className="text-sm text-muted-foreground">{t('transcript.emptyResult')}</div>
      )}
      <SegmentsBlock rec={rec} t={t} />
    </div>
  )
}

function ErrorFace({ message, conv, t }: { message: string; conv: ExtractConversionState; t: (key: string, opts?: Record<string, unknown>) => string }) {
  return (
    <div className="flex flex-col items-start gap-3 py-8 text-sm" data-testid="transcript-error">
      <div className="text-destructive">{t('transcript.failed')}：{message}</div>
      <AcrylicButton variant="neutral" size="small" onClick={() => conv.start()}>
        <RotateCcw className="size-4" />
        {t('transcript.retry')}
      </AcrylicButton>
    </div>
  )
}

/** 转写档本体。`conv` 是 Detail 树里那份 `useExtractConversion` 的返回值（唯一状态源）。 */
export function TranscriptPanel({ conv }: { conv: ExtractConversionState }) {
  const { t } = useTranslation()
  if (conv.loading) {
    return <div className="py-8 text-sm text-muted-foreground">{t('transcript.loadingCache')}</div>
  }
  if (conv.startError !== undefined) {
    return <ErrorFace message={conv.startError} conv={conv} t={t} />
  }
  const rec = conv.record
  if (rec === null) {
    return (
      <div className="flex flex-col items-start gap-3 py-8" data-testid="transcript-idle">
        <p className="text-sm text-muted-foreground">{t('transcript.intro')}</p>
        <AcrylicButton variant="neutral" size="small" onClick={() => conv.start()}>
          <FileText className="size-4" />
          {t('transcript.start')}
        </AcrylicButton>
      </div>
    )
  }
  switch (rec.status) {
    case 'queued':
      return <QueuedFace rec={rec} conv={conv} t={t} />
    case 'running':
      return <RunningFace rec={rec} conv={conv} t={t} />
    case 'done':
      return <DoneFace rec={rec} conv={conv} t={t} />
    case 'error':
      return <ErrorFace message={rec.error?.message ?? ''} conv={conv} t={t} />
  }
}
