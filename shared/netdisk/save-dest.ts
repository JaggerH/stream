/** 默认落点：Stream 转存进用户网盘时的目标目录。目录不需要预先存在——转存实现用网盘自己的
 *  API 查不到就建。用户在 Provider 页面改转存行的成员参数 `dest` 即可换落点。
 *
 *  消费方：转存 builtin 通道（调用点没传 dest 时的兜底）、追更的转存客户端、网盘路由拼落点路径。
 *  **同一个字面量还写在 `packages/quark/package.json` 转存行的成员参数里**（JSON 引不到常量），
 *  两份由 `src/packages/netdisk-providers.real.test.ts` 钉成相等。 */
export const NETDISK_SAVE_DEST = 'From Stream'
