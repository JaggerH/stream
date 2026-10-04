import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TasksPage, groupTasks, runText } from './TasksPage.tsx'
import type { TaskListItem } from '../../lib/api.tasks.ts'

// `@testing-library/user-event` 不是本项目依赖（见 NetdiskPicker.test.tsx 里的同一句说明），
// 这里把 brief 里的 userEvent.click 换成 fireEvent.click，交互和断言不变。

// `shadowed` 是可选键（缺席 = 正常），所以 fixture 得显式标注类型——否则前两条推不出这个键，
// 往数组里 push 一条撞名行就编译不过。
const tasks: Array<{
  id: string; label: string; schedule: string; source: string
  enabled: boolean; lastRun: unknown; shadowed?: boolean
  command?: string; action?: string; configRef?: string
  args?: string[]; maxAttempts?: number; serial?: boolean
  exclusiveOn?: string; whenBusy?: 'queue' | 'skip'
}> = [
  { id: 'cookie-refresh', label: '登录态刷新', schedule: '0 */5 * * * *', source: 'builtin', enabled: true, lastRun: { id: 9, state: 'completed', insertedAt: 1, attemptedAt: 1, completedAt: 3, durationMs: 2, attempt: 1, summary: 'cookies refreshed', detail: undefined, errors: undefined } },
  // 用户任务带全 `command`/`args`/`maxAttempts`：后端写路由只有 upsert 一条（要整行），
  // 暂停/改排期就是把这一行原样发回去、只覆盖一个键。fixture 少这几个字段的话，那两个
  // 交互在测试里"过"了，实盘上却会被 400 挡住。
  { id: 'dfcf-subscribe', label: '新股新债申购', schedule: '0 45 9 * * 1-5', source: 'user', enabled: true, lastRun: null, command: 'python', args: ['sub.py'], maxAttempts: 1, serial: true },
  // 真下单的那一条：一次「立即跑一次」= 撤掉全部挂单 + 全仓买入逆回购，当天撤不回来。
  { id: 'dfcf-repo', label: '撤单+逆回购', schedule: '0 55 14 * * 1-5', source: 'user', enabled: true, lastRun: null, command: 'python', args: ['repo.py'], maxAttempts: 1, serial: true },
  // 动作型的那一条：**没有** command/args，执行体是包提供的动作。改它（暂停 / 改排期）时
  // 发回去的整行必须带 action、不带 command——fixture 缺了它，那个区别在测试里就验不出来。
  { id: 'em-repo', label: '东财 撤单+逆回购', schedule: '0 55 14 * * 1-5', source: 'user', action: 'eastmoney:repo', args: [], maxAttempts: 1, serial: true, configRef: 'eastmoney', enabled: true, lastRun: null },
]
// 两条任务的历次执行各自不同，按 task id 区分——这样「展开了哪条就该拉哪条的历史」才有得验：
// 一个把请求发错（写死 id，或永远拉第一条）的实现会在这份 fixture 下露馅。
const runsByTask: Record<string, unknown[]> = {
  'dfcf-subscribe': [
    { id: 2, state: 'completed', insertedAt: 200, attemptedAt: 200, completedAt: 900, durationMs: 700, attempt: 1, summary: '申购 3 只', detail: { count: 3 }, errors: undefined },
    { id: 1, state: 'failed', insertedAt: 100, attemptedAt: 100, completedAt: null, durationMs: null, attempt: 1, summary: 'exit 2：Traceback: boom', detail: undefined, errors: { message: 'boom' } },
  ],
  'cookie-refresh': [
    { id: 8, state: 'completed', insertedAt: 400, attemptedAt: 400, completedAt: 401, durationMs: 1, attempt: 1, summary: 'cookie 历史第一条', detail: undefined, errors: undefined },
  ],
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/tasks') && init?.method !== 'PUT') return new Response(JSON.stringify({ tasks }))
    const runsMatch = /\/api\/tasks\/([^/]+)\/runs/.exec(url)
    if (runsMatch) return new Response(JSON.stringify({ runs: runsByTask[decodeURIComponent(runsMatch[1])] ?? [] }))
    // 写路由回的是改完那一行（`{ task }`），页面就地换掉它、不整页重拉
    if (init?.method === 'PUT') return new Response(JSON.stringify({ task: JSON.parse(String(init.body)) }))
    return new Response(JSON.stringify({ ok: true }))
  }))
})

/** 取某一次 PUT 的 body——「发过去的是不是整行、改的是不是那一个键」只能这么验。 */
function putBody(id: string): Record<string, unknown> | undefined {
  // 按客户端真正发出去的那个形状匹配：包任务的 id 带冒号，`encodeURIComponent` 会把它变成
  // `%3A`。不编码的话这个 helper 会静默找不到那一次调用，断言变成"没发过"——而实际发了。
  const call = vi.mocked(fetch).mock.calls.find(([u, i]) =>
    String(u).endsWith(`/api/tasks/${encodeURIComponent(id)}`) && (i as RequestInit | undefined)?.method === 'PUT')
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined
}

describe('TasksPage', () => {
  it('列出两类任务，排期显示成人话', async () => {
    render(<TasksPage apiBase="http://x" />)
    expect(await screen.findByText('新股新债申购')).toBeTruthy()
    expect(screen.getByText('周一至周五 09:45')).toBeTruthy()
    expect(screen.getByText('每 5 分钟')).toBeTruthy()
  })

  // 人话是给人读的，cron 原文是给人复制、和后端对账的——两个都要在，只是主次不同：
  // 翻得出人话时原文降到展开层（扫一眼用不着它），翻不出时它升回行上（那一刻它是唯一的真相）。
  // 两处**永远只画一处**——同时画会让同一个 testid 出现两个，`getByTestId` 当场炸。
  it('cron 原文降到展开层，人话翻不出来时它升回行上', async () => {
    tasks.push({ id: 'odd', label: '怪表达式', schedule: '0 0 9-15/2 * * 1-5', source: 'user', enabled: true, lastRun: null })
    try {
      render(<TasksPage apiBase="http://x" />)
      await screen.findByText('怪表达式')
      // 翻得出人话的那条：收着的时候行上没有原文，展开才有
      expect(screen.queryByTestId('task-cron-dfcf-subscribe')).toBeNull()
      fireEvent.click(screen.getByTestId('task-expand-dfcf-subscribe'))
      expect(screen.getByTestId('task-cron-dfcf-subscribe').textContent).toBe('0 45 9 * * 1-5')
      // 翻不出人话的那条：不编，直接把人指向原文——**不用展开**
      const row = screen.getByTestId('task-row-user-odd')
      expect(row.textContent).toContain('翻不成人话')
      expect(row.textContent).toContain('0 0 9-15/2 * * 1-5')
      expect(screen.getByTestId('task-cron-odd').textContent).toBe('0 0 9-15/2 * * 1-5')
      // 展开它也只有一个原文，不是两个
      fireEvent.click(screen.getByTestId('task-expand-odd'))
      expect(screen.getAllByTestId('task-cron-odd')).toHaveLength(1)
    } finally { tasks.pop() }
  })

  it('行上给出下次触发时刻——「什么时候跑」是这一页的第二个问题', async () => {
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('新股新债申购')
    // 绝对时刻（月-日 时:分:秒）+「还有多久」，两样都要：前者用来跨行比较，后者是人真正的反应单位。
    // 「下次」两个字不重复——列头已经写着（`bare`）。
    const cell = screen.getByTestId('task-next-dfcf-subscribe').textContent ?? ''
    expect(cell).toMatch(/\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
    expect(cell).toMatch(/(秒|分钟|小时|天)后/)
    expect(cell).not.toContain('下次')
  })

  it('顶栏与其余 Present 同一条：标题 + 「重新读取」', async () => {
    render(<TasksPage apiBase="http://x" title="定时任务" />)
    await screen.findByText('新股新债申购')
    const header = screen.getByTestId('panel-tasks-header')
    expect(header.textContent).toContain('定时任务')
    // 顶栏那一格的几何是抄过来的，不是各画各的——五档在同一个壳里换来换去，差一格就看得见跳
    expect(header.className).toContain('h-8')
    expect(header.className).toContain('pt-3')
    // 下边线**不在顶栏上**：底下那排分页自己带一条铺满整宽的线（ChannelTabs 头注），
    // 两条一起画会出现双线。这一条和「必须有分页」是一对，拆开任何一半都会退回到
    // "标题飘在内容上、没有边界"那个样子。
    expect(header.className).not.toContain('border-b')
    expect(screen.getByTestId('channel-tabs')).toBeTruthy()
  })

  // 和时间线/研究/外接面板同一条分页。「配置」= 任务管理（建/改/删）。
  // 配置页只干一件事：新建。**改和删在「内容」里那条任务自己的行上**——在配置页挑一条来改，
  // 人得先记住自己刚才在列表里看的是哪一条再到那边认一遍；在自己那行点编辑，上下文本来就在手上。
  it('顶栏下面有「内容 | 配置」分页，配置页只有新建', async () => {
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('新股新债申购')
    fireEvent.click(screen.getByRole('tab', { name: '配置' }))
    const config = screen.getByTestId('panel-tasks-config')
    expect(config.textContent).toContain('新建任务')
    expect(screen.getByTestId('task-config-new')).toBeTruthy()
    // 挑一条来改的入口不在这儿了
    expect(screen.queryByTestId('task-config-pick-dfcf-subscribe')).toBeNull()
    // 切到配置就不该还画着任务表
    expect(screen.queryByTestId('tasks-section-user')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '内容' }))
    expect(screen.getByTestId('tasks-section-user')).toBeTruthy()
  })

  // 「可以参数配置」落地成的就是这一格：参数本来就是命令行上那几个词（`--alias jagger`、
  // `--dry-run`），给 args 一个像样的列表编辑器就够了，不用另造一层参数 schema。
  // **入口是这条任务自己那一行**：参数是任务的一部分，不该有第二个地方。
  it('在任务自己那一行改参数，整行发回去', async () => {
    render(<TasksPage apiBase="http://x" />)
    fireEvent.click(await screen.findByTestId('task-edit-dfcf-subscribe'))
    // fixture 的 args 是 ['sub.py']，改成换个账号跑
    fireEvent.change(screen.getByTestId('task-arg-0'), { target: { value: '--alias' } })
    fireEvent.click(screen.getByTestId('task-arg-add'))
    fireEvent.change(screen.getByTestId('task-arg-1'), { target: { value: 'wife' } })
    fireEvent.click(screen.getByTestId('task-editor-save'))
    await waitFor(() => expect(putBody('dfcf-subscribe')).toBeTruthy())
    const body = putBody('dfcf-subscribe')!
    expect(body.args).toEqual(['--alias', 'wife'])
    // 整行——不是补丁。少一个键后端就 400
    expect(body.command).toBe('python')
    expect(body.schedule).toBe('0 45 9 * * 1-5')
  })

  // 一条刚建出来、还没跑过一次的任务，默认就挂上节拍器是没道理的：先手动跑一次看结果。
  it('新建的任务默认停用', async () => {
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('新股新债申购')
    fireEvent.click(screen.getByRole('tab', { name: '配置' }))
    fireEvent.click(screen.getByTestId('task-config-new'))
    expect((screen.getByTestId('task-field-enabled') as HTMLInputElement).checked).toBe(false)
    // id/label/command 还空着 ⇒ 存不出去，且说清缺什么
    expect((screen.getByTestId('task-editor-save') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('task-editor-invalid').textContent).toContain('id 必填')
  })

  // id 是账本、排期、撞名判定共用的钥匙，建好之后改它等于换了一条任务而账本还挂在旧的上。
  // 编辑是一次有始有终的动作，所以是**模态弹窗**而不是摊进行里：摊开会把这条任务的历史顶到
  // 屏幕外，一张表就不成表了。两条一起钉——是弹窗，且**行没有跟着展开**（在弹窗背后偷偷改变
  // 页面，关掉之后人看到的就不是他离开时那一屏）。
  it('点编辑开的是模态弹窗，行不跟着展开', async () => {
    render(<TasksPage apiBase="http://x" />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(await screen.findByTestId('task-edit-dfcf-subscribe'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('编辑：新股新债申购')
    expect(within(dialog).getByTestId('task-editor')).toBeTruthy()
    // 展开层的标志是那段「排期表达式」，弹窗里没有它
    expect(screen.queryByText('排期表达式')).toBeNull()
    fireEvent.click(screen.getByTestId('task-editor-cancel'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('新建也是同一个弹窗', async () => {
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('新股新债申购')
    fireEvent.click(screen.getByRole('tab', { name: '配置' }))
    fireEvent.click(screen.getByTestId('task-config-new'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('新建任务')
    expect((within(dialog).getByTestId('task-field-enabled') as HTMLInputElement).checked).toBe(false)
  })

  it('已有任务的 id 改不动', async () => {
    render(<TasksPage apiBase="http://x" />)
    fireEvent.click(await screen.findByTestId('task-edit-dfcf-subscribe'))
    expect((screen.getByTestId('task-field-id') as HTMLInputElement).disabled).toBe(true)
  })

  it('删除要两步，确认后发 DELETE', async () => {
    render(<TasksPage apiBase="http://x" />)
    fireEvent.click(await screen.findByTestId('task-edit-dfcf-subscribe'))
    const del = screen.getByTestId('task-editor-delete')
    fireEvent.click(del)
    expect(del.textContent).toContain('确认删除？')
    expect(vi.mocked(fetch).mock.calls.some(([u, i]) =>
      String(u).endsWith('/api/tasks/dfcf-subscribe') && (i as RequestInit | undefined)?.method === 'DELETE')).toBe(false)
    fireEvent.click(del)
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([u, i]) =>
        String(u).endsWith('/api/tasks/dfcf-subscribe') && (i as RequestInit | undefined)?.method === 'DELETE')).toBe(true)
    })
  })

  // 表格换掉卡片的硬理由：acrylic 的 Card 没有描边，而 light 档 --background 与
  // --acr-surface 都是 #ffffff——纯文字卡贴白底没有任何边界。Table 是透明控件，靠发丝线
  // 分行，两个主题都成立。所以"别退回卡片"是一条规则，不是偏好。
  it('任务列表是表格，不是一堆卡片', async () => {
    const { container } = render(<TasksPage apiBase="http://x" />)
    await screen.findByText('新股新债申购')
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
    // 两段各一张表，**列头逐字相同**：两段上下堆着，列一旦对不齐就不像"一张表分了两段"。
    const tables = [...container.querySelectorAll('table')]
    expect(tables).toHaveLength(2)
    for (const table of tables) {
      expect([...table.querySelectorAll('th')].map((th) => th.textContent))
        .toEqual(['任务', '排期', '上次 / 下次', '操作'])
    }
  })

  // 五列的时候怎么分都不够：最长的任务名要 190px、最长的摘要要 1613px，而面板常态只有约
  // 890px。合并换来的是"定长的那一行和会变长的那一行不再抢同一份宽度"——所以「上次」和
  // 「下次」必须在同一格里，分开就退回原样。
  it('「上次」和「下次」在同一格里，上下两行', async () => {
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('登录态刷新')
    const cell = screen.getByTestId('task-next-cookie-refresh').closest('td')!
    expect(cell.textContent).toContain('上次')
    expect(cell.textContent).toContain('下次')
    expect(cell.textContent).toContain('cookies refreshed')
  })

  // 一列全是灰点的时候，多一颗红点不显眼——真出事那条就淹了。所以常态一个像素都不画，
  // 但**占位保留**（invisible 而不是不渲染），否则有点/没点的行名字左边界差 12px。
  it('「正常」不画状态点也不写字，异常那几档才现身', async () => {
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('登录态刷新')
    const normal = screen.getByTestId('task-row-builtin-cookie-refresh')
    expect(normal.querySelector('.rounded-full.invisible')).toBeTruthy()
    expect(screen.getByTestId('task-status-builtin-cookie-refresh').className).toContain('sr-only')

    tasks.push({ id: 'boom', label: '炸了的任务', schedule: '0 0 * * * *', source: 'user', enabled: true, lastRun: { id: 3, state: 'failed', insertedAt: 1, attemptedAt: 1, completedAt: null, durationMs: null, attempt: 1, summary: 'boom', detail: undefined, errors: undefined } })
    try {
      cleanup()
      render(<TasksPage apiBase="http://x" />)
      await screen.findByText('炸了的任务')
      const bad = screen.getByTestId('task-row-user-boom')
      expect(bad.querySelector('.rounded-full.invisible')).toBeNull()
      expect(screen.getByTestId('task-status-user-boom').className).not.toContain('sr-only')
      expect(screen.getByTestId('task-status-user-boom').textContent).toBe('上次失败')
    } finally { tasks.pop() }
  })

  // 展开层不缩进的话，一屏里它和别的行的**名字**左对齐不上，读的人得回头数一遍才知道这段
  // 详情属于哪一条。缩进的数值和名字左边那一截（箭头 + 状态点 + 间距）是同一个。
  it('展开层缩进到和任务名同一条竖线上', async () => {
    render(<TasksPage apiBase="http://x" />)
    fireEvent.click(await screen.findByTestId('task-expand-dfcf-subscribe'))
    const detail = await screen.findByText('排期表达式')
    expect(detail.closest('.pl-\\[38px\\]')).toBeTruthy()
  })

  // 用户任务和内置任务是两种东西（前者能暂停/改排期，后者只能看）。混在一张表里，这个区别
  // 只能靠"这一行有没有那两颗按钮"反推，而"按钮不在"和"我还没注意到"长得一样。
  it('分成「我的任务」「内置运维任务」两段，各归各的表', async () => {
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('新股新债申购')
    const mine = screen.getByTestId('tasks-section-user')
    const builtin = screen.getByTestId('tasks-section-builtin')
    expect(mine.textContent).toContain('我的任务')
    expect(builtin.textContent).toContain('内置运维任务')
    // 每一行只落在自己那一段里
    expect(mine.querySelector('[data-testid="task-row-user-dfcf-subscribe"]')).toBeTruthy()
    expect(mine.querySelector('[data-testid="task-row-builtin-cookie-refresh"]')).toBeNull()
    expect(builtin.querySelector('[data-testid="task-row-builtin-cookie-refresh"]')).toBeTruthy()
    // 段标题已经说了"这是内置的"，逐行那枚「内置」标签就是每行重复一遍同一句话——撤掉，
    // 把宽度还给任务名。
    expect(screen.getByTestId('task-row-builtin-cookie-refresh').textContent).not.toContain('内置')
  })

  // 动作型的行和外部命令的行在这一页上**没有区别**：都是「我的任务」，都能暂停、改排期、删。
  // 东方财富那几条就是普通的用户任务，不是第三种东西。
  it('动作型任务和命令型任务同在「我的任务」那一段', async () => {
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('东财 撤单+逆回购')
    const mine = screen.getByTestId('tasks-section-user')
    expect(mine.querySelector('[data-testid="task-row-user-em-repo"]')).toBeTruthy()
    expect(mine.querySelector('[data-testid="task-row-user-dfcf-subscribe"]')).toBeTruthy()
    expect(screen.getByTestId('task-toggle-em-repo')).toBeTruthy()
    expect(screen.getByTestId('task-edit-em-repo')).toBeTruthy()
  })

  // 写路由要整行。动作型的行没有 command——发回去时必须带 action，否则被 400 挡在
  // 「command 或 action 必填一个」上，而那句话跟用户刚点的那颗暂停按钮毫无关系。
  it('暂停一条动作型任务 ⇒ 整行发回去，带 action 不带 command', async () => {
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('东财 撤单+逆回购')
    fireEvent.click(screen.getByTestId('task-toggle-em-repo'))
    await waitFor(() => expect(putBody('em-repo')).toBeTruthy())
    const body = putBody('em-repo')!
    expect(body.action).toBe('eastmoney:repo')
    expect('command' in body).toBe(false)
    expect(body.enabled).toBe(false)
    expect(body.configRef).toBe('eastmoney')
  })

  // 一个「我的任务」标题下面空着，说的是"这里本该有东西"；而实情是这台机器上就没有自定义
  // 任务。两件事不同，所以空了连标题一起不画。
  it('没有自定义任务时，「我的任务」那段整个不画——标题也不画', async () => {
    const onlyBuiltin = tasks.filter((t) => t.source === 'builtin')
    vi.mocked(fetch).mockImplementation(async (url: unknown) =>
      new Response(JSON.stringify(String(url).endsWith('/api/tasks') ? { tasks: onlyBuiltin } : { runs: [] })))
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('登录态刷新')
    expect(screen.queryByTestId('tasks-section-user')).toBeNull()
    expect(screen.queryByText('我的任务')).toBeNull()
    // 内置那段照常
    expect(screen.getByTestId('tasks-section-builtin')).toBeTruthy()
  })

  it('内置任务没有删除键', async () => {
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('登录态刷新')
    const row = screen.getByTestId('task-row-builtin-cookie-refresh')
    expect(row.querySelector('[data-testid="task-delete-cookie-refresh"]')).toBeNull()
  })

  // 撞了内置 id 的存量行永远不会执行，而它外表和正常任务一模一样。页面不说出来，唯一的
  // 证据就只剩一行后端日志——行主永远看不到。这个面只读，所以出路（删）也要一并写出来。
  it('撞名的行标「不会执行」并说清怎么处理', async () => {
    tasks.push({ id: 'standby-reaper', label: '我自己的回收', schedule: '0 0 * * * *', source: 'user', enabled: true, lastRun: null, shadowed: true })
    try {
      render(<TasksPage apiBase="http://x" />)
      await screen.findByText('我自己的回收')
      const row = screen.getByTestId('task-row-user-standby-reaper')
      expect(row.textContent).toContain('不会执行')
      expect(row.textContent).toContain('DELETE /api/tasks/standby-reaper')
    } finally { tasks.pop() }
  })

  // 撞名时同一个 id 会出现两行（内置一条、用户存量一条）。key 只用 id 会撞 React 重复 key，
  // 两行的展开状态还会串在一起——这里靠"两行都在且各自可寻址"钉住 key 带了 source。
  // 分段之后它们还落在**不同的段**里，这正是撞名最容易看懂的一次呈现。
  it('同 id 的内置行与用户行同时列出，各在各段，互不相扰', async () => {
    tasks.push({ id: 'cookie-refresh', label: '我自己的刷新', schedule: '0 0 * * * *', source: 'user', enabled: true, lastRun: null, shadowed: true })
    try {
      render(<TasksPage apiBase="http://x" />)
      await screen.findByText('我自己的刷新')
      const mine = screen.getByTestId('tasks-section-user')
      const builtin = screen.getByTestId('tasks-section-builtin')
      expect(builtin.querySelector('[data-testid="task-row-builtin-cookie-refresh"]')).toBeTruthy()
      expect(mine.querySelector('[data-testid="task-row-user-cookie-refresh"]')).toBeTruthy()
      expect(screen.getByTestId('task-row-user-cookie-refresh').textContent).toContain('不会执行')
    } finally { tasks.pop() }
  })

  // 互斥组不新开一列（绝大多数行没有它，为少数几行让出一整列不划算），但**必须在行上看得见**：
  // "这条任务为什么没跑" 第一个要问的就是它被谁挡着。
  it('有互斥组的行画一枚行内小标记，没有的行一个像素都不占', async () => {
    tasks.push({
      id: 'ipo', label: '新股申购', schedule: '0 45 9 * * 1-5', source: 'user', enabled: true, lastRun: null,
      command: 'python', args: ['ipo.py'], maxAttempts: 1, serial: true,
      exclusiveOn: 'dfcf-session', whenBusy: 'skip',
    })
    try {
      render(<TasksPage apiBase="http://x" />)
      await screen.findByText('新股申购')
      const mark = screen.getByTestId('task-exclusive-user-ipo')
      expect(mark.textContent).toContain('dfcf-session')
      // skip 那一档要标出来：它意味着轮不上时整班不跑，那是"这条任务什么都没干"的原因
      expect(mark.textContent).toContain('不排队')
      expect(mark.getAttribute('title')).toContain('同组的任务同时只跑一条')
      // 没设互斥组的那条不画
      expect(screen.queryByTestId('task-exclusive-user-dfcf-repo')).toBeNull()
    } finally { tasks.pop() }
  })

  // 写路由只有整行 upsert 一条。暂停只改 `enabled`，但发回去的必须是整行——这两格漏了的
  // 表现不是报错，是一条本来跟别人互斥的任务从此跟别人一起跑，而界面上一个字都不会变。
  it('暂停一条带互斥组的任务 ⇒ 整行 PUT 里这两格还在', async () => {
    tasks.push({
      id: 'ipo', label: '新股申购', schedule: '0 45 9 * * 1-5', source: 'user', enabled: true, lastRun: null,
      command: 'python', args: ['ipo.py'], maxAttempts: 1, serial: true,
      exclusiveOn: 'dfcf-session', whenBusy: 'skip',
    })
    try {
      render(<TasksPage apiBase="http://x" />)
      await screen.findByText('新股申购')
      fireEvent.click(screen.getByTestId('task-toggle-ipo'))
      await waitFor(() => expect(putBody('ipo')).toBeTruthy())
      const body = putBody('ipo')!
      expect(body.enabled).toBe(false)
      expect(body.exclusiveOn).toBe('dfcf-session')
      expect(body.whenBusy).toBe('skip')
    } finally { tasks.pop() }
  })

  it('上次结果一句话直接显示在行上', async () => {
    render(<TasksPage apiBase="http://x" />)
    expect(await screen.findByText('cookies refreshed')).toBeTruthy()
  })

  it('从没跑过的任务如实说"还没跑过"，不显示空白', async () => {
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('新股新债申购')
    expect(screen.getByTestId('task-row-user-dfcf-subscribe').textContent).toContain('还没跑过')
  })

  it('整行都是展开的触发区；落在控件上的点击不算', async () => {
    render(<TasksPage apiBase="http://x" />)
    const row = await screen.findByTestId('task-row-user-dfcf-subscribe')
    expect(screen.queryByText('排期表达式')).toBeNull()
    // 点任务名那段文字 ⇒ 展开
    fireEvent.click(within(row).getByText('新股新债申购'))
    expect(await screen.findByText('排期表达式')).toBeTruthy()
    // 再点名字 ⇒ 收起
    fireEvent.click(within(row).getByText('新股新债申购'))
    await waitFor(() => expect(screen.queryByText('排期表达式')).toBeNull())
    // 箭头按钮只切一次，不会被行的处理器再切回去
    fireEvent.click(screen.getByTestId('task-expand-dfcf-subscribe'))
    expect(await screen.findByText('排期表达式')).toBeTruthy()
    // 点「立即跑一次」是按钮自己的事，行不跟着收起
    fireEvent.click(screen.getByTestId('task-run-dfcf-subscribe'))
    expect(screen.getByText('排期表达式')).toBeTruthy()
  })

  it('滚动容器自己当 absolute 后代的包含块——否则 sr-only 的状态 span 逃出去撑长整页', async () => {
    render(<TasksPage apiBase="http://x" />)
    const scroller = await screen.findByTestId('panel-tasks-scroller')
    expect(scroller.className.split(' ')).toContain('relative')
    expect(scroller.className.split(' ')).toContain('overflow-y-auto')
  })

  it('行上那一句按状态说：失败讲 failure、完成没摘要说"不写摘要"、在跑说在跑', () => {
    expect(runText({ state: 'failed', summary: null, failure: '后端重启，这一轮被中断' })).toBe('后端重启，这一轮被中断')
    expect(runText({ state: 'failed', summary: 'exit 2：boom', failure: null })).toBe('exit 2：boom')
    expect(runText({ state: 'failed', summary: null, failure: null })).toBe('失败，没有说明')
    expect(runText({ state: 'completed', summary: null, failure: null })).toBe('跑完了（这条任务不写摘要）')
    expect(runText({ state: 'completed', summary: '🟢 写入 3 行', failure: null })).toBe('写入 3 行')
    expect(runText({ state: 'running', summary: null })).toBe('还在跑…')
  })

  it('「上次」失败且没有 summary 时行上是 failure，不是「没报摘要」', async () => {
    const rows = structuredClone(tasks)
    rows.push({ id: 'cut', label: '被打断的任务', schedule: '0 0 * * * *', source: 'user', enabled: true, lastRun: { id: 3, state: 'failed', insertedAt: 1, attemptedAt: 1, completedAt: null, durationMs: null, attempt: 1, summary: null, detail: undefined, errors: [{ message: 'x' }], failure: '后端重启，这一轮被中断' } })
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) =>
      new Response(JSON.stringify(String(url).endsWith('/api/tasks') ? { tasks: rows } : { runs: [] }))))
    render(<TasksPage apiBase="http://x" />)
    expect(await screen.findByText('后端重启，这一轮被中断')).toBeTruthy()
    expect(screen.queryByText(/没报摘要/)).toBeNull()
    vi.unstubAllGlobals()
  })

  it('展开一条 ⇒ 拉历次执行，失败那次显示错误', async () => {
    render(<TasksPage apiBase="http://x" />)
    fireEvent.click(await screen.findByTestId('task-expand-dfcf-subscribe'))
    expect(await screen.findByText('申购 3 只')).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/exit 2/)).toBeTruthy())
    // 拉的必须是这一条自己的历史，不是随便哪条：另一条任务的历史摘要不该出现在页面上。
    expect(screen.queryByText('cookie 历史第一条')).toBeNull()
  })

  it('确认之后才真发 POST', async () => {
    render(<TasksPage apiBase="http://x" />)
    const btn = await screen.findByTestId('task-run-dfcf-subscribe')
    fireEvent.click(btn)
    fireEvent.click(btn)
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([u, i]) =>
        String(u).endsWith('/api/tasks/dfcf-subscribe/run') && (i as RequestInit)?.method === 'POST')).toBe(true)
    })
  })

  // **闸挂在动作上，不挂在任务的自述上。** 这道闸曾经只对标着 `effect: 'external'` 的行生效，
  // 而那个字段是行主自己填的、没有任何后端校验或消费——填错就没有闸，且没有一处会喊。
  it('第一次点「立即跑一次」不发请求，要再确认一次', async () => {
    render(<TasksPage apiBase="http://x" />)
    const btn = await screen.findByTestId('task-run-dfcf-repo')
    fireEvent.click(btn)
    // 第一次点只是把按钮变成确认态——一次点击就撤掉全部挂单 + 全仓买入逆回购是不可接受的
    expect(btn.textContent).toContain('确认执行？')
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).endsWith('/api/tasks/dfcf-repo/run'))).toBe(false)

    fireEvent.click(btn)
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([u, i]) =>
        String(u).endsWith('/api/tasks/dfcf-repo/run') && (i as RequestInit)?.method === 'POST')).toBe(true)
    })
    expect(btn.textContent).toContain('立即跑一次')
  })

  it('确认态会自己过期 —— 晾着的按钮不能变回"一点就跑"', async () => {
    vi.useFakeTimers()
    try {
      render(<TasksPage apiBase="http://x" />)
      const btn = await vi.waitFor(() => screen.getByTestId('task-run-dfcf-repo'))
      fireEvent.click(btn)
      expect(btn.textContent).toContain('确认执行？')
      // 定时器里那次 setState 发生在 React 之外，不包 act 的话渲染不会跟上
      await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
      expect(btn.textContent).toContain('立即跑一次')
    } finally {
      vi.useRealTimers()
    }
  })

  // 内置任务也一样要确认——闸不分档，不然"哪些要确认"就又变成一份要靠人记的名单。
  it('内置任务的「立即跑一次」同样要两步', async () => {
    render(<TasksPage apiBase="http://x" />)
    const btn = await screen.findByTestId('task-run-cookie-refresh')
    fireEvent.click(btn)
    expect(btn.textContent).toContain('确认执行？')
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).endsWith('/api/tasks/cookie-refresh/run'))).toBe(false)
    fireEvent.click(btn)
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).endsWith('/api/tasks/cookie-refresh/run'))).toBe(true)
    })
  })

  it('暂停一条任务 ⇒ PUT 整行、只翻 enabled 那一个键', async () => {
    render(<TasksPage apiBase="http://x" />)
    fireEvent.click(await screen.findByTestId('task-toggle-dfcf-subscribe'))
    await waitFor(() => expect(putBody('dfcf-subscribe')).toBeTruthy())
    const body = putBody('dfcf-subscribe')!
    expect(body.enabled).toBe(false)
    // 整行——只发 { enabled:false } 会被后端 400 挡在「command 必填」上
    expect(body.command).toBe('python')
    expect(body.args).toEqual(['sub.py'])
    expect(body.schedule).toBe('0 45 9 * * 1-5')
    // 改完就地生效：那一行变成「已停用」，不整页重拉
    await waitFor(() => expect(screen.getByTestId('task-status-user-dfcf-subscribe').textContent).toBe('已停用'))
  })

  it('内置任务没有暂停/改排期键——改它的排期要改代码', async () => {
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('登录态刷新')
    expect(screen.queryByTestId('task-toggle-cookie-refresh')).toBeNull()
    expect(screen.queryByTestId('task-edit-cookie-refresh')).toBeNull()
  })

  // 排期编辑器在整行编辑器里是**嵌入档**：只报结果，不画自己的保存键（整行一次保存）。
  it('改排期：选预设 ⇒ 写出 cron，跟整行一起 PUT，页面上立刻是新的人话', async () => {
    render(<TasksPage apiBase="http://x" />)
    fireEvent.click(await screen.findByTestId('task-edit-dfcf-subscribe'))
    // 打开时停在这条表达式对应的那一档（工作日 09:45 = 每周）
    expect(screen.getByTestId('task-schedule-editor-dfcf-subscribe')).toBeTruthy()
    fireEvent.click(screen.getByTestId('sched-kind-daily'))
    fireEvent.change(screen.getByTestId('sched-hour'), { target: { value: '7' } })
    fireEvent.change(screen.getByTestId('sched-minute'), { target: { value: '30' } })
    // 边改边给人话 + 表达式，不是保存之后才知道自己选了什么
    expect(screen.getByTestId('sched-sentence').textContent).toBe('每天 07:30')
    expect(screen.getByTestId('sched-expr').textContent).toBe('0 30 7 * * *')
    fireEvent.click(screen.getByTestId('task-editor-save'))
    await waitFor(() => expect(putBody('dfcf-subscribe')?.schedule).toBe('0 30 7 * * *'))
    await waitFor(() => expect(screen.getByText('每天 07:30')).toBeTruthy())
  })

  // 「非法表达式当场报错、且不会被采纳」搬去了 `ScheduleEditor.test.tsx`——它是那个组件
  // 自己的判据，穿过整页去点它只是把同一件事验得更脆。整页这一层要钉的是**排期跟着整行
  // 一起发出去**，上一条已经在钉了。

  // 摘要是外部命令自己打印的，东财那两条按终端习惯在开头放了颗 🟢。这一行左边已经有一颗
  // 状态点了，同一件事画两遍，其中一颗还是别人家的 emoji——只削开头，句中的一律留着。
  it('摘要开头那颗状态 emoji 不画，内容一个字不动', async () => {
    tasks.push({
      id: 'emoji', label: '带 emoji 的', schedule: '0 0 * * * *', source: 'user', enabled: true,
      lastRun: { id: 5, state: 'completed', insertedAt: 1, attemptedAt: 1, completedAt: 2, durationMs: 1, attempt: 1, summary: '🟢 LIVE 申购 3 笔 ✅ 完成', detail: undefined, errors: undefined },
    })
    try {
      render(<TasksPage apiBase="http://x" />)
      await screen.findByText('带 emoji 的')
      const cell = screen.getByTestId('task-next-emoji').closest('td')!
      expect(cell.textContent).toContain('LIVE 申购 3 笔 ✅ 完成')
      expect(cell.textContent).not.toContain('🟢')
    } finally { tasks.pop() }
  })

  it('写失败 ⇒ 卡上说出来，不是静悄悄什么也没发生', async () => {
    vi.mocked(fetch).mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') return new Response('排期非法', { status: 400 })
      return new Response(JSON.stringify(String(url).endsWith('/api/tasks') ? { tasks } : { runs: [] }))
    })
    render(<TasksPage apiBase="http://x" />)
    fireEvent.click(await screen.findByTestId('task-toggle-dfcf-subscribe'))
    await waitFor(() => expect(screen.getByTestId('task-error-dfcf-subscribe').textContent).toContain('400'))
  })

  it('后端挂了 ⇒ 页面显示错误，不是一片空白', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    render(<TasksPage apiBase="http://x" />)
    expect(await screen.findByText(/ECONNREFUSED/)).toBeTruthy()
  })
})

/**
 * 分组（`group`）**只影响这一页怎么摆**。任务被拆细到"一个数据源一条"之后列表变长，
 * 而"这几条其实是同一个市场的"在界面上看不出来——分组把它说出来，仅此而已。
 */
function item(over: Partial<TaskListItem> & { id: string }): TaskListItem {
  return {
    label: over.id, schedule: '0 0 9 * * *', source: 'user', enabled: true, lastRun: null,
    command: 'python', args: [], maxAttempts: 1, serial: true,
    ...over,
  }
}

describe('groupTasks', () => {
  it('组按组名排序、组内保持原顺序、没分组的落在最后一节且那一节没有名字', () => {
    const out = groupTasks([
      item({ id: 'z', group: '宏观' }),
      item({ id: 'a' }),
      item({ id: 'y', group: '农产品' }),
      item({ id: 'x', group: '宏观' }),
      item({ id: 'b' }),
    ])
    // 组的顺序按组名排（中文按拼音：hóngguān < nóngchǎnpǐn），不吃到达顺序也不吃对象键顺序。
    expect(out.map((s) => s.group)).toEqual(['宏观', '农产品', null])
    // 组内保持原顺序：进来时已经是稳定的（后端按 id 排），这里再排一次只是换一份稳定。
    expect(out[0].tasks.map((t) => t.id)).toEqual(['z', 'x'])
    expect(out[2].tasks.map((t) => t.id)).toEqual(['a', 'b'])
  })

  // 空串不是一个组名。不当成"没分组"的话，页面上会顶出一个没有名字的分组小标题。
  it('空串 / 只有空白的 group 当作没分组', () => {
    const out = groupTasks([item({ id: 'a', group: '' }), item({ id: 'b', group: '   ' })])
    expect(out).toEqual([{ group: null, tasks: expect.any(Array) }])
    expect(out[0].tasks).toHaveLength(2)
  })

  it('一条都没有 ⇒ 一节都没有（不凭空造一个空的「未分组」）', () => {
    expect(groupTasks([])).toEqual([])
  })
})

describe('TasksPage 的分组分节', () => {
  function serve(list: TaskListItem[]): void {
    vi.mocked(fetch).mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') return new Response(JSON.stringify({ task: JSON.parse(String(init.body)) }))
      return new Response(JSON.stringify(String(url).endsWith('/api/tasks') ? { tasks: list } : { runs: [] }))
    })
  }

  it('按 group 分节，组标题按组名排序，未分组那一节在最后', async () => {
    serve([
      item({ id: 'macro-1', label: '宏观表', group: '宏观' }),
      item({ id: 'loose', label: '没归类的' }),
      item({ id: 'hog-1', label: '生猪存栏', group: '农产品' }),
      item({ id: 'macro-2', label: '社融', group: '宏观' }),
    ])
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('宏观表')
    const headings = screen.getAllByTestId(/^tasks-group-user-/)
    expect(headings.map((h) => h.textContent)).toEqual(['宏观', '农产品', '未分组'])
    // 分节是**表内的行**，不是把表拆成好几张——所有行仍在同一张表里，列宽才对得齐。
    expect(screen.getAllByTestId(/^tasks-section-user$/)).toHaveLength(1)
  })

  // 全都没分组时再画一个「未分组」标题，等于在段标题下面写一行"以下是全部"——没有信息量，
  // 却把这一页从"两段表"变成"到处是标题"。
  it('一个组都没有时 ⇒ 一条组标题都不画', async () => {
    serve([item({ id: 'a', label: '甲' }), item({ id: 'b', label: '乙' })])
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('甲')
    expect(screen.queryAllByTestId(/^tasks-group-/)).toHaveLength(0)
    expect(screen.queryByText('未分组')).toBeNull()
    // 行本身照常画——不画的是标题，不是内容。
    expect(screen.getByTestId('task-row-user-a')).toBeTruthy()
  })

  it('内置那段自己分自己的组，和用户那段互不干扰', async () => {
    serve([
      item({ id: 'cookie-refresh', label: '登录态刷新', source: 'builtin', group: '登录态', command: undefined }),
      item({ id: 'ledger-prune', label: '历史清理', source: 'builtin', group: '运维', command: undefined }),
      item({ id: 'mine', label: '我的', group: '宏观' }),
    ])
    render(<TasksPage apiBase="http://x" />)
    await screen.findByText('我的')
    expect(screen.getAllByTestId(/^tasks-group-builtin-/).map((h) => h.textContent)).toEqual(['登录态', '运维'])
    expect(screen.getAllByTestId(/^tasks-group-user-/).map((h) => h.textContent)).toEqual(['宏观'])
  })

  // 后端写路由只有 upsert 一条、要整行。group 漏在外面的话，一次「暂停」就把这条任务的
  // 分组抹掉了——而页面上要等下次刷新才看得出来。
  it('暂停一条任务时，整行 PUT 里带着 group', async () => {
    serve([item({ id: 'macro-1', label: '宏观表', group: '宏观' })])
    render(<TasksPage apiBase="http://x" />)
    fireEvent.click(await screen.findByTestId('task-toggle-macro-1'))
    await waitFor(() => expect(putBody('macro-1')).toBeTruthy())
    const body = putBody('macro-1')!
    expect(body.group).toBe('宏观')
    expect(body.enabled).toBe(false)
  })

  // 建同一组的第二条任务时不该重新拼一遍组名（拼歪一个字就多出一个只有一条的组）。
  // 候选取自**全部**任务：把自己的一条归进内置那几条用的组名是正常需求。
  it('编辑器的分组候选来自现有任务用过的组名（内置的也算），且能敲一个新的', async () => {
    serve([
      item({ id: 'cookie-refresh', label: '登录态刷新', source: 'builtin', group: '登录态', command: undefined }),
      item({ id: 'macro-1', label: '宏观表', group: '宏观' }),
    ])
    render(<TasksPage apiBase="http://x" />)
    fireEvent.click(await screen.findByTestId('task-edit-macro-1'))
    const field = await screen.findByTestId('task-field-group') as HTMLInputElement
    expect(field.value).toBe('宏观')
    const list = document.getElementById(field.getAttribute('list')!)!
    // 候选也按拼音排（dēnglùtài < hóngguān）——顺序稳定，加一条任务不会把下拉重排一遍。
    expect([...list.querySelectorAll('option')].map((o) => o.getAttribute('value'))).toEqual(['登录态', '宏观'])
    // 是输入框不是 select：新分组必须能当场敲出来，组名不是后端定义的白名单。
    expect(field.tagName).toBe('INPUT')
    fireEvent.change(field, { target: { value: '生猪' } })
    fireEvent.click(screen.getByTestId('task-editor-save'))
    await waitFor(() => expect(putBody('macro-1')?.group).toBe('生猪'))
  })

  it('把分组清空 ⇒ 发出去的整行里没有 group（不是一个空串分组）', async () => {
    serve([item({ id: 'macro-1', label: '宏观表', group: '宏观' })])
    render(<TasksPage apiBase="http://x" />)
    fireEvent.click(await screen.findByTestId('task-edit-macro-1'))
    fireEvent.change(await screen.findByTestId('task-field-group'), { target: { value: '  ' } })
    fireEvent.click(screen.getByTestId('task-editor-save'))
    await waitFor(() => expect(putBody('macro-1')).toBeTruthy())
    expect(putBody('macro-1')!.group).toBeUndefined()
  })
})
