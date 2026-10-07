import type { ActivateFn } from '../../src/packages/activate.ts'
import { AlistAdapter } from './adapter.ts'
import { alistNormalizer } from './normalizer.ts'

/** 这个包贡献的东西：一个 adapter + 一个 normalizer。
 *  容器地址走 `ctx.backendUrl`（不传参 = 本包自己的 backend service），**递 thunk 不递值**：
 *  host 档下 loopback origin 是容器醒着才存在的，构造期快照必得空串。
 *  `config.url` / `config.token` 都由宿主解析好——token 尤其：它来自宿主里那段可能跑
 *  `provisionAlist` 的异步接管流程，所以 `activatePackages` 的调用点必须排在那之后
 *  （`AlistAdapter` 构造时就把 token 收进字段，惰性的只有 client 的构造）。 */
export const activate: ActivateFn = (ctx) => ({
  adapters: {
    alist: new AlistAdapter(
      { backendUrl: () => ctx.backendUrl(), withAwake: ctx.withAwake },
      ctx.config.url as string | undefined,
      ctx.config.token as string | undefined,
      // 托管模式才有。启动时 token 可能还没拿到（容器在睡），这条通道让 adapter 用到时再取。
      ctx.config.refresh as (() => Promise<string>) | undefined,
    ),
  },
  normalizers: { alist: alistNormalizer },
})
