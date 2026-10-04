import type { ActivateFn } from '../../src/packages/activate.ts'
import { PansouAdapter } from './adapter.ts'
import { pansouNormalizer } from './normalizer.ts'

/** 这个包贡献的东西：一个 adapter + 一个 normalizer。
 *  容器地址走 `ctx.backendUrl`（不传参 = 本包自己的 backend service），**递 thunk 不递值**：
 *  host 档下 loopback origin 是容器醒着才存在的，构造期快照必得空串。
 *  宿主不替本包读任何专用配置项；要指向一台外部 PanSou，设 `PANSOU_URL` 环境变量
 *  （adapter 自己读，排在 `ctx.backendUrl()` 之前）。 */
export const activate: ActivateFn = (ctx) => ({
  adapters: {
    pansou: new PansouAdapter({ backendUrl: () => ctx.backendUrl(), withAwake: ctx.withAwake }),
  },
  normalizers: { pansou: pansouNormalizer },
})
