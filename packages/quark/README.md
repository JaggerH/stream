# 夸克（`@streamapp/quark`）

## 这个包出什么

- **recipe** `quark-share`：一条夸克分享 → 判决对象 `{validity, files, reason}`。看文件本身是公开的，登录态只在需登录的分享才用上。
- **四条 Provider 行**（`package.json#stream.providers`），各自是一个网盘调用点的默认行：

| 行 id | serveKey | 调用点 | 成员 |
|---|---|---|---|
| `netdisk-verify-quark` | `quark-verify` | `netdisk.share.verify` | 本包 `quark-share` |
| `netdisk-save-quark` | `quark-save` | `netdisk.share.save` | `@streamapp/builtin/quark-save`（`dest` 默认 `From Stream`） |
| `netdisk-play-quark` | `quark-play` | `netdisk.play` | `@streamapp/builtin/quark-play` |
| `netdisk-folder-quark` | `quark-folder` | `netdisk.folder` | `@streamapp/builtin/quark-folder` |

## 为什么三条行的成员指着 builtin

转存、转码播放、文件夹跳转要**写**用户网盘或走夸克的私有接口，逻辑本体住 `shared/netdisk/quark/`。
那份代码同时被能力包 `capabilities/netdisk` 吃，而包不能 import `shared/netdisk/`（守卫
`src/packages/self-contained.guard.test.ts`）。所以这三个动作由宿主注册成 builtin mode，本包只声明
"哪条行、服务哪个键、默认用哪个成员"。

## 改这里要注意

- **行 id 不能改。** 用户库里存着这几条行和它们的编排（成员、参数、频道槽位引用），启动时按 id 认成同一条系统行。改了 id，旧行会被当成"代码删了"清掉。
- **`dest` 的默认值 `From Stream`** 还写在 `shared/netdisk/save-dest.ts`（宿主兜底与追更用它）。两份由 `src/packages/netdisk-providers.real.test.ts` 钉成相等。
- 加一家网盘不用动这里，也不用动宿主：在那家网盘自己的包里声明 `<网盘>-verify` 这类行，并写上 `callsites`。
