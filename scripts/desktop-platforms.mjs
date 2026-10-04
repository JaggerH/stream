/**
 * rust target triple ↔ npm 平台包的**唯一**映射。
 *
 * 为什么要一张显式表、不做字符串推断：triple 的命名法不规整（`x86_64` vs npm 的 `x64`、
 * `aarch64` vs `arm64`、windows 还分 msvc/gnu 两种 ABI 却是同一个产物）。推断一旦推错，
 * 二进制会落进一个没人装的包目录，而 **npm 安装照样成功**——插件要到运行时才报「平台包没装」，
 * 真因离现场十万八千里。所以不认识就抛错，不猜。
 *
 * `pkg` 是**目录名，也是去掉 scope 的包名**（完整包名 = `@streamapp/<pkg>`）。
 *
 * **这张表的语义是「哪些平台有 `stream-desktop` 二进制」**，不是「哪些平台桌面控制能用」。
 * 两件事是分开的：agent 的**配对**那一半（native messaging 收发帧 + `--register` 写浏览器根 +
 * 把 relay token 递给 Chrome 扩展）跨平台通用，mac 上实测可用；**桌面控制**那一半
 * （UIA 树 / 坐标输入 / 窗口枚举）只有 Windows 一份实现，判据在
 * `capabilities/desktop/src/host-agent/binary.ts` 的 `DESKTOP_CONTROL_PLATFORMS`。
 * 所以 mac 出货是有意义的：它把扩展从「永远配不上、采集只有游客态」救回来。
 *
 * linux 不在表里：没在真机上验过，也没有需求。要加就照 darwin 那两行的形状加，并先跑一次真机。
 */
export const HOST_AGENT_PLATFORMS = {
  'x86_64-pc-windows-msvc': { pkg: 'desktop-win32-x64', os: 'win32', cpu: 'x64', ext: '.exe' },
  // 本仓库的桌面端就是从 Linux 交叉编译到 windows-gnu 的，这条不是备胎。
  'x86_64-pc-windows-gnu': { pkg: 'desktop-win32-x64', os: 'win32', cpu: 'x64', ext: '.exe' },
  // mac：`cargo build --release` 开箱编过（实测 Intel Mac / macOS 14.6.1，只有死代码 warning），
  // `--register` 的 `Target::MacOs` 分支把 manifest 写进
  // `~/Library/Application Support/{Google/Chrome,Chromium,Microsoft Edge}/NativeMessagingHosts/`，
  // native messaging 的 `ping`/`token` 都通。**桌面控制在这两个平台上不可用**（见上面头注）。
  'x86_64-apple-darwin': { pkg: 'desktop-darwin-x64', os: 'darwin', cpu: 'x64', ext: '' },
  // arm64 只做到「编得过」，**尚未在真机上验过配对**。
  'aarch64-apple-darwin': { pkg: 'desktop-darwin-arm64', os: 'darwin', cpu: 'arm64', ext: '' },
}

/**
 * 查表。
 * @param {string} triple - rustc 的 target triple。
 * @returns {{pkg: string, os: string, cpu: string, ext: string}}
 * @throws 不认识的 triple——见本文件头注，猜比抛更贵。
 */
export function platformForTriple(triple) {
  const p = HOST_AGENT_PLATFORMS[triple]
  if (!p) {
    throw new Error(
      `stream-desktop: target triple「${triple}」没有出货形态（能出的是：${Object.keys(HOST_AGENT_PLATFORMS).join(', ')}）。` +
      '不猜是因为猜错的二进制会落进一个没人装的包目录，而 npm 安装照样成功。要加一个平台：' +
      '先在那台真机上编一次并验一遍配对（`--register` + native messaging 的 ping/token），' +
      '再往 scripts/desktop-platforms.mjs 加一行、建对应平台包目录、并在 ' +
      'capabilities/desktop/src/host-agent/binary.ts 的 HOST_AGENT_PACKAGES 加一行。' +
      '桌面控制是另一件事，归那个文件的 DESKTOP_CONTROL_PLATFORMS 管。',
    )
  }
  return p
}
