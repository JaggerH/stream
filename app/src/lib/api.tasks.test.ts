import { describe, expect, it, vi, beforeEach } from 'vitest'
import { saveTask, type TaskListItem } from './api.tasks.ts'

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

const task = (over: Partial<TaskListItem>): TaskListItem => ({
  id: 't1', label: 'T', schedule: '0 0 9 * * *', source: 'user', enabled: true, lastRun: null,
  action: '@streamapp/xhs:post', args: [], ...over,
})

describe('saveTask', () => {
  it('整行回写带上执行位置：暂停不能顺手清掉设备 / 身份 / 环境', async () => {
    fetchMock.mockImplementation(async (_u: string, init: RequestInit) =>
      new Response(JSON.stringify({ task: JSON.parse(String(init.body)) }), { status: 200 }))
    for (const where of [{ device: 'linux:nas' }, { identity: 'u_123' }, { environment: '工作' }]) {
      await saveTask('http://x', task(where), { enabled: false })
      const body = JSON.parse(String(fetchMock.mock.lastCall![1].body)) as Record<string, unknown>
      expect(body).toMatchObject({ ...where, enabled: false })
    }
  })
})
