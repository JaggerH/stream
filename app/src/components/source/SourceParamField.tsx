import { useState } from 'react'
import { FolderOpenIcon, InfoIcon } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../acrylic/select.tsx'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../acrylic/hover-card.tsx'
import { Field, FieldLabel } from '../acrylic/field.tsx'
import { Input } from '../acrylic/input.tsx'
import { Button } from '../acrylic/button.tsx'
import { NetdiskDirPickerDialog } from '../netdisk/NetdiskPicker.tsx'
import { Markdown } from './RsshubRouteMarkdown.tsx'
import { paramOptions } from '../../lib/source.ts'
import type { ParamSpec } from '../../lib/types.ts'

/** 一个参数控件拿到的全部东西：填哪个值、怎么写回、后端在哪。控件不认识 source，也不该认识。 */
type ParamWidgetProps = { id: string; value: string; onChange: (value: string) => void; apiBase: string }

/**
 * **参数控件登记表**：manifest 的 `params_schema.<key>.widget` 声明「这个字符串参数用哪种
 * 控件填」，这里把那个 key 兑成一个真控件。
 *
 * 判据是**声明式**的，不是 `if (source === 'alist-audio')` 那种 id 硬编码——后者把站点知识
 * 搬进了通用组件，而且下一个需要同样控件的源来了只能再加一行 if。分工：哪个网盘、哪条路径
 * 是**站点知识**，写在 manifest 里；「一个字符串参数可以用选择器填」是**通用机制**，住这里。
 * 后端对 params_schema 是完全不透明的（`z.record(z.string(), z.unknown())`，原样透传给
 * `/api/plugins/:id/sources/:sourceId` 的 paramsSchema），所以加一个 widget 声明零后端成本。
 *
 * 加一种控件 = 这张表加一行 + 对应 manifest 里写 `widget: <key>`。
 * 认不出来的 key **静默退回纯文本框**：参数本来就是字符串，控件只是省一次手敲，不该把整个
 * 配置面板打掉。
 */
const PARAM_WIDGETS: Record<string, (props: ParamWidgetProps) => React.ReactElement> = {
  'netdisk-dir': NetdiskDirParamInput,
}

export function SourceParamField({
  name,
  spec,
  value,
  onChange,
  container,
  apiBase = '',
}: {
  name: string
  spec: ParamSpec
  value: string
  onChange: (value: string) => void
  /** Portal target for the description HoverCard — pass the Sheet's content node so it
   *  stays hoverable inside a modal Sheet (see SourceConfigSheet). */
  container?: HTMLElement | null
  /** 后端地址，转给需要它的参数控件（目录选择器要去列网盘目录）。 */
  apiBase?: string
}) {
  const Widget = spec.widget ? PARAM_WIDGETS[spec.widget] : undefined
  const options = paramOptions(spec)
  const fieldId = `param-${name}`
  // 走 Field + acrylic Input，不再由调用方传一串手搓的 inputClassName —— 那是本 Sheet 的字阶/
  // 控件样式和别处对不上的来源之一。Field 不带 size：13px 的默认字阶，和 BackendSettings /
  // StreamSettingPage 等其他 config sheet 对齐。
  return (
    <Field orientation="vertical">
      <div className="flex items-center gap-1">
        <FieldLabel htmlFor={fieldId}>{name}{spec.required ? ' *' : ''}</FieldLabel>
        {spec.description ? (
          <HoverCard openDelay={100}>
            <HoverCardTrigger asChild>
              {/* type=button so it never submits; tabIndex=-1 so the Sheet's open-autofocus
                  doesn't land here and pop the card open (HoverCard opens on focus too). */}
              <button type="button" tabIndex={-1} aria-label={`${name} 说明`} className="inline-flex text-muted-foreground/70 transition-colors hover:text-foreground">
                <InfoIcon className="size-3.5" />
              </button>
            </HoverCardTrigger>
            <HoverCardContent container={container} align="start" className="max-h-80 w-80 overflow-y-auto">
              <Markdown text={spec.description} />
            </HoverCardContent>
          </HoverCard>
        ) : null}
      </div>
      {Widget ? (
        <Widget id={fieldId} value={value} onChange={onChange} apiBase={apiBase} />
      ) : options.length ? (
        <Select value={value || spec.default || undefined} onValueChange={onChange}>
          <SelectTrigger id={fieldId} className="w-full">
            <SelectValue placeholder={spec.default || '选择一个选项'} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input id={fieldId} value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </Field>
  )
}

/**
 * 网盘目录参数：文本框 + 「浏览」。
 *
 * 输入框**保持可编辑**——选择器省的是手敲，不是取代手敲：路径已经知道时直接粘一条比点开
 * 弹窗一层层走进去快，而且这是唯一能在 AList 暂时列不出目录时仍把参数填进去的路。
 *
 * 选择器是 Dialog、这里又住在 SourceConfigSheet（也是 Radix 的 Dialog）里 —— Dialog 套
 * Dialog 是 Radix 支持的（ReconcilePanel 里同一个弹窗就这么用着）。不用 Popover：它见到
 * 自己 portal 之外的焦点/点击就自关，点「浏览」那一刻整个编辑器会被连根卸掉。
 */
function NetdiskDirParamInput({ id, value, onChange, apiBase }: ParamWidgetProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  return (
    <>
      <div className="flex w-full items-center gap-2">
        <Input id={id} className="flex-1" value={value}
          placeholder="/夸克网盘/我的转存/某节目"
          onChange={(event) => onChange(event.target.value)} />
        <Button type="button" size="small" variant="neutral" onClick={() => setPickerOpen(true)}>
          <FolderOpenIcon /> 浏览
        </Button>
      </div>
      <NetdiskDirPickerDialog
        apiBase={apiBase}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={value || '/'}
        onPick={(path) => { onChange(path); setPickerOpen(false) }}
      />
    </>
  )
}
