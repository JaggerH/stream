import type { ActivateFn } from '../../src/packages/activate.ts'
import { NeteaseLyricsAdapter } from './lyrics.ts'
import { neteaseNormalizer } from './normalizer.ts'

/** 这个包贡献的东西：一个歌词 adapter + 一个 normalizer。取歌那条 Provider 行是**声明**
 *  （package.json#stream.providers），不经这里——它没有代码，成员是目录里的 download 路由。 */
export const activate: ActivateFn = () => ({
  adapters: { 'netease-lyrics': new NeteaseLyricsAdapter() },
  normalizers: { netease: neteaseNormalizer },
})
