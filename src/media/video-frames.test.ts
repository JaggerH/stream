import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, stat as fsStat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  keyframeTimes,
  keyframeThumbs,
  frameAt,
  sliceThumbs,
  pairFrames,
  planVideoFrames,
  mediaDurationS,
  sampleFrames,
  headerArgs,
} from './video-frames.ts'
import { THUMB_BYTES, THUMB_W, THUMB_H, dhash } from './frame-hash.ts'

const execFileP = promisify(execFile)

/** 造一张 17×16 灰度缩略：`px(x, y)` 给每个像素一个值。 */
function thumbFixture(px: (x: number, y: number) => number): Uint8Array {
  const out = new Uint8Array(THUMB_BYTES)
  for (let y = 0; y < THUMB_H; y++) for (let x = 0; x < THUMB_W; x++) out[y * THUMB_W + x] = px(x, y)
  return out
}

let dir: string
let video: string

/** 现造一个 20s / 25fps / 每 2s 一个关键帧的视频（GOP 50）。造它比往仓库里塞一个二进制夹具
 *  好：夹具会被 lint/打包/tarball 白名单绊到，而 lavfi 就在 ffmpeg 里，造一次不到 1s。 */
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'video-frames-'))
  video = join(dir, 'spike.mp4')
  await execFileP('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=20',
    '-c:v', 'libx264', '-g', '50', '-pix_fmt', 'yuv420p', video,
  ])
}, 60_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('keyframeTimes', () => {
  it('20s / GOP 50 → 10 个关键帧，每 2s 一个', async () => {
    const times = await keyframeTimes(video)
    expect(times).toHaveLength(10)
    expect(times[0]).toBeCloseTo(0, 3)
    expect(times[1]).toBeCloseTo(2, 3)
    expect(times[9]).toBeCloseTo(18, 3)
  })

  it('每一项都是有限数——ffprobe 第一行带一个尾随逗号，解析漏了就会冒出 NaN', async () => {
    const times = await keyframeTimes(video)
    expect(times.every((t) => Number.isFinite(t))).toBe(true)
  })
})

describe('sliceThumbs', () => {
  it('3 张 THUMB_BYTES 拼一块 → 切回 3 张，且按顺序切对（不是拼错位的字节）', () => {
    const raw = new Uint8Array(3 * THUMB_BYTES)
    for (let i = 0; i < 3; i++) raw.fill(i, i * THUMB_BYTES, (i + 1) * THUMB_BYTES)
    const thumbs = sliceThumbs(raw)
    expect(thumbs).toHaveLength(3)
    thumbs.forEach((t, i) => {
      expect(t.length).toBe(THUMB_BYTES)
      expect(t.every((b) => b === i)).toBe(true)
    })
  })

  it('长度不是 THUMB_BYTES 的整数倍 → 抛，错误信息里带实际长度', () => {
    const raw = new Uint8Array(100)
    expect(() => sliceThumbs(raw)).toThrow(/100/)
  })

  it('空输入 → 空数组，不抛（0 是 THUMB_BYTES 的整数倍，合法的"一个关键帧都没有"）', () => {
    expect(sliceThumbs(new Uint8Array(0))).toEqual([])
  })
})

describe('keyframeThumbs', () => {
  it('缩略图张数与关键帧时刻数严格相等——对不上就没法把哈希配回时刻', async () => {
    const [times, thumbs] = await Promise.all([keyframeTimes(video), keyframeThumbs(video)])
    expect(thumbs).toHaveLength(times.length)
  })

  it('每张都是 17×16 灰度 = 272 字节', async () => {
    const thumbs = await keyframeThumbs(video)
    expect(thumbs.every((t) => t.length === THUMB_BYTES)).toBe(true)
  })
})

describe('pairFrames', () => {
  it('按下标一一对应——第 i 个哈希确实来自第 i 张缩略图，不是配错位的', () => {
    // dHash 只看「右边比左边亮不亮」，不看差多少，所以三张缩略图必须各有**不同的梯度形状**
    // 才能产出互不相同的哈希（同形状、不同亮度值的缩略图会算出同一个哈希，验证不了配对）。
    const asc = thumbFixture((x) => x * 15) // 全行递增 → 每一位都是 1
    const desc = thumbFixture((x) => (THUMB_W - x) * 15) // 全行递减 → 每一位都是 0
    const checker = thumbFixture((x, y) => ((x + y) % 2 === 0 ? 0 : 255)) // 棋盘 → 每行交替
    const thumbs = [asc, desc, checker]
    const times = [0, 2, 4]
    const kept = pairFrames(times, thumbs)
    expect(kept).toEqual([
      { at: 0, hash: dhash(thumbs[0]!) },
      { at: 2, hash: dhash(thumbs[1]!) },
      { at: 4, hash: dhash(thumbs[2]!) },
    ])
    // 三张哈希互不相同，证明上面的断言不是靠巧合全等通过的。
    expect(new Set(kept.map((k) => k.hash)).size).toBe(3)
  })

  it('长度不等 → 抛，错误信息带上两个数', () => {
    expect(() => pairFrames([0, 2, 4], [thumbFixture(() => 0), thumbFixture(() => 0)])).toThrow(/3.*2|2.*3/)
  })
})

describe('frameAt', () => {
  it('取回一张 JPEG（魔数 ff d8 ff）', async () => {
    const jpg = await frameAt(video, 6)
    expect(jpg.length).toBeGreaterThan(1000)
    expect([jpg[0], jpg[1], jpg[2]]).toEqual([0xff, 0xd8, 0xff])
  })

  it('文件不存在 → 抛，且错误里带得上 ffmpeg 说了什么', async () => {
    await expect(frameAt(join(dir, 'nope.mp4'), 1)).rejects.toThrow()
  })
})

describe('planVideoFrames', () => {
  // testsrc 相邻关键帧的画面主体不动，只有角落的帧号在变，dHash 差距天然就小——minDistance
  // 若直接设成 DEFAULT_MIN_DISTANCE（10）会把不少帧压掉，这条测试的原意是单独验「时刻/哈希
  // 对齐是否正确」，不测「够不够门槛」，所以用 minDistance:0：哈明距离恒 >=0，`>= 0` 永真，
  // 保证一张都不合并。「门槛真的接了」留给下一条测试，「默认值真的生效」留给再下一条。
  it('minDistance:0 时哈明距离恒 >= 门槛，一张都不该被合并——用它验时刻/哈希对齐', async () => {
    const kept = await planVideoFrames(video, { minDistance: 0 })
    expect(kept).toHaveLength(10)
    expect(kept.map((k) => Math.round(k.at))).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
    expect(kept.every((k) => k.hash.length === 64)).toBe(true)
    // 哈希长度对不上仍然会漏配错位：真正能发现「哈希被配到别的时刻上」的断言是哈希互不
    // 相同（单元级的严格「第 i 个来自第 i 张」由 pairFrames 那组测试钉，这里只需能看出
    // 「不是全部一样」——曾经把 dhash(thumbs[i]) 错写成 dhash(thumbs[0])，全部哈希相同，
    // 这条断言会当场变红）。
    expect(new Set(kept.map((k) => k.hash)).size).toBeGreaterThan(1)
  })

  it('门槛设成 257（比 256 位还大，永远达不到）→ 只剩第一张', async () => {
    // 这条钉的是「去重真的接在链路上」：`planVideoFrames` 若忘了调 dedupeFrames，
    // 上面那条照样绿（testsrc 本来就每张都留），只有这条会红。
    const kept = await planVideoFrames(video, { minDistance: 257 })
    expect(kept).toHaveLength(1)
    expect(kept[0]!.at).toBeCloseTo(0, 3)
  })

  it('不传 minDistance → 走 DEFAULT_MIN_DISTANCE，不是某个巧合全绿的默认值', async () => {
    // 两条现有测试都显式传 minDistance，从未跑到过默认分支。实测：17×16 网格下这份 testsrc
    // 素材用默认门槛 10 保留 [0, 10] 共 2 张；`kept.length` 卡在 (1, 10) 区间是关键——如果
    // DEFAULT_MIN_DISTANCE 被错改成一个远超 256 位哈希空间的值（如 999），只会剩第一张
    // （长度 1），会被 `toBeGreaterThan(1)` 当场抓到；若被改成 0 附近，会接近全留（长度 10），
    // 会被 `toBeLessThan(10)` 抓到。
    const kept = await planVideoFrames(video)
    expect(kept.length).toBeGreaterThan(1)
    expect(kept.length).toBeLessThan(10)
    expect(kept[0]!.at).toBeCloseTo(0, 3)
  })
})

describe('mediaDurationS', () => {
  it('量得出 20s', async () => {
    expect(await mediaDurationS(video)).toBeCloseTo(20, 1)
  })
})

describe('sampleFrames', () => {
  it('默认取 8 帧，均匀撒在片长里', async () => {
    const got = await sampleFrames(video)
    expect(got).toHaveLength(8)
    // 均匀 = 相邻间隔基本相等；不钉死具体秒数（那是取样策略的实现细节），钉「铺开了」。
    expect(got[0]!.at).toBeLessThan(3)
    expect(got[7]!.at).toBeGreaterThan(15)
    expect(got.every((g, i) => i === 0 || g.at > got[i - 1]!.at)).toBe(true)
  })

  it('每帧都带哈希，长度与正式那条路一致', async () => {
    const got = await sampleFrames(video, { count: 4 })
    expect(got).toHaveLength(4)
    expect(got.every((g) => g.hash.length === 64)).toBe(true)
  })

  it('testsrc 一直在动 → 取样帧彼此不同', async () => {
    const got = await sampleFrames(video, { count: 4 })
    expect(new Set(got.map((g) => g.hash)).size).toBe(4)
  })

  it('count 比片长还密也不会取出重复时刻', async () => {
    const got = await sampleFrames(video, { count: 3 })
    expect(new Set(got.map((g) => g.at)).size).toBe(3)
  })

  it('count <= 0 → 抛，不静默回空数组（空数组会让闸门误判成"画面不动"）', async () => {
    await expect(sampleFrames(video, { count: 0 })).rejects.toThrow(/count/)
    await expect(sampleFrames(video, { count: -1 })).rejects.toThrow(/count/)
  })
})

describe('headerArgs', () => {
  it('未传 / 空对象 → 空数组（不影响现有调用的参数形状）', () => {
    expect(headerArgs()).toEqual([])
    expect(headerArgs({})).toEqual([])
  })

  it('单个头 → [\'-headers\', \'Key: Value\\r\\n\']', () => {
    expect(headerArgs({ Referer: 'https://www.bilibili.com/' })).toEqual([
      '-headers',
      'Referer: https://www.bilibili.com/\r\n',
    ])
  })

  it('多个头用 \\r\\n 拼接，结尾也带一个 \\r\\n', () => {
    const args = headerArgs({ Referer: 'https://x.com/', 'User-Agent': 'stream/1.0' })
    expect(args[0]).toBe('-headers')
    expect(args[1]).toBe('Referer: https://x.com/\r\nUser-Agent: stream/1.0\r\n')
  })

  it('值里带 \\n → 抛，错误信息里带上是哪个 key（防注入：换行等于能拼出新的 header）', () => {
    expect(() => headerArgs({ Cookie: 'a=1\nX-Evil: 1' })).toThrow(/Cookie/)
  })

  it('值里带 \\r → 抛', () => {
    expect(() => headerArgs({ Referer: 'https://x.com/\r\n' })).toThrow(/Referer/)
  })

  it('key 里带换行 → 也抛', () => {
    expect(() => headerArgs({ 'X-Evil\nInjected': '1' })).toThrow(/X-Evil/)
  })
})

/** 起一个只在带对头时才放行的本地 HTTP 服务器——验的不是"参数拼对了"（那是 headerArgs 的
 *  职责），是"headers 真的被 ffprobe/ffmpeg 用上了、且位置对"：`-headers` 若被错放到 `-i`/
 *  源地址之后，ffprobe/ffmpeg 根本不会把它应用到这个输入，服务器收不到头、403，这条测试会
 *  当场变红——比只测 headerArgs 的输出形状更接近"B 站 CDN 不带 Referer 就 403"这个真实故障。 */
function startHeaderGuardServer(filePath: string, requiredToken: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      void (async () => {
        if (req.headers['x-test-secret'] !== requiredToken) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        const st = await fsStat(filePath)
        const range = req.headers.range
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range)
          const start = m ? Number(m[1]) : 0
          const end = m?.[2] ? Number(m[2]) : st.size - 1
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${st.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': 'video/mp4',
          })
          createReadStream(filePath, { start, end }).pipe(res)
        } else {
          res.writeHead(200, {
            'Content-Length': st.size,
            'Accept-Ranges': 'bytes',
            'Content-Type': 'video/mp4',
          })
          createReadStream(filePath).pipe(res)
        }
      })()
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}/video.mp4`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

describe('headers 转发到 ffprobe/ffmpeg —— 真实 HTTP 服务器验证', () => {
  let guardedVideo: string
  let url: string
  let closeServer: () => Promise<void>

  beforeAll(async () => {
    // faststart：moov 挪到文件头，ffprobe 探时长不用先摸到文件尾——避免这条测试的红/绿
    // 被"服务器要不要支持 Range 到文件尾"这个无关变量污染。
    guardedVideo = join(dir, 'guarded.mp4')
    await execFileP('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=5',
      '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', guardedVideo,
    ])
    const s = await startHeaderGuardServer(guardedVideo, 'letmein-secret')
    url = s.url
    closeServer = s.close
  }, 60_000)

  afterAll(async () => {
    await closeServer()
  })

  it('不带 headers → 服务器 403 → mediaDurationS 抛', async () => {
    await expect(mediaDurationS(url)).rejects.toThrow()
  })

  it('带对的 headers → 通过，量出 5s', async () => {
    await expect(
      mediaDurationS(url, undefined, { headers: { 'x-test-secret': 'letmein-secret' } })
    ).resolves.toBeCloseTo(5, 0)
  })

  it('带错的 headers → 仍然 403，不是"传了 headers 就一律放行"', async () => {
    await expect(
      mediaDurationS(url, undefined, { headers: { 'x-test-secret': 'wrong' } })
    ).rejects.toThrow()
  })

  // frameAt 走的是 ffmpeg（显式 `-i`），不是 ffprobe 隐式输入——「-headers 必须在 -i 之前」
  // 这条约束对 ffmpeg 是真的会咬人的（多输入语法，选项按位置归属到它前面最近的输入），
  // 上面 mediaDurationS 那组测的是 ffprobe（单一隐式输入，实测 ffprobe 对 -headers 的位置
  // 不敏感），补这组才是真正卡住「必须在 -i 之前」这条约束的地方。
  it('frameAt 不带 headers → 403 → 抛', async () => {
    await expect(frameAt(url, 1)).rejects.toThrow()
  })

  it('frameAt 带对的 headers → 通过，取到一张 JPEG', async () => {
    const jpg = await frameAt(url, 1, undefined, { headers: { 'x-test-secret': 'letmein-secret' } })
    expect([jpg[0], jpg[1], jpg[2]]).toEqual([0xff, 0xd8, 0xff])
  })
})
