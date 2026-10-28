import type { TaskOutcome } from '../tasks/types.ts'

export interface HelperAccount {
  id: string
  displayName: string
  version: string
  enabled: boolean
  status: string
  lastError?: string
  lastCheckin?: string
  lastCheckinDate?: string
  lastPointsAt?: string
  tokenExpiresAt?: number
  balance: number
  used?: number
  total?: number
}

export interface HelperState {
  accounts: HelperAccount[]
  settings: { scheduleEnabled: boolean; scheduleTime: string }
  summary: { accounts: number; enabled: number; balance: number }
  serverTime: string
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Explicit projection: a future Helper response must not accidentally expose tokens via Stream. */
function accountView(raw: HelperAccount): HelperAccount {
  if (typeof raw?.id !== 'string' || raw.id === '') throw new Error('WorkBuddy Helper 返回了没有 id 的账号')
  return {
    id: raw.id,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : raw.id,
    version: typeof raw.version === 'string' ? raw.version : '',
    enabled: raw.enabled === true,
    status: typeof raw.status === 'string' ? raw.status : '',
    ...(typeof raw.lastError === 'string' ? { lastError: raw.lastError } : {}),
    ...(typeof raw.lastCheckin === 'string' ? { lastCheckin: raw.lastCheckin } : {}),
    ...(typeof raw.lastCheckinDate === 'string' ? { lastCheckinDate: raw.lastCheckinDate } : {}),
    ...(typeof raw.lastPointsAt === 'string' ? { lastPointsAt: raw.lastPointsAt } : {}),
    ...(typeof raw.tokenExpiresAt === 'number' ? { tokenExpiresAt: raw.tokenExpiresAt } : {}),
    balance: typeof raw.balance === 'number' ? raw.balance : 0,
    ...(typeof raw.used === 'number' ? { used: raw.used } : {}),
    ...(typeof raw.total === 'number' ? { total: raw.total } : {}),
  }
}

/** Helper is a local account vault. Never forward its page token or account credentials to the panel. */
export class HelperClient {
  private readonly origin: string
  private readonly fetcher: Fetcher
  private pageToken: string | undefined

  constructor(rawUrl: string, fetcher: Fetcher = fetch) {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('WorkBuddy Helper 只能通过本机 HTTP 地址连接')
    }
    this.origin = url.origin
    this.fetcher = fetcher
  }

  private async token(): Promise<string> {
    if (this.pageToken) return this.pageToken
    const response = await this.fetcher(`${this.origin}/`)
    if (!response.ok) throw new Error(`WorkBuddy Helper 页面不可用（HTTP ${response.status}）`)
    const html = await response.text()
    const token = html.match(/<meta\s+name=["']app-token["']\s+content=["']([^"']+)["']/i)?.[1]
    if (!token) throw new Error('WorkBuddy Helper 没有返回页面令牌；可能启用了 Basic Auth 或版本不兼容')
    this.pageToken = token
    return token
  }

  private async request<T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown): Promise<T> {
    const send = async (): Promise<Response> => {
      const headers = new Headers()
      if (method !== 'GET') {
        headers.set('Content-Type', 'application/json')
        headers.set('X-App-Token', await this.token())
      }
      return await this.fetcher(`${this.origin}${path}`, {
        method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    }
    let response = await send()
    if (response.status === 403 && method !== 'GET') {
      this.pageToken = undefined
      response = await send()
    }
    if (!response.ok) {
      const raw = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(`WorkBuddy Helper HTTP ${response.status}: ${raw.error ?? '请求失败'}`)
    }
    return await response.json() as T
  }

  async state(): Promise<HelperState> {
    const raw = await this.request<HelperState>('/api/state')
    if (!Array.isArray(raw.accounts) || typeof raw.settings?.scheduleEnabled !== 'boolean') {
      throw new Error('WorkBuddy Helper 状态格式不兼容')
    }
    const accounts = raw.accounts.map(accountView)
    return {
      accounts,
      settings: { scheduleEnabled: raw.settings.scheduleEnabled, scheduleTime: raw.settings.scheduleTime },
      summary: { accounts: accounts.length, enabled: accounts.filter((a) => a.enabled).length, balance: accounts.reduce((n, a) => n + a.balance, 0) },
      serverTime: raw.serverTime,
    }
  }
  async runAll(): Promise<{ accounts: HelperAccount[] }> {
    const raw = await this.request<{ accounts: HelperAccount[] }>('/api/run-all', 'POST', { version: 'cn' })
    if (!Array.isArray(raw.accounts)) throw new Error('WorkBuddy Helper 签到结果格式不兼容')
    return { accounts: raw.accounts.map(accountView) }
  }
  async checkin(id: string): Promise<{ account: HelperAccount }> {
    const raw = await this.request<{ account: HelperAccount }>(`/api/accounts/${encodeURIComponent(id)}/checkin`, 'POST')
    return { account: accountView(raw.account) }
  }
  async points(id: string): Promise<{ account: HelperAccount }> {
    const raw = await this.request<{ account: HelperAccount }>(`/api/accounts/${encodeURIComponent(id)}/points`, 'POST')
    return { account: accountView(raw.account) }
  }
  async setEnabled(id: string, enabled: boolean): Promise<{ account: HelperAccount }> {
    const raw = await this.request<{ account: HelperAccount }>(`/api/accounts/${encodeURIComponent(id)}`, 'PUT', { enabled })
    return { account: accountView(raw.account) }
  }
  remove(id: string): Promise<{ deleted: boolean }> {
    return this.request(`/api/accounts/${encodeURIComponent(id)}`, 'DELETE')
  }
  loginStart(): Promise<{ loginId: string; authUrl: string }> {
    return this.request('/api/login/start', 'POST', { version: 'cn' })
  }
  async loginPoll(loginId: string): Promise<{ status: string; message?: string; account?: HelperAccount }> {
    const raw = await this.request<{ status: string; message?: string; account?: HelperAccount }>('/api/login/poll', 'POST', { loginId })
    if (raw.status !== 'pending' && raw.status !== 'complete') throw new Error('WorkBuddy Helper 登录状态格式不兼容')
    return {
      status: raw.status,
      ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
      ...(raw.account ? { account: accountView(raw.account) } : {}),
    }
  }
  disableOwnSchedule(): Promise<void> {
    return this.request('/api/settings', 'PUT', { scheduleEnabled: false }).then(() => undefined)
  }
}

export function checkinOutcome(accounts: HelperAccount[], today: string): TaskOutcome {
  if (accounts.length === 0) throw new Error('WorkBuddy Helper 没有启用的国内版账号')
  const failed = accounts.filter((a) => a.lastCheckinDate !== today || !['confirmed', 'already_done'].includes(a.lastCheckin ?? ''))
  if (failed.length) {
    throw new Error(`WorkBuddy 签到失败：${failed.map((a) => `${a.displayName || a.id}${a.lastError ? `（${a.lastError}）` : ''}`).join('、')}`)
  }
  return {
    summary: `${accounts.length} 个账号已签到或今日已签` ,
    detail: accounts.map((a) => ({ id: a.id, name: a.displayName, status: a.lastCheckin, balance: a.balance, pointsCheckedAt: a.lastPointsAt ?? null })),
  }
}
