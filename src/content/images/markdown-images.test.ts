import { describe, it, expect } from 'vitest'
import { listMarkdownImages, annotateMarkdownImages } from './markdown-images.ts'

const MD = `# 标题

一段正文。

![封面](https://e.com/a.png)

再一段。

![](https://e.com/b.jpg)
`

describe('listMarkdownImages', () => {
  it('按出现顺序列出 alt 与 url', () => {
    expect(listMarkdownImages(MD)).toEqual([
      { alt: '封面', url: 'https://e.com/a.png' },
      { alt: '', url: 'https://e.com/b.jpg' },
    ])
  })

  it('同一个 url 出现两次就是两条——按位置不按去重', () => {
    const md = '![x](https://e.com/a.png)\n\n![y](https://e.com/a.png)'
    expect(listMarkdownImages(md)).toHaveLength(2)
  })

  it('不把普通链接当图片', () => {
    expect(listMarkdownImages('[不是图](https://e.com/a.png)')).toEqual([])
  })

  it('没有图片时返回空数组', () => {
    expect(listMarkdownImages('# 只有文字')).toEqual([])
  })

  it('url 含一层成对括号（CommonMark 允许）不会被截断', () => {
    expect(listMarkdownImages('![封面](https://up.wikimedia.org/Foo_(disambiguation).jpg)')).toEqual([
      { alt: '封面', url: 'https://up.wikimedia.org/Foo_(disambiguation).jpg' },
    ])
  })
})

describe('annotateMarkdownImages', () => {
  it('批注插在该图片紧接着的下一行，原图保留', () => {
    const out = annotateMarkdownImages(MD, ['图中文字：你好', null])
    expect(out).toContain('![封面](https://e.com/a.png)\n> 图中文字：你好')
    // 第二张没有批注，原样不动
    expect(out).toContain('![](https://e.com/b.jpg)')
    expect(out).not.toContain('![](https://e.com/b.jpg)\n>')
  })

  it('多行 OCR 结果每一行都带上引用前缀，否则第二行会脱离引用块', () => {
    const out = annotateMarkdownImages('![a](https://e.com/a.png)', ['图中文字：第一行\n第二行'])
    expect(out).toBe('![a](https://e.com/a.png)\n> 图中文字：第一行\n> 第二行')
  })

  it('notes 与图片一一对位——同 url 的两次出现各拿各的', () => {
    const md = '![x](https://e.com/a.png)\n\n![y](https://e.com/a.png)'
    const out = annotateMarkdownImages(md, ['第一处', '第二处'])
    expect(out).toBe('![x](https://e.com/a.png)\n> 第一处\n\n![y](https://e.com/a.png)\n> 第二处')
  })

  it('notes 比图片少时，多出来的图片不加批注（不抛）', () => {
    const out = annotateMarkdownImages(MD, ['只有第一张'])
    expect(out).toContain('> 只有第一张')
    expect(out).toContain('![](https://e.com/b.jpg)')
  })

  it('notes 全 null 时原样返回', () => {
    expect(annotateMarkdownImages(MD, [null, null])).toBe(MD)
  })

  // 下面四条钉住"批注插在行尾，不插在正则匹配结束处"——旧实现会把图片后面同一行的
  // 正文一起吞进引用块，或把图片语法本身劈开。
  it('行内图：批注落在行尾，图片后面同一行的正文不会被吞进引用块', () => {
    const out = annotateMarkdownImages('前面的字 ![图](https://e.com/a.png) 后面的字，同一段。', [
      '图中文字：XX',
    ])
    expect(out).toBe('前面的字 ![图](https://e.com/a.png) 后面的字，同一段。\n> 图中文字：XX')
  })

  it('嵌套链接：外层链接结构不能被批注劈开', () => {
    const out = annotateMarkdownImages('[![logo](https://e.com/l.png)](https://e.com/home)', [
      '图中文字：XX',
    ])
    expect(out).toBe('[![logo](https://e.com/l.png)](https://e.com/home)\n> 图中文字：XX')
  })

  it('URL 含成对括号不被截断，批注内容不被污染', () => {
    const out = annotateMarkdownImages(
      '![封面](https://up.wikimedia.org/Foo_(disambiguation).jpg)',
      ['图中文字：XX'],
    )
    expect(out).toBe(
      '![封面](https://up.wikimedia.org/Foo_(disambiguation).jpg)\n> 图中文字：XX',
    )
  })

  // alt 部分 `[^\]]*` 能吃换行，匹配因此可以跨行——行号必须按匹配**结束位置**算，
  // 否则"起点所在行"落在图片语法内部，批注会把 `![...]` 劈成两半。
  it('alt 含换行：批注落在图片语法结束后那一行的行尾，图片语法本身不被批注劈开', () => {
    const md = '![第一行\n第二行](https://e.com/a.png) 尾巴'
    const out = annotateMarkdownImages(md, ['图中文字：XX'])
    expect(out).toBe('![第一行\n第二行](https://e.com/a.png) 尾巴\n> 图中文字：XX')
  })

  it('同一行两张图，各自的批注按出现顺序攒到行尾，不串位', () => {
    const out = annotateMarkdownImages(
      '![a](https://e.com/a.png) ![b](https://e.com/b.png)',
      ['注A', '注B'],
    )
    expect(out).toBe('![a](https://e.com/a.png) ![b](https://e.com/b.png)\n> 注A\n> 注B')
  })
})
