import { useEffect, useState } from 'react'
import { AlertTriangleIcon, ExternalLinkIcon } from 'lucide-react'
import { Button } from '../acrylic/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../acrylic/dialog.tsx'
import { Field, FieldDescription, FieldLabel } from '../acrylic/field.tsx'
import { Input } from '../acrylic/input.tsx'
import type { RuntimeConfigProvisioner } from '../../lib/types.ts'

/**
 * 「这一格 key 你还没有——两条路，选一条」。
 *
 * 摆两个按钮而不是一个，是因为这两条路的**代价完全不同**，而只有用户知道自己接不接受：
 *
 *  - **我自己去注册** → 就是今天那条外链（`helpUrl`），他去官网自己建、自己贴回来。
 *  - **一键帮我完成** → 在他自己的 Chrome 里打开那一页、用他**已经登录的账号**建一把新 key。
 *    这是一个真实的账户级副作用（对方账号里会多出一条 key），所以文案必须把这四件事逐条说清
 *    ——用哪个浏览器、用谁的身份、在哪个站、结果落到哪。口径与 `run_action_recipe` 的二次确认
 *    一致：**复述具体会发生什么**，不是一句"确定吗"。
 *
 * 和 `InstallConfirmDialog` 同一套交互语汇（acrylic Dialog + 顶部警示块 + 页脚两颗按钮），
 * 因为它们是同一件事的两个实例：**一个不可撤销的副作用，摆在眼前再动手**。别新造第三种。
 *
 * 它不做的两件事：不替用户猜哪条路更好（两颗按钮同等分量，主按钮只是视觉重心）；
 * 失败了不自己关掉——错误留在原地，因为下一步动作（重试 / 改名 / 转去自己注册）就在这张卡上。
 */
export function SourceProvisionDialog({
  open,
  onOpenChange,
  provisioner,
  fieldLabel,
  helpUrl,
  busy,
  error,
  onRun,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  provisioner: RuntimeConfigProvisioner
  /** 这一格在配置卡上的名字（"Groq API Key"）——用户认得的是它，不是字段名。 */
  fieldLabel: string
  /** 自己去注册那条路的落点；manifest 没声明就退回 recipe 会打开的那一页。 */
  helpUrl?: string
  busy: boolean
  error: string | null
  onRun: (params: Record<string, string>) => void
}) {
  const paramEntries = Object.entries(provisioner.paramsSchema ?? {}) as Array<[string, { required?: boolean; description?: string }]>
  const [params, setParams] = useState<Record<string, string>>({})

  // 每次打开都换一批默认值：建 key **不幂等**，同名重跑会在对方账号里堆出一排看不出区别的
  // key。所以后缀由这里现生成，而不是写死一个常量或沿用上一次那份。
  useEffect(() => {
    if (!open) return
    setParams(Object.fromEntries(paramEntries.map(([key, spec]) => [key, spec.required ? suggestedName() : ''])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provisioner.sourceId])

  const missing = paramEntries.find(([key, spec]) => spec.required && !params[key]?.trim())
  const externalUrl = helpUrl || provisioner.entryUrl

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>还没有 {fieldLabel}</DialogTitle>
          <DialogDescription>两条路，选一条——也可以直接关掉，自己把 key 粘进上面那个输入框。</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-[12px]">
          {/* 警示块摆在最上面、不折叠：这一键的副作用发生在**用户自己的账号里**，
              把它收进"详情"就等于让人在不知情的情况下点下去。 */}
          <div className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-2">
            <strong className="flex items-center gap-1.5 text-destructive">
              <AlertTriangleIcon className="size-3.5 shrink-0" />
              「一键帮我完成」会动你的 {provisioner.label} 账号
            </strong>
            <ul className="ml-5 list-disc text-destructive/90">
              <li>在<strong>你自己那个 Chrome</strong> 里打开 <span className="break-all font-mono">{provisioner.entryUrl}</span>（会看得见）</li>
              <li>用你<strong>已经登录</strong>的 {provisioner.label} 账号新建一把 API key</li>
              <li>把那把只显示一次的明文直接存进本机配置的 {fieldLabel} 这一格</li>
              <li>要几十秒；中途可能撞上登录墙或人机验证，那就得你自己接手</li>
            </ul>
          </div>

          {paramEntries.map(([key, spec]) => (
            <Field key={key} orientation="vertical">
              <FieldLabel htmlFor={`provision-${key}`}>{key}{spec.required ? ' *' : ''}</FieldLabel>
              <Input id={`provision-${key}`} value={params[key] ?? ''} disabled={busy}
                onChange={(event) => setParams((prev) => ({ ...prev, [key]: event.target.value }))} />
              {spec.description ? <FieldDescription>{spec.description}</FieldDescription> : null}
            </Field>
          ))}

          {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="neutral" size="medium" asChild>
            <a href={externalUrl} target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              我自己去注册
            </a>
          </Button>
          <Button size="medium" disabled={busy || !!missing} onClick={() => onRun(params)}>
            {busy ? '正在办…' : '一键帮我完成'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 一个能把两次运行区分开的名字。随机段只为"别撞名"，不承载任何语义。 */
function suggestedName(): string {
  return `stream-auto-${Math.random().toString(16).slice(2, 6)}`
}
