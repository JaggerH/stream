import { useState } from 'react'
import { AlertTriangleIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../acrylic/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../acrylic/dialog.tsx'
import type { RecipePackagePreview } from '../../lib/types.ts'
import { assessInstallRisk, needsSlowConfirm, type RiskReason } from './risk.ts'

/** 安装确认。两件事同时做：
 *   1. 把 preview 里的风险信息**摆到眼前**（副作用、覆盖、钳后限流）——风险置顶，
 *      recipe 明细在其下，**不做折叠**（折叠会把风险藏起来）。
 *   2. 高风险时让动作慢下来：首次点击「安装」不执行，换成一个**复述具体风险**的按钮。
 *      按钮标签本身就是那句认知声明，比一个可以无意识勾掉的 checkbox 更难略过。
 *
 * phase 做成显式状态而非布尔标志，是为了让测试能直接断言「elevated 下首次点击后
 * onInstall 未被调用」——这正是这道门存在的意义。第三档 'installing' 由页面持有
 * （网络归页面），以 prop 传入。
 *
 * phase 不是自己存的 state，而是从「哪个包被确认过」派生出来的：存布尔标志再用 effect
 * 复位会留下一帧窗口——包 A 升档后同一实例换成包 B（「更新到 x.y.z」就是这条路），
 * 复位 effect 跑之前那一帧上摆着的仍是 A 那颗红色确认按钮，点下去直接装了 B。
 * 派生式没有这一帧：key 一变，phase 当场就是 'review'。 */
export function InstallConfirmDialog({
  preview,
  installing,
  error,
  onCancel,
  onInstall,
}: {
  preview: RecipePackagePreview | null
  installing: boolean
  error: string | null
  onCancel: () => void
  onInstall: (preview: RecipePackagePreview) => void
}) {
  const { t } = useTranslation()
  // 确认确认的是**这份字节**，不是版本号。`confirm` 是后端给的 tarball integrity，也正是最终
  // 发回去做两步校验的那个 token——所以判等靠它（name@version 前缀只为可读）。同名同版本换了
  // tarball（`confirm token mismatch` 这个错的含义就是"preview 之后内容变了"，页面对它唯一正确的
  // 反应是重新 preview）时，新 preview 的风险面可能更大，而红色确认按钮若原地不动，手就会先于
  // 眼睛动。反过来，原样重试（preview 没变、confirm 没变）仍停在确认档，不罚站。
  const key = preview ? `${preview.name}@${preview.version}#${preview.confirm}` : null
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null)
  // 存着的确认状态一旦不再属于当前这个包——换了包，或者 preview 变成 null（页面把对话框关了）
  // ——当场丢掉。这个组件自己处理 `preview === null`（`return null` 而不是卸载），所以
  // 「关掉再打开同一个包」这条路上没有别人会替它复位；漏了这一步，第二次打开时首帧摆着的
  // 就是那颗红色确认按钮，一击即装。在渲染期丢弃（而不是 effect 里）才没有中间帧。
  if (confirmedFor !== null && confirmedFor !== key) setConfirmedFor(null)
  const phase: 'review' | 'confirming' = key !== null && confirmedFor === key ? 'confirming' : 'review'

  if (!preview || key === null) return null
  const risk = assessInstallRisk(preview, preview.name)

  const reasonText = (r: RiskReason): string => {
    if (r.kind === 'code') {
      // 注册名是这个包会**占住**的位置，也是唯一能被点名的具体物；一个都没申报时不能凑一句
      // 「占用 」的空话，换成不带名字的那句——文案没有信息量就等于没有摩擦。
      const names = [...r.adapters, ...r.normalizers]
      return names.length > 0
        ? t('recipes.riskCode', { names: names.join('、') })
        : t('recipes.riskCodeNoNames')
    }
    if (r.kind === 'capability') {
      // 工具名**通常拿不到**（要 import + mount 之后才知道，而确认发生在那之前）。所以默认
      // 那句话说的是权限本身：在后端进程内以完整权限跑、能取浏览器里的登录态。有名字时才
      // 一并点名——点得出的具体物比一句泛泛的警告更难被略过。
      return r.tools.length > 0
        ? t('recipes.riskCapabilityWithTools', { tools: r.tools.join('、') })
        : t('recipes.riskCapability')
    }
    if (r.kind === 'container') {
      // 镜像全名是用户唯一能自己去核实的东西（去 registry 上看是谁发的），所以它必须进
      // 按钮标签本身，而不是只躺在下面的明细里。申报了凭证域就一并复述——那是这个容器能
      // 拿到的登录态；没申报就换成不提登录态的那一句（凑一个空名单等于撒谎）。
      return r.credentials.length > 0
        ? t('recipes.riskContainerWithCreds', { image: r.image, domains: r.credentials.join('、') })
        : t('recipes.riskContainer', { image: r.image })
    }
    return r.kind === 'write'
      ? t('recipes.riskWrite', { ids: r.recipeIds.join('、') })
      : t('recipes.riskShadow', { ids: r.sourceIds.join('、') })
  }

  // 凭证域是**包级**申报（容器经凭证代理、代码经 ctx.cookieFor 吃的是同一份名单），所以
  // 这一行两个位置都可能落：有容器时摆进容器块（它就是那个容器的能力边界），没有容器时
  // 摆在顶层明细里。定义一次、放一处，别为了位置不同复刻两份。
  const credentialsRow = preview.credentials?.length ? (
    <div className="flex gap-2">
      <span className="text-muted-foreground">{t('recipes.credentialsLabel')}</span>
      <span>{preview.credentials.join('、')}</span>
    </div>
  ) : null

  const confirmLabel = `${t('recipes.confirmInstall')} · ${risk.reasons.map(reasonText).join(' · ')}`

  const primaryLabel = installing
    ? t('recipes.installing')
    : phase === 'confirming'
      ? confirmLabel
      : t('recipes.install')

  // 「关掉」只有一个动作，两处出口（Esc/遮罩/X 与「取消」按钮）都走它：关闭是明确的退出信号，
  // 门必须随之重新武装——哪怕页面把同一个 preview 原样再递回来。
  const close = () => { setConfirmedFor(null); onCancel() }

  const onPrimary = () => {
    // 这里刻意只读 state，不像页面那条 preview 路径那样再加一层 ref。两处不同不是疏漏：
    // preview 由**列表里一颗随时可点的按钮**发起，按钮不会因请求在飞而消失，所以要一个
    // 同 tick 就生效的闸；而这颗主按钮在 installing 期间自身 disabled，且两次点击是两个
    // 独立事件、React 已在其间把 state 刷回来——真正的闸是 disabled，这行只是兜底。
    if (installing) return
    if (phase === 'review' && needsSlowConfirm(risk)) { setConfirmedFor(key); return }
    onInstall(preview)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('recipes.dialogTitle', { name: preview.name, version: preview.version })}</DialogTitle>
          <DialogDescription>{t('recipes.disclaimer')}</DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto text-[12px]">
          {/* 警示块的档位跟着 risk.level 走，而不是「有没有理由」：带代码的包换一个**说出实情**
              的标题（它在 Stream 里跑自己的代码），并额外摆出注册名、入口与「重启才生效」。
              纯数据包一个字都不多——所有包都吓一遍等于没有分级。 */}
          {needsSlowConfirm(risk) ? (
            <div className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-2">
              <strong className="text-destructive">
                {t(
                  risk.level === 'code'
                    ? 'recipes.riskCodeHeading'
                    : risk.level === 'container'
                      ? 'recipes.riskContainerHeading'
                      : 'recipes.riskHeading',
                )}
              </strong>
              {risk.reasons.map((r) => (
                <div key={r.kind} className="flex items-start gap-1.5 text-destructive">
                  <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                  <span>{reasonText(r)}</span>
                </div>
              ))}
              {preview.code ? (
                <div className="flex flex-col gap-1 pt-1">
                  <div className="flex gap-2">
                    <span className="text-muted-foreground">{t('recipes.codeEntryLabel')}</span>
                    <span>{preview.code.entry}</span>
                  </div>
                  {preview.code.adapters.length > 0 ? (
                    <div className="flex gap-2">
                      <span className="text-muted-foreground">{t('recipes.codeAdaptersLabel')}</span>
                      <span>{preview.code.adapters.join('、')}</span>
                    </div>
                  ) : null}
                  {preview.code.normalizers.length > 0 ? (
                    <div className="flex gap-2">
                      <span className="text-muted-foreground">{t('recipes.codeNormalizersLabel')}</span>
                      <span>{preview.code.normalizers.join('、')}</span>
                    </div>
                  ) : null}
                  {/* ESM 的模块缓存卸不掉：卸载删的是磁盘上的文件，已经 import 进来的那份还在跑。
                      如实写出来，别让用户以为点完「卸载」代码就停了。 */}
                  <p className="text-destructive">{t('recipes.codeRestartNote')}</p>
                </div>
              ) : null}

              {/* 能力槽位的明细。和上面代码格并列而不是二选一：一个包两格都填是合法的
                  （`stream.code` 与 `stream.capability` 指同一个文件），那时两条都该摆出来。
                  「重启才生效」同样适用——ESM 的模块缓存卸不掉。 */}
              {preview.capability ? (
                <div className="flex flex-col gap-1 pt-1">
                  <div className="flex gap-2">
                    <span className="text-muted-foreground">{t('recipes.capabilityEntryLabel')}</span>
                    <span>{preview.capability.entry}</span>
                  </div>
                  {preview.capability.tools?.length ? (
                    <div className="flex gap-2">
                      <span className="text-muted-foreground">{t('recipes.capabilityToolsLabel')}</span>
                      <span>{preview.capability.tools.join('、')}</span>
                    </div>
                  ) : null}
                  <p className="text-destructive">{t('recipes.capabilityHostNote')}</p>
                  {preview.code ? null : <p className="text-destructive">{t('recipes.codeRestartNote')}</p>}
                </div>
              ) : null}

              {/* 容器明细。摆的是**钳制后**那份声明的摘要（后端 summarizeBackend）——落盘的、
                  provisioner 起容器读的都是同一份字节，展示别的等于让用户批准一个不会发生的东西。
                  这几格是用户判断「这东西要在我机器上干什么」的全部依据：镜像全名（唯一可核实的
                  具体物）、内存上限、卷（已加包前缀，各包互不相通）、env 的键名（值不外泄，可能
                  是包作者塞的 token）、能取的登录态、闲置多久回收。
                  没有 gpu 一格——第三方声明 gpu 一律在安装期被拒，摆一个恒为 false 的字段只会让人
                  以为那是个可能出现的状态。 */}
              {preview.backend ? (
                <div className="flex flex-col gap-1 pt-1">
                  <div className="flex gap-2">
                    <span className="text-muted-foreground">{t('recipes.backendImageLabel')}</span>
                    <span className="break-all">{preview.backend.image}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-muted-foreground">{t('recipes.backendMemLabel')}</span>
                    <span>{preview.backend.mem}</span>
                  </div>
                  {preview.backend.volumes.length > 0 ? (
                    <div className="flex gap-2">
                      <span className="text-muted-foreground">{t('recipes.backendVolumesLabel')}</span>
                      <span className="break-all">{preview.backend.volumes.join('、')}</span>
                    </div>
                  ) : null}
                  {preview.backend.envKeys.length > 0 ? (
                    <div className="flex gap-2">
                      <span className="text-muted-foreground">{t('recipes.backendEnvLabel')}</span>
                      <span className="break-all">{preview.backend.envKeys.join('、')}</span>
                    </div>
                  ) : null}
                  {credentialsRow}
                  <p className="text-destructive">
                    {t('recipes.backendStandbyNote', { minutes: preview.backend.standby.idleMinutes })}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex gap-2">
            <span className="text-muted-foreground">{t('recipes.facility')}</span>
            <span>{preview.facility}</span>
          </div>

          {/* 这一行是界面里唯一能回答「这个包会拿我在哪个站的登录身份去干活」的东西。
              facility 说 xhs、登录域却是 quark.cn 是合法包结构，也正是钓鱼的签名——
              但**只展示、不当判据**：没有官方域白名单，任何"域不符就罚站"的规则都会误伤
              正常的第三方包。判断留给看得见它的人。 */}
          {preview.cookieDomain ? (
            <div className="flex gap-2">
              <span className="text-muted-foreground">{t('recipes.cookieDomainLabel')}</span>
              <span>{preview.cookieDomain}</span>
            </div>
          ) : null}

          {preview.backend ? null : credentialsRow}

          {preview.mirrorUnverified ? (
            <div className="flex gap-2">
              <span className="text-muted-foreground">{t('recipes.mirrorUnverifiedLabel')}</span>
              <span>{t('recipes.mirrorUnverifiedNote', { reason: preview.mirrorUnverified })}</span>
            </div>
          ) : null}

          {preview.rateLimit ? (
            <div className="flex gap-2">
              <span className="text-muted-foreground">{t('recipes.rateLimit')}</span>
              <span>
                {/* 声明了每小时预算就一并显示：这一行的意思是「装了它以后这个站点会被卡多严」，
                    漏掉累计那一档等于把话说少了一半。 */}
                {preview.rateLimit.perHour
                  ? t('recipes.rateLimitValueHourly', {
                      burst: preview.rateLimit.burst,
                      perMinute: preview.rateLimit.perMinute,
                      perHour: preview.rateLimit.perHour,
                    })
                  : t('recipes.rateLimitValue', {
                      burst: preview.rateLimit.burst,
                      perMinute: preview.rateLimit.perMinute,
                    })}
              </span>
            </div>
          ) : null}

          {/* serving 声明的 match 与 hosts 并集：装了它以后，后端会替这个包去连这些主机送字节
              （spec 2026-09-18-facility-knowledge-in-package §4）。这是一个"后端替第三方出站"的事实，
              和限流、登录域同级，必须亮出来；没有声明就不占一行。 */}
          {preview.proxies && preview.proxies.length > 0 ? (
            <div className="flex gap-2">
              <span className="text-muted-foreground">{t('recipes.proxiesLabel')}</span>
              <span>{preview.proxies.join('、')}</span>
            </div>
          ) : null}

          {/* 身份表是启动期快照（Task 3）：热装一个带 providers 的包，那几条 Provider 行要到
              下次启动才出现——这件事必须在确认页说出来，否则用户装完看不到行、也没人告诉他为什么。 */}
          {preview.providers && preview.providers.length > 0 ? (
            <div className="flex gap-2">
              <span className="text-muted-foreground">{t('recipes.providersLabel')}</span>
              <span>{preview.providers.join('、')}</span>
              <span className="text-destructive">{t('recipes.providersRestartNote')}</span>
            </div>
          ) : null}

          {preview.overrides.length > 0 ? (
            <div className="flex gap-2">
              <span className="text-muted-foreground">{t('recipes.overridesLabel')}</span>
              <span>{preview.overrides.join('、')}</span>
            </div>
          ) : null}

          <ul className="flex flex-col gap-2">
            {preview.recipes.map((r) => (
              <li key={r.id} className="rounded-md border p-2">
                <div className="flex items-center gap-2">
                  <strong>{r.id}</strong>
                  {r.effects.includes('write') ? (
                    <span className="rounded bg-destructive/15 px-1 text-destructive">{t('recipes.writeBadge')}</span>
                  ) : null}
                </div>
                {r.description ? <p className="text-muted-foreground">{r.description}</p> : null}
                <div className="flex flex-wrap gap-2 pt-1">
                  <span className="text-muted-foreground">{t('recipes.capabilitiesLabel')}</span>
                  {r.capabilities.map((c) => <span key={c}>{c}</span>)}
                  {r.effects.length > 0 ? (
                    <>
                      <span className="text-muted-foreground">{t('recipes.effectsLabel')}</span>
                      <span>{r.effects.join(', ')}</span>
                    </>
                  ) : null}
                  {r.params.length > 0 ? (
                    <>
                      <span className="text-muted-foreground">{t('recipes.paramsLabel')}</span>
                      <span>{r.params.join(', ')}</span>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          {error ? <p className="text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="neutral" size="medium" onClick={close}>{t('recipes.cancel')}</Button>
          {/* 确认档的标签是一整句复述具体风险的话，远超一颗 medium 按钮的宽度。Button 基类带
              `whitespace-nowrap shrink-0`，照单全收会把面板撑出圆角——**恰恰是风险最高的那一档
              最读不全**。所以确认档解掉 nowrap、放开高度、左对齐、允许收缩：让它换行成一块
              多行按钮。标签本身就是那道摩擦，读不全等于没有摩擦。 */}
          <Button
            variant={phase === 'confirming' ? 'destructive' : 'default'}
            size="medium"
            className={phase === 'confirming' ? 'h-auto min-w-0 shrink whitespace-normal py-1 text-left' : undefined}
            disabled={installing}
            onClick={onPrimary}
          >
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
