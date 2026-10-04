import type { RecipePackagePreview } from '../../lib/types.ts'

/** 一条具体风险。带着**具体 id**，是为了让二次确认控件的文案能点名
 *  （「用第三方包替换官方的 xhs-home」），而不是笼统的「有风险」。 */
export type RiskReason =
  | { kind: 'code'; entry: string; adapters: string[]; normalizers: string[] }
  | { kind: 'capability'; entry: string; tools: string[] }
  | { kind: 'container'; image: string; credentials: string[] }
  | { kind: 'write'; recipeIds: string[] }
  | { kind: 'shadow-builtin'; sourceIds: string[] }

/** 四档，严格升序：plain < elevated < container < code。
 *  'code' 单独占最高一档而不是并进 elevated，是因为它和另外两条不是同一个量级——elevated 的
 *  两条判据都是「在 recipe 这个受限壳子里多做了一件事」，宿主仍在中间；带代码的包是宿主
 *  自己 import 进来的模块，与 Stream 同权限（全部 cookie / token / 任意出站请求），
 *  recipe 那层约束对它一条都不成立。
 *
 *  'container' 夹在 elevated 与 code 之间，两侧的理由都是**能力面**，不是感觉：
 *   - 比 elevated 重：它在用户机器上长期跑一个**任意镜像**（用户看不见里面是什么），有网，
 *     并且能经凭证代理取它申报过那些域的登录态。elevated 那两条仍在宿主的 recipe 壳子里。
 *   - 比 code 轻：容器是另一个进程、另一个文件系统命名空间。宿主路径 bind 被拒、卷加了包
 *     前缀、内存有上限、GPU 被拒、不额外开宿主端口，而凭证只到**申报过的域**为止；代码格
 *     拿的是宿主进程本身——全部 cookie/token、任意文件、任意出站，一格边界都没有。
 *  所以两者同在时 level 是 'code'（更高的那一档），但**两条理由都要摆出来**：容器那条带着
 *  镜像全名，是用户唯一能核实的具体物。 */
export interface InstallRisk {
  level: 'plain' | 'elevated' | 'container' | 'code'
  reasons: RiskReason[]
}

/** 这一档要不要那道慢速确认门。plain 之外全要——判据集中在这里，免得调用方各写一遍
 *  `level === 'elevated'` 而漏掉后加的档。 */
export const needsSlowConfirm = (risk: InstallRisk): boolean => risk.level !== 'plain'

/** 官方 scope。官方包覆盖内置源是正常升级路径，不该罚站。 */
const OFFICIAL_SCOPE = '@streamapp/'

/**
 * 不变量：**`overrides` 里的每个全名都以这个包自己的名字打头**。
 *
 * sourceId 是 `<npm 包名>/<局部名>`，覆盖的归并键就是全名，所以「覆盖」只在同一个包名的
 * 两层之间发生 —— 也就是说它永远是一次**自我升级**，不可能是李代桃僵（第三方包盖掉官方源）。
 * 上面那条 `shadow-builtin` 判据因此**永不触发**：它不是死代码，它是一条仍然正确的不变量。
 *
 * 写成断言而不是删掉：真触发了，说明「包名唯一 ⇒ 全名唯一」这个前提被破坏了（宿主哪一层
 * 把前缀加错了，或者 preview 报了一份不属于这个包的名单）——那是要大声报的，不是要静默
 * 走进一档更严的确认框就算了的。
 */
function assertOverridesAreSelfUpgrade(overrides: string[], packageName: string): void {
  const foreign = overrides.filter((id) => !id.startsWith(`${packageName}/`))
  if (foreign.length) {
    throw new Error(
      `安装预览自相矛盾：包 ${packageName} 报称会覆盖不属于它的源 ${foreign.join('、')}。` +
      `sourceId 全名以包名打头，所以覆盖只可能发生在同名包的两层之间——出现这种情况说明前缀合成或 preview 出了问题。`,
    )
  }
}

/** 纯函数、无 React、无网络：这道门的判据要能脱离 DOM 单测。
 *  四条判据，从重到轻：
 *   0. `preview.code` **或** `preview.capability` 存在（包带一个预打包的代码入口——两格指的是
 *      同一个文件、同一种权限，只是注册的东西不同）→ 直接是最高档 'code'；
 *      **官方 scope 不豁免这一条**——@streamapp/ 前缀能说明的只有「覆盖内置源是升级而非
 *      李代桃僵」，说明不了这份字节里的代码要干什么。
 *   1. `preview.backend` 存在（包会在这台机器上跑一个容器）→ 至少 'container'；
 *      官方 scope 同样不豁免（前缀说明不了那个镜像里是什么）。
 *   2. 包内任一 recipe 声明 `effects` 含 'write'（会写用户账户：点赞/收藏/转存）；
 *   3. 覆盖内置源（overrides 非空）**且**包名不以 '@streamapp/' 开头。
 *  reasons 按同一顺序排：确认按钮的标签就是这串理由拼出来的，最重的那条要先被读到。 */
export function assessInstallRisk(preview: RecipePackagePreview, packageName: string): InstallRisk {
  const reasons: RiskReason[] = []
  const code = preview.code
  if (code) {
    reasons.push({
      kind: 'code',
      entry: code.entry,
      adapters: [...code.adapters],
      normalizers: [...code.normalizers],
    })
  }
  // 能力槽位和代码槽位是**同一个文件、同一种权限**（后端进程内 import、完整权限、能经
  // `streamBrowserCookies` 取用户浏览器里的登录态）。只认 `code` 的话，一个能力包——它不声明
  // `stream.code`——会被当成纯数据包一路静默装上，这正是这道门最不该漏的那一类。
  const capability = preview.capability
  if (capability) {
    reasons.push({ kind: 'capability', entry: capability.entry, tools: [...(capability.tools ?? [])] })
  }
  const backend = preview.backend
  if (backend) {
    // credentials 是包级申报，容器经凭证代理取的就是这份名单——没申报就是空名单，
    // 而不是"未知"：文案据此换成不提登录态的那一句。
    reasons.push({ kind: 'container', image: backend.image, credentials: [...(preview.credentials ?? [])] })
  }
  const writers = preview.recipes.filter((r) => r.effects.includes('write')).map((r) => r.id)
  if (writers.length > 0) reasons.push({ kind: 'write', recipeIds: writers })
  if (preview.overrides.length > 0 && !packageName.startsWith(OFFICIAL_SCOPE)) {
    reasons.push({ kind: 'shadow-builtin', sourceIds: [...preview.overrides] })
  }
  assertOverridesAreSelfUpgrade(preview.overrides, packageName)
  const level: InstallRisk['level'] = code || capability
    ? 'code'
    : backend
      ? 'container'
      : reasons.length > 0
        ? 'elevated'
        : 'plain'
  return { level, reasons }
}
