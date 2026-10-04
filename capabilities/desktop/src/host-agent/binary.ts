/**
 * 「本机该用哪个 `stream-desktop` 二进制、它在哪」——**包里唯一那份解析**。
 *
 * 可执行文件 `stream-desktop`、npm 平台包 `@streamapp/desktop-<平台>`、native messaging host id
 * `com.stream.desktop`：这三个是**线上常量**（写进用户浏览器的 native messaging 清单、注册表，
 * 以及 npm registry）。要改就得让每一台配对过的机器重新 `--register` 一次——不重配的表现是
 * 静默失联，一个字都不报。
 *
 * 浏览器那一半
 * （`../index.ts` 的 `defaultDeps.resolveBinary`，要 spawn 它去问归属、去 `--register`）和
 * 桌面那一半（`./index.ts` 的 `mountHostAgent`，要把它当长驻进程养着）问的是同一个 exe，
 * 所以两边都从这里问。
 *
 * 二进制不随本包发，而是**平台子包**各带一份，主包用 `optionalDependencies` 引它们——
 * npm 按 `os`/`cpu` 只装匹配的那一个，装不上的静默跳过（这正是要的行为：一个可选能力不该
 * 因为跨平台而让整个安装失败）。
 *
 * 这里全是纯函数 + 一个注入点（`resolvePath`），所以 Windows 的解析路径能在 Linux 上被测到。
 */

/**
 * `${process.platform}-${process.arch}` → 完整包名。**这张表的语义是「哪些平台有 Stream Desktop
 * 的二进制」**，不是「哪些平台桌面控制能用」——后者是另一个事实，见下面的
 * {@link DESKTOP_CONTROL_PLATFORMS}。
 *
 * 两个事实必须分开，因为这只手是**两半**、可以只有一半：
 * - **配对**（native messaging 收发帧 + `--register` 把 manifest 写进浏览器根 + 把 relay token
 *   递给 Chrome 扩展）跨平台通用，mac 上实测可用。没有它，扩展永远 `never-seen`，要登录态的
 *   源全是游客态——不报错，只是采得少采得浅。
 * - **桌面控制**（a11y 树 / 坐标输入 / 窗口枚举）今天有两份实现：Windows 走 UIA
 *   （`app/host-agent/src/windows.rs`），macOS 走 AX（`app/host-agent/src/macos.rs`）。
 *   其余平台仍是 `main.rs` 里那个每个动词都 `Err(unsupported())` 的占位后端。
 *
 * 合成一张表的代价是有二进制的平台白白丢掉配对那一半（2026-09-07 干净装机实测撞到过：
 * 那时 mac 还没有桌面控制后端，合表会让它连 `--register` 都不跑）。**两半仍然要分开看**：
 * 下一个出货的平台多半又是"先有二进制、后有后端"那一档。
 *
 * 加平台的顺序：**先在那台真机上编一次、验一遍配对**，再加一行 + 建 `platforms/<pkg>/` +
 * `scripts/desktop-platforms.mjs` 里加对应 triple + 主包 `optionalDependencies` 加一条。
 * 四处对不上会被 `versions.test.ts` / `scripts/desktop-platforms.test.ts` 当场钉红。
 */
export const HOST_AGENT_PACKAGES: Record<string, string> = {
  'win32-x64': '@streamapp/desktop-win32-x64',
  'darwin-x64': '@streamapp/desktop-darwin-x64',
  // arm64 只做到「编得过」，尚未在真机上验过配对（x64 已在 Intel Mac 上实测通过）。
  'darwin-arm64': '@streamapp/desktop-darwin-arm64',
}

/**
 * 「桌面控制（a11y 树 / 坐标输入 / 窗口枚举）在哪些平台真的能用」——和
 * {@link HOST_AGENT_PACKAGES} **是两个独立的事实**，不许合并。
 *
 * 今天有两份后端：Windows 走 UIA（`app/host-agent/src/windows.rs`），macOS 走 AX
 * （`app/host-agent/src/macos.rs`，2026-09-07 在 Intel Mac 上把「代装扩展」整条跑通，
 * 记录见 `docs/superpowers/reports/2026-09-07-mac-desktop-install-verify.md`）。其余平台
 * 仍是 `main.rs` 里那个每个动词都 `Err(unsupported())` 的占位后端。
 *
 * **mac 这一格是「够用」不是「齐全」**：`macos.rs` 只实现了代装扩展用到的那几个动词
 * （windows / focusWindow / scopeWindow / find / invoke / setValue / type / press / click），
 * `readSubtree` / `screenshot` / `readScreen` / `findImage` / `url` 仍如实报 unsupported。
 * 名单只回答"这个平台起不起常驻 agent"，回答不了"每个动词都有没有"——后者由每个动词
 * 自己如实报，别指望这份名单替它们答。
 *
 * 这份名单的消费者是 `index.ts` 的 `mountHostAgent`：不在名单里的平台**跑 `--register` 但不起
 * 常驻 agent**。理由：常驻 agent 连上 `/api/host` 之后每个 op 都 `unsupported`，正是本仓库
 * 反复警告的「装得上、一动就报错」形状，还白占一个进程；而配对靠的是 Chrome 自己按 manifest
 * 拉起 agent，和常驻那条命无关。
 */
export const DESKTOP_CONTROL_PLATFORMS: readonly string[] = ['win32', 'darwin']

/**
 * 这个平台的桌面控制能不能用。
 * @param platform - `process.platform`（WSL 下要传 `'win32'`——那边控制的是 Windows 桌面）。
 */
export function desktopControlSupported(platform: string): boolean {
  return DESKTOP_CONTROL_PLATFORMS.includes(platform)
}

export interface BinaryLookup {
  /** `process.platform`。 */
  platform: string
  /** `process.arch`。 */
  arch: string
  /**
   * 引擎跑在 WSL 里、要控制的桌面在 Windows 一侧时置真。
   *
   * 为真时**无视 `platform`/`arch`**，直接按 `win32-x64` 解析、挑 `.exe` 版本。原因：
   * WSL 下 `process.platform` 报的是 `'linux'`，照它挑会当场判成「本平台不支持桌面控制」并
   * 整个跳过——而 WSL 下真正能看见、能控制的桌面在 Windows 一侧，只有 Windows 版 agent 能
   * 做到。所以专门给一个显式判据，不靠调用方拿 `platform` 去猜。
   * 默认 `false`（非 WSL 场景可以整体省略这个字段，行为与加这个能力之前逐字相同）。
   */
  wsl?: boolean
  /** 注入点：给 `<包名>/bin/<文件名>`，返回绝对路径；找不到就抛（`require.resolve` 的语义）。 */
  resolvePath: (specifier: string) => string
  /**
   * 本地构建产物兜底：给包根同级的 `platforms/<平台包目录名>/bin/<文件名>` 相对路径，
   * 命中就返回绝对路径，没有就返回 `undefined`。**只在 `resolvePath` 抛出之后才会被调用**——
   * 已发布安装是更强的证据，优先信它。
   *
   * 存在的理由：本地档（`file:` 软链进 monorepo）里 `require.resolve` 会 realpath 回仓库，
   * 那里的 node_modules 没有 npm 平台包（optionalDependencies 只能从 registry 装）——于是
   * `scripts/build-server.mjs` 刚编出来的二进制今天没有任何消费者，唯一还欠的真机验证只能
   * 排在平台包发布 registry 之后。缺省 = 不试，行为与加这个能力之前逐字相同。
   */
  resolveLocalBuild?: (relPath: string) => string | undefined
}

export type BinaryResult =
  | {
      ok: true
      path: string
      source: 'installed' | 'local-build'
      usesWindowsAgent: boolean
      /**
       * 这只手在本机上桌面控制能不能用（配对无论如何都能用——不然二进制就不会出货）。
       * 由 {@link desktopControlSupported} 按**解析时用的那个平台**判（WSL 下是 win32，
       * 不是 `look.platform` 报的 linux）。调用方直接读它，别自己再推一遍——推两遍就是
       * 两份实现，分歧时 mac 上会白起一个每个 op 都报 unsupported 的常驻进程。
       */
      desktopControl: boolean
    }
  | { ok: false; reason: string }

/**
 * 解出本机那个 `stream-desktop` 可执行文件（Stream Desktop 的本机进程）的绝对路径。
 *
 * **三种「没有」分开报**：没出过这个平台的包 / 出了但没装上且本地也没有构建产物——前者要
 * 换机器，后者要装包或先跑一次本地构建，合成一句「找不到」等于让用户猜。用了哪一档
 * （已装 vs 本地构建产物）也分开报，调用方（`index.ts` 的 `apply()`）拿 `source` 去说清楚。
 * @param look - 平台标识 + 解析注入点。
 * @returns 成功给绝对路径 + 用的是哪一档；失败给一句可以直接打进日志的人话。
 */
export function resolveAgentBinary(look: BinaryLookup): BinaryResult {
  // WSL 下强制走 win32-x64——见 BinaryLookup.wsl 头注为什么不能用 look.platform/arch。
  const usesWindowsAgent = Boolean(look.wsl)
  const platform = usesWindowsAgent ? 'win32' : look.platform
  const arch = usesWindowsAgent ? 'x64' : look.arch
  const key = `${platform}-${arch}`
  const pkg = HOST_AGENT_PACKAGES[key]
  if (!pkg) {
    return {
      ok: false,
      // 话术要说清是「这个平台没出过二进制」而不是「包没装」：后者会让人去查安装、去 registry
      // 上找一个根本不存在的包。同一个二进制也是 Chrome 扩展配对拿 relay token 的唯一
      // 来源，所以这里没有它不止桌面控制不可用，扩展也配不上。
      reason:
        `本机 ${key} 没有出过 Stream Desktop 二进制（出货平台：${Object.keys(HOST_AGENT_PACKAGES).join(' / ')}），` +
        `Chrome 扩展配不上（拿不到 relay token），桌面控制也不可用。这不是没装包——这个平台还没出货。`,
    }
  }
  // 文件名按平台分叉：Windows 带 .exe，其余（mac）没有扩展名。这不是一条走不到的分支——
  // mac 出货之后它是常态；写死 .exe 的表现是 require.resolve 找一个不存在的文件，
  // 报出来的却是「平台包没装」，真因离现场很远。
  const file = platform === 'win32' ? 'stream-desktop.exe' : 'stream-desktop'
  const desktopControl = desktopControlSupported(platform)
  try {
    // `<包名>/bin/<文件名>` 这种子路径解析能成立，前提是平台包（`platforms/*/package.json`）
    // **故意不声明 `exports`**——声明了之后 Node 只认里面列出的入口，`bin/` 这条没被列进去的
    // 子路径当场解析失败（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。这个隐含前提没有测试钉住它，
    // 以后有人给平台包加 `exports` 会当场断链且不报错，留这句注释在这就是唯一的提醒。
    return { ok: true, path: look.resolvePath(`${pkg}/bin/${file}`), source: 'installed', usesWindowsAgent, desktopControl }
  } catch (err) {
    // platforms/ 下平台包目录名去掉 scope 前缀，与 scripts/build-server.mjs 落盘时用的
    // `join(root, 'capabilities/desktop/platforms', pkg, 'bin', ...)` 里的 `pkg` 是同一个词。
    const platformDir = pkg.replace('@streamapp/', '')
    const local = look.resolveLocalBuild?.(`${platformDir}/bin/${file}`)
    if (local) {
      return { ok: true, path: local, source: 'local-build', usesWindowsAgent, desktopControl }
    }
    return {
      ok: false,
      // 原始错误一起带上：加了本地构建这一档回落之后，「没有」变成三档，require.resolve
      // 抛出的原因（哪条候选路径、Node 的具体报错）比过去更值钱，不该被 catch {} 吞掉。
      reason:
        `平台包 ${pkg} 没装上（optionalDependencies 在本平台被 npm 跳过，或 npm install 没跑过），` +
        `本地构建产物也没有（platforms/${platformDir}/bin/${file}），Chrome 扩展配不上` +
        `（拿不到 relay token）${desktopControl ? '，桌面控制也不可用' : ''}。` +
        `原始错误：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
