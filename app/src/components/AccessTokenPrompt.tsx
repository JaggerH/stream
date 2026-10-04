import { useEffect, useState } from 'react'
import { Button } from './ui/button.tsx'
import { LOCAL, setAccessToken } from '../lib/api.ts'

/**
 * 「从别的设备访问要出示令牌」的那一下。
 *
 * 后端对本机 loopback 免密，所以**在运行 Stream 的那台机器上永远见不到这个框**；它只在
 * 手机/局域网访问、而链接里又没带 `?token=` 时出现（api.ts 收到 401 就派发那个事件）。
 *
 * 存进 localStorage 后原地刷新：整页的数据请求已经在这一轮里失败过了，一个个补发不如重来。
 */
export function AccessTokenPrompt() {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')

  useEffect(() => {
    const on = () => setOpen(true)
    window.addEventListener('stream:unauthorized', on)
    return () => window.removeEventListener('stream:unauthorized', on)
  }, [])

  if (!open) return null

  const submit = () => {
    if (!value.trim()) return
    setAccessToken(value)
    window.location.reload()
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-6">
      <div className="w-full max-w-sm space-y-3 rounded-lg border border-[var(--acr-border-soft)] bg-[var(--acr-surface,#1a1a1a)] p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">需要访问令牌</h2>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            你正在从别的设备访问 Stream。在运行 Stream 的那台机器上打开设置 → 远程访问，
            复制令牌（或直接用那里的链接打开本页）。
          </p>
        </div>
        <input
          autoFocus
          className="w-full rounded-md border border-[var(--acr-border-soft)] bg-transparent px-2.5 py-1.5 font-mono text-[12px] outline-none transition-colors focus:border-foreground/40"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          placeholder="粘贴访问令牌"
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>稍后</Button>
          <Button size="sm" type="button" onClick={submit} disabled={!value.trim()}>
            {LOCAL.token ? '换一个令牌' : '保存并重试'}
          </Button>
        </div>
      </div>
    </div>
  )
}
