/**
 * widget.json 描述文件的 zod schema（openspec `widget-manifest`）。
 * 字段：id / name / icon / version / entry / serve / size / data / permissions / preview。
 * 全部必填项显式；未知字段拒绝（strict）。
 * `data` 的写入口是一条固定约定，见 `WIDGET_DATA_PATH`（openspec `widget-data-ingress`）。
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
  permissions?: {
    model?: boolean
    credentials?: string[]
    network?: string[]
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
