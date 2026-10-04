import { describe, expect, it } from 'vitest'
import { isValidPackageName, NPM_NAME_RE } from './package-name.ts'

describe('isValidPackageName', () => {
  it('接受合法的 npm 包名（scoped 与裸名）', () => {
    for (const name of ['@streamapp/xhs', '@streamapp/telegram', 'telegram', 'my-recipe_pack', '@a/b.c~d', 'x0']) {
      expect(isValidPackageName(name), name).toBe(true)
    }
  })

  it('历史包允许大写（npm 只禁止新包用大写，老包如 JSONStream 合法且可安装）', () => {
    for (const name of ['Upper', 'JSONStream', '@Scope/Name', 'MixedCase123']) {
      expect(isValidPackageName(name), name).toBe(true)
    }
  })

  it('拒绝安装门那批恶意名样本（与后端同一批）', () => {
    for (const name of ['../../evil', '..', '@x/y/../../evil', '', '@scope/', 'a b', '.hidden', '@/x', 'a/b']) {
      expect(isValidPackageName(name), name).toBe(false)
    }
  })

  it('导出的正则就是判据本身（前端要拿它做输入识别）', () => {
    expect(NPM_NAME_RE.test('@streamapp/xhs')).toBe(true)
    expect(NPM_NAME_RE.test('../../evil')).toBe(false)
  })
})
