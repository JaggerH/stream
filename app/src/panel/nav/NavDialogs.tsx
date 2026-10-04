/**
 * 导航这一层能开出来的四张弹窗：建空间 / 改名空间 / 删空间 / 建频道。
 *
 * **就地渲染、不 portal**：portal 到 `document.body`
 * 去的是**宿主**的 body，浮层会拿宿主的配色、明暗还可能反着来，另有多实例 body 锁那一类
 * 已知的坑。所以这里是一层 `position:absolute; inset:0` 的遮罩 + 一张卡片，挂在导航根容器
 * （`position:relative`）里；不用 `components/ui/dialog.tsx` 那套 Radix 件。
 *
 * **写操作直接用面板自己那份 `api`**，不另起一套 REST 封装：`api.createSpace` /
 * `updateSpace` / `deleteSpace` / `createChannel` / `presents` 早就在那儿了，复刻一份只会
 * 多一处会和后端契约漂移的地方。失败一律往上报人话——静默失败的表现是"点了没反应"，
 * 和坏了长得一模一样。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { api, LOCAL } from '../../lib/api.ts'
import type { ChannelCreate } from '../../lib/types.ts'
import { channelStore } from './channel-store.ts'

/** 一档展示方式（建频道时选）。 */
interface PresentOption { id: string; label: string }

/** 拉不到 `/api/presents` 时的兜底：这张弹窗的作用是建频道，不该因为标签取不到就开不出来。 */
const FALLBACK_PRESENTS: PresentOption[] = [
  { id: 'timeline', label: '时间线' },
  { id: 'audio', label: '音乐/播客' },
  { id: 'video', label: '影视' },
  { id: 'research', label: '研究' },
  { id: 'search', label: '搜索' },
]

export type NavDialog =
  | { kind: 'new-space' }
  | { kind: 'rename-space'; space: { id: string; label: string } }
  | { kind: 'delete-space'; space: { id: string; label: string } }
  | { kind: 'new-channel'; spaceId?: string }

/**
 * 弹窗里的一个下拉选择——就地渲染的一小张列表，不是原生 `<select>`。
 *
 * 原生 `<select>` 的展开列表由操作系统画，配色和圆角都跟着系统走：暗色宿主里就是一块白底，
 * 而弹窗其余部件都是我们自己画的。
 */
function DialogSelect({ label, options, value, onChange, open, onOpenChange }: {
  label: string
  options: PresentOption[]
  value: string
  onChange: (id: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const current = options.find((o) => o.id === value)
  return (
    <label>
      {label}
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          aria-label={label}
          aria-expanded={open}
          onClick={() => { onOpenChange(!open) }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
            boxSizing: 'border-box', width: '100%', height: 32, padding: '0 8px', font: 'inherit', fontSize: 13,
            cursor: 'pointer', color: 'var(--stream-nav-label-primary)', background: 'transparent',
            border: '1px solid var(--stream-nav-border)', borderRadius: 8,
          }}
        >
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {current?.label ?? value}
          </span>
        </button>
        {open ? (
          <div className="stream-nav-menu" role="menu" style={{ left: 0, right: 0 }}>
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                role="menuitemradio"
                aria-checked={o.id === value}
                onClick={() => { onChange(o.id); onOpenChange(false) }}
              >
                {o.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </label>
  )
}

/**
 * 四张弹窗共用的宿主：输入 → 写 → 重拉名录。
 *
 * **写完一定要 `channelStore.load()`**：名录的真相源是那个 store，少了这一步建出来的东西
 * 要刷新整页才看得见，而且没有任何一处会报错。
 */
export function NavDialogs({ dialog, spaces, onClose, onError }: {
  dialog: NavDialog
  spaces: Array<{ id: string; label: string }>
  onClose: () => void
  onError: (message: string | null) => void
}): ReactElement {
  const [label, setLabel] = useState(dialog.kind === 'rename-space' ? dialog.space.label : '')
  const [present, setPresent] = useState('timeline')
  const [spaceId, setSpaceId] = useState(
    dialog.kind === 'new-channel' ? (dialog.spaceId ?? spaces[0]?.id ?? '') : '',
  )
  const [presents, setPresents] = useState<PresentOption[]>([])
  /** 同时只开一个下拉（两个都开着会重叠）。null = 都关着。 */
  const [openPicker, setOpenPicker] = useState<'present' | 'space' | null>(null)
  const [busy, setBusy] = useState(false)

  // Esc 关弹窗（写请求飞着时不关——关了请求照样落地，人却以为取消了）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || busy) return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [busy, onClose])

  useEffect(() => {
    if (dialog.kind !== 'new-channel') return
    let dead = false
    api.presents(LOCAL)
      .then((r) => { if (!dead && r.items.length > 0) setPresents(r.items.map((p) => ({ id: p.id, label: p.label }))) })
      .catch(() => { /* 用兜底 */ })
    return () => { dead = true }
  }, [dialog.kind])

  const options = presents.length > 0 ? presents : FALLBACK_PRESENTS

  const run = async (): Promise<void> => {
    setBusy(true)
    onError(null)
    try {
      if (dialog.kind === 'new-space') await api.createSpace(LOCAL, { label: label.trim() })
      else if (dialog.kind === 'rename-space') await api.updateSpace(LOCAL, dialog.space.id, { label: label.trim() })
      else if (dialog.kind === 'delete-space') await api.deleteSpace(LOCAL, dialog.space.id)
      else {
        await api.createChannel(LOCAL, {
          label: label.trim(),
          present: present as ChannelCreate['present'],
          // `stream_ids` / `options` 后端必填（非 partial 校验），建的时候都是空的。
          stream_ids: [],
          options: {},
          ...(spaceId === '' ? {} : { space_id: spaceId }),
        })
      }
      await channelStore.load()
      onClose()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const needsLabel = dialog.kind !== 'delete-space'
  const canSubmit = !busy && (!needsLabel || label.trim() !== '')
  const title =
    dialog.kind === 'new-space' ? '新建空间'
      : dialog.kind === 'rename-space' ? '重命名空间'
        : dialog.kind === 'delete-space' ? '删除空间'
          : '新建频道'

  return (
    <div className="stream-nav-overlay" onClick={onClose}>
      <div
        className="stream-nav-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // 遮罩点了就关，卡片自己吃掉这一下——不拦就是"在输入框里点一下弹窗没了"。
        onClick={(e) => { e.stopPropagation() }}
      >
        <h2>{title}</h2>
        {/* 说清"删的是分组不是内容"——不写这句，一个装着十个频道的分组前面的删除键很吓人。 */}
        {dialog.kind === 'delete-space'
          ? <p>{`将删除「${dialog.space.label}」。里面的频道不会被删除，会移回默认空间。`}</p>
          : null}
        {needsLabel ? (
          <input
            autoFocus
            value={label}
            aria-label="名称"
            placeholder={dialog.kind === 'new-channel' ? '频道名称' : '空间名称'}
            onChange={(e) => { setLabel(e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) void run() }}
          />
        ) : null}
        {dialog.kind === 'new-channel' ? (
          <div className="stream-nav-dialog-fields">
            <DialogSelect
              label="展示方式"
              options={options}
              value={present}
              onChange={setPresent}
              open={openPicker === 'present'}
              onOpenChange={(o) => { setOpenPicker(o ? 'present' : null) }}
            />
            {spaces.length > 0 ? (
              <DialogSelect
                label="放在哪个空间"
                options={spaces}
                value={spaceId}
                onChange={setSpaceId}
                open={openPicker === 'space'}
                onOpenChange={(o) => { setOpenPicker(o ? 'space' : null) }}
              />
            ) : null}
          </div>
        ) : null}
        <div className="stream-nav-dialog-footer">
          <button type="button" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="stream-nav-primary" onClick={() => { void run() }} disabled={!canSubmit}>
            {busy ? '处理中…' : dialog.kind === 'delete-space' ? '删除' : '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}
