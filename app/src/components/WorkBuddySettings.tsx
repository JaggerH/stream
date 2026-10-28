import { useCallback, useEffect, useState } from 'react'
import { Button } from './acrylic/button.tsx'
import { SettingsBlock, SettingsGroup, SettingsRow, SettingsSection } from './settings/SettingsSection.tsx'
import { fetchTasks, putTask, saveTask, type TaskListItem } from '../lib/api.tasks.ts'

interface Account {
  id: string; displayName: string; version: string; enabled: boolean; status: string
  lastError?: string; lastCheckin?: string; lastCheckinDate?: string; lastPointsAt?: string
  balance: number; tokenExpiresAt?: number
}
interface State {
  accounts: Account[]
  settings: { scheduleEnabled: boolean; scheduleTime: string }
  summary: { accounts: number; enabled: number; balance: number }
}
const TASK_ID = 'workbuddy-daily-checkin'

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export function WorkBuddySettings({ apiBase }: { apiBase: string }) {
  const [state, setState] = useState<State | null>(null)
  const [task, setTask] = useState<TaskListItem | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [time, setTime] = useState('09:15')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [login, setLogin] = useState<{ id: string; url: string } | null>(null)

  const call = useCallback(async <T,>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`${apiBase}/api/workbuddy${path}`, {
      method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const value = await response.json() as T & { error?: string }
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    return value
  }, [apiBase])

  const reload = useCallback(async () => {
    const [helperResult, tasksResult] = await Promise.allSettled([call<State>('/state'), fetchTasks(apiBase)])
    if (helperResult.status === 'fulfilled') setState(helperResult.value)
    else { setState(null); setError(message(helperResult.reason)) }
    if (tasksResult.status === 'rejected') throw tasksResult.reason
    const daily = tasksResult.value.tasks.find((row) => row.id === TASK_ID && row.source === 'user') ?? null
    setTask(daily)
    setEnabled(daily?.enabled ?? false)
    if (daily) {
      const match = daily.schedule.match(/^0 (\d{1,2}) (\d{1,2}) \* \* \*$/)
      if (match) setTime(`${match[2]!.padStart(2, '0')}:${match[1]!.padStart(2, '0')}`)
    }
  }, [apiBase, call])

  useEffect(() => { void reload().catch((e) => setError(message(e))) }, [reload])

  useEffect(() => {
    if (!login) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await call<{ status: string }>('/login/poll', 'POST', { loginId: login.id })
        if (stopped) return
        if (result.status === 'complete') {
          setLogin(null)
          setNotice('账号已添加')
          await reload()
        } else {
          timer = setTimeout(() => { void poll() }, 2000)
        }
      } catch (e) {
        if (!stopped) { setLogin(null); setError(message(e)) }
      }
    }
    timer = setTimeout(() => { void poll() }, 1500)
    return () => { stopped = true; clearTimeout(timer) }
  }, [login, call, reload])

  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('')
    try { await work(); await reload() }
    catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  const saveSchedule = () => act(async () => {
    const [hour, minute] = time.split(':').map(Number)
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour! < 0 || hour! > 23 || minute! < 0 || minute! > 59) {
      throw new Error('时间必须是 HH:MM')
    }
    const schedule = `0 ${minute} ${hour} * * *`
    if (enabled) await call('/claim-schedule', 'POST')
    if (task) await saveTask(apiBase, task, { schedule, enabled })
    else await putTask(apiBase, {
      id: TASK_ID, label: 'WorkBuddy 每日签到', action: 'workbuddy:checkin',
      schedule, timezone: 'Asia/Shanghai', args: [], serial: true, whenBusy: 'skip', maxAttempts: 1,
      group: 'WorkBuddy', enabled,
    })
    setNotice(enabled ? '已交给 Stream 定时执行' : '已暂停 Stream 定时签到')
  })

  const beginLogin = () => act(async () => {
    const result = await call<{ loginId: string; authUrl: string }>('/login/start', 'POST')
    const url = new URL(result.authUrl)
    const host = url.hostname.toLowerCase()
    const trusted = host === 'codebuddy.cn' || host.endsWith('.codebuddy.cn') || host === 'copilot.tencent.com' || host.endsWith('.copilot.tencent.com')
    if (url.protocol !== 'https:' || (url.port && url.port !== '443') || !trusted) throw new Error('Helper 返回了不受信任的登录地址')
    setLogin({ id: result.loginId, url: result.authUrl })
    setNotice('请打开腾讯授权页，完成后此处会自动识别')
  })

  return <SettingsGroup className="p-4">
    <SettingsSection title="WorkBuddy 账号" footnote="账号凭据保存在本机 WorkBuddy Helper；Magpie 的对话反代保持独立。">
      <SettingsBlock>
        <SettingsRow label="连接" control={<span className="text-[11px] text-muted-foreground">{state ? `已连接 · ${state.summary.accounts} 个账号` : '未连接'}</span>} />
        <SettingsRow label="账号" control={<div className="flex gap-2"><Button size="small" onClick={() => void beginLogin()} disabled={busy}>添加账号</Button><Button size="small" variant="neutral" onClick={() => void act(async () => {})} disabled={busy}>刷新</Button><Button size="small" variant="neutral" onClick={() => void act(async () => { await call('/checkin', 'POST') })} disabled={busy || !state?.accounts.some((a) => a.version === 'cn' && a.enabled)}>全部签到</Button></div>} />
      </SettingsBlock>
    </SettingsSection>
    {login ? <div className="rounded-lg bg-[var(--acr-card-nested)] p-3 text-[13px]">
      <a href={login.url} target="_blank" rel="noopener noreferrer" className="underline">打开腾讯授权页</a>
      <span className="ml-3 text-muted-foreground">等待登录完成…</span>
    </div> : null}
    {state ? <SettingsSection title="积分与签到" footnote="“已签到”是 Helper 的接口状态；余额以最近一次积分查询时间为准。">
      <div className="divide-y divide-[var(--acr-border-soft)] rounded-[10px] bg-[var(--acr-card-nested)]">
        {state.accounts.filter((a) => a.version === 'cn').map((a) => <div key={a.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
          <span className="min-w-24 font-medium">{a.displayName}</span>
          <span>{a.balance} 积分</span>
          <span className="text-[11px] text-muted-foreground">{a.lastCheckinDate ? `${a.lastCheckinDate} ${a.lastCheckin === 'confirmed' || a.lastCheckin === 'already_done' ? '已签到' : a.lastCheckin || '未签到'}` : '未签到'}</span>
          <span className="text-[11px] text-muted-foreground">积分查询：{a.lastPointsAt ? new Date(a.lastPointsAt).toLocaleString('zh-CN') : '尚未查询'}</span>
          <div className="ml-auto flex gap-1">
            <Button size="small" variant="neutral" disabled={busy || !a.enabled} onClick={() => void act(async () => { await call(`/accounts/${encodeURIComponent(a.id)}/checkin`, 'POST') })}>签到</Button>
            <Button size="small" variant="neutral" disabled={busy} onClick={() => void act(async () => { await call(`/accounts/${encodeURIComponent(a.id)}/points`, 'POST') })}>查积分</Button>
            <Button size="small" variant="neutral" disabled={busy} onClick={() => void act(async () => { await call(`/accounts/${encodeURIComponent(a.id)}`, 'PUT', { enabled: !a.enabled }) })}>{a.enabled ? '停用' : '启用'}</Button>
            <Button size="small" variant="neutral" disabled={busy} onClick={() => { if (window.confirm(`从 Helper 删除 ${a.displayName}？`)) void act(async () => { await call(`/accounts/${encodeURIComponent(a.id)}`, 'DELETE') }) }}>删除</Button>
          </div>
        </div>)}
      </div>
    </SettingsSection> : null}
    <SettingsSection title="每日自动签到" footnote="排期由 Stream 的任务中心执行；保存启用时会先关闭 Helper 自带的定时签到。历次结果在 Stream 任务页查看。">
      <SettingsBlock>
        <SettingsRow label="启用" control={<input aria-label="每日自动签到" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />} />
        <SettingsRow label="北京时间" control={<input aria-label="签到时间" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="rounded bg-transparent px-1 text-[13px]" />} />
        <SettingsRow label="排期" control={<Button size="small" disabled={busy} onClick={() => void saveSchedule()}>保存排期</Button>} />
      </SettingsBlock>
    </SettingsSection>
    {error ? <p role="alert" className="px-3 text-[12px] text-destructive">{error}</p> : null}
    {notice ? <p role="status" className="px-3 text-[12px] text-muted-foreground">{notice}</p> : null}
  </SettingsGroup>
}
