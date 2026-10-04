/**
 * `stream recipe run <id> [--param k=v]… [--yes] [--json]`：从命令行跑一条**动作型** recipe。
 *
 * 它是 `POST /api/recipes/action` 的薄壳，**自己不含一行执行逻辑**：两步确认、参数按 recipe
 * 自己的 schema 校验、凭据注入、facility 限速、退让冷却，全在后端那条路上（`src/mcp/action-recipe.ts`
 * 头注）。这里只做三件事：把参数递过去、把 `running` 轮询到落地、把结果翻成退出码。
 *
 * **为什么要有它**：动作 recipe 在这之前只有 MCP 一个入口——也就是只有"对话在场"时才跑得了。
 * 而"探一次、之后不烧 token 地跑一万次"那句话，落到调度中心得有个能被 cron 敲的东西。调度中心
 * 的 `command` 执行体填 `stream recipe run <id> --yes`，就把 recipe 挂上了定时，不用给任务再
 * 加一种执行体（`src/tasks/user-tasks.ts` 只认 command / action，那条边界不动）。
 *
 * **不带 `--yes` 不执行**——只把"会做什么"打出来，退出码 2。与 MCP 那侧 `confirmed` 缺席时的
 * 行为一模一样，理由也一样：一个有真实副作用的动作（一条消息真发出去、一次登录真做了）不该
 * 在没人点头的情况下跑。`--yes` 就是那个点头，无人值守的任务行里由建任务的人给。
 *
 * **后端不在就报错，不自己起一份。** `stream mcp` 会替宿主拉起后端，这里有意不学：一条 cron
 * 敲下来发现后端没了，正确的反应是响亮地失败（让任务中心记一条红），不是起一个孤儿后端
 * 抢 8900——那份后端谁来收、它的日志落哪，都没有答案。
 *
 * 退出码（脚本口按它判，别去 grep 输出）：
 *   0 done · 1 blocked（跑了但没读到落地回执）· 2 用法/参数/没这条 recipe/它不是动作
 *   3 run 没正常收尾（**动作可能已做了一部分**）· 4 环境（没连 Stream Desktop / Chrome 扩展 / 要登录）
 *   5 够不着后端
 */
import type { CliCommand } from './cli.ts'

export type RecipeRunCommand = Extract<CliCommand, { kind: 'recipe-run' }>

export interface RecipeRunIo {
  stdout: (line: string) => void
  stderr: (line: string) => void
  sleep: (ms: number) => Promise<void>
}

export interface RecipeRunDeps {
  fetch?: typeof globalThis.fetch
  /** 后端地址。缺省 `STREAM_BACKEND_URL`，再缺省 `http://127.0.0.1:8900`。 */
  backendUrl: string
  /** `STREAM_API_TOKEN`：本机 loopback 免密，只有打远端那份后端才用得上。 */
  apiToken?: string
  io?: RecipeRunIo
  /** 轮询间隔；生产 10s（与 MCP 那侧建议的 10–15s 同档），测试注入。 */
  pollMs?: number
}

/** `running` 时 `GET /api/recipes/action/:runId` 回的那份投影（`src/mcp/action-run.ts` 的 ActionRunView）。 */
interface RunView {
  runId: string
  status: 'queued' | 'running' | 'done' | 'error'
  sourceId: string
  result?: ActionResult
  error?: string
  note?: string
}

/** `POST /api/recipes/action` 的回执（`ActionRecipeResult`），只列这里要读的字段。 */
interface ActionResult {
  status: string
  sourceId: string
  reason?: string
  description?: string
  targetApp?: string
  screenTakeover?: string
  targetSite?: string
  params?: Record<string, unknown>
  items?: Record<string, string>[]
  runId?: string
}

const EXIT: Record<string, number> = {
  done: 0,
  blocked: 1,
  'not-found': 2,
  'not-action': 2,
  'invalid-params': 2,
  'unsupported-kind': 2,
  'no-desktop': 4,
  'no-browser': 4,
  'needs-login': 4,
}

const defaultIo: RecipeRunIo = {
  stdout: (s) => console.log(s),
  stderr: (s) => console.error(s),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}

export async function runRecipeRunCommand(cmd: RecipeRunCommand, deps: RecipeRunDeps): Promise<number> {
  const fetch = deps.fetch ?? globalThis.fetch
  const io = deps.io ?? defaultIo
  const base = deps.backendUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (deps.apiToken) headers.authorization = `Bearer ${deps.apiToken}`
  // `--json` 时 stdout 只留那一份 JSON，人话一律去 stderr——脚本口 `| jq` 不该被一行提示撞碎。
  const say = cmd.json ? io.stderr : io.stdout
  const emitJson = (v: unknown) => { if (cmd.json) io.stdout(JSON.stringify(v)) }

  let first: ActionResult
  try {
    const res = await fetch(`${base}/api/recipes/action`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sourceId: cmd.sourceId, params: cmd.params, ...(cmd.yes ? { confirmed: true } : {}) }),
    })
    if (res.status === 503) {
      io.stderr(`stream: 这份后端没开动作 recipe 这条路（/api/recipes/action 回 503）`)
      return 5
    }
    first = (await res.json()) as ActionResult
  } catch (e) {
    io.stderr(`stream: 够不着后端 ${base}（${(e as Error).message}）——先在这台机器上跑一份 \`stream\`，或用 STREAM_BACKEND_URL 指向已经在跑的那一份`)
    return 5
  }

  if (first.status === 'needs-confirmation') {
    emitJson(first)
    say(`这条 recipe 会做的事（还没做）：`)
    say(`  ${cmd.sourceId}${first.description ? ` — ${first.description}` : ''}`)
    if (first.params && Object.keys(first.params).length) say(`  参数：${JSON.stringify(first.params)}`)
    // 两档各有一样物理副作用，回执里哪个在就说哪个——这是确认的全部意义，不能只打 description。
    if (first.targetApp) say(`  目标应用：${first.targetApp}${first.screenTakeover ? `（${first.screenTakeover}）` : ''}`)
    if (first.targetSite) say(`  目标站点：${first.targetSite}`)
    say(`确认无误就加 --yes 真跑：stream recipe run ${cmd.sourceId}${Object.entries(cmd.params).map(([k, v]) => ` --param ${k}=${v}`).join('')} --yes`)
    return 2
  }

  let final: ActionResult = first
  if (first.status === 'running' && first.runId) {
    say(`动作还在执行（runId ${first.runId}），等它落地…`)
    const pollMs = deps.pollMs ?? 10_000
    for (;;) {
      await io.sleep(pollMs)
      let view: RunView
      try {
        const r = await fetch(`${base}/api/recipes/action/${encodeURIComponent(first.runId)}`, { headers })
        view = (await r.json()) as RunView
      } catch (e) {
        io.stderr(`stream: 等结果时够不着后端（${(e as Error).message}）。动作可能已经做了一部分——先核目标应用的实际状态，再决定要不要重跑。`)
        return 3
      }
      if (view.status === 'error') {
        emitJson(view)
        io.stderr(`stream: 执行没有正常收尾：${view.error ?? '未知'}。${view.note ?? '动作可能已经做了一部分（消息可能已发出）——先核目标应用的实际状态，再决定要不要重跑。'}`)
        return 3
      }
      if (view.status === 'done') {
        final = view.result ?? { status: 'blocked', sourceId: cmd.sourceId, reason: 'run 跑完了但没有 result' }
        break
      }
    }
  }

  emitJson(final)
  const code = EXIT[final.status] ?? 1
  const line = `${cmd.sourceId}: ${final.status}${final.reason ? ` — ${final.reason}` : ''}`
  if (code === 0) {
    say(line)
    if (final.items?.length) say(`  回执：${JSON.stringify(final.items)}`)
  } else {
    io.stderr(`stream: ${line}`)
  }
  return code
}
