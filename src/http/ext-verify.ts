// 薄壳：本模块已搬进 shared/browser-relay/verify.ts（好让插件也能 import 同一份）。
// 保留此路径的 re-export，现有消费者（src/http/app.ts）import 不用改。
export { extVerifyProof, VERIFY_PREFIX as EXT_VERIFY_PREFIX } from '../../shared/browser-relay/verify.ts'
