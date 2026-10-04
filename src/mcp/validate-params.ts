import { existsSync } from 'node:fs'
import { detectWsl, translateToWindowsPath } from '../../capabilities/desktop/src/wsl.ts'
import { derivePathParams } from '../replay/path-params.ts'

export interface ParamSpec {
  type?: 'string' | 'number' | 'boolean'
  required?: boolean
  description?: string
  /** 可选参数缺席时的值；只有动作 recipe 的执行路线（`materializeParams`）会补它，校验这里不看。 */
  default?: unknown
  /**
   * `'path'`：这个值是**目标机器上的文件路径**（要交给 agent 那一侧的应用打开）。
   *
   * 后端跑在 WSL 里、agent 在 Windows 侧时，`/home/...` 那种路径 Windows 的文件对话框认不出——
   * `materializeParams` 把它翻成 `\\wsl.localhost\<distro>\...`（`wslpath -w`，与代装扩展那条路同一份
   * 翻译，`capabilities/desktop/src/wsl.ts`）。翻不出来、或 Linux 侧根本没有这个文件，就在这里拒
   * （`invalid-params`），别把一条注定填不进去的路径交给对话框——那样的失败长得像"控件没找到"。
   * 已经是 Windows 形状的路径（`C:\...` / `\\server\...`）原样放行：`wslpath -w` 会把反斜杠吃掉，
   * 不能让它碰。
   *
   * 顺带派生 **`<key>_name` / `_stem` / `_stem6` / `_ext` / `_kind`**（拆法与用途见 `src/replay/path-params.ts`）：
   * 文件发出去之后界面上显示的是文件名不是路径（微信的文件气泡），而且长名会被截断——判据只能拿片段写；
   * 图片没有文字可指，recipe 按 `_kind` 分流。派生键不在 params_schema 里，调用方传它会被未声明键那道闸
   * 拒掉——它只有这一个来源。
   */
  format?: 'path'
  /**
   * 只对 `format:'path'` 有意义：值是**按换行拼的多条路径**，每一条各自翻译、各自验存在，翻完仍按换行拼回去
   * （`setFiles` 步骤吃的就是这个形状）。**不派生** `<key>_name` 那几个键——它们是"一个文件的名字"的片段，
   * 一串文件没有一个名字；要按名判就一个文件一个参数。
   */
  multiple?: boolean
}

/**
 * Minimal validator for a manifest's loose params_schema. Enforces required keys
 * and primitive types. Throws before any fetch happens.
 */
export function validateParams(
  schema: Record<string, unknown>,
  params: Record<string, unknown>
): void {
  for (const [key, raw] of Object.entries(schema)) {
    const spec = (raw ?? {}) as ParamSpec
    const val = params[key]
    if (spec.required && (val === undefined || val === null)) {
      throw new Error(`Missing required param "${key}"`)
    }
    if (val !== undefined && val !== null && spec.type && typeof val !== spec.type) {
      throw new Error(`Param "${key}" must be ${spec.type}, got ${typeof val}`)
    }
  }
}

/** `materializeParams` 的环境注入点（测试用；省略 = 真探 WSL、真调 `wslpath`、真看文件系统）。 */
export interface ParamEnv {
  wsl?: boolean
  translateToWindowsPath?: (linuxPath: string) => string | undefined
  exists?: (path: string) => boolean
}

/** Windows 形状的路径：盘符开头或 UNC。 */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/

/**
 * 校验过的参数 → 交给 runner 的那份字符串参数袋。**动作 recipe 的三个入口（`run_action_recipe` /
 * 单步调试 / CLI）都只经这一份**：单步跑的必须是整跑时一模一样的参数，两处各写一遍就多一个
 * "单步能过、整跑就挂"的来源。
 *
 * 做三件事：每个值 `String()`（桌面路线最终把它打进键盘）；`default` 只补缺席的键、不覆盖调用方给的；
 * `format:'path'` 的值按 {@link ParamSpec.format} 翻译并验存在。抛的错是给调用方当 `invalid-params` 的。
 */
export function materializeParams(
  schema: Record<string, unknown>,
  params: Record<string, unknown>,
  env: ParamEnv = {},
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) out[k] = String(v)
  for (const [k, raw] of Object.entries(schema)) {
    const spec = (raw ?? {}) as ParamSpec
    if (out[k] === undefined && spec.default !== undefined) out[k] = String(spec.default)
    if (spec.format === 'path' && out[k] !== undefined) {
      if (spec.multiple) {
        out[k] = out[k].split('\n').map((p) => p.trim()).filter(Boolean).map((p) => materializePath(k, p, env)).join('\n')
      } else {
        out[k] = materializePath(k, out[k], env)
        Object.assign(out, derivePathParams(k, out[k]))
      }
    }
  }
  return out
}

function materializePath(key: string, value: string, env: ParamEnv): string {
  if (WINDOWS_PATH.test(value)) return value
  if (!value.startsWith('/')) throw new Error(`Param "${key}" 要是绝对路径（/home/... 或 C:\\...），给的是 ${JSON.stringify(value)}`)
  const exists = env.exists ?? existsSync
  if (!exists(value)) throw new Error(`Param "${key}" 指的文件不存在：${value}`)
  const wsl = env.wsl ?? detectWsl()
  if (!wsl) return value
  const win = (env.translateToWindowsPath ?? translateToWindowsPath)(value)
  if (!win) throw new Error(`Param "${key}"：WSL 路径翻不成 Windows 路径（wslpath -w ${value} 失败），Windows 侧的应用打不开它`)
  return win
}
