import { describe, it, expect } from 'vitest'
import { materializeParams, validateParams, type ParamEnv } from './validate-params.ts'

describe('validateParams', () => {
  const schema = { uid: { type: 'string', required: true }, page: { type: 'number' } }

  it('passes when required present and types match', () => {
    expect(() => validateParams(schema, { uid: '42', page: 2 })).not.toThrow()
  })

  it('throws on a missing required param', () => {
    expect(() => validateParams(schema, {})).toThrow(/uid/)
  })

  it('throws on a wrong type', () => {
    expect(() => validateParams(schema, { uid: 42 })).toThrow(/string/)
  })

  it('ignores absent optional params', () => {
    expect(() => validateParams(schema, { uid: '42' })).not.toThrow()
  })
})

describe('materializeParams', () => {
  it('String() 每个值、只补缺席的 default、不覆盖调用方给的', () => {
    const schema = { send: { type: 'boolean', default: true }, n: { type: 'number' }, contact: { type: 'string', required: true } }
    expect(materializeParams(schema, { contact: 'a', send: false })).toEqual({ contact: 'a', send: 'false' })
    expect(materializeParams(schema, { contact: 'a', n: 3 })).toEqual({ contact: 'a', n: '3', send: 'true' })
  })

  describe("format:'path'", () => {
    const schema = { path: { type: 'string', required: true, format: 'path' } }
    const env = (over: Partial<ParamEnv> = {}): ParamEnv => ({
      wsl: true,
      exists: () => true,
      translateToWindowsPath: (p) => `\\\\wsl.localhost\\Ubuntu${p.replace(/\//g, '\\')}`,
      ...over,
    })

    /** `a.txt` 的那五个派生键（`path-params.ts`）。 */
    const A_TXT = { path_name: 'a.txt', path_stem: 'a', path_stem6: 'a', path_ext: 'txt', path_kind: 'file' }
    it('后端在 WSL 里 → Linux 路径翻成 \\\\wsl.localhost\\… 交给 Windows 侧；顺带派生 <key>_name 等片段', () => {
      expect(materializeParams(schema, { path: '/home/j/a.txt' }, env())).toEqual({ path: '\\\\wsl.localhost\\Ubuntu\\home\\j\\a.txt', ...A_TXT })
    })
    it('不在 WSL 里 → 原样', () => {
      expect(materializeParams(schema, { path: '/Users/j/报表 v2.xlsx' }, env({ wsl: false }))).toEqual({
        path: '/Users/j/报表 v2.xlsx', path_name: '报表 v2.xlsx', path_stem: '报表 v2', path_stem6: '报表 v2', path_ext: 'xlsx', path_kind: 'file',
      })
    })
    it('multiple：按换行拆开各自翻译、各自验存在，翻完按换行拼回去；不派生 _name 那几个键', () => {
      const multi = { files: { type: 'string', format: 'path', multiple: true } }
      expect(materializeParams(multi, { files: '/home/j/a.png\n\n/home/j/b.png\n' }, env())).toEqual({
        files: '\\\\wsl.localhost\\Ubuntu\\home\\j\\a.png\n\\\\wsl.localhost\\Ubuntu\\home\\j\\b.png',
      })
      expect(() => materializeParams(multi, { files: '/home/j/a.png\n/home/j/gone.png' }, env({ exists: (p) => !p.includes('gone') })))
        .toThrow(/gone\.png/)
    })
    it('已经是 Windows 形状的路径不碰（wslpath -w 会把反斜杠吃掉）', () => {
      const translate = () => { throw new Error('不该被调') }
      expect(materializeParams(schema, { path: 'C:\\Users\\j\\a.txt' }, env({ translateToWindowsPath: translate }))).toEqual({ path: 'C:\\Users\\j\\a.txt', ...A_TXT })
      expect(materializeParams(schema, { path: '\\\\server\\share\\a.txt' }, env({ translateToWindowsPath: translate }))).toEqual({ path: '\\\\server\\share\\a.txt', ...A_TXT })
    })
    /**
     * 派生片段是给**对截断鲁棒的判据**和**按类型分流**用的（活体 2026-09-18：微信把长文件名截成
     * 「中基协登记备...2期.pdf」，全名恒不命中；图片挂进输入框没有文件名）。`_stem6` 正好是截断前保住的那一截。
     */
    it('派生：_stem6 取主干前 6 个字（不足就整个主干）、_ext 小写不带点、图片扩展名 _kind=image', () => {
      const m = (p: string) => materializeParams(schema, { path: p }, env({ wsl: false }))
      expect(m('/x/中基协登记备案文件第2期.pdf')).toMatchObject({ path_stem6: '中基协登记备', path_ext: 'pdf', path_kind: 'file', path_name: '中基协登记备案文件第2期.pdf' })
      expect(m('/x/IMG_20260918.JPG')).toMatchObject({ path_stem6: 'IMG_20', path_ext: 'jpg', path_kind: 'image' })
      for (const ext of ['png', 'jpeg', 'gif', 'webp']) expect(m(`/x/pic.${ext}`)).toMatchObject({ path_kind: 'image', path_ext: ext })
      // 没有扩展名 / 点开头的：ext 空串、kind=file、主干就是整个名字
      expect(m('/x/README')).toMatchObject({ path_stem: 'README', path_stem6: 'README', path_ext: '', path_kind: 'file' })
      expect(m('/x/.bashrc')).toMatchObject({ path_stem: '.bashrc', path_ext: '', path_kind: 'file' })
    })
    it('文件不存在 / 翻译失败 / 相对路径 → 抛，别把注定填不进去的路径交给对话框', () => {
      expect(() => materializeParams(schema, { path: '/home/j/none.txt' }, env({ exists: () => false }))).toThrow(/不存在/)
      expect(() => materializeParams(schema, { path: '/home/j/a.txt' }, env({ translateToWindowsPath: () => undefined }))).toThrow(/wslpath/)
      expect(() => materializeParams(schema, { path: 'a.txt' }, env())).toThrow(/绝对路径/)
    })
  })
})
