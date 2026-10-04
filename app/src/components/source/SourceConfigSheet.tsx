import { useEffect, useMemo, useRef, useState } from 'react'
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../acrylic/sheet.tsx'
import { SettingsBlock, SettingsGroup, SettingsSection } from '../settings/SettingsSection.tsx'
import { Button } from '../acrylic/button.tsx'
import { Combobox } from '../acrylic/combobox.tsx'
import type { ComboboxGroupData } from '../acrylic/combobox.tsx'
import { Field, FieldDescription, FieldLabel } from '../acrylic/field.tsx'
import { Input } from '../acrylic/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../acrylic/select.tsx'
import { ExternalLinkIcon, EyeIcon, WandSparklesIcon } from 'lucide-react'
import { toast } from '../acrylic/sonner.tsx'
import { usePreview } from '../../lib/previewStage.ts'
import { SourceParamField } from './SourceParamField.tsx'
import { SourceProvisionDialog } from './SourceProvisionDialog.tsx'
import { RsshubRouteMarkdown, Markdown } from './RsshubRouteMarkdown.tsx'
import { fillAndValidateParams, sourceDocsMarkdown, rsshubDocsBlocks, sourceSummary, sourceDocsUrl } from '../../lib/source.ts'
import type { Connection } from '../../lib/api.ts'
import type { ParamSpec, SourceDetail, ProviderView, ChannelView, RuntimeConfigProvisioner, SourceRuntimeConfigStatus } from '../../lib/types.ts'
import { initialDestination, submitDestination } from './destination.ts'
import type { ConfigTarget, ResolvedDestination, StreamLike } from './destination.ts'

export function SourceConfigSheet({
  open, onOpenChange, conn, source, target, streams, providers, channels,
  initialParams, initialName, defaultChannelId, onSubmitted,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  conn: Connection
  source: SourceDetail
  target: ConfigTarget
  streams: StreamLike[]
  providers: ProviderView[]
  channels: ChannelView[]
  initialParams?: Record<string, string>
  initialName?: string
  /** Pre-selected channel for the create-stream branch (e.g. the channel the add flow was opened from). */
  defaultChannelId?: string
  onSubmitted?: () => void
}) {
  const paramEntries = useMemo(
    () => Object.entries(source.paramsSchema as Record<string, ParamSpec>), [source])
  const docsBlocks = useMemo(() => {
    const md = sourceDocsMarkdown(source)
    return md ? rsshubDocsBlocks(md) : []
  }, [source])
  // destination: null in pick mode until the user chooses.
  const [dest, setDest] = useState<ResolvedDestination | null>(() => initialDestination(target))
  const [name, setName] = useState(initialName ?? source.title ?? source.id)
  const [channelId, setChannelId] = useState(defaultChannelId ?? '')
  const [params, setParams] = useState<Record<string, string>>(initialParams ?? {})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 半成功记号：成员那次 PATCH/POST 真的落地了，只是紧接着的 key PUT 掉了。用户原地重存不该把
  // 成员写入再放一遍——append/create 分支不是幂等的（重放会撞 duplicate member name / 建出第二份），
  // 只有 edit-* 分支是幂等的但也没必要重放。此标记与已有的"编辑既有成员"分支（isEdit）是两回事：
  // isEdit 判的是「进 Sheet 时目标是不是已有成员」，这个标记判的是「这一次会话里成员写没写过」。
  const [memberWritten, setMemberWritten] = useState(false)
  // portal target for in-sheet popovers (the destination Combobox) — keeps them inside
  // the Sheet's interactive subtree so they stay clickable/scrollable and leave no
  // stuck body pointer-events lock on close.
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const { openPreview } = usePreview()
  const runtime = source.runtimeConfig
  const [runtimeValues, setRuntimeValues] = useState<Record<string, string>>({})
  const [runtimeSecrets, setRuntimeSecrets] = useState<Record<string, boolean>>({})
  // 「谁能替我填这一格」——后端算的，前端只投影。null = 没人能，界面退回今天那条外链。
  const [provisioner, setProvisioner] = useState<RuntimeConfigProvisioner | null>(null)
  const [envFallback, setEnvFallback] = useState<string[]>([])
  const [provisionOpen, setProvisionOpen] = useState(false)
  const [provisioning, setProvisioning] = useState(false)
  const [provisionError, setProvisionError] = useState<string | null>(null)
  // 引导只在「撞上这件事」的那一刻弹一次，之后靠字段旁那颗按钮回来——每次 status 回来都弹
  // 就成了一个赶不走的弹窗，而用户可能正想手动粘一把已有的 key。用 ref 不用 state：它只是
  // 一个"提过了吗"的记号，进 effect 的依赖数组会让每次提议都触发一次多余的重新拉取。
  const provisionOffered = useRef(false)
  // perInstance 源（llm-openai）：这一份配置属于**一个成员实例**，不是全源共享。实例名既是成员的
  // 寻址键，也决定 key 存哪儿（`llm:<实例名>` = 成员 params.tokenName），所以名字在这里定死一次：
  // 新建时用户填，编辑时从既有成员的 tokenName 回显且不可改——改了名就与已经存下的 key 对不上。
  const perInstance = !!runtime?.perInstance
  const initialInstance = instanceOf(initialParams?.tokenName)
  const [instance, setInstance] = useState(initialInstance)
  const instanceRef = perInstance && instance ? tokenNameOf(instance) : undefined

  // 会话身份复位：有的调用点（PluginPanel.tsx 的 `picked` 挂载模式）关闭 Sheet 只翻 `open`，
  // 不清 `picked`——同一个组件实例会先后配置两个不同的源。上面那批 useState 只在**首次挂载**
  // 跑初始化器，第二次 open 复用的是第一次会话遗留的状态：最要命的是 `memberWritten`——它
  // 留着 true，第二个源的保存会被判定成"已经写过成员"直接跳过 submitDestination，对没有
  // runtimeConfig 的源等于什么都没写却报成功。按 open/source.id/target 身份变化整批复位，
  // 顺带把 dest/name/params/instance 也归零，消掉同源换目的地的潜在陈旧态。
  const targetKey = JSON.stringify(target)
  useEffect(() => {
    if (!open) return
    setDest(initialDestination(target))
    setName(initialName ?? source.title ?? source.id)
    setChannelId(defaultChannelId ?? '')
    setParams(initialParams ?? {})
    setInstance(instanceOf(initialParams?.tokenName))
    setMemberWritten(false)
    setErr(null)
    // 引导的"提过了"记号跟着会话身份复位：同一个组件实例先后配置两个源时，第二个源缺 key
    // 也该被提醒一次。漏了这一步的表现是"换个源就再也不提示了"，而且完全无声。
    provisionOffered.current = false
    setProvisionOpen(false)
    setProvisionError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source.id, targetKey])

  // 状态回填时**保住用户已经敲进去、还没提交的 secret**。后端从不回显 secret（status.values
  // 里根本没有它们），所以直接 setRuntimeValues(status.values) 等于把输入框清空——改一次实例名
  // 就要重打一遍 key。非 secret 字段仍以服务端为准。
  const keepUnsavedSecrets = (previous: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(previous).filter(([key, value]) => value && runtime?.fields[key]?.type === 'secret'))

  /** 三个出口（查状态 / 存完 / 一键申请完）回的是同一份回执，落地也只写一处——分开写的
   *  代价是某一条路忘了刷新 `configured`，界面上那一格永远停在"还没配"。 */
  const applyRuntimeStatus = (status: SourceRuntimeConfigStatus) => {
    setRuntimeValues((previous) => ({ ...status.values, ...keepUnsavedSecrets(previous) }))
    setRuntimeSecrets(Object.fromEntries(Object.entries(status.secrets).map(([key, value]) => [key, value.configured])))
    setProvisioner(status.provisioner ?? null)
    setEnvFallback(status.envFallback ?? [])
  }

  useEffect(() => {
    if (!runtime || !open) return
    // perInstance 源在实例名定下来之前没有可查的 ref——查也只会查到别的实例（或全源共享层）的状态。
    if (perInstance && !instanceRef) { setRuntimeValues(keepUnsavedSecrets); setRuntimeSecrets({}); setProvisioner(null); return }
    // 实例名是逐字符敲出来的，每敲一下都换一个 ref——防抖，别把中间态的名字一个个打到后端。
    let live = true
    const timer = setTimeout(() => {
      fetch(`${conn.baseUrl}/api/source-runtime-config/status`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}) },
        body: JSON.stringify({ pluginId: source.pluginId, sourceId: source.id, ...(instanceRef ? { ref: instanceRef } : {}) }),
      }).then((r) => r.ok ? r.json() as Promise<SourceRuntimeConfigStatus> : Promise.reject())
        .then((status) => {
          if (!live) return
          applyRuntimeStatus(status)
          // **就是这一刻**：这一格要一把 key、还没有、而且有人能替他弄。引导弹窗弹在这里，
          // 不弹在"打开 Sheet"——那时还不知道缺不缺。一次会话只提一次（provisionOffered）。
          const p = status.provisioner
          if (p && !status.secrets[p.field]?.configured && !provisionOffered.current) {
            provisionOffered.current = true
            setProvisionError(null)
            setProvisionOpen(true)
          }
        })
        .catch(() => { if (live) { setRuntimeValues(keepUnsavedSecrets); setRuntimeSecrets({}); setProvisioner(null) } })
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [conn.baseUrl, conn.token, open, runtime, perInstance, instanceRef, source.id, source.pluginId])

  const isCreateStream = dest?.action === 'create-stream'
  const isEdit = dest?.action === 'edit-stream-member' || dest?.action === 'edit-provider-member'

  // pick-mode destination: a value→destination map + grouped options for the Combobox.
  // Provider CREATE is intentionally not offered yet (append-only).
  const { pickMap, pickGroups } = useMemo(() => {
    const map: Record<string, ResolvedDestination> = { 'create-stream': { action: 'create-stream', channelId: '' } }
    const groups: ComboboxGroupData[] = [{ options: [{ value: 'create-stream', label: '新建 Stream' }] }]
    if (streams.length) {
      groups.push({ heading: 'Stream', options: streams.map((s) => ({ value: 'stream:' + s.id, label: s.description || s.id })) })
      for (const s of streams) map['stream:' + s.id] = { action: 'append-stream', streamId: s.id }
    }
    if (providers.length) {
      groups.push({ heading: 'Provider', options: providers.map((p) => ({ value: 'provider:' + p.id, label: p.label })) })
      for (const p of providers) map['provider:' + p.id] = { action: 'append-provider', providerId: p.id }
    }
    return { pickMap: map, pickGroups: groups }
  }, [streams, providers])

  async function onSave() {
    if (!dest) { setErr('请选择目的地'); return }
    let finalDest = dest
    if (dest.action === 'create-stream') {
      if (!channelId) { setErr('请选择频道'); return }
      finalDest = { action: 'create-stream', channelId }
    }
    const filled = fillAndValidateParams(source.paramsSchema as Record<string, ParamSpec>, params)
    if (!filled.ok) { setErr(`缺少必填参数: ${filled.missing}`); return }
    // 实例名先于任何写入校验：它同时是成员寻址键和 key 的落点，名字不合法就没有一个安全的写入地址。
    if (perInstance && !INSTANCE_NAME.test(instance)) { setErr('实例名必填，且只能用字母、数字、下划线或短横线'); return }
    // 部署环境变量兜得住的格空着也能跑（后端执行时用同一张表补上），不拦——否则只靠环境变量配好的用户存不了盘。
    const missingRuntime = runtime && Object.entries(runtime.fields).find(([key, field]) => field.required && !runtimeValues[key] && !runtimeSecrets[key] && !envFallback.includes(key))
    if (missingRuntime) { setErr(`缺少运行时配置: ${missingRuntime[1].label}`); return }
    setBusy(true); setErr(null)
    // 顺序是承重的：**先写成员，成功了再写 key**。反过来的话，实例名撞上一个已有实例时，key 已经
    // 把对方的凭据覆盖掉了，成员 PATCH 才回"重名"——用户看到一条"没保存"的报错，实际上另一档
    // 已经被打坏。顺带也不会在成员写失败时留下一份没有主人的 secret。
    // 半成功后原地重存：成员这次已经写过了（memberWritten），跳过再写一遍——append/create 分支
    // 重放会撞 duplicate member name（这一档已经真的存在了），别把它当没发生过。
    if (!memberWritten) {
      try {
        // perInstance 成员自带 tokenName：它就是 key 的完整 ref，读侧（keyState / 梯子解析）认的
        // 就是这个字段——不写它，这一档永远取不到自己的 key。
        const memberParams = perInstance ? { ...filled.params, tokenName: tokenNameOf(instance) } : filled.params
        await submitDestination({ conn, source, dest: finalDest, name, memberName: perInstance ? instance : undefined, params: memberParams, streams, providers, channels })
        setMemberWritten(true)
      } catch (e) { setErr((e as Error).message); setBusy(false); return }
    }
    if (runtime && Object.keys(runtime.fields).length) {
      try {
        await saveRuntimeConfig()
      } catch (e) {
        // 半成功必须说清楚：成员是真建了（列表要刷新），但 key 没落盘。装成关闭走人的话，
        // 用户下次只会看到一档"缺 key"的成员，猜不到是这一步掉的。
        onSubmitted?.()
        setErr(`成员已保存，但 key 未保存（${(e as Error).message}）——请重新打开这一档补填 key`)
        setBusy(false)
        return
      }
    }
    onSubmitted?.()
    onOpenChange(false)
    setBusy(false)
  }

  // Preview pulls this source live with the params as configured right now — no destination,
  // no store. Validates required params first so the preview matches what would be saved.
  function onPreview() {
    const filled = fillAndValidateParams(source.paramsSchema as Record<string, ParamSpec>, params)
    if (!filled.ok) { setErr(`缺少必填参数: ${filled.missing}`); return }
    setErr(null)
    openPreview({ kind: 'source', sourceId: source.id, params: filled.params, label: name || source.title || source.id })
  }

  async function saveRuntimeConfig() {
    if (!runtime) return
    const response = await fetch(`${conn.baseUrl}/api/source-runtime-config`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}) },
      body: JSON.stringify({ pluginId: source.pluginId, sourceId: source.id, ...(instanceRef ? { ref: instanceRef } : {}), values: runtimeValues }),
    })
    if (!response.ok) throw new Error('保存 Source 配置失败')
    applyRuntimeStatus(await response.json() as SourceRuntimeConfigStatus)
  }

  /**
   * 「一键帮我完成」。跑的是哪条 recipe **由后端定**——这里只说"把这张卡这一格填上"，
   * 所以前端手里没有一个可以换成别的 sourceId 的口子。
   *
   * 成功的判据不是"请求 200"，是回执里那一格 `configured` 变成了 true——后端已经替我们判过
   * （见该端点头注：这类 recipe 不产 item，成功和白跑在 runner 那边一字不差）。所以这里
   * 只管两件事：把新状态铺回界面、把失败原文原样摆出来。
   */
  async function runProvision(params: Record<string, string>) {
    setProvisioning(true); setProvisionError(null)
    try {
      const response = await fetch(`${conn.baseUrl}/api/source-runtime-config/provision`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}) },
        body: JSON.stringify({ pluginId: source.pluginId, sourceId: source.id, ...(instanceRef ? { ref: instanceRef } : {}), params }),
      })
      const body = await response.json().catch(() => ({})) as SourceRuntimeConfigStatus & { error?: string }
      if (!response.ok) throw new Error(body.error || `申请失败（HTTP ${response.status}）`)
      applyRuntimeStatus(body)
      setProvisionOpen(false)
      toast.success(`${provisioner?.label ?? source.title ?? source.id} 的 key 已经建好并填进配置`)
    } catch (e) {
      // 失败留在弹窗里、不 toast 走人：下一步动作（重试 / 改个名 / 转去自己注册）就在这张卡上，
      // 而错误正文里带着"去 failures/ 看现场"这条线索——飘走的 toast 会把它一起带走。
      setProvisionError((e as Error).message)
    } finally {
      setProvisioning(false)
    }
  }

  const saveLabel = isEdit ? '保存' : isCreateStream ? '新建 Stream' : '添加'

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* 半屏起步。注意 sheet.tsx 的 side="right" 自带 sm:max-w-sm(24rem) 上限——只写
          w-[…] 会被它盖掉(原来的 w-[26rem] 实际只有 24rem),所以必须一起解掉那个 cap。 */}
      <SheetContent side="right" className="w-[max(26rem,50vw)] p-0 sm:max-w-none">
        {/* container = non-clipping wrapper the Combobox popover portals into; scroll lives
            on the inner div so the popover isn't clipped by the scroll container. */}
        <div ref={setContainer} className="flex min-h-0 flex-1 flex-col">
        <SheetHeader className="px-4 pt-4">
          <SheetTitle>{source.title || source.id}</SheetTitle>
        </SheetHeader>
        <div className="scrollbar-mac min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-1">
          <SettingsGroup>
          <SettingsSection
            title="说明"
            actions={
              source.facility && sourceDocsUrl(source) ? (
                <a href={sourceDocsUrl(source)} target="_blank" rel="noreferrer" className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-[var(--acr-card-nested)] hover:text-foreground">
                  <span className="max-w-[8rem] truncate">{source.facility.label}</span>
                  <ExternalLinkIcon className="size-3 shrink-0" />
                </a>
              ) : null
            }
          >
            <SettingsBlock>
              <code className="mb-2 block truncate font-mono text-[11px] text-muted-foreground">{source.id.replace(/^rsshub:/, '')}</code>
              {docsBlocks.length ? (
                <RsshubRouteMarkdown blocks={docsBlocks} />
              ) : (
                <div className="text-[13px] leading-relaxed text-muted-foreground"><Markdown text={sourceSummary(source)} /></div>
              )}
            </SettingsBlock>
            {paramEntries.length ? (
              <SettingsBlock>
                <div className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">参数</div>
                <div className="space-y-1.5">
                  {paramEntries.map(([key, spec]) => (
                    <div key={key} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 text-[11px]">
                      <code className="font-mono text-foreground">{key}{spec.required ? ' *' : ''}</code>
                      <div className="text-muted-foreground">{spec.description ? <Markdown text={spec.description} /> : 'string'}</div>
                    </div>
                  ))}
                </div>
              </SettingsBlock>
            ) : null}
          </SettingsSection>

          <div className="flex flex-col gap-4">
          {target.kind === 'pick' ? (
            <Field orientation="vertical">
              <FieldLabel>加到哪里</FieldLabel>
              <Combobox
                groups={pickGroups}
                value={pickValue(dest)}
                onValueChange={(v) => setDest(pickMap[v] ?? null)}
                placeholder="选择目的地"
                searchPlaceholder="搜索 Stream / Provider"
                emptyText="无匹配"
                className="w-full"
                container={container}
              />
            </Field>
          ) : null}

          {isCreateStream ? (
            <>
              <Field orientation="vertical">
                <FieldLabel>频道</FieldLabel>
                <Select value={channelId} onValueChange={setChannelId}>
                  <SelectTrigger className="w-full" aria-label="选择频道">
                    <SelectValue placeholder="选择一个频道" />
                  </SelectTrigger>
                  <SelectContent>
                    {channels.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.label}{c.kind === 'audio' ? ' · 歌单' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field orientation="vertical">
                <FieldLabel htmlFor="stream-name">名称</FieldLabel>
                <Input id="stream-name" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
            </>
          ) : null}

          {paramEntries.map(([key, spec]) => (
            <SourceParamField key={key} name={key} spec={spec} value={params[key] ?? ''}
              onChange={(value) => setParams((prev) => ({ ...prev, [key]: value }))}
              container={container} apiBase={conn.baseUrl} />
          ))}
          </div>
          {runtime ? (
            <SettingsSection title="运行时配置">
              <SettingsBlock>
              {perInstance ? (
                <Field orientation="vertical" className="mb-2">
                  <FieldLabel htmlFor="member-instance">实例名 *</FieldLabel>
                  <Input id="member-instance" value={instance} disabled={!!initialInstance}
                    placeholder="kimi / deepseek…"
                    onChange={(event) => setInstance(event.target.value.trim())} />
                  <FieldDescription>
                    {initialInstance
                      ? '这一档在梯子上的名字，同时决定它的 key 存在哪里；建好之后不能改名。'
                      : '这一档在梯子上的名字（同一个源可以有多档，各自端点/模型/key）。key 存为 ' + tokenNameOf(instance || '<实例名>') + '。'}
                  </FieldDescription>
                </Field>
              ) : null}
              {Object.keys(runtime.fields).length ? <div className="flex flex-col gap-2">
                {Object.entries(runtime.fields).map(([key, field]) => (
                  <Field key={key} orientation="vertical">
                    <FieldLabel htmlFor={`runtime-${key}`}>{field.label}{field.required ? ' *' : ''}{field.type === 'secret' && runtimeSecrets[key] ? '（留空保持不变）' : ''}</FieldLabel>
                    <Input id={`runtime-${key}`} type={field.type === 'secret' ? 'password' : 'text'}
                      placeholder={field.type === 'secret' && runtimeSecrets[key] ? '••••••••' : field.default}
                      value={runtimeValues[key] ?? ''}
                      onChange={(event) => setRuntimeValues((previous) => ({ ...previous, [key]: event.target.value }))} />
                    {field.description || field.helpUrl ? <FieldDescription>
                      {field.description}{field.description && field.helpUrl ? ' ' : ''}
                      {field.helpUrl ? <a className="underline underline-offset-2 hover:text-foreground" href={field.helpUrl} target="_blank" rel="noreferrer">前往申请</a> : null}
                    </FieldDescription> : null}
                    {/* 有人能替他弄这一格，就给一个入口——引导弹窗一次会话只自动弹一次，
                        关掉之后这颗按钮是**唯一**回得去的路。已经配好了也留着：换一把 key
                        是个正当需求，而它跑的正是同一条 recipe。 */}
                    {provisioner?.field === key ? (
                      <Button variant="secondary" size="small" className="mt-1 self-start" disabled={provisioning}
                        onClick={() => { setProvisionError(null); setProvisionOpen(true) }}>
                        <WandSparklesIcon />
                        {runtimeSecrets[key] ? '再建一把' : '一键帮我申请'}
                      </Button>
                    ) : null}
                  </Field>
                ))}
              </div> : null}
              </SettingsBlock>
            </SettingsSection>
          ) : null}
          {paramEntries.length === 0 ? <p className="px-3 text-[11px] text-muted-foreground">无需参数</p> : null}
          </SettingsGroup>
        </div>

        {/* 动作条固定在底部。以前它跟在滚动区末尾，源说明一长就被滚出视野——主操作不该需要先滚到底才找得到。 */}
        <SheetFooter className="flex-row gap-2 border-t border-[var(--acr-border-soft)] px-4 py-3">
          {err ? (
            <div role="alert" className="mr-auto min-w-0 flex-1 truncate text-[11px] text-destructive" title={err}>{err}</div>
          ) : null}
          <Button variant="secondary" onClick={onPreview} disabled={busy} className="shrink-0" aria-label="预览抓取效果，不入库">
            <EyeIcon />
            预览
          </Button>
          <Button onClick={onSave} disabled={busy} className="min-w-[7rem]">{busy ? '处理中…' : saveLabel}</Button>
        </SheetFooter>
        </div>
        {provisioner ? (
          <SourceProvisionDialog
            open={provisionOpen}
            onOpenChange={setProvisionOpen}
            provisioner={provisioner}
            fieldLabel={runtime?.fields[provisioner.field]?.label ?? provisioner.field}
            helpUrl={runtime?.fields[provisioner.field]?.helpUrl}
            busy={provisioning}
            error={provisionError}
            onRun={runProvision}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

/** 实例名的合法字符集。它要能安全地拼进 key 的 ref（`llm:<实例名>`）——后端按同一条白名单
 *  (`^llm:[\w-]+$`) 校验，这里先拦一道，用户不必等一个 400 才知道名字不合法。 */
const INSTANCE_NAME = /^[\w-]+$/

/** 实例名 → key 的完整 ref（= 成员 params.tokenName）。这条拼法只有这一处和后端种子迁移知道，
 *  两边必须一致；读侧（keyState / 梯子端点解析）一律直接读 tokenName，不再反向拆。 */
const tokenNameOf = (instance: string): string => `llm:${instance}`

/** 从既有成员的 tokenName 反推实例名（编辑既有实例时回显用）。拿不到 → 空串（新建）。 */
function instanceOf(tokenName: string | undefined): string {
  const name = typeof tokenName === 'string' && tokenName.startsWith('llm:') ? tokenName.slice(4) : ''
  return INSTANCE_NAME.test(name) ? name : ''
}

function pickValue(d: ResolvedDestination | null): string | undefined {
  if (!d) return undefined
  if (d.action === 'create-stream') return 'create-stream'
  if (d.action === 'append-stream') return 'stream:' + d.streamId
  if (d.action === 'append-provider') return 'provider:' + d.providerId
  return undefined
}
