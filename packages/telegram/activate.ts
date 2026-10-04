import type { ActivateFn } from '../../src/packages/activate.ts'
import { telegramNormalizer } from './normalizer.ts'

/** 这个包贡献的代码只有一个 normalizer（资源频道消息 → 链接卡，`telegram`）；它是纯函数，不用任何宿主能力。 */
export const activate: ActivateFn = () => ({
  normalizers: { telegram: telegramNormalizer },
})
