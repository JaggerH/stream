/**
 * widget.json 描述文件的 zod schema（openspec `widget-manifest`）。
 * 字段：id / name / icon / version / entry / serve / size / data / dataDir / permissions / preview。
 * 全部必填项显式；未知字段拒绝（strict）。
 * `data` 的写入口是一条固定约定，见 `WIDGET_DATA_PATH`（openspec `widget-data-ingress`）。
 * `dataDir` 声明数据目录、清单不提供环境变量注入面、`serve.command` 由哪个解释器起，是三条归属规则
 * （openspec `widget-manifest-limits`）：形状由 schema 受理，对错由检查器判。
 * 数据目录同时是持久数据的**数据根**，宿主可提供一套可选的持久数据服务约定
 * （openspec `widget-data-storage`，见下文的 `WIDGET_DATA_*` / `WIDGET_STORAGE_*` 常量）。
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
 * 从数据的角度看，这个目录是该 widget 持久数据的**数据根**（openspec `widget-data-storage`）：数据根
 * 下的路径构成该 widget 持久数据的唯一命名空间，代码与 `widget.json` 不在其中。未声明时缺省数据根是
 * {@link WIDGET_DATA_DEFAULT_DIR}（清单目录下的 `data/`）。宿主若提供持久数据服务，数据根下的内容经
 * 那套接口（见下文的存储约定常量）落到宿主维护的存储里；只写本地文件不自动等于持久。
 *
 * schema 只受理形状（非空字符串），对错交给检查器——与 `data` 声明了却没有 `serve` 同一先例：现存
 * `widget.json` 的解析行为不变，拒绝是检查器的规则，不是 schema 的。目录的创建、权限与内容迁移都不在
 * 本能力内。
 */
export const DATA_DIR_SCHEMA = z.string().min(1, 'dataDir 必须是非空字符串（相对清单目录的路径）')

// ── 宿主提供的持久数据服务（openspec `widget-data-storage`）─────────────────────
//
// 下面是一套**可选**约定的常量：宿主可以起一个数据服务，让 widget 后端把数据写到宿主维护的存储里
// 而不是只写本地目录。是否提供、怎么实现由宿主决定；本仓库只定约定、常量与检查（`data-storage`
// 探活），不实现存储服务端。与 {@link WIDGET_DATA_PATH} 方向相反、并存：那个口是宿主**向** widget
// 送数据的固定写入口，这一套是 widget **往外**存自己数据的通用接口。

/** 缺省数据根：`dataDir` 未声明时，构件持久数据的命名空间缺省是清单目录下的 `data/`。 */
export const WIDGET_DATA_DEFAULT_DIR = 'data'

/**
 * 存储服务的 base URL 环境变量名。宿主组装环境时注入（值形如 `http://127.0.0.1:<port>`），widget
 * 后端从这里发现数据服务；清单不能声明它（环境由宿主组装，见 `FORBIDDEN_ENV_FIELDS` 的归属规则）。
 * 没有这个变量的宿主 = 不提供持久数据服务，widget 只用本地数据目录。
 */
export const WIDGET_DATA_URL = 'WIDGET_DATA_URL'

/** 本次会话的构件数据凭据环境变量名（值由宿主生成与轮换；widget 原样带到请求头）。 */
export const WIDGET_DATA_TOKEN = 'WIDGET_DATA_TOKEN'

/**
 * 持久性级别提示的环境变量名。取值是 {@link WIDGET_DATA_MODES} 之一。
 *
 * **这只是宿主向构件的提示**（宿主保证的持久性级别）：构件不得依赖它做正确性判断——即便提示为
 * `write_behind`，写失败仍要按 503/507 等错误处理与重试。提示不对构成行为的豁免。
 */
export const WIDGET_DATA_MODE = 'WIDGET_DATA_MODE'

/** {@link WIDGET_DATA_MODE} 的取值。 */
export const WIDGET_DATA_MODES = ['off', 'snapshot', 'write_behind', 'write_through'] as const

/** 存储接口的版本化路径前缀：所有端点都在 `<base>` + 本前缀之下。 */
export const WIDGET_STORAGE_PATH_PREFIX = '/v1'

/** 文档端点（相对 `<base>`）：整份 JSON 的 `GET` / `PUT`，带 revision 与条件写。 */
export const WIDGET_STORAGE_DOCUMENT_PATH = '/v1/document'

/** 对象端点前缀（相对 `<base>`）：`/v1/objects`（列举）与 `/v1/objects/<path>`（单个对象）。 */
export const WIDGET_STORAGE_OBJECTS_PATH = '/v1/objects'

/**
 * 「宿主至少应接受」的大小下限，供构件作者参考的**保守值**，不是契约：实际大小上限由宿主决定，
 * 超限回 413（单个过大）或 507（总量超限），客户端必须处理这两种错误。
 */
export const WIDGET_STORAGE_MIN_DOCUMENT_BYTES = 256 * 1024
/** 见 {@link WIDGET_STORAGE_MIN_DOCUMENT_BYTES}。 */
export const WIDGET_STORAGE_MIN_OBJECT_BYTES = 1024 * 1024

// 路径规范化的限制（服务端与客户端各校验一遍，不信任其中一侧）。
/** 单段最大长度。 */
export const WIDGET_STORAGE_MAX_SEGMENT = 255
/** 路径总长最大长度。 */
export const WIDGET_STORAGE_MAX_PATH = 512
/** 路径最大深度（段数）。 */
export const WIDGET_STORAGE_MAX_DEPTH = 16
/**
 * 文件命名空间的保留名：`doc`（文档端点用 `path = ''` 表达，`doc` 留作实现侧的保留字避免歧义）与
 * `.well-known`（本仓库自己的约定路径 `.well-known/widget-data` 在其下，不进数据命名空间）。
 * 以这些名字开头（`doc`、`doc/x`、`.well-known/…`）的路径不是合法对象路径。
 */
export const WIDGET_STORAGE_RESERVED_NAMES = ['doc', '.well-known'] as const

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
   * 数据目录的声明（相对清单目录的路径），即构件持久数据的**数据根**。写了宿主就把它映射成该 widget
   * 唯一可写的数据目录；没写，缺省数据根是 {@link WIDGET_DATA_DEFAULT_DIR}（清单目录下的 `data/`）。
   * 取值对不对由检查器的 `data-dir` 判（见 {@link DATA_DIR_SCHEMA}）。
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
