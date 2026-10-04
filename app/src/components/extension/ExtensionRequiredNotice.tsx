import { ExtensionOnboardingCard, type ExtensionOnboardingActions } from './ExtensionOnboardingCard.tsx'

/**
 * 「这一步需要 Chrome 扩展」——用户**自己发起**的动作因为扩展没连而做不成时，就在那个动作的
 * 返回处贴出来（spec §4.2）。它就是引导卡片的 inline 档加一句现场话，不是第二套流程：
 * 同一件事只有一处文案。
 *
 * **不做的两件事**（都在 spec §4.2 里）：不丢进通知中心（用户此刻就在这个上下文里，
 * 通知中心是给"稍后再看"用的）；无人值守的后台采集失败**不弹这个**——用户看到时早已不在
 * 那个上下文里，那种失败照旧只记一条。
 *
 * 节流（一天一次、按能力分开）在调用方：它才知道这次是哪个能力、以及要不要记一笔。
 */
export function ExtensionRequiredNotice({
  actions,
  onConnected,
}: {
  actions: ExtensionOnboardingActions
  onConnected?: () => void
}) {
  return (
    <div role="status" className="px-3 py-2">
      <ExtensionOnboardingCard variant="inline" actions={actions} onConnected={onConnected} />
    </div>
  )
}
