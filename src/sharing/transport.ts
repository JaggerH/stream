import { readFile } from 'node:fs/promises'
import { ownedFetch } from '../http/owned-outbound.ts'
import { deserializeBundle, type StreamBundleV1 } from './bundle-format.ts'

type Loaded = { ok: true; bundle: StreamBundleV1 } | { ok: false; error: string }

/** URL 导入 body 上限（防 attacker-sized 响应 OOM）。分享包是配置+内嵌 recipe，正常远小于此。
 *  host 无关是设计选择（单用户自托管、URL 用户自贴）；SSRF 内网防护不做（会误伤 LAN 自托管），
 *  仅以大小上限兜住最坏的 OOM 面。 */
const MAX_URL_BUNDLE_BYTES = 32 * 1024 * 1024

export async function loadBundleFromFile(filePath: string): Promise<Loaded> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (e) {
    return { ok: false, error: `读取文件失败：${(e as Error).message}` }
  }
  return deserializeBundle(text)
}

/** host 无关：任何能吐出包字节的 URL 都收，不看 host。走 Stream 自己的受控出站通道。 */
export async function loadBundleFromUrl(url: string, fetchImpl: typeof ownedFetch = ownedFetch): Promise<Loaded> {
  let resp: Response
  try {
    resp = await fetchImpl(url)
  } catch (e) {
    return { ok: false, error: `拉取 URL 失败：${(e as Error).message}` }
  }
  if (!resp.ok) return { ok: false, error: `拉取 URL 失败：HTTP ${resp.status}` }
  const declared = Number(resp.headers.get('content-length') ?? '0')
  if (declared > MAX_URL_BUNDLE_BYTES) return { ok: false, error: `分享包过大（${Math.round(declared / 1024 / 1024)}MB > ${MAX_URL_BUNDLE_BYTES / 1024 / 1024}MB 上限）` }
  const text = await resp.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_URL_BUNDLE_BYTES) return { ok: false, error: '分享包过大，已拒绝' }
  return deserializeBundle(text)
}
