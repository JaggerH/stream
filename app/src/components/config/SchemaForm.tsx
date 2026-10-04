// app/src/components/config/SchemaForm.tsx
//
// 配置 row 的通用表单：schema 由后端下发（schemastery toJSON），这里 `new Schema(json)`
// 复原后按字段类型渲染。spec 2026-08-17-config-rows-slice1 §5。
//
// 本片只渲染四类（首批三族用到的）：string、string+role('secret')（password 框 + 「已配置」
// placeholder）、string+role('textarea')、boolean。**手写表单只留给真需要定制交互的**
// （目录选择器、mustChoose 流程那类），加类型前先确认真有 row 用到。
//
// 密文语义：输入框留空提交 = 发空串，后端引擎保留存量——判据只有后端那一份，
// 客户端不复刻"空串是保留还是清空"的判断。
import { useEffect, useState } from 'react'
import Schema from 'schemastery'
import { Loader2 } from 'lucide-react'
import { toast } from '../acrylic/sonner.tsx'
import { Button } from '../ui/button.tsx'
import { api, type Connection, type ConfigRowStatus } from '../../lib/api.ts'

const inputCls =
  'w-full rounded-md border border-[var(--acr-border-soft)] bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors focus:border-foreground/40'

function fieldLabel(key: string, field: Schema): string {
  const d = field.meta.description
  if (typeof d === 'string') return d
  return key
}

/** 通用 row 表单。挂上去就自取自存：GET 取 schema+values，保存 PUT 后按响应刷新。 */
export function SchemaForm({ conn, rowId, onSaved }: { conn: Connection; rowId: string; onSaved?: () => void }) {
  const [status, setStatus] = useState<ConfigRowStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.config
      .get(conn, rowId)
      .then((next) => {
        if (!alive) return
        setStatus(next)
        setDraft({ ...next.values }) // 密文不在 values 里 → 草稿里天然是空串起步
      })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [conn, rowId])

  if (failed) return <div className="text-[12px] text-muted-foreground">后端不可达</div>
  if (!status) return <div className="text-[12px] text-muted-foreground">载入中…</div>

  const schema = new Schema(status.schema as never)
  const fields = Object.entries(schema.dict ?? {})

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const next = await api.config.put(conn, rowId, draft)
      setStatus(next)
      // 保存后回到"值来自服务端"的状态：密文草稿清空（存量已在后端），普通值取回显。
      setDraft({ ...next.values })
      toast.success('已保存')
      onSaved?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      {error && <p className="text-[12px] text-red-400">{error}</p>}
      {fields.map(([key, field]) => {
        const secret = field.meta.role === 'secret'
        const configured = secret && status.secrets[key]?.configured
        const value = draft[key]
        if (field.type === 'boolean') {
          return (
            <label key={key} className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <input
                type="checkbox"
                checked={Boolean(value)}
                onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.checked }))}
              />
              {fieldLabel(key, field)}
            </label>
          )
        }
        const common = {
          value: typeof value === 'string' ? value : value == null ? '' : String(value),
          onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            setDraft((d) => ({ ...d, [key]: e.target.value })),
        }
        return (
          <label key={key} className="flex flex-col gap-1">
            <span className="text-[12px] text-muted-foreground">
              {fieldLabel(key, field)}
              {configured ? '（留空保持不变）' : ''}
            </span>
            {field.meta.role === 'textarea' ? (
              <textarea className={`${inputCls} min-h-20`} {...common} />
            ) : (
              <input
                className={inputCls}
                type={secret ? 'password' : 'text'}
                placeholder={configured ? '••••••••' : typeof field.meta.default === 'string' ? field.meta.default : ''}
                {...common}
              />
            )}
          </label>
        )
      })}
      <div className="flex items-center gap-2 pt-0.5">
        <Button size="sm" type="button" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : '保存并应用'}
        </Button>
      </div>
    </div>
  )
}
