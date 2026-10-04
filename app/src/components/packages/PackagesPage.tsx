import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BoxIcon,
  ChevronDownIcon,
  DownloadIcon,
  KeyRoundIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ScrollTextIcon,
  Settings2Icon,
  TrashIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { api, ApiError, LOCAL, type Connection } from '../../lib/api.ts'
import type { PackageSummary, PendingChange, ProviderView, RecipePackageUpdate } from '../../lib/types.ts'
import { CATEGORY_LABEL } from '../providers/labels.ts'
import { Button } from '../acrylic/button.tsx'
import { Badge } from '../acrylic/badge.tsx'
import { Card } from '../acrylic/card.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../acrylic/dropdown-menu.tsx'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMeta } from '../acrylic/item.tsx'
import { Searchbar } from '../acrylic/searchbar.tsx'
import { ShellContent, ShellNavbar, ShellNavbarActions, ShellPanel } from '../acrylic/shell.tsx'
import { Switch } from '../ui/switch.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty.tsx'
import { toast } from '../acrylic/sonner.tsx'
import { OnboardWishlist } from '../OnboardWishlist.tsx'
import { InstallConfirmDialog } from '../recipes/InstallConfirmDialog.tsx'
import { PluginConfigSheet } from '../source/PluginConfigSheet.tsx'
import { AddPackageSheet } from './AddPackageSheet.tsx'
import { BundleShareDialog } from '../BundleShareDialog.tsx'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '../acrylic/dialog.tsx'
import { LogsSheet } from './LogsSheet.tsx'
import { PendingRestartBanner } from './PendingRestartBanner.tsx'
import { useRecipePackageOps } from './useRecipePackageOps.ts'

/** 重启后轮 `/api/health` 的节奏与上限。60s 是给 reexec 档留的：它要整个进程重新起、把包目录再扫一遍。 */
const RESTART_POLL_MS = 2_000
const RESTART_WAIT_MS = 60_000

/**
 * 「包」页 —— 这台机器上有什么、还活着吗、再装一个。
 *
 * 与「源」页的接缝是**使用 vs 拥有**：那一页是"找一个源配成流"（天天用），这一页是运维
 * 与安装（偶尔用）。启用开关、容器状态、装卸升级，只在这里有一份实现。
 *
 * ## 三段：先按「坏了会怎样」，再按「谁装的」——都不按能力槽位
 *
 *  1. **容器**（`hosted` = `backend || credentials`）—— 会崩、会占内存、会掉登录态。
 *  2. **内置能力** —— **只放随 Stream 出货的那些**：提供源清单 / 代码 / normalizer，跟着
 *     Stream 一起跑，没有单独会崩的活件，也卸不掉（它跟着仓库走）。
 *  3. **抓取配方** —— 用户自己装进来的一切（`<dataDir>/recipes/`），外加内置层里那些纯
 *     `*.recipe.json` 的包。这一段的行**带卸载/更新菜单**。
 *
 * 后两段上一版是合成一段的。拆开的理由是它们**动作不同**：内置能力只能"去源页看看"，
 * 配方能更新 / 卸载。而且 `builtin`（22 个源）和 `zhipu`（一条 JSON）摆在同一段里没有一点像。
 *
 * **第 2、3 段之间的判据是「层」不是「槽位」**：槽位判据会把一个用户装的能力包（无 recipe、
 * 无源清单）判进内置段——既在骗人说"它跟着 Stream 一起发布"，又让它没有卸载入口。
 *
 * ## 容器段：异常才占版面
 *
 * 卡片是很贵的排版，6 张 ≈ 两行 ≈ 220px；涨到 15 个就是近 600px，把下面两段整个压到折叠线
 * 以下——而**全绿的时候那几张卡片一个字都没在说**。所以：出错的每个单独浮出来（常驻），
 * 其余收成一行摘要，展开才是卡片。代价是「停用某个容器」多一次点击，那是一年做两次的动作。
 *
 * ## 卡片上不放的东西
 *
 * 包 id、槽位 chip（这一段按定义就是有容器的，`容器`/`代码`/`清单` 全是废话）、页脚图例。
 * **唯一留下的 chip 是凭证域**——登录态掉了会静默降级成游客态、不报错，它是这张卡上唯一
 * "不说用户就不知道"的东西。
 */

/** 这个包摆在哪一段。**具名判据**：内联的 `if` 搜不到、也钉不住测试。 */
export type PackageBand = 'container' | 'builtin' | 'recipe'

export function bandOf(p: PackageSummary): PackageBand {
  // 读不动的包（后端连它的描述都解析不出来）摆进配方段：它一定是用户自己装进来的，而这一段
  // 正是"用户装的东西"那一段。摆进内置能力段会更糟——那段的言下之意是"跟着 Stream 一起发布"。
  if (p.unreadable) return 'recipe'
  if (p.hosted) return 'container'
  // **用户层的包一律进可卸载那一段，不看它填了什么槽位。**「内置能力」段的言下之意是
  // "跟着 Stream 一起发布"——把用户自己 `stream add` 装进来的东西摆进去，既在骗人，又让它
  // 没有卸载入口（那一段的行按定义就没有菜单）。分段判据因此是**层**不是槽位：一个能力包
  // （无 recipe、无源清单）此前正好掉进这个缝里，显示成内置且卸不掉。
  if (p.layer === 'user') return 'recipe'
  // 内置层里再分：「只有 recipe 数据」才算配方包。带了源清单或代码的（rsshub / builtin /
  // browser / replay）是平台自己的采集能力，动作完全不同——它们不能卸载，也没有 npm 版本。
  return p.slots.recipes && !p.slots.sources && !p.slots.code ? 'recipe' : 'builtin'
}

const DOT: Record<NonNullable<PackageSummary['runtime']>['state'], string> = {
  running: 'bg-green-500',
  idle: 'bg-orange-500',
  error: 'bg-red-500',
  unknown: 'bg-muted-foreground/60',
}
const STATE_KEY = {
  running: 'packages.stateRunning',
  idle: 'packages.stateIdle',
  error: 'packages.stateError',
  unknown: 'packages.stateUnknown',
} as const

/** 一个包的搜索 haystack。30 个包里找一个具体的靠搜索，分段只是让眼睛有落点，
 *  所以匹配面要宽：id / 显示名 / 描述 / npm 包名 / recipe 名 / 镜像名。 */
function haystack(p: PackageSummary): string {
  return [
    p.id, p.name, p.description ?? '', p.pkgName ?? '',
    ...(p.slots.recipeNames ?? []),
    p.slots.backend ? '容器 container' : '',
    ...(p.slots.credentials ?? []).map((d) => `凭证 credential ${d}`),
    // 工具名要能搜到：用户记得的往往是那个动词（"我装的哪个包给了 netdisk_save"），
    // 而不是包名——包名是 npm 上的东西，工具名才是他在对话里天天见的。
    p.slots.capability ? '能力 capability' : '',
    ...(p.slots.tools ?? []),
    p.runtime?.image ?? '',
  ].join(' ').toLowerCase()
}

/**
 * 「这个包在后端进程里跑代码，并给了对话这几个动词」——能力槽位的那一格。
 *
 * 和凭证域 chip 同一条理由：它是**不说用户就不知道**的东西。一个能力包在这一页上原本和一份
 * 纯数据的 recipe 包长得一模一样，而它的权限完全不同（后端进程内、完整权限、能取登录态）。
 *
 * **有工具名就列工具名**：那才是用户在对话里天天见的东西，比一句"它有能力"具体得多。
 * 列不出来时（装载没成、或包没注册工具）退回不带名字的那句——空数组和"没有这一格"是
 * 两句不同的话，凑一个空名单等于撒谎。
 */
function CapabilityChips({ slots }: { slots: PackageSummary['slots'] }) {
  const { t } = useTranslation()
  if (!slots.capability) return null
  const tools = slots.tools ?? []
  return (
    <div className="flex flex-wrap gap-1">
      {tools.length > 0 ? (
        tools.map((name) => (
          <Badge key={name} variant="secondary" size="sm" className="bg-violet-500/14 font-mono text-violet-600 dark:text-violet-400">
            {name}
          </Badge>
        ))
      ) : (
        <Badge variant="secondary" size="sm" className="bg-violet-500/14 text-violet-600 dark:text-violet-400">
          {t('packages.slotCapability')}
        </Badge>
      )}
    </div>
  )
}

// ── 容器段 ───────────────────────────────────────────────────────────────

/** 一张卡 = 一个宿主在替它跑的容器。四样：名字、一句话、状态、开关。
 *
 * **用户自己装的那些也会落在这一段**：`bandOf` 里 `hosted` 排在 `layer === 'user'` 前面
 * （容器起来了就该在容器段里看得见它的状态），所以一个带 `stream.backend` 的第三方包摆在这里。
 * 于是这张卡也必须给得出卸载入口——否则用户 `stream add` 装进来的东西**只能装不能卸**，
 * 而配方段那些同样是他装的、卸得掉。同一件事两个答案，取决于它碰巧有没有容器。 */
function ContainerCard({
  pkg, onToggle, onConfig, anyPending, onUninstall,
}: {
  pkg: PackageSummary
  onToggle: (id: string, next: boolean) => void
  onConfig?: () => void
  anyPending: boolean
  onUninstall: () => void
}) {
  const { t } = useTranslation()
  const rt = pkg.runtime
  // 判据与配方段那一行逐字相同（`RecipeRow` 的 `canUninstall`）：内置包卸不掉，没有 npm 名
  // 的也卸不掉——给它一个点了会 404 的菜单比不给更坏。
  const canUninstall = pkg.layer === 'user' && !!pkg.pkgName
  return (
    <Card data-testid={`package-card-${pkg.id}`} className="flex flex-col gap-2.5 p-3.5">
      <div className="flex items-start gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-[var(--acr-card-nested)]">
          {pkg.slots.backend ? <BoxIcon className="size-4" /> : <KeyRoundIcon className="size-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold leading-snug">{pkg.name}</div>
        </div>
        {pkg.enabled !== undefined ? (
          <Switch checked={pkg.enabled} aria-label={pkg.name} onCheckedChange={(next) => onToggle(pkg.id, next)} />
        ) : null}
        {canUninstall ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button icon variant="ghost" size="mini" aria-label={t('packages.rowMenu', { name: pkg.name })}>
                <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive" disabled={anyPending} onSelect={onUninstall}>
                  <TrashIcon />{t('packages.uninstall')}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {pkg.description ? <p className="text-[11.5px] leading-relaxed text-muted-foreground">{pkg.description}</p> : null}

      {rt ? (
        <div className="flex items-center gap-2 rounded-[8px] bg-[var(--acr-card-nested)] px-2.5 py-1.5 text-[12px]">
          <span className={`size-[7px] shrink-0 rounded-full ${DOT[rt.state]}`} aria-hidden />
          <span>{t(STATE_KEY[rt.state])}</span>
          <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground/70">{rt.image}</span>
        </div>
      ) : null}

      {/* 凭证域是这张卡上唯一"不说用户就不知道"的东西：它掉了会静默降级成游客态、不报错。 */}
      {pkg.slots.credentials?.length ? (
        <div className="flex flex-wrap gap-1">
          {pkg.slots.credentials.map((d) => (
            <Badge key={d} variant="secondary" size="sm" className="bg-orange-500/14 text-orange-600 dark:text-orange-400">
              {t('packages.slotCredential', { domain: d })}
            </Badge>
          ))}
        </div>
      ) : null}

      <CapabilityChips slots={pkg.slots} />

      {onConfig ? (
        <Button variant="link" size="mini" className="self-start px-0" onClick={onConfig}>
          <Settings2Icon />{t('packages.netdiskSettings')}
        </Button>
      ) : null}
    </Card>
  )
}

/**
 * 出错的那一个（或几个）：常驻、不参与折叠、带上几个自助动作。
 *
 * **卸载也在这里**，判据与 `ContainerCard` 逐字相同（`layer === 'user' && !!pkgName`）：
 * 一个用户自己装的包**恰恰是坏掉之后最该卸得掉**，而这一行是它此刻唯一的落点——容器一红它
 * 就从折叠段挪到这儿来了。少这个入口的表现是「装得进、卸不掉」，且用户只在出问题时才撞上。
 */
function BrokenRow({
  pkg, onLogs, onRestart, restarting, anyPending, onUninstall,
}: {
  pkg: PackageSummary
  onLogs: () => void
  onRestart: () => void
  restarting: boolean
  anyPending: boolean
  onUninstall: () => void
}) {
  const { t } = useTranslation()
  const canUninstall = pkg.layer === 'user' && !!pkg.pkgName
  return (
    <div
      data-testid={`package-broken-${pkg.id}`}
      className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-[12.5px]"
    >
      <span className="size-[7px] shrink-0 rounded-full bg-red-500" aria-hidden />
      <span className="font-semibold">{pkg.name}</span>
      {/* 说不出原因是**有意的**：/api/packages 不带错误文本（PluginStatus 根本没有那个字段，
          硬凑一个就得新起一套探活）。理由在「看日志」那一次点击之外。 */}
      <span className="text-muted-foreground">{t('packages.brokenWhy')}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button variant="neutral" size="mini" onClick={onLogs}><ScrollTextIcon />{t('packages.viewLogs')}</Button>
        <Button variant="neutral" size="mini" disabled={restarting} onClick={onRestart}>
          <RotateCwIcon />{restarting ? t('packages.restarting') : t('packages.restart')}
        </Button>
        {canUninstall ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button icon variant="ghost" size="mini" aria-label={t('packages.rowMenu', { name: pkg.name })}>
                <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive" disabled={anyPending} onSelect={onUninstall}>
                  <TrashIcon />{t('packages.uninstall')}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </span>
    </div>
  )
}

// ── 行（下面两段） ────────────────────────────────────────────────────────

function BuiltinRow({ pkg, onOpenSources }: { pkg: PackageSummary; onOpenSources: ((pkgId: string) => void) | null }) {
  const { t } = useTranslation()
  return (
    <Item variant="muted" size="xs" data-testid={`package-row-${pkg.id}`}>
      <ItemContent className="flex min-w-0 items-center gap-2.5">
        <span className="w-[110px] shrink-0 truncate text-[12.5px] font-medium">{pkg.name}</span>
        {pkg.description ? <ItemDescription className="min-w-0 flex-1 truncate">{pkg.description}</ItemDescription> : <span className="flex-1" />}
        <CapabilityChips slots={pkg.slots} />
        {pkg.slots.sources ? (
          <span className="shrink-0 text-[11.5px] text-muted-foreground">{t('packages.slotSources', { count: pkg.slots.sources })}</span>
        ) : null}
      </ItemContent>
      <ItemMeta>
        {/* 只有真有源可看的包才给这个跳转。配方包在源页没有条目，跳过去只会落在空列表上。
            宿主明说"没有源页"（`null`）时也不画：一个点了没反应的链接比没有它更糟。 */}
        {pkg.slots.sources && onOpenSources !== null ? (
          <Button variant="link" size="mini" className="px-0" onClick={() => onOpenSources(pkg.id)}>
            {t('packages.openInSources')}
          </Button>
        ) : null}
      </ItemMeta>
    </Item>
  )
}

function RecipeRow({
  pkg, update, busy, anyPending, onUpdate, onUninstall,
}: {
  pkg: PackageSummary
  update?: RecipePackageUpdate
  busy: boolean
  anyPending: boolean
  onUpdate: () => void
  onUninstall: () => void
}) {
  const { t } = useTranslation()
  // 内置包卸不掉（它跟着仓库走），也没有 npm 版本可更新——给它一个点了会 404 的菜单
  // 比不给更坏。所以菜单只在真有动作时才渲染。
  const canUninstall = pkg.layer === 'user' && !!pkg.pkgName
  const hasActions = canUninstall || !!update
  return (
    <Item variant="muted" size="xs" data-testid={`package-row-${pkg.id}`}>
      <ItemContent className="flex min-w-0 items-center gap-2.5">
        <span className="w-[110px] shrink-0 truncate text-[12.5px] font-medium">{pkg.name}</span>
        {/* 读不动的包：这一行的正文就是"为什么读不动"。不标出来的话它看起来只是一个 0 条配方的
            包，用户会以为装坏了的是自己那份 recipe，而真正的原因在 package.json 里。 */}
        {pkg.unreadable ? (
          <Badge variant="secondary" size="sm" className="shrink-0 bg-red-500/14 text-red-600 dark:text-red-400">
            {t('packages.unreadable')}
          </Badge>
        ) : null}
        <ItemDescription className="min-w-0 flex-1 truncate">
          {pkg.unreadable ?? pkg.slots.recipeNames?.join(' · ') ?? pkg.description ?? ''}
        </ItemDescription>
        <CapabilityChips slots={pkg.slots} />
        {pkg.unreadable ? null : (
          <span className="shrink-0 text-[11.5px] text-muted-foreground">
            {t('packages.slotRecipes', { count: pkg.slots.recipes ?? 0 })}
          </span>
        )}
      </ItemContent>
      <ItemMeta className="flex items-center gap-1.5">
        <span className={update ? 'font-medium text-primary' : 'font-mono text-[10.5px] text-muted-foreground'}>
          {update ? t('packages.hasUpdateTo', { version: update.latest }) : pkg.layer === 'builtin' ? t('packages.builtinVersion') : pkg.version ?? ''}
        </span>
        {hasActions ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button icon variant="ghost" size="mini" aria-label={t('packages.rowMenu', { name: pkg.name })} disabled={busy}>
                <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                {update ? (
                  // anyPending：preview 是全页单例（硬闸在 useRecipePackageOps），A 行在飞时
                  // B 行的「更新」不能看着能点——点了会被那道闸静默吞掉。
                  <DropdownMenuItem disabled={anyPending} onSelect={onUpdate}>
                    <RefreshCwIcon />{t('packages.updateTo', { version: update.latest })}
                  </DropdownMenuItem>
                ) : null}
                {canUninstall ? (
                  <DropdownMenuItem variant="destructive" disabled={anyPending} onSelect={onUninstall}>
                    <TrashIcon />{t('packages.uninstall')}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </ItemMeta>
    </Item>
  )
}

// ── Provider 段（组件页把能力行同列，spec 2026-08-17-component-page） ──────────

/** 一行 = 一条 Provider 行，**只读**：有什么、什么类别、几个成员、活没活。
 *
 *  **不可点**——编辑面（成员/路由/测配）整个下线了，点进去没有落点。别给它加回 `onClick`：
 *  一个点了什么都不发生的行，和坏了长得一模一样。加成员那条日常动作有自己的入口（添加来源
 *  时选目的地 = 组件）；其余（建/删/exclude/strategy/绑定）今天只在 `/api/providers` 上。 */
function ProviderRow({ provider }: { provider: ProviderView }) {
  const { t } = useTranslation()
  // 「有几个成员」不等于「有几个能干活」：一条没配 key 的腿在列表里和配好的长得一模一样。
  //
  // 这不是锦上添花——它是后端那条改动的**另一半**。转写那一行以前按「此刻有哪些 key」筛成员，
  // 理由正是"怕这里骗人"；代价却是整批能力的存在与否被绑在启动那一刻（配上 key 要重启才生效，
  // 见 src/providers/seed.ts 的 ensureTranscribeRow 头注）。行改成无条件写满之后，诚实就得由
  // 这里负责：缺 key 的档必须看得见。keyState 后端本来就逐个成员算好了（members[].keyState），
  // 这里只投影，不另判。
  const missingKeys = provider.resolvedMembers.filter((m) => m.keyState === 'missing').length
  return (
    <Item variant="muted" size="xs" data-testid={`provider-row-${provider.id}`}>
      <ItemContent className="flex min-w-0 items-center gap-2.5">
        <span className="w-[110px] shrink-0 truncate text-[12.5px] font-medium">{provider.label || provider.id}</span>
        {provider.category ? (
          <Badge variant="secondary" size="sm">{CATEGORY_LABEL[provider.category]}</Badge>
        ) : null}
        {provider.parked ? (
          <Badge variant="outline" size="sm">{t('packages.providerParked')}</Badge>
        ) : null}
        {provider.description ? (
          <ItemDescription className="min-w-0 flex-1 truncate">{provider.description}</ItemDescription>
        ) : (
          <span className="flex-1" />
        )}
        <span className="shrink-0 text-[11.5px] text-muted-foreground">
          {t('packages.providerMembers', { count: provider.members.length })}
        </span>
        {missingKeys ? (
          <Badge variant="outline" size="sm" data-testid={`provider-missing-keys-${provider.id}`}>
            {t('packages.providerMissingKeys', { count: missingKeys })}
          </Badge>
        ) : null}
      </ItemContent>
    </Item>
  )
}

function Band({ title, why, count, children }: { title: string; why: string; count: number; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-2 px-0.5">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        <Badge variant="secondary" size="sm" data-testid="band-count">{count}</Badge>
        <p className="basis-full text-[11.5px] text-muted-foreground">{why}</p>
      </div>
      {children}
    </section>
  )
}

// ── 页 ───────────────────────────────────────────────────────────────────

export function PackagesPage({ apiBase = '', onOpenSources }: {
  apiBase?: string
  /** 「在源页里打开这个包」。不传 = 这个宿主里没有源页，那几个链接就不画——源浏览器现在
   *  住在频道配置页的「添加来源」里，那儿才有"加到哪个频道"这个上下文。 */
  onOpenSources?: (pkgId: string) => void
}) {
  const { t } = useTranslation()
  const openSources = onOpenSources ?? null
  const conn: Connection = apiBase ? { baseUrl: apiBase } : LOCAL

  const [packages, setPackages] = useState<PackageSummary[]>([])
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [updates, setUpdates] = useState<RecipePackageUpdate[]>([])
  const [pending, setPending] = useState<PendingChange[]>([])
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 跨页跳来的 `?q=`（源页问「这是什么包」）。只读一次初值——之后由用户的输入接管，
  // 每次渲染都回读 URL 会让人一个字都删不掉。
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '')

  const [addOpen, setAddOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [logsFor, setLogsFor] = useState<PackageSummary | null>(null)
  const [configFor, setConfigFor] = useState<PackageSummary | null>(null)
  const [restarting, setRestarting] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setPackages(await api.packages(conn))
      setUnavailable(false)
      try {
        setUpdates(await api.recipePackageUpdates(conn))
      } catch {
        // 查更新要打 npm registry。registry 抖动 / 单包下架**不该让这一页打不开**——
        // 「有新版」是锦上添花，「我装了什么」不是。
        setUpdates([])
      }
      try {
        setProviders(await api.providers(conn))
      } catch {
        // Provider 段同理：包清单是这一页的主体，能力行列不出来就整段不渲染，不掀翻页面。
        setProviders([])
      }
      try {
        setPending(await api.packagesPending(conn))
      } catch {
        // 老后端没这个口（404）→ 没有横幅，页照开。
        setPending([])
      }
    } catch (err) {
      // 503 不是「出错了」，是「这台后端没开这个功能」。
      if (err instanceof ApiError && err.status === 503) setUnavailable(true)
      else setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [apiBase])

  // ── 重启后端 → 等它回来 ────────────────────────────────────────────────
  // 判据是 `/api/health.started_at` **变了**，不是「能连上」：202 之后旧进程还要走一段优雅关，
  // 这期间 health 照样 200——只看连通会在旧进程身上误判成"回来了"。基线在发 restart **之前**取。
  const restartBaseline = useRef<string | null>(null)
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 每轮重启结束（回来了 / 超时）换一次 key，让横幅从「重启中…」重置回可点状态。
  const [restartRound, setRestartRound] = useState(0)
  useEffect(() => () => { if (restartTimer.current) clearTimeout(restartTimer.current) }, [])

  const restartBackend = async (force: boolean) => {
    restartBaseline.current = (await api.health(conn).catch(() => null))?.started_at ?? null
    return api.restartBackend(conn, force)
  }
  const onRestarted = () => {
    const baseline = restartBaseline.current
    const finish = () => { setRestartRound((r) => r + 1); void load() }
    // 基线没取到（restart 之前那次 health 失败）就没法判「变了」：轮下去只能在旧进程身上误判或干等到
    // 超时报一句吓人的红字。重启本身已经发出去了（202），如实说一句、让人自己刷新。
    if (baseline === null) { toast.info(t('packages.pendingRestart.noBaseline')); finish(); return }
    const deadline = Date.now() + RESTART_WAIT_MS
    const tick = async () => {
      restartTimer.current = null
      const h = await api.health(conn).catch(() => null)
      if (h?.started_at && h.started_at !== baseline) return finish()
      if (Date.now() >= deadline) { toast.error(t('packages.pendingRestart.timeout')); return finish() }
      restartTimer.current = setTimeout(() => { void tick() }, RESTART_POLL_MS)
    }
    restartTimer.current = setTimeout(() => { void tick() }, RESTART_POLL_MS)
  }

  const ops = useRecipePackageOps(conn, load)

  const toggle = async (id: string, next: boolean) => {
    // 乐观翻，失败翻回来并报后端原话（required 插件会 409，那句话是唯一有用的信息）。
    setPackages((prev) => prev.map((p) => (p.id === id ? { ...p, enabled: next } : p)))
    try {
      await api.setPluginEnabled(conn, id, next)
    } catch (err) {
      setPackages((prev) => prev.map((p) => (p.id === id ? { ...p, enabled: !next } : p)))
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const restart = async (pkg: PackageSummary) => {
    setRestarting(pkg.id)
    try {
      const r = await api.restartPackage(conn, pkg.id)
      // 成功返回也可能是 state:'error' —— 那表示我们试过了、容器没起来。只看有没有抛错
      // 会把一次失败的重启报成成功。
      if (r.state === 'error') toast.error(t('packages.restartFailed', { name: pkg.name, message: r.error ?? '' }))
      else toast.success(t('packages.restartOk', { name: pkg.name }))
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRestarting(null)
    }
  }

  const updateByPkgName = useMemo(() => new Map(updates.map((u) => [u.name, u])), [updates])

  const { broken, healthy, builtin, recipes } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const shown = q ? packages.filter((p) => haystack(p).includes(q)) : packages
    const container = shown.filter((p) => bandOf(p) === 'container')
    return {
      broken: container.filter((p) => p.runtime?.state === 'error'),
      healthy: container.filter((p) => p.runtime?.state !== 'error'),
      builtin: shown.filter((p) => bandOf(p) === 'builtin'),
      recipes: shown.filter((p) => bandOf(p) === 'recipe'),
    }
  }, [packages, query])

  // Provider 段跟包共用同一个搜索框（这一页只有一个"找东西"的动作）。
  const shownProviders = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return providers
    return providers.filter((p) =>
      [p.id, p.label, p.description ?? '', p.category ? CATEGORY_LABEL[p.category] : '']
        .join(' ').toLowerCase().includes(q)
    )
  }, [providers, query])

  if (unavailable) {
    return (
      <ShellPanel variant="detail" data-nested-surface="true">
        <ShellContent padding="flush" className="scrollbar-mac px-4 py-4">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t('packages.unavailableTitle')}</EmptyTitle>
              <EmptyDescription>{t('packages.unavailableBody')}</EmptyDescription>
            </EmptyHeader>
            <Button variant="neutral" size="small" disabled={loading} onClick={() => void load()}>
              <RefreshCwIcon />{t('packages.checkUpdates')}
            </Button>
          </Empty>
        </ShellContent>
      </ShellPanel>
    )
  }

  const updateCount = packages.filter((p) => p.pkgName && updateByPkgName.has(p.pkgName)).length
  const nothingShown = !loading && !broken.length && !healthy.length && !builtin.length && !recipes.length

  return (
    <ShellPanel variant="detail" data-nested-surface="true">
      {/* 这条 49px 顶栏里只剩**过滤 + 动作**：左边搜索，右边检查更新、导入、添加。主筛选常驻、不随正文滚走
          ——这一页正文有三十几行，把过滤框留在正文里意味着往下翻两屏就找不到它了。
          **身份和计数都不在这里**：这一页只在 DSH 设置的「Stream」分区里出现，分区在设置侧栏
          里已经自报家门；「35 个已装 · 5 个有容器」这类总数没有对应的动作，正文每一段的标题
          各自带着自己那格的数，顶栏再报一遍只是噪音。 */}
      {/* 顶栏不画下边框（`border-b-0`）：正文每一段自己带卡片边界，再来一条横贯全宽的分隔线
          只是把一页切成两块，没有任何东西靠它区分。 */}
      <ShellNavbar className="h-[49px] gap-2 border-b-0 px-4">
        {/* 搜索靠左：它是这一页的**过滤器**，作用于下方整份列表，所以贴着列表的起始边；
            右边那一组才是动作。挤在右侧和按钮排成一排时，它看起来像第四个按钮。 */}
        <Searchbar
          size="large"
          // 字号比 large 档小一号（15px → 13px），控件几何不动：顶栏里它只是个过滤框，
          // 15px 的字比旁边的按钮还响。
          className="w-56 min-w-[7rem] shrink text-[13px]"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
          placeholder={t('packages.searchPlaceholder')}
          aria-label={t('packages.searchPlaceholder')}
        />
        {updateCount ? (
          <Badge variant="secondary" size="sm" className="shrink-0">{t('packages.updatesLine', { count: updateCount })}</Badge>
        ) : null}
        <ShellNavbarActions className="gap-2">
          <Button variant="ghost" size="small" disabled={loading} onClick={() => void load()}>
            <RefreshCwIcon />{t('packages.checkUpdates')}
          </Button>
          {/* 导入别人的分享包。**落点在这一页而不是侧栏**：导入的那一刻频道还不存在，没有
              任何一张频道配置面能承载它；而它做的事——把别人的一份编排装进来——和这一页的
              「装包」是同一类动作。导出在频道自己的配置面上（那儿才知道是哪一个频道）。 */}
          <Button variant="ghost" size="small" onClick={() => setImportOpen(true)}>
            <DownloadIcon />导入分享包
          </Button>
          <Button variant="default" size="small" onClick={() => setAddOpen(true)}>
            <PlusIcon />{t('packages.add')}
          </Button>
        </ShellNavbarActions>
      </ShellNavbar>

      <ShellContent padding="flush" className="scrollbar-mac flex flex-col gap-5 px-4 py-4">
        {error ? <p className="text-[12px] text-destructive">{t('packages.loadFailed', { message: error })}</p> : null}

        {/* 「装了但还没生效」放在正文最上面而不是顶栏：它是一条要人动手的事，不是一个计数徽章；
            而且它有正文（哪几项、为什么）——顶栏那格宽度装不下。 */}
        <PendingRestartBanner key={restartRound} pending={pending} restart={restartBackend} onRestarted={onRestarted} />

        {/* 容器段：出错的常驻在最上面，其余收起来。没有标题栏——那一行摘要本身就是标题。 */}
        {broken.length || healthy.length ? (
          <section aria-label={t('packages.containerBand')} className="flex flex-col gap-2">
            {broken.map((p) => (
              <BrokenRow
                key={p.id}
                pkg={p}
                restarting={restarting === p.id}
                onLogs={() => setLogsFor(p)}
                onRestart={() => void restart(p)}
                anyPending={ops.pendingName !== null}
                onUninstall={() => { if (p.pkgName) ops.uninstall(p.pkgName) }}
              />
            ))}
            {healthy.length ? (
              // 原生 <details>：可聚焦、可键盘操作、零 JS。自己搓一个折叠器就得自己补 a11y。
              <details className="rounded-[10px] border border-[var(--acr-border-soft)] bg-[var(--acr-card-nested)]/40">
                <summary
                  data-testid="container-fold"
                  className="flex cursor-pointer list-none items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-[12.5px] outline-none hover:bg-[var(--acr-hover)] focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden"
                >
                  <span className="flex shrink-0 gap-1" aria-hidden>
                    {healthy.map((p) => (
                      <span key={p.id} className={`size-[6px] rounded-full ${DOT[p.runtime?.state ?? 'unknown']}`} />
                    ))}
                  </span>
                  <span>{t('packages.containerSummary', { count: healthy.length })}</span>
                  <ChevronDownIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform [details[open]_&]:rotate-180" />
                </summary>
                <div className="grid gap-2.5 px-2.5 pb-2.5 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                  {healthy.map((p) => (
                    <ContainerCard
                      key={p.id}
                      pkg={p}
                      onToggle={(id, next) => void toggle(id, next)}
                      anyPending={ops.pendingName !== null}
                      onUninstall={() => { if (p.pkgName) ops.uninstall(p.pkgName) }}
                      // 网盘底座的挂载点与绑定汇总只住在它的配置面板里。按后端标的 role 判，不认包 id。
                      onConfig={p.role === 'netdisk-base' ? () => setConfigFor(p) : undefined}
                    />
                  ))}
                </div>
              </details>
            ) : null}
          </section>
        ) : null}

        <Band title={t('packages.builtinBand')} why={t('packages.builtinWhy')} count={builtin.length}>
          <ItemGroup className="gap-1">
            {builtin.map((p) => <BuiltinRow key={p.id} pkg={p} onOpenSources={openSources} />)}
          </ItemGroup>
        </Band>

        <Band title={t('packages.recipeBand')} why={t('packages.recipeWhy')} count={recipes.length}>
          <ItemGroup className="gap-1">
            {recipes.map((p) => (
              <RecipeRow
                key={p.id}
                pkg={p}
                update={p.pkgName ? updateByPkgName.get(p.pkgName) : undefined}
                busy={ops.busyName === p.pkgName || ops.pendingName === p.pkgName}
                anyPending={ops.pendingName !== null}
                onUpdate={() => {
                  const u = p.pkgName ? updateByPkgName.get(p.pkgName) : undefined
                  if (u) ops.startPreview(u.name, u.latest)
                }}
                onUninstall={() => { if (p.pkgName) ops.uninstall(p.pkgName) }}
              />
            ))}
          </ItemGroup>
          {/* 「等一份 recipe」的站住在这一段底下：这份清单唯一的出口就是给它写一份 recipe，
              所以它得和 recipe 待在同一屏里。清单空了它自己不渲染。 */}
          <OnboardWishlist conn={conn} />
        </Band>

        {/* Provider 段：**这是组件在 UI 上仅存的那一面**——只读清单，答的是"装完之后这些能力
            接上了没有、各挂了几个成员"。编辑面已下线（见 manage-entry 头注）。 */}
        {shownProviders.length ? (
          <Band title={t('packages.providerBand')} why={t('packages.providerWhy')} count={shownProviders.length}>
            <ItemGroup className="gap-1">
              {shownProviders.map((p) => <ProviderRow key={p.id} provider={p} />)}
            </ItemGroup>
          </Band>
        ) : null}

        {nothingShown ? (
          <p className="py-6 text-center text-[13px] text-muted-foreground">{t('packages.empty')}</p>
        ) : null}
      </ShellContent>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>导入分享包</DialogTitle>
            <DialogDescription>贴一个 URL 或选本地文件。导入零执行，撞车 id 自动重映射、不动你已有的编排。</DialogDescription>
          </DialogHeader>
          {/* 只在开着时挂：它一挂载就去拉可搭车的 Provider / 网盘绑定。 */}
          {importOpen ? <BundleShareDialog conn={conn} mode="import" /> : null}
        </DialogContent>
      </Dialog>

      <AddPackageSheet open={addOpen} onOpenChange={setAddOpen} conn={conn} ops={ops} />
      <LogsSheet
        pkgId={logsFor?.id ?? null}
        name={logsFor?.name ?? ''}
        conn={conn}
        onOpenChange={(o) => { if (!o) setLogsFor(null) }}
      />
      <PluginConfigSheet
        open={configFor !== null}
        onOpenChange={(o) => { if (!o) setConfigFor(null) }}
        conn={conn}
        plugin={configFor ? { id: configFor.id, name: configFor.name, role: configFor.role } : null}
      />
      {/* 确认框挂在页上、常驻不带 key：行内「更新」和抽屉里「安装」用的是同一份 ops，
          所以只能有一个确认框。它自己处理 preview=null 与三条复位路径。 */}
      <InstallConfirmDialog
        preview={ops.preview}
        installing={ops.installing}
        error={ops.installError}
        onCancel={ops.cancelPreview}
        onInstall={(p) => ops.install(p)}
      />
    </ShellPanel>
  )
}
