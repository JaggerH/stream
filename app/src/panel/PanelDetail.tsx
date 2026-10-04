/**
 * 面板里的详情：把 Stream 自己的 `<Detail>` 原样搬进工作台右列，不复刻第二份详情页。
 *
 * 这里只解决"搬进来"必须补的两件事，别的一律不碰 `Detail`——它是主应用在用的那一份。
 *
 * ## 1. 视频舞台：面板自带一份实例，共用同一份代码
 *
 * `Detail` 里的 `useVideoStage()` 没有 Provider 就直接抛。舞台本身（一个共享的 Artplayer
 * 实例，靠 react-reverse-portal 在卡片和详情之间搬家）住在 `lib/videoStageProvider.tsx`，
 * 主应用和这里各挂一份**实例**——同一个 `<video>` 元素本来就不可能跨浏览器页面共享，
 * 所以"面板自带一份"是正确形状；能共用的是代码，不是实例。
 *
 * 不给 `openId`/`onOpenIdChange`：面板的详情是**独立的第二个 React root**（见
 * `detail-entry.tsx` 头注），列表那棵树里没有会经 `<OutPortal>` 骑走这份播放器的卡片，
 * 也就没有"内联播 → 展开进详情"这条搬家路径可言。传一个永远为空的 openId 只会让读的人
 * 以为这里也有那两态。
 *
 * 音频那半这里**故意不挂**：面板一页里只该有一个 `<audio>`，它挂在列表那棵树上
 * （`StreamPanel.tsx`），详情盖上来时列表并不卸载，所以正在播的那条会照常播下去。
 * 详情这一侧 `useAudioStageOptional()` 拿到 null、自己降级——这是**选择**，不是"两个 root
 * 没法各持一份 `<audio>`"：两个 root 其实同住一个浏览器页面，页面级共享一份舞台状态技术上
 * 可行，只是没做（真做的话是往 `StreamPanel.tsx`/`detail-entry.tsx` 之间搭一条状态通道，
 * 量级不小，本次不做）。选择的代价是真实的：一条**播客**详情（没有视频也没有图集）在这里
 * 会看到没有任何媒体面板——`Detail.tsx` 判 `audioTrack` 靠 `audioStage &&`，这里 `audioStage`
 * 恒为 null，`audioTrack` 也就恒为 null，`hasMedia` 恒为 false。它是降级不是崩溃，但那个
 * 详情页目前是**死页面**：播客那一支入口在面板里点开详情等于点了个寂寞。
 *
 * ## 2. 把 `fixed` 关进面板里
 *
 * `Detail` 的根是 `fixed inset-0`——在主应用里那正是"铺满整屏"，但在工作台里它会盖住
 * DSH 整页。CSS 规范里，祖先只要有非 none 的 `transform`，就成为 `fixed` 后代的包含块；
 * 所以外面这层 `translateZ(0)` 一加，`Detail` 就只铺满面板这一列。
 * **别去改 `Detail` 的定位**——那会动到主应用。
 *
 * ## 3. 「转成文字」的能力发现：这棵树自己有一份
 *
 * `canExtract` 的真相是 `/api/conversion-kinds` 的分支可用性。这棵树是**独立的 React root**
 * （自己的 bundle、自己的 React 实例），主应用/面板列表那棵树上的 `ExtractCapsProvider`
 * 一个字都到不了这里——所以在这儿自己挂一份（`useExtractCaps`）。
 *
 * `extractCaps` 是**种子**：列表那棵树开页就拉过一次，拉到了就顺着 `mount()` 递进来，
 * 详情这边直接用、不再拉第二次，也就没有"按钮晚半拍冒出来"的那一跳。**只有列表那边确实
 * 拉到了（status==='ready'）才递**——递一份"还没拉到"的全 false 进来，这棵树会把它当结论，
 * 按钮就永远不出现了。没种子（列表还在路上/拉失败）就自己拉，拉不到就不显示按钮：
 * 底线仍然是**宁可不亮，也不亮一个点了必失败的入口**。
 */
import type { ReactElement } from 'react'
import { Detail } from '../components/Detail.tsx'
import { LOCAL } from '../lib/api.ts'
import type { ExtractCapabilities } from '../lib/extract.ts'
import { ExtractCapsProvider, useCanExtract, useExtractCaps } from '../lib/extractCaps.tsx'
import { VideoStageProvider } from '../lib/videoStageProvider.tsx'
import type { Item as StreamItem } from '../lib/types.ts'

export function PanelDetail({
  item,
  startMediaIndex,
  autoPlayMedia,
  extractCaps,
  onClose,
}: {
  item: StreamItem
  /** 点的是图集第几张（`OpenDetailOptions.mediaIndex`）。 */
  startMediaIndex: number
  /** 点媒体进来的（`autoPlaysDetailMedia`）才自动播；点标题进来的先让人读。 */
  autoPlayMedia: boolean
  /** 列表那棵树**已经拉到**的能力发现结果（见头注 §3）。缺席 = 这棵树自己去拉。 */
  extractCaps?: ExtractCapabilities
  onClose: () => void
}): ReactElement {
  const { caps } = useExtractCaps(LOCAL, extractCaps)
  // Provider 也罩住 Detail 里可能出现的右键菜单（`ItemContextMenu` 走 context 读同一份 caps），
  // 免得同一棵树里两个「转成文字」入口一个亮一个不亮。
  return (
    <ExtractCapsProvider caps={caps}>
      <PanelDetailBody
        item={item}
        startMediaIndex={startMediaIndex}
        autoPlayMedia={autoPlayMedia}
        onClose={onClose}
      />
    </ExtractCapsProvider>
  )
}

/** Provider 里面那半：`useCanExtract` 得站在 `ExtractCapsProvider` **底下**才读得到
 *  （同一个组件体里 `useContext` 读不到自己渲染的那个 Provider）。 */
function PanelDetailBody({
  item,
  startMediaIndex,
  autoPlayMedia,
  onClose,
}: {
  item: StreamItem
  startMediaIndex: number
  autoPlayMedia: boolean
  onClose: () => void
}): ReactElement {
  const canExtract = useCanExtract()
  return (
    // translateZ(0)：见文件头注 §2，把 Detail 的 fixed 关在面板这一列里。
    <div className="absolute inset-0 [transform:translateZ(0)]">
      <VideoStageProvider baseUrl={LOCAL.baseUrl}>
        <Detail
          item={item}
          conn={LOCAL}
          onClose={onClose}
          startMediaIndex={startMediaIndex}
          autoPlayMedia={autoPlayMedia}
          // variant 走 'default' 而不是主应用那档 'acrylic'：acrylic 那档会挂
          // `ModalAcrylicBody`，它把 `modal-acrylic` 这个类点到**DSH 那一页的 <html>** 上。
          // 面板是客人，不改主人家的根元素。
          variant="default"
          // 「转成文字」的显隐（能力发现见头注 §3）。谓词恒在，但 caps 还没拉到/拉不到时它一律
          // 返回 false——按钮不出现，不会出现一个点了必失败的入口。动作本身走
          // `lib/askExtract.ts`（Detail 内部调，和右键菜单同一份，别另写第二份）。
          canExtract={canExtract}
        />
      </VideoStageProvider>
    </div>
  )
}
