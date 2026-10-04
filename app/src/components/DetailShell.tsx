import { useEffect, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../lib/utils.ts'
import { Button as AcrylicButton } from './acrylic/button.tsx'
import { ModalAcrylicBody } from './acrylic/use-modal-acrylic.ts'
import { addOverlay } from '../lib/overlayPresence.ts'

/**
 * 详情页的**外壳 + 播放区**：全屏 dialog、acrylic 涂层、左上关闭、左侧媒体窗格（点暗区关闭、
 * 滚轮翻上/下一条），右侧 480px 面板是**插槽**——放什么由调用方决定。
 *
 * 为什么抽出来：时间线的帖子详情和影视频道的分集播放要的是**同一个页面框架和同一套播放逻辑**，
 * 不同的只是右侧面板的内容（帖子正文/评论/转写 vs 某人的发言段）。此前影视频道另起了一个裸的
 * `FullscreenEpisodePlayer`，等于把这套框架绕开重搓——两处播放行为会各自漂移，且滚轮翻页、
 * acrylic 涂层、关闭语义这些只在一边有。
 *
 * `panel` 为空时媒体区独占整幅（影视全屏看片、右侧没内容可放时就是这样）。
 *
 * 它**在场即报到**（`overlayPresence`）：这块 `fixed inset-0` 是"主区被占满"这件事的唯一
 * 来源，工作台的对话列据此让位。报到写在这里而不是各个调用方，是因为播放入口会继续加
 * （继续观看 / 作品详情 / TMDb 详情各有一个），而它们的共同点就是都渲染这个组件——判据
 * 只在这一处成立一次，加第四个入口的人不需要记得接线。
 */
export function DetailShell({
  media,
  panel,
  onClose,
  variant = 'default',
  onMediaWheel,
}: {
  /** 左侧媒体窗格的内容——播放器/图集，由调用方渲染后传进来 */
  media: ReactNode
  /** 右侧 480px 面板的内容；缺省 = 不渲染右栏，媒体区独占 */
  panel?: ReactNode
  onClose: () => void
  variant?: 'default' | 'acrylic'
  /** 媒体区滚轮：时间线用它翻上/下一条；影视不需要就不传 */
  onMediaWheel?: (e: React.WheelEvent) => void
}) {
  const { t } = useTranslation()
  // 在场即报到；卸载即撤销（`addOverlay` 返回的撤销函数是幂等的，StrictMode 双跑不会打成负数）。
  useEffect(() => addOverlay(), [])
  return (
    <div
      role="dialog"
      aria-modal="true"
      // acrylic overlay 参与 modal-acrylic 涂层：use-modal-acrylic 按 DOM 事实
      // [role=dialog][data-state=open] 判定开态，故这个自定义全屏 overlay 必须自报 data-state=open。
      {...(variant === 'acrylic' ? { 'data-state': 'open' } : {})}
      className={cn(
        'fixed inset-0 z-50 flex',
        variant === 'acrylic' ? 'bg-[var(--acr-overlay)] backdrop-blur-2xl' : 'bg-background'
      )}
    >
      {variant === 'acrylic' ? <ModalAcrylicBody /> : null}
      {/* single close affordance, top-left (matches the video player's back button).
          `!bg-black hover:!bg-black active:!bg-black` 里的后两个是必要的：ghost variant 自带的
          `hover:bg-[var(--acr-chip)]`（rgba(0,0,0,.06)）盖到实心黑药丸上会把它洗成一块几乎透明
          的灰。但只压不给，等于把整个 hover/active 态压平成静止态——鼠标移上去零反馈，而类名里
          有 `hover:` 字样，读代码的人不会起疑。
          反馈因此走 `::before` 的**白色薄层**，不动底下那层黑：
          ①它相对按钮自己的黑变亮，所以**不管底下是什么媒体都读得出来**——用 `bg-black/55 →
            /75` 那套（媒体上圆形字形按钮的既有刻度）在这里实测是**零变化**：这颗按钮浮在
            `bg-black/80` 的媒体窗格上，黑压黑，两张截图逐像素相同；
          ②方向和同一窗格里的轮播左右键一致（`bg-white/10 → hover:bg-white/20`），
            没引入第三种语汇。 */}
      <AcrylicButton
        variant="ghost"
        size="xl"
        icon
        onClick={onClose}
        aria-label={t('timeline.back')}
        className="fixed left-4 top-4 z-[60] !bg-black !text-white shadow-sm hover:!bg-black active:!bg-black overflow-hidden before:pointer-events-none before:absolute before:inset-0 before:rounded-full before:bg-white/0 before:transition-colors hover:before:bg-white/15 active:before:bg-white/25 [&>svg]:relative [&>svg]:z-10"
      >
        <ArrowLeft />
      </AcrylicButton>
      <div
        className={cn(
          'relative flex flex-1 items-center justify-center overflow-hidden',
          variant === 'acrylic' ? 'bg-black/80' : 'bg-black'
        )}
        onClick={onClose}
        onWheel={onMediaWheel}
      >
        {media}
      </div>
      {panel ? (
        <aside
          className={cn(
            'h-full w-[480px] shrink-0 border-l',
            variant === 'acrylic'
              ? 'border-[var(--acr-border-soft)] shadow-[0_0_0_1px_var(--acr-border-soft)]'
              : 'border-border'
          )}
        >
          {panel}
        </aside>
      ) : null}
    </div>
  )
}
