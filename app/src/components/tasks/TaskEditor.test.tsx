import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TaskEditor } from './TaskEditor.tsx'
import type { TaskListItem } from '../../lib/api.tasks.ts'

/**
 * 「跑什么」那一格：一条用户任务的执行体有两种——**外部命令**，或者**包提供的动作**。
 *
 * 这一档没有测试的话，那个下拉切换里最容易错的一步不会被任何东西挡住：切到动作档时必须把
 * `command`/`args`/`cwd`/`env` 清掉。留着的话保存时两个执行体同时在场，后端 400 拒
 * （「command 和 action 只能给一个」），而那句话跟用户刚才点的那个下拉毫无关系。
 */

const ACTIONS = ['eastmoney:calendar', 'eastmoney:repo']

function setup(over: { task?: TaskListItem | null; actions?: string[] } = {}) {
  const onSaved = vi.fn()
  render(
    <TaskEditor
      apiBase="http://x"
      conn={{ baseUrl: 'http://x' }}
      task={over.task ?? null}
      existingIds={[]}
      actions={over.actions ?? ACTIONS}
      onSaved={onSaved}
      onDeleted={vi.fn()}
      onCancel={vi.fn()}
    />,
  )
  return { onSaved }
}

/** 取那一次 PUT 的 body——「发过去的执行体是哪一个」只能这么验。 */
function putBody(id: string): Record<string, unknown> | undefined {
  const call = vi.mocked(fetch).mock.calls.find(([u, i]) =>
    String(u).endsWith(`/api/tasks/${encodeURIComponent(id)}`) && (i as RequestInit | undefined)?.method === 'PUT')
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    // 「用哪一格」的下拉：编辑器一挂载就读它，读失败不挡编辑但会多一条报错文案。
    if (u.endsWith('/api/packages')) {
      return new Response(JSON.stringify({ packages: [{ id: 'eastmoney', slots: { config: ['eastmoney'] } }] }))
    }
    // 「账号 / 密钥」那一格是嵌进来的 `SchemaForm`，绑了 configRef 就会去读那一行。
    // 这里让它读失败：它有自己的降级分支（显示读不到的原因，不挡编辑），而这个文件验的是
    // **任务那一半**。给一份假 schema 反而要维护第二份 schemastery 序列化格式。
    if (u.includes('/api/config/')) return new Response('nope', { status: 500 })
    if (init?.method === 'PUT') return new Response(JSON.stringify({ task: JSON.parse(String(init.body)) }))
    return new Response(JSON.stringify({ ok: true }))
  }))
})

describe('TaskEditor —— 跑什么（执行体二选一）', () => {
  it('默认是外部命令档：有 command，没有 action 下拉', async () => {
    setup()
    await screen.findByTestId('task-editor')
    expect((screen.getByTestId('task-field-kind') as HTMLSelectElement).value).toBe('command')
    expect(screen.getByTestId('task-field-command')).toBeTruthy()
    expect(screen.queryByTestId('task-field-action')).toBeNull()
  })

  it('一个包动作都没有 ⇒ 那一档不可选（不是给一个选了会 400 的空下拉）', async () => {
    setup({ actions: [] })
    await screen.findByTestId('task-editor')
    const opt = [...(screen.getByTestId('task-field-kind') as HTMLSelectElement).options]
      .find((o) => o.value === 'action')!
    expect(opt.disabled).toBe(true)
  })

  it('切到动作档 ⇒ 画出 action 下拉、收起 command/args/cwd/env', async () => {
    setup()
    await screen.findByTestId('task-editor')
    fireEvent.change(screen.getByTestId('task-field-kind'), { target: { value: 'action' } })
    expect((screen.getByTestId('task-field-action') as HTMLSelectElement).value).toBe('eastmoney:calendar')
    expect(screen.queryByTestId('task-field-command')).toBeNull()
    expect(screen.queryByTestId('task-field-cwd')).toBeNull()
    expect(screen.queryByTestId('task-arg-add')).toBeNull()
    expect(screen.queryByTestId('task-env-add')).toBeNull()
  })

  // 这一条是整个文件存在的理由：切档时留着 command，保存就撞后端的「只能给一个」。
  it('建一条动作任务 ⇒ PUT 里只有 action，没有 command', async () => {
    setup()
    await screen.findByTestId('task-editor')
    fireEvent.change(screen.getByTestId('task-field-id'), { target: { value: 'em-repo' } })
    fireEvent.change(screen.getByTestId('task-field-label'), { target: { value: '东财 逆回购' } })
    fireEvent.change(screen.getByTestId('task-field-kind'), { target: { value: 'action' } })
    fireEvent.change(screen.getByTestId('task-field-action'), { target: { value: 'eastmoney:repo' } })
    fireEvent.click(screen.getByTestId('task-editor-save'))
    await waitFor(() => expect(putBody('em-repo')).toBeTruthy())
    const body = putBody('em-repo')!
    expect(body.action).toBe('eastmoney:repo')
    expect(body.command).toBeUndefined()
    expect(body.args).toEqual([])
  })

  // **先填了命令、再改主意切到动作** —— 这才是那个清空动作真正防的场景。不清的话，
  // 保存时 command 和 action 同时在场，后端 400「只能给一个」，而那句话跟刚才那个下拉无关。
  // （空着就切档验不出这条：空串在保存那一步本来就会被丢掉，清不清都一样。）
  it('填过命令再切到动作 ⇒ 那条命令不会跟着一起发出去', async () => {
    setup()
    await screen.findByTestId('task-editor')
    fireEvent.change(screen.getByTestId('task-field-id'), { target: { value: 'switched' } })
    fireEvent.change(screen.getByTestId('task-field-label'), { target: { value: '改过主意的' } })
    fireEvent.change(screen.getByTestId('task-field-command'), { target: { value: '/bin/python' } })
    fireEvent.change(screen.getByTestId('task-field-cwd'), { target: { value: '/work' } })
    fireEvent.change(screen.getByTestId('task-field-kind'), { target: { value: 'action' } })
    fireEvent.click(screen.getByTestId('task-editor-save'))
    await waitFor(() => expect(putBody('switched')).toBeTruthy())
    const body = putBody('switched')!
    expect(body.action).toBe('eastmoney:calendar')
    expect(body.command).toBeUndefined()
    expect(body.cwd).toBeUndefined()
  })

  // 反向：命令档保存时不许夹带一个 action 键（同一道 400 的另一半）。
  it('建一条命令任务 ⇒ PUT 里只有 command，没有 action', async () => {
    setup()
    await screen.findByTestId('task-editor')
    fireEvent.change(screen.getByTestId('task-field-id'), { target: { value: 'plain' } })
    fireEvent.change(screen.getByTestId('task-field-label'), { target: { value: '普通命令' } })
    fireEvent.change(screen.getByTestId('task-field-command'), { target: { value: '/bin/true' } })
    fireEvent.click(screen.getByTestId('task-editor-save'))
    await waitFor(() => expect(putBody('plain')).toBeTruthy())
    const body = putBody('plain')!
    expect(body.command).toBe('/bin/true')
    expect(body.action).toBeUndefined()
  })

  it('两个执行体都空 ⇒ 保存键禁用（后端也会 400，但要在按下之前就看得见）', async () => {
    setup()
    await screen.findByTestId('task-editor')
    fireEvent.change(screen.getByTestId('task-field-id'), { target: { value: 'x' } })
    fireEvent.change(screen.getByTestId('task-field-label'), { target: { value: 'x' } })
    expect((screen.getByTestId('task-editor-save') as HTMLButtonElement).disabled).toBe(true)
  })

  // 改一条已有的动作任务：草稿要**照原样**带过来。把缺席的 command 补成空串的话，
  // 一保存就是"两个都给了"。
  it('打开一条已有的动作任务 ⇒ 直接落在动作档，保存仍只发 action', async () => {
    const task: TaskListItem = {
      id: 'em-repo', label: '东财 逆回购', schedule: '0 55 14 * * 1-5',
      source: 'user', enabled: true, lastRun: null,
      action: 'eastmoney:repo', args: [], serial: true, maxAttempts: 1, configRef: 'eastmoney',
    }
    setup({ task })
    await screen.findByTestId('task-editor')
    expect((screen.getByTestId('task-field-kind') as HTMLSelectElement).value).toBe('action')
    expect((screen.getByTestId('task-field-action') as HTMLSelectElement).value).toBe('eastmoney:repo')
    fireEvent.click(screen.getByTestId('task-editor-save'))
    await waitFor(() => expect(putBody('em-repo')).toBeTruthy())
    const body = putBody('em-repo')!
    expect(body.action).toBe('eastmoney:repo')
    expect(body.command).toBeUndefined()
  })
})

/**
 * 互斥那两格。写路由只有整行 upsert 一条，所以这里验的是**保存时它们真的在 body 里**——
 * 漏了的表现不是报错，是一条本来跟别人互斥的任务改完排期之后开始跟别人一起跑。
 */
describe('TaskEditor —— 互斥组与迟到语义', () => {
  const existing: TaskListItem = {
    id: 'ipo', label: '新股申购', schedule: '0 45 9 * * 1-5',
    source: 'user', enabled: true, lastRun: null,
    command: '/bin/true', args: [], serial: true, maxAttempts: 1,
    exclusiveOn: 'dfcf-session', whenBusy: 'skip',
  }

  it('打开一条已有任务 ⇒ 两格照原样显示', async () => {
    setup({ task: existing })
    await screen.findByTestId('task-editor')
    expect((screen.getByTestId('task-field-exclusive-on') as HTMLInputElement).value).toBe('dfcf-session')
    expect((screen.getByTestId('task-field-when-busy') as HTMLSelectElement).value).toBe('skip')
  })

  it('只改了别的字段也照样把这两格发回去（整行 PUT，漏一格就抹掉）', async () => {
    setup({ task: existing })
    await screen.findByTestId('task-editor')
    fireEvent.change(screen.getByTestId('task-field-label'), { target: { value: '新股申购（改名）' } })
    fireEvent.click(screen.getByTestId('task-editor-save'))
    await waitFor(() => expect(putBody('ipo')).toBeTruthy())
    const body = putBody('ipo')!
    expect(body.exclusiveOn).toBe('dfcf-session')
    expect(body.whenBusy).toBe('skip')
  })

  it('新建时填互斥组 + 选"这一班不跑" ⇒ 两格都进 PUT', async () => {
    setup()
    await screen.findByTestId('task-editor')
    fireEvent.change(screen.getByTestId('task-field-id'), { target: { value: 'newx' } })
    fireEvent.change(screen.getByTestId('task-field-label'), { target: { value: '新的' } })
    fireEvent.change(screen.getByTestId('task-field-command'), { target: { value: '/bin/true' } })
    fireEvent.change(screen.getByTestId('task-field-exclusive-on'), { target: { value: '  jq-bridge  ' } })
    fireEvent.change(screen.getByTestId('task-field-when-busy'), { target: { value: 'skip' } })
    fireEvent.click(screen.getByTestId('task-editor-save'))
    await waitFor(() => expect(putBody('newx')).toBeTruthy())
    const body = putBody('newx')!
    expect(body.exclusiveOn).toBe('jq-bridge') // 两头空白削掉，否则就是另一个组
    expect(body.whenBusy).toBe('skip')
  })

  it('互斥组留空 ⇒ 不发一个空串过去（那会让队列名变成 x:）', async () => {
    setup({ task: existing })
    await screen.findByTestId('task-editor')
    fireEvent.change(screen.getByTestId('task-field-exclusive-on'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('task-editor-save'))
    await waitFor(() => expect(putBody('ipo')).toBeTruthy())
    expect(putBody('ipo')!.exclusiveOn).toBeUndefined()
  })

  it('候选取自现有值，但敲一个新的照样能存（是提示不是白名单）', async () => {
    render(
      <TaskEditor
        apiBase="http://x" conn={{ baseUrl: 'http://x' }} task={null} existingIds={[]}
        actions={ACTIONS} exclusiveGroups={['netdisk', 'jq-bridge']}
        onSaved={vi.fn()} onDeleted={vi.fn()} onCancel={vi.fn()}
      />,
    )
    await screen.findByTestId('task-editor')
    const opts = [...document.querySelectorAll('#task-exclusive-options option')].map((o) => (o as HTMLOptionElement).value)
    expect(opts).toEqual(['netdisk', 'jq-bridge'])
    // 白名单的话下面这一步会被控件挡回去；可输入下拉不挡。
    fireEvent.change(screen.getByTestId('task-field-exclusive-on'), { target: { value: '全新的组' } })
    expect((screen.getByTestId('task-field-exclusive-on') as HTMLInputElement).value).toBe('全新的组')
  })
})
