import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseStreamDescriptor } from '../packages/descriptor.ts'
import { validateRecipe } from '../replay/recipe-store.ts'
import { whoamiLoginProblem } from './whoami.ts'

const PACKAGES = join(import.meta.dirname, '../../packages')
const descriptor = (name: string) =>
  parseStreamDescriptor(JSON.parse(readFileSync(join(PACKAGES, name, 'package.json'), 'utf-8')), name)

/** spike S3 的结论落进三个内置包（design.md「Spike 结果」S3）。 */
describe('内置包的 whoami', () => {
  it('bilibili：http，nav 接口的 data.mid / data.uname / data.isLogin', () => {
    expect(descriptor('bilibili').whoami).toEqual({
      kind: 'http', url: 'https://api.bilibili.com/x/web-interface/nav', id: 'data.mid', name: 'data.uname', signedIn: 'data.isLogin',
    })
  })

  it('xhs：page，explore 页的 __INITIAL_STATE__（游客也有 userInfo，所以带 loggedIn）', () => {
    const d = descriptor('xhs')
    expect(d.whoami).toEqual({
      kind: 'page',
      url: 'https://www.xiaohongshu.com/explore',
      id: '__INITIAL_STATE__.user.userInfo.userId',
      name: '__INITIAL_STATE__.user.userInfo.nickname',
      signedIn: '__INITIAL_STATE__.user.loggedIn',
    })
    expect(d.network?.hosts).toContain('xiaohongshu.com')
  })

  it('eastmoney：login，zjzh 是登录 recipe 的 secret 参数', () => {
    const d = descriptor('eastmoney')
    expect(d.whoami).toEqual({ kind: 'login', param: 'zjzh' })
    const login = validateRecipe('eastmoney-login.recipe.json',
      JSON.parse(readFileSync(join(PACKAGES, 'eastmoney', 'eastmoney-login.recipe.json'), 'utf-8')))
    expect(whoamiLoginProblem(d.whoami!, [login], d.facility ?? d.id)).toBeNull()
  })
})
