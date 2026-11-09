/**
 * widget.json 描述文件的 zod schema（openspec `widget-manifest`）。
 * 字段：id / name / icon / version / entry / serve / size / data / dataDir / permissions / preview。
 * 全部必填项显式；未知字段拒绝（strict）。
 * `data` 的写入口是一条固定约定，见 `WIDGET_DATA_PATH`（openspec `widget-data-ingress`）。
 * `dataDir` 声明数据目录、清单不提供环境变量注入面、`serve.command` 由哪个解释器起，是三条归属规则
 * （openspec `widget-manifest-limits`）：形状由 schema 受理，对错由检查器判。
 */
import { z } from 'zod'

/** version：semver（允许 prerelease / build 后缀）。 */
export const VERSION_SCHEMA = z.string().regex(
  /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/,
  '版本必须是有效的 semver 格式（如 1.0.0）',
)

/** entry / icon：相对路径（不允许绝对路径与 ..）。 */
const REL_PATH = z
  .string()
  .regex(/^[\w][\w\-./_%]*$/, '必须是相对路径（字母数字与 -_/. 等）')
  .refine((s) => !s.startsWith('/') && !s.split('/').includes('..'), '不允许绝对路径或 ..')

/** id：kebab-case。 */
export const ID_SCHEMA = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'id 必须是 kebab-case')

/** size 枚举。 */
export const SIZE_SCHEMA = z.enum(['card', 'half', 'full'])

/**
 * 数据写入口（openspec `widget-data-ingress`）：宿主把数据写给一个 widget 的唯一约定路径。
 * widget 在它 `serve.port` 的 HTTP 服务上实现 `POST /.well-known/widget-data`，收一份符合 `data`
 * schema 的 JSON，回 2xx 表示收下。声明了 `data` 却没有 `serve` 的 widget 无处可写——检查器的
 * `data-ingress` 规则就是查这一条。
 */
export const WIDGET_DATA_PATH = '/.well-known/widget-data'

/**
 * data：JSON Schema 对象（形状校验，不验语义）。
 *
 * 约定（见 {@link WIDGET_DATA_PATH}）：声明了本字段的 widget，宿主对该 widget 的 `serve` 端口发
 * `POST /.well-known/widget-data`，`Content-Type: application/json`，body 是一份符合本 schema 的
 * JSON；widget 回 2xx 表示收下，其余状态码一律视为失败（含它自己校验数据后回的 4xx）。
 * 本仓库只定这条约定与检查它，不负责往这个口写数据。
 */
export const DATA_SCHEMA = z.record(z.string(), z.unknown())

/**
 * `dataDir`：该 widget **数据目录**的声明——一个相对清单目录的路径。
 *
 * 语义（openspec `widget-manifest-limits`）：宿主把这条相对路径映射成**这个 widget 唯一可写的数据
 * 目录**；没写 `dataDir` 的 widget，宿主在它自己的数据目录下给一份按 widget `id` 命名的目录。也就是
 * 说清单只能**声明位置**，不能指定宿主数据目录之外的地方：绝对路径与含 `..` 段的值都不是「widget 自己
 * 的目录」，检查器的 `data-dir` 规则据此拒绝。
 *
 * schema 只受理形状（非空字符串），对错交给检查器——与 `data` 声明了却没有 `serve` 同一先例：现存
 * `widget.json` 的解析行为不变，拒绝是检查器的规则，不是 schema 的。目录的创建、权限与内容迁移都不在
 * 本能力内。
 */
export const DATA_DIR_SCHEMA = z.string().min(1, 'dataDir 必须是非空字符串（相对清单目录的路径）')

/**
 * 顶层不许出现的环境变量字段名（openspec `widget-manifest-limits`）：清单**不提供环境变量注入面**——
 * `serve.command` 进程看见什么环境，由宿主组装，不由清单决定。strict schema 本来就把这两个键拒在
 * 「不认识的字段」里；检查器的 `env` 规则把原因指名到这一条。键名不分大小写。
 */
export const FORBIDDEN_ENV_FIELDS = ['env', 'environment'] as const

/**
 * `serve.command` 第一个词允许的解释器裸名（openspec `widget-manifest-limits`）。
 *
 * 取这四个的依据是仓库现状：仓库里没有随代码发布的 `widget.json` 示例，清单与检查器的测试夹具用的解释器
 * 只有 `node`（Stream 自身的运行时候）；`deno` / `bun` 是同类的 JS/TS 运行时，`python3` 是本仓库脚本
 * （`scripts/*.py`）用的第二类运行时。裸名之外的另一律只允许**清单目录内的相对路径**
 * （`./bin/server`）；绝对路径、解析后跳出清单目录的路径、非白名单的解释器（`ruby`、`sh`）都不通过。
 * 要支持别的运行时是宿主部署的事，不是清单能要求的。
 */
export const SERVE_INTERPRETERS = ['node', 'python3', 'deno', 'bun'] as const

/**
 * `serve.command` 任意元素里都不许出现的 shell 元字符（openspec `widget-manifest-limits`）。
 *
 * 命令参数不得含 shell 元字符：宿主可能在别处以 shell 字符串拉起后端，一条写着 `a; b` 或 `x | y` 的
 * 清单在那些地方就不是它在这里看起来的那个意思；就是不经 shell 起的时候，元字符也只会原样传给程序，
 * 多半是写错了。
 */
export const SHELL_METACHARS = [';', '&&', '|', '`', '$('] as const

/** permissions.network 里的单条主机规则：主机名或 `*.` 后缀，小写。 */
const HOST_RULE = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .refine(
    (s) => {
      const host = s.startsWith('*.') ? s.slice(2) : s
      return host.length > 0 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)
    },
    '域名只能是主机名或 *.前缀模式（小写字母、数字、点、连字符）',
  )

export const PERMISSIONS_SCHEMA = z
  .object({
    model: z.boolean().optional(),
    credentials: z.array(z.string().min(1)).optional(),
    network: z.array(HOST_RULE).optional(),
    /**
     * media：iframe 媒体能力（autoplay / fullscreen / popups）的**声明**。声明不执行——放不放、怎么放
     * （iframe `allow` 的拼装、登记审批卡上展示声明清单）由宿主决定，清单只能表达「想用」；宿主侧的
     * 口径是永不放开 `allow-same-origin` / `allow-top-navigation`（跨域隔离底线），本声明不触及这两项。
     */
    media: z
      .object({
        autoplay: z.boolean().optional(),
        fullscreen: z.boolean().optional(),
        popups: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

/** preview：text 要 text 字段，image 要 src 字段。 */
export const PREVIEW_SCHEMA = z
  .object({
    type: z.enum(['text', 'image']),
    text: z.string().optional(),
    src: REL_PATH.optional(),
  })
  .strict()
  .refine((d) => (d.type === 'text' ? typeof d.text === 'string' : typeof d.src === 'string'), {
    message: "preview.type='text' 必须给 text，'image' 必须给 src",
  })

/** serve.port：1024–65535 且不是主实例的 8900。 */
export const SERVE_PORT_SCHEMA = z
  .number()
  .int()
  .min(1024)
  .max(65535)
  .refine((p) => p !== 8900, '端口不得是主实例的 8900')

export interface WidgetManifest {
  id: string
  name: string
  icon?: string
  version: string
  entry: string
  serve?: { command: string[]; port: number }
  size: 'card' | 'half' | 'full'
  /**
   * 数据形状（JSON Schema）。写了它就得有 `serve`：宿主只往那个端口的
   * `POST /.well-known/widget-data` 送数据（`DATA_SCHEMA` / `WIDGET_DATA_PATH`）。
   */
  data?: Record<string, unknown>
  /**
   * 数据目录的声明（相对清单目录的路径）。写了宿主就把它映射成该 widget 唯一可写的数据目录；没写，
   * 宿主在它自己的数据目录下给一份按本清单 `id` 命名的目录。取值对不对由检查器的 `data-dir` 判
   * （见 {@link DATA_DIR_SCHEMA}）。
   */
  dataDir?: string
  permissions?: {
    model?: boolean
    credentials?: string[]
    network?: string[]
    /** media：媒体能力声明，放不放由宿主决定（见 {@link PERMISSIONS_SCHEMA}）。 */
    media?: { autoplay?: boolean; fullscreen?: boolean; popups?: boolean }
  }
  preview?: {
    type: 'text' | 'image'
    text?: string
    src?: string
  }
}

/** 完整 schema（strict：拒绝未知字段）。 */
export const WIDGET_SCHEMA = z
  .object({
    id: ID_SCHEMA,
    name: z.string().min(1),
    icon: REL_PATH.optional(),
    version: VERSION_SCHEMA,
    entry: REL_PATH.pipe(z.string().refine((s) => s.endsWith('.html'), 'entry 必须以 .html 结尾')),
    serve: z
      .object({
        command: z.array(z.string().min(1)).min(1, 'command 至少一个元素'),
        port: SERVE_PORT_SCHEMA,
      })
      .strict()
      .optional(),
    size: SIZE_SCHEMA.default('card'),
    data: DATA_SCHEMA.optional(),
    /** 形状受理（非空字符串），是不是「widget 自己的目录」由检查器的 `data-dir` 判。 */
    dataDir: DATA_DIR_SCHEMA.optional(),
    permissions: PERMISSIONS_SCHEMA.optional(),
    preview: PREVIEW_SCHEMA.optional(),
  })
  .strict()

/** 解析 widget.json 文本：不合法返回 null（调用方给逐条结论的另一个口是 checkWidget）。 */
export function parseWidgetManifest(raw: string): WidgetManifest | null {
  let m: unknown
  try {
    m = JSON.parse(raw)
  } catch {
    return null
  }
  const r = WIDGET_SCHEMA.safeParse(m)
  return r.success ? (r.data as WidgetManifest) : null
}
