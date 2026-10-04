// src/media/frame-hash.ts
//
// 「这两帧画面是不是同一幅」——感知哈希（dHash）与它的去重。
//
// 为什么需要它：抽帧那层真正的成本是**每帧一次 OCR**，不是解码。I 帧直取会把「幻灯片停在
// 同一页」的那几十秒抽成好几张几乎一样的图，逐张 OCR 全是白花的钱。去重是这层唯一的省钱手段。
//
// 为什么是 dHash 而不是别的：它只需要一张小灰度缩略图，而缩放和灰度**由 ffmpeg 直出**
// （`scale=17:16,format=gray` 的 rawvideo），所以整条链路不用解码任何图片、不用引任何图像库。
//
// 网格为什么是 17×16 而不是更省内存的 9×8：实测（真编码视频，见 spec §5.3 表）9×8 下换页
// 那一跳只有 5 位、噪声底 0–1，可用窗口窄到 4 位宽，调门槛救不了；17×16 下换页 28 位、
// 噪声底 0–2，中间空出 25 位隔离带。代价实测为零——缩放发生在解码之后，输入分辨率不变，
// 解码成本一样，只多 200 字节/帧（272 − 72）。
//
// 纯函数：不碰 I/O、不认识 ffmpeg、不知道帧是从哪来的。
import { Buffer } from 'node:buffer'

/** ffmpeg 直出的缩略尺寸。**改这里必须同改 video-frames.ts 的 scale 滤镜**——两处对不上时
 *  表现是 dhash 抛「尺寸不对」，不是静默错哈希（这正是它要抛而不是容忍的理由）。 */
export const THUMB_W = 17
export const THUMB_H = 16
export const THUMB_BYTES = THUMB_W * THUMB_H

/** 每行的位数（相邻像素比较，W 列出 W-1 位）与拼成哈希需要的十六进制位数。哈希拼装必须
 *  从 `THUMB_W` 推导而不是写死——曾经写死「每行 8 位 = 2 个 hex」，网格从 9×8 改成 17×16
 *  后每行变成 16 位，仍按 2 个 hex 拼会拼出**变长的错哈希，而且不抛**（`padStart` 会默默
 *  截断/保留错误宽度）。 */
const BITS_PER_ROW = THUMB_W - 1
const HEX_CHARS_PER_ROW = BITS_PER_ROW / 4

/**
 * 差分哈希：每行比较相邻两个像素，右边比左边亮就是 1（沿行递增的梯度记成全 1）。
 * `THUMB_W` 列 → 每行 `THUMB_W - 1` 位，`THUMB_H` 行 → 共 `THUMB_H * (THUMB_W - 1)` 位。
 *
 * 返回十六进制字符串。用字符串而不是 bigint：它要进 conversion 的 JSON 结果、要能直接
 * 比对与打印，而 bigint 连 `JSON.stringify` 都过不去。
 */
export function dhash(thumb: Uint8Array): string {
  if (thumb.length !== THUMB_BYTES) {
    // 尺寸不对时算出来的是一个**看着正常的错哈希**，会安静地把不同的帧判成同一张。
    throw new Error(`[frame-hash] 缩略图尺寸不对：期望 ${THUMB_BYTES} 字节，实得 ${thumb.length}`)
  }
  let hex = ''
  for (let y = 0; y < THUMB_H; y++) {
    let row = 0
    for (let x = 0; x < THUMB_W - 1; x++) {
      row = (row << 1) | (thumb[y * THUMB_W + x]! < thumb[y * THUMB_W + x + 1]! ? 1 : 0)
    }
    hex += row.toString(16).padStart(HEX_CHARS_PER_ROW, '0')
  }
  return hex
}

const HEX_RE = /^[0-9a-f]+$/

/** 两个哈希差几位。长度不同、或不是合法偶数长度十六进制字符串直接抛——那说明有一边不是这套
 *  哈希，比出来的数没有意义。**必须显式校验字符集与奇偶长度**：`Buffer.from(x, 'hex')` 遇到
 *  非法字符或奇数长度会静默截断，两个脏串可能因此截出等长的前缀、算出距离 0——正是这条链路
 *  最怕的那类安静错合并：一张该 OCR 的帧被当重复丢掉，没有任何一处会喊。 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new Error(`[frame-hash] 哈希长度不同：${a.length} vs ${b.length}`)
  if (!HEX_RE.test(a) || a.length % 2 !== 0) throw new Error(`[frame-hash] 不是合法的十六进制哈希：${a}`)
  if (!HEX_RE.test(b) || b.length % 2 !== 0) throw new Error(`[frame-hash] 不是合法的十六进制哈希：${b}`)
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  let n = 0
  for (let i = 0; i < ba.length; i++) {
    let v = ba[i]! ^ bb[i]!
    while (v) {
      n += v & 1
      v >>= 1
    }
  }
  return n
}

/**
 * 把「画面没变」的连续帧合并掉，只留每一段变化的第一张。
 *
 * **比的是「上一张留下的」，不是「上一张看过的」。** 后者会被慢慢漂移的画面骗过去：每张只比
 * 前一张差几位，逐张比全都不够门槛，于是一整段渐变里一张都留不下——而那正是内容在变的一段。
 *
 * **已知的边界：只回看一张。** A-B-A-B 这种剪辑（讲话人 → 幻灯片 → 讲话人 → 同一张幻灯片）
 * 里，那张幻灯片每回来一次都算「变了」，于是同一屏被反复留下、反复付一次 OCR。结果不会错
 * （OCR 之后还有一层文本级去重，`conversions/frames/dedupe-track.ts` 规则 3 会收掉重复的行），
 * **错的只是钱**。要修就是把 `last` 换成「最近 N 张留下的」再取最小距离——`claude-real-video`
 * 那边的默认是回看 4 张。**没量过我们这边能省多少**，所以没做。
 */
export function dedupeFrames<T extends { hash: string }>(frames: readonly T[], minDistance: number): T[] {
  const kept: T[] = []
  let last: string | undefined
  for (const f of frames) {
    if (last === undefined || hammingDistance(last, f.hash) >= minDistance) {
      kept.push(f)
      last = f.hash
    }
  }
  return kept
}
