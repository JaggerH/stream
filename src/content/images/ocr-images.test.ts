import { describe, it, expect, vi } from 'vitest'
import { ocrArticleImages, type OcrImagesDeps } from './ocr-images.ts'

const MD = '![a](https://e.com/a.png)\n\n![b](https://e.com/b.png)'
const BYTES = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }

/** 默认全好使的 deps；单条用例按需覆盖其中一项。 */
function deps(over: Partial<OcrImagesDeps> = {}): OcrImagesDeps {
  return {
    fetchBytes: async () => BYTES,
    ocr: async () => '识别出来的字',
    ...over,
  }
}

describe('ocrArticleImages', () => {
  it('每张图都识别，结果批注回原位', async () => {
    const r = await ocrArticleImages(MD, deps())
    expect(r.recognized).toBe(2)
    expect(r.unrecognized).toBe(0)
    expect(r.markdown).toContain('![a](https://e.com/a.png)\n> 图中文字：识别出来的字')
    expect(r.markdown).toContain('![b](https://e.com/b.png)\n> 图中文字：识别出来的字')
  })

  it('没有图片时原样返回，一次 dep 都不调', async () => {
    const fetchBytes = vi.fn()
    const r = await ocrArticleImages('# 只有文字', deps({ fetchBytes }))
    expect(r.markdown).toBe('# 只有文字')
    expect(r.recognized).toBe(0)
    expect(fetchBytes).not.toHaveBeenCalled()
  })

  // 下面三条是同一条纪律的三种形态：单张图出问题**不能**让整篇正文消失。
  // "正文有、某张图没识别"是一个有用的结果。
  it('单张图下载失败 → 只有那张留标记，另一张照常', async () => {
    const r = await ocrArticleImages(
      MD,
      deps({ fetchBytes: async (u) => (u.endsWith('a.png') ? null : BYTES) }),
    )
    expect(r.markdown).toContain('![a](https://e.com/a.png)\n> [未识别：取不到图片]')
    expect(r.markdown).toContain('![b](https://e.com/b.png)\n> 图中文字：识别出来的字')
    expect(r.recognized).toBe(1)
    expect(r.unrecognized).toBe(1)
  })

  it('OCR 抛错 → 留标记并带上原因，不往外抛', async () => {
    const r = await ocrArticleImages(
      MD,
      deps({ ocr: async () => { throw new Error('模型返回空正文') } }),
    )
    expect(r.markdown).toContain('> [未识别：模型返回空正文]')
    expect(r.recognized).toBe(0)
    expect(r.unrecognized).toBe(2)
  })

  it('OCR 返回空 → 留标记，不插一条空批注', async () => {
    const r = await ocrArticleImages(MD, deps({ ocr: async () => '   ' }))
    expect(r.markdown).toContain('> [未识别：图上没有可读文字]')
    expect(r.unrecognized).toBe(2)
  })

  // ocr 合法返回 null（按契约="没识别出东西"）不能和 fetchBytes 返回 null（="取不到图片"）
  // 混成同一条标记——两者对应完全不同的排查方向（查 OCR 后端 vs 查图片 URL/网络）。
  it('OCR 返回 null（不是空字符串）→ 标记是"没有可读文字"，不能被误标成"取不到图片"', async () => {
    const r = await ocrArticleImages(MD, deps({ ocr: async () => null }))
    expect(r.markdown).toContain('> [未识别：图上没有可读文字]')
    expect(r.markdown).not.toContain('取不到图片')
    expect(r.unrecognized).toBe(2)
  })

  // 这条是"不静默截断"的兑现：超时后剩下的图**必须在正文里看得见**，
  // 否则读的人无从知道自己缺了什么——而"不缺省图片信息"正是这整件事的目的。
  //
  // fetchBytes 按 url 返回可区分的字节（而非两张图共用同一份 BYTES），这样
  // ocr 的快慢判据才能真的按图分流——否则两张图会一起落进"慢"分支，验不到
  // "已完成的保留"这半句承诺。
  it('总超时 → 未完成的留可见标记，已完成的保留', async () => {
    const r = await ocrArticleImages(
      MD,
      deps({
        fetchBytes: async (u) =>
          u.endsWith('a.png')
            ? { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }
            : { bytes: new Uint8Array([9, 9, 9]), mime: 'image/png' },
        ocr: async (b, m) =>
          m === 'image/png' && b[0] === 1
            ? new Promise((res) => setTimeout(() => res('永远来不及'), 10_000))
            : '快的那张',
      }),
      { totalTimeoutMs: 50, concurrency: 2 },
    )
    expect(r.markdown).toContain('> [未识别：总超时]')
    expect(r.unrecognized).toBeGreaterThan(0)
    // 已完成的那张必须保留识别结果——不是被总超时一起抹掉
    expect(r.markdown).toContain('![b](https://e.com/b.png)\n> 图中文字：快的那张')
    // 正文本身必须完好——超时不能让整篇消失
    expect(r.markdown).toContain('![a](https://e.com/a.png)')
    expect(r.markdown).toContain('![b](https://e.com/b.png)')
  }, 10_000)

  // Promise.race 里输掉的那个 setTimeout 不会自动清理；常规路径下 OCR 远快于总超时，
  // 赢的每次都是 timer 那一路。用假定时器验证：work 先完成后，不该再有悬挂的定时器
  // 挂在事件循环里等着 60s 后触发。
  it('work 先完成 → 输掉的定时器被清理，不留悬挂 timer', async () => {
    vi.useFakeTimers()
    try {
      const r = await ocrArticleImages(MD, deps())
      expect(r.recognized).toBe(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('OCR 抛出非 Error（裸字符串）→ 标记里必须带上那个字符串，不能是 undefined', async () => {
    const r = await ocrArticleImages(
      MD,
      deps({
        ocr: async () => {
          throw '一个裸字符串'
        },
      }),
    )
    expect(r.markdown).toContain('[未识别：一个裸字符串]')
    expect(r.markdown).not.toContain('undefined')
  })

  // ocr 的真实返回类型是 string | null，与内部哨兵共享字符串值域会有极小概率的误判
  // （水印/对抗样本恰好识别出和哨兵字面量相同的文字）。用判别式联合排除后，即使 OCR
  // 真的识别出 '__nofetch__' 这个字符串，也必须当成一段正常识别到的文字处理。
  it('OCR 识别出的文字恰好是哨兵字面量 "__nofetch__" → 当成识别成功，不是"取不到图片"', async () => {
    const r = await ocrArticleImages(MD, deps({ ocr: async () => '__nofetch__' }))
    expect(r.markdown).toContain('> 图中文字：__nofetch__')
    expect(r.markdown).not.toContain('取不到图片')
    expect(r.recognized).toBe(2)
  })

  // 饿死回归——本文件里最重要的一条。修复前：一张挂住的图占死一个工位到总预算耗尽，
  // 并发 2 的情况下 1 张挂住图就能让后面排队的图连一次尝试都没发生（0 张成功而不是
  // "快的那些成功了"）。单图超时的意义就是让挂住的那张自己认栽、把工位让出来。
  //
  // fetchBytes 按 url 传回可区分的字节，ocr 按字节内容分流：第 0 张永远不回，
  // 其余 4 张立即返回。5 张图、并发 2。
  it('一张图挂住不能饿死其余图：那张标"识别超时"，其余全部识别成功', async () => {
    const md = Array.from({ length: 5 }, (_, i) => `![i${i}](https://e.com/${i}.png)`).join('\n\n')
    const r = await ocrArticleImages(
      md,
      deps({
        fetchBytes: async (u) => ({ bytes: new TextEncoder().encode(u), mime: 'image/png' }),
        ocr: async (b) => {
          const url = new TextDecoder().decode(b)
          if (url.endsWith('/0.png')) return new Promise<string>(() => {}) // 永远不回
          return '识别出来的字'
        },
      }),
      { concurrency: 2, perImageTimeoutMs: 30, totalTimeoutMs: 5_000 },
    )
    expect(r.markdown).toContain('![i0](https://e.com/0.png)\n> [未识别：识别超时]')
    for (let i = 1; i < 5; i++) {
      expect(r.markdown).toContain(`![i${i}](https://e.com/${i}.png)\n> 图中文字：识别出来的字`)
    }
    expect(r.recognized).toBe(4)
    expect(r.unrecognized).toBe(1)
  }, 10_000)

  // 单图超时 vs 总超时：两种标记必须不同，且各自触发条件独立——单图超时不依赖总预算
  // 是否宽裕，只看这一张自己是否超过了 perImageTimeoutMs。
  it('单图超时：即使总预算很宽裕，单张图超过 perImageTimeoutMs 也标"识别超时"', async () => {
    const r = await ocrArticleImages(
      MD,
      deps({ ocr: async () => new Promise<string>(() => {}) }),
      { concurrency: 2, perImageTimeoutMs: 30, totalTimeoutMs: 60_000 },
    )
    expect(r.markdown).toContain('[未识别：识别超时]')
    expect(r.markdown).not.toContain('总超时')
    expect(r.unrecognized).toBe(2)
  })

  // 总超时依旧保留：单图超时不取代总预算这道闸，两者并存、取先到的那个。
  it('总超时依旧生效：perImageTimeoutMs 很宽松时，总预算耗尽仍标"总超时"', async () => {
    const r = await ocrArticleImages(
      MD,
      deps({ ocr: async () => new Promise<string>(() => {}) }),
      { concurrency: 2, perImageTimeoutMs: 60_000, totalTimeoutMs: 30 },
    )
    expect(r.markdown).toContain('[未识别：总超时]')
    expect(r.markdown).not.toContain('识别超时')
    expect(r.unrecognized).toBe(2)
  })

  // GIF：视觉模型处理不了，主动跳过——不调用 deps.ocr（省下那次注定挂住的调用）,
  // 且标记要让读的人分清"我们没送"和"送了但没识别出来"。判据用下载回来的 mime，
  // 不用 URL 后缀（bilibili 的 URL 长这样 `....gif@264w_264h_1e_1c`，后缀不可靠）。
  it('GIF：主动跳过，留标记，一次 ocr 都不调', async () => {
    const ocr = vi.fn(async () => '不该被调用到')
    const r = await ocrArticleImages(
      MD,
      deps({
        fetchBytes: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/gif' }),
        ocr,
      }),
    )
    expect(r.markdown).toContain('[未识别：GIF 不支持，未送识别]')
    expect(r.unrecognized).toBe(2)
    expect(r.recognized).toBe(0)
    expect(ocr).not.toHaveBeenCalled()
  })

  // 非 GIF（png/jpeg/webp）不受影响，照常送去识别。
  it.each(['image/png', 'image/jpeg', 'image/webp'])('非 GIF（%s）不受影响，照常识别', async (mime) => {
    const r = await ocrArticleImages(
      MD,
      deps({ fetchBytes: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime }) }),
    )
    expect(r.recognized).toBe(2)
    expect(r.markdown).toContain('图中文字：识别出来的字')
  })

  it('并发有上限：同时在跑的不超过 concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const md = Array.from({ length: 8 }, (_, i) => `![i${i}](https://e.com/${i}.png)`).join('\n\n')
    const r = await ocrArticleImages(
      md,
      deps({
        ocr: async () => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise((res) => setTimeout(res, 5))
          inFlight--
          return '字'
        },
      }),
      { concurrency: 3 },
    )
    // 8 张图 × 5ms × 3 worker：peak 命中 3 是确定性的。<=3 太松——一个把并发彻底做没了
    // （完全串行，peak=1）的回归照样能过那条断言，而并发就是这个编排层存在的理由之一。
    expect(peak).toBe(3)
    expect(r.recognized).toBe(8)
  })
})
