/**
 * 挂载网盘 preset 表（v1 只列 cookie 登录型驱动）。
 *
 * 每个条目对应「挂载网盘」列表里的一个网盘：driver 对应 AList 驱动名，
 * cookieDomain 是登录态快照里的 cookie 域（用户在浏览器登录过即有），
 * mountPath 是默认挂载点。addition 的字段 schema 不硬编码——UI 运行时从
 * `GET /api/admin/driver/info?driver=xx` 拉取，这里只放 cookie 之外的必填默认值。
 */
export interface MountPreset {
  /** preset 稳定 id（持久化到 mounts 配置里，不随 label 变）。 */
  id: string
  /** UI 展示名。 */
  label: string
  /** AList 驱动名（storage/create 的 driver 字段，原样传）。 */
  driver: string
  /** 登录态快照里的键（域名，无协议前缀）。 */
  cookieDomain: string
  /** 默认挂载点。 */
  mountPath: string
  /** cookie 之外的 addition 默认值（JSON 序列化前的对象形态）。 */
  additionDefaults: Record<string, unknown>
}

export const MOUNT_PRESETS: readonly MountPreset[] = [
  {
    id: '115',
    label: '115 网盘',
    driver: '115 Cloud',
    cookieDomain: '115.com',
    mountPath: '/115',
    additionDefaults: { root_folder_id: '0' },
  },
  {
    id: 'quark',
    label: '夸克网盘',
    driver: 'Quark',
    cookieDomain: 'pan.quark.cn',
    mountPath: '/quark',
    additionDefaults: { root_folder_id: '0' },
  },
  {
    id: 'uc',
    label: 'UC 网盘',
    driver: 'UC',
    cookieDomain: 'drive.uc.cn',
    mountPath: '/uc',
    additionDefaults: { root_folder_id: '0' },
  },
] as const

export function findPreset(id: string): MountPreset | undefined {
  return MOUNT_PRESETS.find((p) => p.id === id)
}
