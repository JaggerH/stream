import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 缓存的值就是「一段带 mime 的音频字节」——netdisk 抽出来的 mka、某平台的纯音轨 m4a、
 *  douyin 的整段 mp4 都装得下。netdisk 侧的 NetdiskAudio 在结构上是它的超集（多几个
 *  探针字段），可直接赋值。 */
export interface CachedAudio {
  bytes: Uint8Array
  mime: string
}

/**
 * 音频字节的落盘缓存——供**所有**要给转写/声纹喂音频的腿共用：netdisk 音轨抽取（走转码档
 * ~30s、走原盘几分钟）、douyin/各视频平台整段拉流。同一条内容短时间内重转（开关 diarize、
 * 补说话人、误删转写）不再重付网络/容器传输。
 *
 * 键是**调用方自己起的字符串**（netdisk 用盘内路径、代理腿用 provider+定位符），缓存对键
 * 的语义不知情，sha256 一视同仁。mime 编码在文件扩展名里（映射见 EXT_BY_MIME），映射外的
 * mime 不缓存——宁可少缓存也不落一个读不回 mime 的文件。
 *
 * 和 subtitle-cache 同骨架（sha256 键、mtime 判 TTL、过期视为未命中），但**寿命完全不同**：
 * 字幕每次播放都要端出来、值得留 10 天；音频是转写的**中间品**——持久产物是 conversions 表里
 * 那条 stt 记录（`src/conversions/store.ts`），复用窗口就是「同一次转写的重试」那几分钟。所以 TTL 只有 10 分钟，且每次
 * 写入顺手把过期条目连文件一起清掉（不等容量压力），常态下这个目录几乎是空的。
 *
 * 容量上限（默认 2GiB）仍在，兜「10 分钟内密集转一整季」的并发场景：超了按 mtime 淘汰
 * 最久未用的（读命中会 touch mtime，mtime 序 = LRU 序）。
 */
const TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024

const EXT_BY_MIME: Record<string, string> = {
  'audio/x-matroska': 'mka',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
}
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m])
)

/**
 * 各腿注入这个缓存时用的类型。**别再手写 `Pick<AudioCache, …>`**：那样每加一个方法就要去
 * 找齐所有注入点，找漏了是 typecheck 报错（响亮），但改起来是一次没必要的全仓翻找。
 */
export type AudioCacheLike = Pick<AudioCache, 'read' | 'write' | 'share' | 'isInFlight' | 'readOrCompute'>

export class AudioCache {
  /**
   * 「这份字节此刻有没有人正在取」——**在途表**，纯内存，进程重启即空（重启之后本来也没人在取）。
   *
   * 为什么它必须住在这个类里：落盘缓存回答的是「这份字节在不在本地」，在途表回答的是同一个
   * 问题的另一半。**两者必须用同一把钥匙**——另起一处记「谁在取」就要另算一次键，两把键一旦
   * 对不上，就会出现「缓存认为是同一份、在途表认为是两份」，照样白取一遍，且没有任何一处报错。
   *
   * 为什么需要它：落盘缓存是**取完才写**的。两个消费方同时开工（取白文 ‖ 声纹时间轴）时，
   * 后来的那个读缓存必然落空——于是同一份几百 MB 的音频被同时取两遍，互抢带宽。串行时代
   * 靠「第二个总是后到」白蹭到缓存，一并行这条运气就没了。
   */
  private readonly inflight = new Map<string, Promise<unknown>>()

  constructor(
    private readonly dir: string,
    private readonly opts: { maxBytes?: number; ttlMs?: number } = {},
  ) {}

  private hash(key: string): string {
    return createHash('sha256').update(key).digest('hex')
  }

  /** 这把键此刻有没有人在取。**问完必须在同一个 tick 内接着 `share`**（中间不能有 await），
   *  否则这个判断就成了猜的。它存在只为让调用方分得清「我自己取的」和「我等了别人的」，
   *  好在账上留下痕迹。 */
  isInFlight(key: string): boolean {
    return this.inflight.has(key)
  }

  /**
   * 同一把键同一时刻只跑一次 `fn`，后来者等第一个的结果。
   *
   * **失败也是共享的**：第一个取失败，等着的人拿到同一个异常，不会各自再去重试一遍——那是
   * 在一个已经证明取不到的地址上放大流量。要重试是调用方下一次调用的事。
   *
   * 键的取值空间由调用方保证不串（网盘腿用盘内路径、代理腿用 `provider:定位符`，天然不重叠）。
   * 同一把键必须对应同一种返回值——这也是它和落盘缓存共用键的必然要求。
   */
  share<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key)
    if (running) return running as Promise<T>
    let p: Promise<T>
    try {
      p = Promise.resolve(fn())
    } catch (e) {
      // fn 同步抛：压根没有在途的东西可共享，直接把异常交回去，表里不留痕。
      return Promise.reject(e)
    }
    p = p.finally(() => {
      // 只摘自己那条：这期间可能已经起了新的一轮。
      if (this.inflight.get(key) === p) this.inflight.delete(key)
    })
    this.inflight.set(key, p)
    return p
  }

  /**
   * 「这份字节给我」——本地有就给，有人在取就等他，都没有才去取，取完顺手存下。
   *
   * 落盘缓存的读在 `share` **里面**：后来者根本走不到读那一步（它在等第一个的结果），
   * 所以不会出现「读了个空、于是自己也去取一遍」。
   *
   * 写失败不拖累本次结果——字节已经在手上了，存不下只是下次要重取。
   */
  async readOrCompute(key: string, compute: () => Promise<CachedAudio>): Promise<CachedAudio> {
    return this.share(key, async () => {
      const hit = await this.read(key).catch(() => null)
      if (hit) return hit
      const out = await compute()
      await this.write(key, out).catch(() => {})
      return out
    })
  }

  async read(key: string): Promise<CachedAudio | null> {
    const prefix = this.hash(key)
    try {
      // 键不携带 mime，所以按 hash 前缀找文件、从扩展名读回 mime。目录常态近空
      // （见头注的寿命哲学），readdir 就是最便宜的查法。
      const name = (await readdir(this.dir)).find((f) => f.startsWith(`${prefix}.`))
      if (!name) return null
      const mime = MIME_BY_EXT[name.slice(prefix.length + 1)]
      if (!mime) return null
      const file = join(this.dir, name)
      const st = await stat(file)
      if (Date.now() - st.mtimeMs > (this.opts.ttlMs ?? TTL_MS)) return null
      const bytes = await readFile(file)
      // 读命中 touch mtime：mtime 序 = LRU 序，热条目不会被容量淘汰扫掉
      const now = new Date()
      await utimes(file, now, now).catch(() => {})
      return { bytes, mime }
    } catch {
      return null
    }
  }

  /**
   * 清扫什么时候发生——三个触发点，缺一就有磁盘残留：
   *
   *  1. **每次写入后**（本方法尾部）：删过期 + 容量淘汰。
   *  2. **每次写入后再约一个 TTL 之后**（unref 定时器）：兜「最后一批写入」——转完一季就不再
   *     转写的话，没有下一次写入来收尸，靠这个定时器在它们过期后回来删。unref 不拖住进程退出；
   *     定时器天生不劫后重启，所以还有 3。
   *  3. **进程启动时**（bootstrap 调一次 `sweep()`）：接住重启丢掉的定时器留下的残留。
   *
   * 清扫失败不影响写入结果。
   */
  async write(key: string, audio: CachedAudio): Promise<void> {
    const ext = EXT_BY_MIME[audio.mime]
    if (!ext) return // 映射外的 mime 不缓存（见头注）
    await mkdir(this.dir, { recursive: true })
    const prefix = this.hash(key)
    // 同键换 mime（同一集这次走了不同转码档）会换扩展名——先把旧扩展名的尸体清掉，
    // 免得 read 的前缀匹配捞到两个文件里旧的那个。
    for (const f of (await readdir(this.dir).catch(() => [] as string[]))) {
      if (f.startsWith(`${prefix}.`) && f !== `${prefix}.${ext}`) await rm(join(this.dir, f), { force: true })
    }
    await writeFile(join(this.dir, `${prefix}.${ext}`), audio.bytes)
    await this.evict().catch(() => {})
    const ttl = this.opts.ttlMs ?? TTL_MS
    setTimeout(() => void this.evict().catch(() => {}), ttl + 5000).unref?.()
  }

  /** 启动清扫（触发点 3）。best-effort：目录不存在/扫不动都安静返回。 */
  async sweep(): Promise<void> {
    await this.evict().catch(() => {})
  }

  private async evict(): Promise<void> {
    const max = this.opts.maxBytes ?? DEFAULT_MAX_BYTES
    const ttl = this.opts.ttlMs ?? TTL_MS
    const entries = await Promise.all(
      (await readdir(this.dir)).filter((f) => MIME_BY_EXT[f.split('.').pop() ?? '']).map(async (f) => {
        const p = join(this.dir, f)
        const st = await stat(p)
        return { p, size: st.size, mtimeMs: st.mtimeMs }
      }),
    )
    const now = Date.now()
    const live: typeof entries = []
    for (const e of entries) {
      if (now - e.mtimeMs > ttl) await rm(e.p, { force: true })
      else live.push(e)
    }
    let total = live.reduce((a, e) => a + e.size, 0)
    for (const e of live.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= max) break
      await rm(e.p, { force: true })
      total -= e.size
    }
  }
}
