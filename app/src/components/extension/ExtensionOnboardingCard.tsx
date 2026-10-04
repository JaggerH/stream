import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api, type Connection } from '../../lib/api.ts'
import type { ExtensionInstallOutcome } from '../../lib/types.ts'

/**
 * 扩展安装引导（spec 2026-08-30-extension-onboarding §4、§6）。
 *
 * **一个组件两处用**：首启横幅（`variant="banner"`）和"动作现场"（`variant="inline"`）。
 * variant 只影响外观和给不给「以后再说」；文案与流程两者共用——同一件事只有一处文案，
 * 分成两份的下场是两处慢慢说出两种话。
 *
 * **不实现「帮我重启 Chrome」**（spec §6.4 里有这个按钮）。这是一处刻意留白，不是漏了：
 * 关掉用户所有标签页是不可逆的，而它省下的只是一次点击。等真有人抱怨再加不迟。
 */
export type OnboardingVariant = 'banner' | 'inline'

/** 组件吃的是这三个动作，不是 `conn`——测试因此不用桩 fetch。真身见 `extensionActions`。 */
export interface ExtensionOnboardingActions {
  materialize(): Promise<{ dir: string; source: string }>
  install(): Promise<ExtensionInstallOutcome>
  decline(): Promise<void>
}

/** 真身：三个端点的薄封装。挂载点（StreamPanel / 设置页 / 动作现场）用它把 conn 绑进去。 */
export const extensionActions = (conn: Connection): ExtensionOnboardingActions => ({
  materialize: () => api.extension.materialize(conn),
  install: () => api.extension.install(conn),
  decline: () => api.extension.decline(conn),
})

type Phase =
  | { kind: 'idle' }
  /** 点了「帮我装」但**还没动手**——先把会发生什么说清楚（spec §6.1）。 */
  | { kind: 'confirm' }
  | { kind: 'running' }
  | { kind: 'done'; outcome: ExtensionInstallOutcome }
  /** 代装**根本没跑起来**（Stream Desktop 没连、端点 500）。和 blocked 是两件事。 */
  | { kind: 'failed'; message: string }
  | { kind: 'manual'; dir?: string; error?: string }

export function ExtensionOnboardingCard({
  variant,
  actions,
  onDismiss,
  onConnected,
}: {
  variant: OnboardingVariant
  actions: ExtensionOnboardingActions
  /** 「以后再说」之后收起这一面（只有 banner 档给这个按钮）。 */
  onDismiss?: () => void
  /** 装成了。调用方据此去重读 `browser-capability`——**判据在那边，不在这个回执上**。 */
  onConnected?: () => void
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const run = async () => {
    setPhase({ kind: 'running' })
    try {
      const outcome = await actions.install()
      setPhase({ kind: 'done', outcome })
      if (outcome.status === 'connected') onConnected?.()
    } catch (e) {
      setPhase({ kind: 'failed', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const manual = async () => {
    setPhase({ kind: 'manual' })
    try {
      const { dir } = await actions.materialize()
      setPhase({ kind: 'manual', dir })
    } catch (e) {
      setPhase({ kind: 'manual', error: e instanceof Error ? e.message : String(e) })
    }
  }

  const dismiss = async () => {
    await actions.decline().catch(() => {})
    onDismiss?.()
  }

  return (
    <div
      className={
        variant === 'banner'
          ? 'space-y-2 border-b border-[var(--acr-border-soft)] px-3 py-2.5 text-[12px] leading-relaxed'
          : 'space-y-2 rounded-md border border-[var(--acr-border-soft)] px-3 py-2.5 text-[12px] leading-relaxed'
      }
    >
      {/* 先说为什么再说做什么：用户此刻还不知道扩展和"我想追的内容"有什么关系。 */}
      <p className="text-muted-foreground">
        {variant === 'inline' ? '这一步需要 Chrome 扩展（要用你的登录态）。' : null}
        Stream 采集你关注的内容时要借你自己那个 Chrome 的
        <span className="text-foreground">登录态</span>
        ——小红书、B站、抖音这些站，不登录就只能看到游客能看的东西。所以要在你的 Chrome
        里装一个小扩展。
      </p>

      {phase.kind === 'confirm' && (
        <div className="space-y-1.5 rounded-md bg-foreground/5 px-2.5 py-2 text-muted-foreground">
          <p>
            我会打开 Chrome 的扩展管理页，打开右上角的开发者模式开关，然后选中 Stream
            的扩展目录把它装上。这几步你会在屏幕上看到——期间屏幕顶部会有一条提示告诉你 AI
            正在操作，按 <span className="text-foreground">Ctrl+Alt+Esc</span> 随时能停。
          </p>
          {/* 这段必须在**装之前**说：一个昨天刚让 AI 装进浏览器的东西，今天浏览器自己弹窗
              说它可疑——用户会怀疑自己被装了什么。提前说了，它就只是个已知的小麻烦。 */}
          <p>
            装好之后 Chrome 每次启动会问你要不要停用
            <span className="text-foreground">开发者模式扩展</span>
            ，点「保留」就行——这是 Chrome 对所有非商店扩展的固定提醒，不是出了问题。
          </p>
          <div className="flex gap-2 pt-0.5">
            <ActionButton onClick={run}>确认</ActionButton>
            <ActionButton onClick={() => setPhase({ kind: 'idle' })}>再想想</ActionButton>
          </div>
        </div>
      )}

      {phase.kind === 'running' && (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          正在装……屏幕上能看到操作过程，按 Ctrl+Alt+Esc 可以随时停下。
        </p>
      )}

      {phase.kind === 'done' && <Outcome outcome={phase.outcome} onManual={manual} />}

      {phase.kind === 'failed' && (
        <p className="text-amber-500">
          代装没能跑起来：{phase.message}
          <span className="text-muted-foreground">（这一趟根本没开始，不是装到一半坏了。）</span>
        </p>
      )}

      {phase.kind === 'manual' && (
        <div className="space-y-1 text-muted-foreground">
          {phase.error ? (
            <p className="text-amber-500">拿不到扩展目录：{phase.error}</p>
          ) : phase.dir === undefined ? (
            <p>准备扩展目录……</p>
          ) : (
            <>
              <p>
                打开 <code className="text-foreground">chrome://extensions</code>
                ，右上角打开「开发者模式」，点「加载未打包的扩展程序」，选这个目录：
              </p>
              <p>
                <code className="break-all text-foreground">{phase.dir}</code>
              </p>
            </>
          )}
        </div>
      )}

      {(phase.kind === 'idle' || phase.kind === 'manual' || phase.kind === 'failed' || phase.kind === 'done') && (
        <div className="flex flex-wrap gap-2">
          <ActionButton onClick={() => setPhase({ kind: 'confirm' })}>帮我装</ActionButton>
          <ActionButton onClick={manual}>我自己来</ActionButton>
          {/* 现场那一档不给「以后再说」：他正要用这个能力，收起来只会让他卡在原地。 */}
          {variant === 'banner' && <ActionButton onClick={dismiss}>以后再说</ActionButton>}
        </div>
      )}
    </div>
  )
}

/** 三态回执各有各的下一步。**`needs-chrome-restart` 绝不能显示成「安装失败」**——
 *  它最常见的真因是 native messaging 清单在这次 Chrome 启动之后才登记（spec §3、§6.4）。 */
function Outcome({
  outcome,
  onManual,
}: {
  outcome: ExtensionInstallOutcome
  onManual: () => void
}) {
  if (outcome.status === 'connected') {
    return <p className="text-foreground">装好了，扩展已经连上 Stream。</p>
  }
  if (outcome.status === 'needs-chrome-restart') {
    return (
      <p className="text-muted-foreground">
        扩展装上了，但还没和 Stream 握上手。多半是 Chrome 需要
        <span className="text-foreground">重启一次</span>
        才能读到本机的通道配置——你自己重启一下 Chrome，然后回来看这里。
      </p>
    )
  }
  return (
    <div className="space-y-1">
      {/* reason 原样显示：它指名了是哪一步的哪个控件，收成一句"装不上"就是把线索扔掉。 */}
      <p className="text-amber-500">{outcome.reason}</p>
      <p className="text-muted-foreground">
        也可以
        <button type="button" onClick={onManual} className="mx-1 underline underline-offset-2">
          自己装
        </button>
        ——步骤和目录我给你。
      </p>
    </div>
  )
}

function ActionButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-[var(--acr-border-soft)] px-2.5 py-1 text-[12px] transition-colors hover:border-foreground/40"
    >
      {children}
    </button>
  )
}
