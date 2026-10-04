/**
 * 外部命令任务的结果回传约定。
 *
 * **为什么要有这条约定**：退出码只能说明进程没崩，说不出「申购了 3 只」「补了 21 天数据」。
 * 只看退出码的可见面是一串绿灯，看不见效果——那正是 infra_scheduler 死了 37 天没人发现的
 * 那种失明（见 spec 2026-08-28 §1）。
 *
 * 约定：任务在 stdout 打一行 `::outcome:: {"summary":"...","detail":{...}}`。
 * 取**最后一行**——允许任务边跑边报进度，最后那行才是定论。
 */
import type { TaskOutcome } from './types.ts'
import { errText } from '../err-text.ts'

const MARKER = '::outcome::'
/** stderr 末尾带进摘要的行数：够看清 Python traceback 的最后一击，又不至于把摘要撑爆。 */
const STDERR_TAIL_LINES = 5

function tail(text: string, n: number): string {
  return text.split('\n').filter((l) => l.trim() !== '').slice(-n).join(' | ')
}

export interface ExecResult {
  stdout: string
  stderr: string
  /** 正常退出时是数字；被信号杀死时是 null */
  exitCode: number | null
  signal: string | null
}

export function parseOutcome(r: ExecResult): { ok: boolean; outcome: TaskOutcome } {
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(MARKER))
  const last = lines.at(-1)

  let reported: TaskOutcome | undefined
  let parseError: string | undefined
  if (last) {
    const raw = last.slice(MARKER.length).trim()
    try {
      const o = JSON.parse(raw) as { summary?: unknown; detail?: unknown }
      // summary 必须是非空字符串——让 undefined 进账本等于页面上一行空白，
      // 那比没有摘要更难查（分不清"没报"还是"报了个空"）。
      reported = typeof o.summary === 'string' && o.summary.trim() !== ''
        ? { summary: o.summary, ...(o.detail === undefined ? {} : { detail: o.detail }) }
        : { summary: `::outcome:: 行缺 summary：${raw.slice(0, 200)}`, ...(o.detail === undefined ? {} : { detail: o.detail }) }
    } catch (e) {
      parseError = `::outcome:: 行解析失败（${errText(e)}）：${raw.slice(0, 200)}`
    }
  }

  if (r.signal) {
    return { ok: false, outcome: { summary: `被信号 ${r.signal} 终止${r.stderr ? `：${tail(r.stderr, STDERR_TAIL_LINES)}` : ''}`, ...(reported?.detail === undefined ? {} : { detail: reported.detail }) } }
  }
  if (r.exitCode !== 0) {
    const why = r.stderr.trim() ? `：${tail(r.stderr, STDERR_TAIL_LINES)}` : ''
    // 失败时任务自己报的 summary 也留着——它常常比 stderr 更说明问题
    const own = reported ? `（${reported.summary}）` : ''
    return { ok: false, outcome: { summary: `exit ${r.exitCode}${own}${why}`, ...(reported?.detail === undefined ? {} : { detail: reported.detail }) } }
  }
  if (parseError) return { ok: true, outcome: { summary: parseError } }
  if (reported) return { ok: true, outcome: reported }
  return { ok: true, outcome: { summary: 'exit 0（任务没报 ::outcome::）' } }
}
