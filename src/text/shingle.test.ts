import { describe, it, expect } from 'vitest'
import { textSketch, sketchSim, normalizeForFingerprint, longestSharedRun } from './shingle.ts'

const sim = (a: string, b: string) => sketchSim(textSketch(a), textSketch(b))

/** 一段真实形状的转写（抖音那条观澜介绍的开头，ASR 原样：没有标点、有错字）。 */
const ASR = `关栏 这是我这两天web出来的一个小产品 我来给大家做一个简单的介绍
就是我们这个主要是去监控全球的媒体信息 然后并且能通过这些信息来去观察 舆情背后的议题
就是它的议程设置是如何的 那么我们一共监控了172个国家和地区 包括408家主流的媒体员`

describe('textSketch / sketchSim', () => {
  it('同一段文本 → 1', () => {
    expect(sim(ASR, ASR)).toBe(1)
  })

  it('**标点、空格、大小写不承载身份**——两个 ASR 引擎转同一段音频就差这些', () => {
    const withPunct = ASR.replace(/\n/g, '，') + '。'
    expect(sim(ASR, withPunct)).toBe(1)
    expect(normalizeForFingerprint('Hello, World!')).toBe(normalizeForFingerprint('hello world'))
  })

  it('片头多一句问候、片尾多一句水印 → 仍然认得出是同一条', () => {
    const withIntro = `大家好欢迎回来。${ASR} 记得点赞关注哦，本视频由某某平台提供。`
    expect(sim(ASR, withIntro)).toBeGreaterThan(0.6)
  })

  it('讲同一个话题但不是同一段话 → 明显低', () => {
    const other = `今天我们来聊一聊舆情监控这件事情，市面上有很多做媒体监测的产品，
      它们大多依赖关键词匹配，覆盖的国家和媒体数量差别很大。`
    expect(sim(ASR, other)).toBeLessThan(0.2)
  })

  it('完全不相干 → 接近 0', () => {
    expect(sim(ASR, '今天天气不错，我去菜市场买了两斤排骨和一把青菜。')).toBeLessThan(0.05)
  })

  it('**太短的文本判不了，返回 -1 而不是 0**——「没依据」和「不像」是两件事', () => {
    expect(textSketch('短')).toEqual([])
    expect(sketchSim(textSketch('短'), textSketch(ASR))).toBe(-1)
    expect(sketchSim([], [])).toBe(-1)
  })

  it('草图是定长的：再长的正文也只存几十个数', () => {
    expect(textSketch(ASR.repeat(50)).length).toBe(64)
  })

  it('草图两边各算各的，不需要同时在场（这正是能存进库的原因）', () => {
    const a = textSketch(ASR)
    const b = textSketch(ASR.replace('172', '173'))
    expect(sketchSim(a, b)).toBeGreaterThan(0.8)
  })
})

describe('longestSharedRun —— 两篇里最长的那一段一模一样的连续正文', () => {
  const CORE = ASR.repeat(2)

  it('两边裹着完全不同的样板，共享块照样量得出来（整篇 Jaccard 在这种形状下没用）', () => {
    const a = '导航 首页 财经 体育｜' + CORE + '｜免责声明：本文不构成投资建议。热点阅读 A B C'
    const b = '【转载】' + CORE + '｜关于我们 联系我们 版权所有 京ICP备xxxxxx号 相关推荐 D E F'
    expect(longestSharedRun(a, b)).toBeGreaterThan(200)
  })

  it('各写各的同一件事：只共享零星短语，够不着几十字', () => {
    const a = '开发生成式人工智能的美国OpenAI公司宣布暂时停止其模型的开发，理由是能力大幅提升。'
    const b = 'OpenAI表示，在对即将推出的模型进行内部评估后，无法排除其具备关键性网络能力。'
    expect(longestSharedRun(a, b)).toBeLessThan(20)
  })

  it('一边太短 → 0（判不了由调用方分开表达，别拿 0 冒充）', () => {
    expect(longestSharedRun('短', CORE)).toBe(0)
  })
})
