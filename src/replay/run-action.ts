/**
 * 老门面：动作执行器住在 `shared/browser-relay/run-action.ts`（没有 Stream 后端的宿主也要用
 * 同一份），这里原样转出去，好让后端这侧几处 `./run-action.ts` 的 import 保持不变。
 *
 * 要改「一个动作怎么落到页面上」，改共享库那份——那是唯一一份。
 */
export {
  runAction,
  actWithConfirm,
  EXPECT_DEADLINE_MS,
  type ActStatus,
} from '../../shared/browser-relay/run-action.ts'
