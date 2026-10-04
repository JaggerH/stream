/**
 * 「哪个包是宿主的网盘底座」——全仓只此一处回答。
 *
 * AList / OpenList 是宿主的网盘底座（`docs/PACKAGE.md`「宿主与包的边界」的豁免栏）：后端认识它
 * 属于领域模型。但**前端不许按包 id 分支**——后端在 `/api/packages` 的出线上给这个包标
 * `role: 'netdisk-base'`，前端只看 `role`。要换底座包，改这里一处。
 */
export const NETDISK_BASE_PACKAGE_ID = 'alist'

/** 包在宿主里扮演的角色（出线到前端的那一格）。今天只有网盘底座这一种。 */
export type PackageRole = 'netdisk-base'

/** 一个包 id 的角色；没有特殊角色的包返回 `undefined`（出线上不带这一格）。 */
export function packageRole(id: string): PackageRole | undefined {
  return id === NETDISK_BASE_PACKAGE_ID ? 'netdisk-base' : undefined
}
