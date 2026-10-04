import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Badge } from './acrylic/badge.tsx'
import { Button } from './acrylic/button.tsx'
import { HoverCard, HoverCardContent, HoverCardTrigger } from './acrylic/hover-card.tsx'
import { Popover, PopoverContent, PopoverTrigger } from './acrylic/popover.tsx'
import { fmtBytes, fmtDur } from './reconcile-action-row.tsx'
import type { ExplainEdge, MatchFact, MatchVetoReason, RowExplain } from '../lib/types.ts'

/**
 * 一条建议的**证据卡**（spec `2026-08-02-match-engine-evidence-graph-design.md` §5）：
 * 回答"凭什么是这个判定"。数据全部来自后端的判决书（`RowExplain` = 裁决轨迹的切片），
 * **前端只排版**——不算相似度、不推结论、不补一句机器没说过的话。
 *
 * 这条铁律不是洁癖：上一次事故就是"文案与判据两张皮"——`no-duration-hit` 那句
 * "时长和名字都对不上节目单任何一集"在 05 案里是**假话**（时长恰恰命中了 005），
 * 而当时那条被否决的名字边根本没被记下来，所以没人能发现它在说谎。现在每一句话背后
 * 都是裁决真用过的那条边。
 *
 * 四段式（§5.2）：① 文件事实 ② 证据清单 ③ 裁决 ④ 如果…。**④ 本阶段不做**——
 * `RowExplain` 还没有 `counterfactual` 字段，而反事实必须由命中规则的模板生成
 * （§5.2：没有模板的规则不显示这一段）。前端自己编一句反事实正是文案铁律禁的两张皮。
 */

/**
 * 规则编号 → 短名。**镜像 `src/netdisk/match-engine/rules.ts` 的 `RULES`**（后端为真相源）。
 * 编号与拍板台账同号，用户可以拿着 `R4` 反查那一格是怎么定的。
 *
 * 后端加了规则、这里没跟上 → 界面只显示编号（`R14`），不编一个名字出来。
 */
export const RULE_NAMES: Record<string, string> = {
  R1: '人工订正预置',
  R2: '时长唯一命中免检',
  R3: '时长唯一命中 × 名字地板不过',
  R4: '时长桶零竞争出口',
  R5: '时长撞车 × 标题消歧',
  R6: '季集结构键',
  R7: '期号分段复合键',
  R8: '集号分桶 × 标题消歧',
  R9: '标题相似度兜底',
  R10: '电影唯一视频文件',
  R11: '横向时长矛盾闸',
  R12: '同集其余份收尾',
  R13: '双集冲突',
  R14: '名字命中 × 时长矛盾',
}

/**
 * 驳回理由 → 一句人话。**键是后端 `VetoReason` 闭集**，`Record<MatchVetoReason, string>` 这个
 * 类型本身就是守卫：后端加了新值、镜像类型同步过来的那一刻，这里缺一条就编译不过。
 *
 * 运行时还有第二道：查不到的码**原样显示**（`vetoText`），绝不退回一句含糊的"被驳回"。
 * 宁可露码，不许编话——露码只是难看，编话会把用户带去一个错误的结论。
 */
export const VETO_TEXT: Record<MatchVetoReason, string> = {
  'duration-contradict': '两边时长差出量级，不是同一段内容',
  'name-floor': '时长撞上了，但名字连地板都不沾——不足以认成这一集',
  'zero-competition-loser': '时长巧合撞进来的别的集文件，不是竞争者',
  'below-threshold': '相似度没到这条规则的门槛',
  'no-margin': '和次佳拉不开差距，谁都不敢认',
  'left-claimed': '该集已被别的文件认领，这条证据没被评估',
  'file-claimed': '这份文件已被别的集认领',
  'quality-dedup': '同集去重时被另一份吸收（清晰度/码率落选）',
  'no-adjudicable-fact': '只有字节孪生这类不可裁决的事实，本就不是候选',
  'unevaluated': '走完全部规则都没人评估它——规则覆盖有漏洞，不是正常终态',
}

/**
 * 缺映射 = 露原始码。**不许**回落成"被驳回（原因未知）"那种听着通顺、实则什么也没说的话。
 *
 * 参数按 `string` 取（不是 `MatchVetoReason`）：编译期那道守卫由 `VETO_TEXT` 的类型给，
 * 这一层守的是**运行时**——后端闭集加了值、前端还没同步镜像类型时，界面上出现的是那个原始码。
 */
export function vetoText(reason: string): string {
  return (VETO_TEXT as Record<string, string | undefined>)[reason] ?? reason
}

/** 处置去向的人话。四个值来自后端 `Trail['disposition']`。 */
const DISPOSITION_TEXT: Record<RowExplain['verdict']['disposition'], string> = {
  claimed: '认领（这一集的正主）',
  copy: '同集其余份',
  asked: '出卡（要你决定）',
  residual: '残差（没配上任何一集）',
}

const STRUCT_KEY_TEXT: Record<Extract<MatchFact, { kind: 'struct-key' }>['key'], string> = {
  'season-episode': '季集',
  'episode-part': '期号分段',
  epnum: '集号',
}

/** 门槛项的人话。后端今天只发 `sim` / `nameFloor` 两种；没见过的键**原样显示**（同露码原则）。 */
const THRESHOLD_TEXT: Record<string, string> = {
  sim: '相似度',
  nameFloor: '名字地板',
}

/** 分数按有效位显示：`0.571` 不补零成 `0.571000`，`1` 不写成 `1.000`。 */
function fmtNum(n: number): string {
  return String(Number(n.toFixed(3)))
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

/**
 * 一条事实 → 一行带**数字对照**的话。数字一律带单位与对照物（`5808s vs 2163s（差 3645s，容差 1s）`）
 * ——只报一个"差 3645s"读者没法判断它是大是小，而容差正是裁决用的那把尺。
 *
 * 两侧时长取自 `explain.file` 与 `edge.episode`（后端下发的原值）。任一侧缺席就只报差值，
 * 不去拿另一个数倒推——那就是前端自算。
 */
export function factText(f: MatchFact, fileDurationS?: number, episodeDurationS?: number): string {
  switch (f.kind) {
    case 'duration': {
      const delta = Math.round(Math.abs(f.deltaS))
      const tail = `（差 ${delta}s，容差 ${f.toleranceS}s）${f.state === 'hit' ? '✓命中' : '✗矛盾'}`
      // 两侧都有原值才摆对照。缺一侧时只报差值——**绝不拿另一个数倒推**，那就是前端自算。
      return fileDurationS != null && episodeDurationS != null
        ? `时长 ${Math.round(fileDurationS)}s vs ${Math.round(episodeDurationS)}s${tail}`
        : `时长${tail}`
    }
    case 'name':
      return f.method === 'identity-exact'
        ? '名字 清洗后全等（identity-exact）✓命中'
        : `名字 sim ${fmtNum(f.score)}`
    case 'struct-key':
      return `结构键 ${STRUCT_KEY_TEXT[f.key] ?? f.key}=${f.value}`
    case 'byte-identity':
      return `与 ${baseName(f.peerPath)} 字节全等`
  }
}

const OUTCOME_TEXT: Record<ExplainEdge['outcome'], string> = {
  won: '✓ 胜出',
  vetoed: '✗ 被驳回',
  informational: '仅供参考',
}
const OUTCOME_CLASS: Record<ExplainEdge['outcome'], string> = {
  won: 'text-[var(--acr-green)]',
  vetoed: 'text-destructive',
  informational: 'text-muted-foreground',
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-[10px] font-medium text-muted-foreground">{title}</h4>
      {children}
    </section>
  )
}

function EdgeBlock({ edge, fileDurationS }: { edge: ExplainEdge; fileDurationS?: number }) {
  return (
    <div className="flex flex-col gap-0.5" data-testid="evidence-edge" data-outcome={edge.outcome}>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
        <span className="min-w-0 break-words text-[11px] font-medium">↔《{edge.episode.title}》</span>
        {/* 付费/免费直接决定这一集有没有货架位（P9），摆出来才看得懂后面的处置。缺席就不渲染，不猜。 */}
        {edge.episode.paid != null && (
          <Badge variant="secondary" size="sm" className="shrink-0">{edge.episode.paid ? '付费' : '免费'}</Badge>
        )}
        <span className={`shrink-0 text-[10px] ${OUTCOME_CLASS[edge.outcome]}`}>{OUTCOME_TEXT[edge.outcome]}</span>
      </div>
      <ul className="flex flex-col gap-px pl-3">
        {edge.facts.map((f, i) => (
          <li key={i} className="tabular-nums text-[10px] text-muted-foreground">{factText(f, fileDurationS, edge.episode.durationS)}</li>
        ))}
      </ul>
      {/* I1：被否决的边**必带**理由，所以这一行只在 `vetoed` 时缺席才是异常。 */}
      {edge.vetoReason && (
        <p className="pl-3 text-[10px] text-muted-foreground">
          驳回理由：{vetoText(edge.vetoReason)}
          {edge.rule && <span className="text-muted-foreground/70">（{edge.rule}{RULE_NAMES[edge.rule] ? ` ${RULE_NAMES[edge.rule]}` : ''}）</span>}
        </p>
      )}
    </div>
  )
}

/**
 * 四段式的正文。**独立导出**：卡片长什么样与"怎么弹出来"是两件事，测试直接渲染这一份，
 * 不必绕过 hover/点击那层交互。
 */
export function EvidenceCard({ explain }: { explain: RowExplain }) {
  const { file, edges, verdict, truncatedCount } = explain
  // ① 文件事实：`explain.file` 直渲。缺的字段整格不出现（绝不 NaN / 空括号）——码率后端算好带来，
  //    这里**不拿 size/duration 再算一遍**：两个数分家就会各说各话。
  const facts = [
    file.durationS != null ? fmtDur(file.durationS) : null,
    fmtBytes(file.sizeBytes),
    file.kbps != null ? `${file.kbps}kbps` : null,
  ].filter((x): x is string => !!x)

  return (
    <div className="flex flex-col gap-2.5" data-testid="evidence-card">
      <Section title="文件事实">
        <p className="break-all font-mono text-[10px] text-muted-foreground">{file.path}</p>
        <p className="tabular-nums text-[11px]">{facts.join(' · ')}</p>
      </Section>

      <Section title="证据清单">
        {edges.length === 0
          ? <p className="text-[10px] text-muted-foreground">一条证据边都没有——节目单里没有任何一集与它沾边。</p>
          : (
            <div className="flex flex-col gap-1.5">
              {edges.map((e) => <EdgeBlock key={e.episode.leftKey} edge={e} fileDurationS={file.durationS} />)}
            </div>
          )}
        {/* 截掉的条数如实交代，不假装没有过（轨迹里那些边一条没少）。 */}
        {truncatedCount != null && truncatedCount > 0 && (
          <p className="text-[10px] text-muted-foreground/70">另有 {truncatedCount} 条弱证据边未列（轨迹里有）</p>
        )}
      </Section>

      <Section title="裁决">
        <p className="text-[11px]">
          {/* 规则编号 + 短名。**残差没有规则**——那时不许编一个编号出来，直说没人认领它。 */}
          {verdict.rule
            ? <span><span className="font-medium">{verdict.rule}</span>{RULE_NAMES[verdict.rule] ? ` ${RULE_NAMES[verdict.rule]}` : ''}</span>
            : <span>没有任何规则认领它</span>}
          {' → '}
          {DISPOSITION_TEXT[verdict.disposition] ?? verdict.disposition}
        </p>
        {verdict.thresholds && Object.keys(verdict.thresholds).length > 0 && (
          <ul className="flex flex-col gap-px">
            {Object.entries(verdict.thresholds).map(([key, { got, need }]) => (
              <li key={key} className="tabular-nums text-[10px] text-muted-foreground">
                {THRESHOLD_TEXT[key] ?? key} 命中 {fmtNum(got)} / 门槛 {fmtNum(need)}{' '}
                <span className={got >= need ? 'text-[var(--acr-green)]' : 'text-destructive'}>{got >= need ? '✓' : '✗'}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ④「如果…」：本阶段不做。`RowExplain` 还没有 `counterfactual` 字段，而反事实只能由命中
          规则的模板生成——前端自己编一句就是文案铁律禁的两张皮。字段到位后在这里补一段。 */}
    </div>
  )
}

/**
 * 有没有 hover 这回事。**判据是指针能力，不是屏幕宽度**：窄窗口的桌面浏览器照样有鼠标，
 * 而平板再宽也悬不出东西来。悬不了的那一档换成 Popover（点开、点外面关掉，Radix 自带）。
 */
function useHoverCapable(): boolean {
  const [hoverable, setHoverable] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)')
    setHoverable(mq.matches)
    const onChange = () => setHoverable(mq.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return hoverable
}

/**
 * 卡片本体的尺寸与材质。三件事，各有各的根因：
 *
 * **① 高度上限是「Radix 量出来的可用高度」，不是 `60vh`。** 弹层放不放得下由 Radix 的 `size`
 * middleware 现量：它把当前这一侧到视口边（减 `collisionPadding`）的空档写进
 * `--radix-popper-available-height`（**活体实测这个数一直是准的**，与触发器位置严丝合缝）。
 * 而 `60vh` 是一个和那个空档毫无关系的常数——两者一旦分家，卡片就画到屏幕外去：
 * 触发器在列表中部时上下空档都只有 ~400px，`60vh`=531px 两边都放不下，`flip` 只能挑
 * "溢出较少"的那一侧，于是 ~100px（含整段「裁决」）落在视口外。**这不是定位算错了**：
 * 面板带 `backdrop-filter` + `translate`，确实给 `position:fixed` 的后代造了包含块，但
 * floating-ui 认得这一类（`isContainingBlock` 收了 `backdropFilter`）并已扣掉面板原点——
 * 活体量到的 transform 与最终 rect 差值正好是面板原点，卡片就贴在触发器边上。**错的只有
 * 那个写死的高度**。超出部分卡片自己滚（`overflow-y-auto`），面板那层滚动条不受影响。
 *
 * **② `collisionPadding` 给避让留边**：紧贴视口边缘的弹层读起来像被切了一刀。
 *
 * **③ 背景要比面板更实一档（`--acr-panel-solid`）。** 弹层默认和 Dialog 面板同为
 * `--acr-panel` 玻璃：同材质叠同材质只把底下压暗四成，底层的行文字直接读得出来
 * （活体截图里"驳回理由"块压着下面那行按钮文案）。弹层是"读证据"的地方，底噪伤的是可读性。
 * 这一档不改共享组件——落在普通页面上的 popover 该是玻璃；只有**叠在另一片玻璃上**的这张要收实。
 */
const CARD_CLASS = 'scrollbar-mac max-h-[var(--radix-popper-available-height)] w-[22rem] overflow-y-auto bg-[var(--acr-panel-solid)] p-3'

/** 避让时离视口边留一口气（同时被 `flip`/`shift`/`size` 三个 middleware 共用）。 */
const COLLISION_PADDING = 12

/**
 * ⓘ 按钮 + 证据卡。**`explain` 缺席时由调用方决定不渲染**（本组件要求它必到）——
 * 老账本行、豁免/字节全等那两档的文件本来就没有轨迹，那时连图标都不该出现（无占位）。
 *
 * **弹层要 portal 进 Dialog 的内容节点**：整理面板是 modal Dialog，Radix 会把 `body` 设成
 * `pointer-events: none`，落在 body 上的弹层看得见却动不了（卡片是要滚的）。判据用
 * `[role="dialog"]`——那是 Radix Dialog Content 的稳定契约。不在 Dialog 里（找不到）就走
 * 默认的 body，**必须传 `undefined` 而不是 `null`**：Radix 的 `container` 只有 `undefined`
 * 才会回落到 `document.body`，显式 `null` 会让弹层渲染到无处。
 */
export function EvidenceButton({ explain }: { explain: RowExplain }) {
  const hoverable = useHoverCapable()
  const [open, setOpen] = useState(false)
  const [container, setContainer] = useState<HTMLElement | undefined>(undefined)
  const ref = useRef<HTMLButtonElement>(null)

  const onOpenChange = (next: boolean) => {
    if (next) setContainer((ref.current?.closest('[role="dialog"]') as HTMLElement | null) ?? undefined)
    setOpen(next)
  }

  const trigger = (
    <Button ref={ref} icon size="medium" variant="ghost" aria-label="这条判定的证据">
      <Info />
    </Button>
  )
  const body = (
    <div className="text-foreground">
      <EvidenceCard explain={explain} />
    </div>
  )

  if (hoverable) {
    return (
      <HoverCard open={open} onOpenChange={onOpenChange} openDelay={120} closeDelay={80}>
        <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
        <HoverCardContent container={container} align="end" collisionPadding={COLLISION_PADDING} className={CARD_CLASS}>{body}</HoverCardContent>
      </HoverCard>
    )
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent container={container} align="end" collisionPadding={COLLISION_PADDING} className={CARD_CLASS}>{body}</PopoverContent>
    </Popover>
  )
}
