import { describe, it, expect } from 'vitest'
import type {
  PluginContext as HostPluginContext,
  PackageActivation as HostPackageActivation,
  Enricher as HostEnricher,
  ConnectFn as HostConnectFn,
} from './activate.ts'
import type {
  PluginContext as SdkPluginContext,
  PackageActivation as SdkPackageActivation,
  PackageAction as SdkPackageAction,
  Enricher as SdkEnricher,
  ConnectFn as SdkConnectFn,
} from '../../sdk/plugin-sdk/index.ts'
import type { PackageAction as HostPackageAction } from '../tasks/package-actions.ts'
import {
  ValidationError as SdkValidationError,
  ContentUnavailableError as SdkContentUnavailableError,
} from '../../sdk/plugin-sdk/index.ts'
import { isValidationError as hostIsValidationError } from './activate.ts'
import { isUnavailable as hostIsUnavailable } from '../providers/unavailable.ts'

/**
 * `@streamapp/plugin-sdk`'s `PluginContext` is a hand-maintained copy of the host's real
 * `PluginContext` (`src/packages/activate.ts`) — deliberately NOT a re-export, so the SDK
 * stays a leaf module a third-party package can install without dragging in Stream's
 * internal `.d.ts` graph (see `sdk/plugin-sdk/index.ts`'s header comment).
 *
 * A hand-maintained copy can drift silently: someone adds/renames/retypes a field on one
 * side and forgets the other, and nothing breaks until a package author's build fails on
 * code that matches what the SDK told them was legal. These two functions are the guard —
 * each only compiles if its parameter type is structurally assignable to its return type.
 * Break either direction (add a field to one side only, change a method's signature, drop
 * a field) and `tsc --noEmit` fails right here, not in some third party's build a week later.
 *
 * This file lives under `src/`, not `sdk/plugin-sdk/`, specifically so it falls under
 * the root tsconfig's `include` and is covered by the project-wide `tsc --noEmit` run
 * (`sdk/**` is not in `include`) — pulling in the SDK's `index.ts` via this relative
 * import brings it into the same compilation regardless.
 */
function assertSdkContextIsHostContext(ctx: SdkPluginContext): HostPluginContext {
  return ctx
}

function assertHostContextIsSdkContext(ctx: HostPluginContext): SdkPluginContext {
  return ctx
}

/** 同款守卫，管的是 `activate()` 的**返回值**——尤其是动作槽位。SDK 那份是给包作者看的
 *  唯一说明书；两边漂了，包作者会照着 SDK 写出一个宿主不受理的形状。 */
function assertSdkActionIsHostAction(a: SdkPackageAction): HostPackageAction { return a }
function assertHostActionIsSdkAction(a: HostPackageAction): SdkPackageAction { return a }
/** 只切 `actions` 那一格：`normalizers` 两边**故意**不同型（SDK 那份的出参是 `unknown`，
 *  因为 `Content` 是宿主内部类型），整份 `PackageActivation` 本来就不该互相赋值。 */
function assertSdkActivationActionsIsHost(
  a: Pick<SdkPackageActivation, 'actions'>,
): Pick<HostPackageActivation, 'actions'> { return a }
/** enrichers 两边同型（进出都是 `Record<string,string>` / `unknown`），双向守。 */
function assertSdkEnricherIsHost(e: SdkEnricher): HostEnricher { return e }
function assertHostEnricherIsSdk(e: HostEnricher): SdkEnricher { return e }
function assertSdkActivationEnrichersIsHost(
  a: Pick<SdkPackageActivation, 'enrichers'>,
): Pick<HostPackageActivation, 'enrichers'> { return a }
/** connect 只守宿主 → SDK 这一向：SDK 那份的 `stream` 是 `unknown`（`Stream` 是宿主内部类型），
 *  同 normalizers 的理由。 */
function assertHostConnectIsSdk(c: HostConnectFn): SdkConnectFn { return c }
function assertHostActivationConnectIsSdk(
  a: Pick<HostPackageActivation, 'connect'>,
): Pick<SdkPackageActivation, 'connect'> { return a }

describe('plugin-sdk PluginContext stays structurally compatible with the host', () => {
  it('is a compile-time guard — if this file typechecks, the two definitions still match', () => {
    // The real assertion already happened above at compile time (`tsc --noEmit`). This
    // runtime check just proves the functions are reachable/callable so the guard can't be
    // silently deleted without a test failure too.
    expect(typeof assertSdkContextIsHostContext).toBe('function')
    expect(typeof assertHostContextIsSdkContext).toBe('function')
    expect(typeof assertSdkActionIsHostAction).toBe('function')
    expect(typeof assertHostActionIsSdkAction).toBe('function')
    expect(typeof assertSdkActivationActionsIsHost).toBe('function')
    expect(typeof assertSdkEnricherIsHost).toBe('function')
    expect(typeof assertHostEnricherIsSdk).toBe('function')
    expect(typeof assertSdkActivationEnrichersIsHost).toBe('function')
    expect(typeof assertHostConnectIsSdk).toBe('function')
    expect(typeof assertHostActivationConnectIsSdk).toBe('function')
  })
})

/**
 * 运行时那一半：包 `import { ValidationError } from '@streamapp/plugin-sdk'` 后被 tsdown 打进自己的
 * `dist/index.js`，宿主进程里于是有**第二份**类。宿主判定必须靠鸭子标记（`validation: true` /
 * `unavailable: true`），不靠 `instanceof`——这里用一份"模拟被 bundle 复制"的对象（Object.create 抄
 * 原型链之外的字段）钉住：只有标记、没有原型也要认；反过来一个普通 Error 不能被误认。
 */
describe('plugin-sdk runtime errors are recognised by the host duck checks', () => {
  /** 模拟包 bundle 里那份副本：字段一样、原型链和宿主那份类无关。 */
  const asForeignCopy = (e: Error): unknown =>
    Object.assign(new Error(e.message), Object.fromEntries(Object.entries(e)))

  it("SDK's ValidationError instance passes host isValidationError（本份与跨 bundle 副本都认）", () => {
    const e = new SdkValidationError('bad noteId')
    expect(hostIsValidationError(e)).toBe(true)
    expect(hostIsValidationError(asForeignCopy(e))).toBe(true)
    expect(hostIsValidationError(new Error('bad noteId'))).toBe(false)
  })

  it("SDK's ContentUnavailableError instance passes host isUnavailable（本份与跨 bundle 副本都认）", () => {
    const e = new SdkContentUnavailableError('作品已删除')
    expect(hostIsUnavailable(e)).toBe(true)
    expect(hostIsUnavailable(asForeignCopy(e))).toBe(true)
    expect(hostIsUnavailable(new Error('作品已删除'))).toBe(false)
  })
})
