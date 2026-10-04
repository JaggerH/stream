import { pluginTarget, type PluginTargetOpts } from '../plugins/plugin-target.ts'
import { withAwake } from '../plugins/standby/hook.ts'

/** Resolve the MinerU backend base url (server-side fetch base — NOT the client-facing gateway
 *  path): explicit → MINERU_URL env → the bootstrap-injected plugin target (compose mode:
 *  container DNS; none: unset → ''). A remote host here is the cloud (relay/paid) tier. Both
 *  tiers run the same MinerU engine — cloud sells GPU throughput, not a better model.
 *
 *  `opts.peek` 只给**纯探测**的调用方（conversions 域的 `mineruInstalled`，每次
 *  `/api/conversion-kinds` 都问一遍）：host 档容器睡着时答空是正确答案，喊出来是噪音。
 *  整个函数不能静音——`MineruClient.base` 在 withAwake 回调里求值，那一端答空是真故障。 */
export function resolveMineruUrl(explicit?: string, opts?: PluginTargetOpts): string {
  return (explicit ?? process.env.MINERU_URL ?? pluginTarget('mineru', opts) ?? '').replace(/\/$/, '')
}

/** A loopback host means the backend runs locally (behind the gateway); anything else
 *  is a remote relay = cloud. Used for status reporting and the local/cloud badge. */
export function mineruMode(baseUrl: string): 'local' | 'cloud' {
  try {
    const h = new URL(baseUrl).hostname
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' ? 'local' : 'cloud'
  } catch {
    return 'cloud'
  }
}

export interface ParseResult {
  /** the extracted document as markdown (tables as html, formulas as LaTeX) */
  markdown: string
  /** MinerU's structured blocks. Passed through from the backend but read by nobody today —
   *  kept because it's free to carry and a number-traceability/verify pass would want it. */
  json?: unknown
}

/** A 'pdf' hint routes the byte stream through MinerU's PDF pipeline (text-layer-first);
 *  'image' runs the OCR/image path. Derived from mime/filename. */
function typeHint(mime: string, filename: string): 'pdf' | 'image' {
  return mime.startsWith('application/pdf') || /\.pdf(\?|$)/i.test(filename) ? 'pdf' : 'image'
}

/** Thin client over the MinerU serving image (`POST /parse` multipart → {markdown, json}).
 *  Stream sends the source BYTES (an item's image, or a fetched PDF); the backend runs the
 *  deterministic-first pipeline (born-digital text layer first; VLM only for image regions). */
export class MineruClient {
  constructor(private readonly explicitUrl?: string) {}

  /** 惰性:host 档下 origin 是容器醒着时才存在的(standby Cell 缓存),构造期快照必得空串。
   *  每次求值现解析;fetch 都在 withAwake 回调里,求值时容器已醒。compose 档恒定,无行为差。 */
  get base(): string {
    return resolveMineruUrl(this.explicitUrl)
  }

  mode(): 'local' | 'cloud' {
    return mineruMode(this.base)
  }

  async parse(bytes: Uint8Array, mime: string, filename = 'document', signal?: AbortSignal): Promise<ParseResult> {
    const fd = new FormData()
    // cast: Uint8Array is a valid BlobPart at runtime; TS's ArrayBuffer/SharedArrayBuffer
    // variance on the generic rejects it otherwise.
    fd.append('file', new Blob([bytes as unknown as BlobPart], { type: mime }), filename)
    fd.append('type', typeHint(mime, filename))
    const r = await withAwake('mineru', () => {
      // 缺席要说人话：base 为空时 fetch 打的是 `/parse` 这个相对路径，报出来的是一句 URL/JSON 解析错，
      // 排查方向完全反了。MinerU 是可选包，「没装」是常态，不是故障——直接给装法。
      // **判在 withAwake 回调里**：host 档下地址只在容器醒着时存在，回调外判空会把睡着的容器误报成没装。
      const base = this.base
      if (base === '') throw new Error('MinerU 未安装：stream add @streamapp/mineru（装完重启后端）')
      return fetch(`${base}/parse`, { method: 'POST', body: fd, signal })
    })
    if (!r.ok) throw new Error(`[mineru] parse HTTP ${r.status}`)
    const j = (await r.json()) as { markdown?: string; json?: unknown }
    return { markdown: j.markdown ?? '', json: j.json }
  }
}
