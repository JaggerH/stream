import { describe, it, expect } from 'vitest'
import { telegramNormalizer } from './normalizer.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

/**
 * 样本全部是活体抄回来的原文（2026-08-03，「夸克云盘影视资源频道」，经 a11y 树读到的控件 name）。
 * **不要拿手写的理想样本测这一层**——它存在的全部理由就是上游给的是一坨没有结构的文本，
 * 自己编一份规整的输入等于把被测的那件事绕过去了。
 */
const REAL = `夸克云盘影视资源频道
图片, 853×1280
名称：野狗骨头（2026）4K 更至EP12

描述：改编自休屠城同名小说，由宋威龙、张婧仪主演。故事设定在90年代南方小城。

夸克：https://pan.quark.cn/s/aacab8de665b

📁 大小：2.5G/集
🏷 标签：#野狗骨头 #宋威龙 #张婧仪 #剧情 #爱情
已收到   20:27 904 浏览次数`

/** 同一个频道里混着的广告条：没有「名称：」、没有链接，只有一行推广。 */
const AD = `夸克云盘影视资源频道
广告: 看到就是你的机会: ✅项目资源分享，副业，创业，自媒体，等知识分享。
已收到   9:19`

/** 频道互推：有正文没网盘链接，引用的是 @handle。 */
const CROSS_PROMO = `夸克云盘影视资源频道
转发自 阿里、夸克、百度网盘4K影视资源
#频道推荐 #纪录片

这是一个夸克网盘纪录片资源频道，每日发布一些高画质纪录片资源。

频道地址：@xvth5
已收到 已编辑   0:54 584 浏览次数`

const manifest = {} as SourceManifest

describe('telegramNormalizer', () => {
  it('网盘链接成卡片，正文只留描述', () => {
    const c = telegramNormalizer({ content: REAL, title: '野狗骨头（2026）4K 更至EP12' }, manifest)
    expect(c.archetype).toBe('link')
    expect(c.title).toBe('野狗骨头（2026）4K 更至EP12')
    expect(c.media).toEqual([
      { kind: 'link', url: 'https://pan.quark.cn/s/aacab8de665b', title: '夸克网盘' },
    ])
    // 尾巴上的「已收到 / 904 浏览次数」是客户端 UI 的读数，不是内容
    expect(c.text).toBe('改编自休屠城同名小说，由宋威龙、张婧仪主演。故事设定在90年代南方小城。')
    expect(c.text).not.toContain('浏览次数')
  })

  /** 标题的唯一来源是 recipe 抽好的顶层字段。这一层再抽一次 = 两处规则、迟早漂移，
   *  而且前端显示的根本不是这里的 title。 */
  it('顶层没给 title 就不编一个——绝不拿正文头一行冒充', () => {
    const c = telegramNormalizer({ content: REAL }, manifest)
    expect(c.title).toBeUndefined()
  })

  it('提取码跟着网盘标签走', () => {
    const c = telegramNormalizer(
      { content: '名称：家有神兽\n\n夸克网盘 https://pan.quark.cn/s/abc123  提取码：1111' },
      manifest,
    )
    expect(c.media?.[0]).toEqual({
      kind: 'link',
      url: 'https://pan.quark.cn/s/abc123',
      title: '夸克网盘 · 提取码 1111',
    })
  })

  it('认不出的域名照原样给 URL，不安一个"网盘"的名头', () => {
    const c = telegramNormalizer({ content: '看这个 https://example.com/x' }, manifest)
    expect(c.media?.[0]).toEqual({ kind: 'link', url: 'https://example.com/x', title: 'https://example.com/x' })
  })

  it('链接末尾粘着的标点不算 URL 的一部分', () => {
    const c = telegramNormalizer({ content: '地址 https://pan.quark.cn/s/abc123。' }, manifest)
    expect(c.media?.[0].url).toBe('https://pan.quark.cn/s/abc123')
  })

  it('同一条里重复贴的同一个链接只留一张卡', () => {
    const c = telegramNormalizer(
      { content: 'https://pan.quark.cn/s/abc 备用 https://pan.quark.cn/s/abc' },
      manifest,
    )
    expect(c.media).toHaveLength(1)
  })

  /** 广告条 / 互推抽不到描述。这时退回原文——把它变成一张空卡，用户只会看见一条没头没尾的东西。 */
  it('抽不到描述就退回原文，不产出空卡', () => {
    expect(telegramNormalizer({ content: AD }, manifest).text).toContain('项目资源分享')
    const promo = telegramNormalizer({ content: CROSS_PROMO }, manifest)
    expect(promo.text).toContain('纪录片资源频道')
    expect(promo.media).toEqual([]) // @handle 不是链接，不该被当成网盘
  })
})
