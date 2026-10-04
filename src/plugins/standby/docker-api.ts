/**
 * Docker Engine API 客户端的本体住在 `shared/docker/engine-api.ts`——Stream 的 standby 与 DSH 网盘插件
 * 的 managed 档同吃一份（netdisk spec §7：容器编排核心抽成不依赖 Stream 的共享模块，别两边各写一份
 * 然后慢慢分家）。这里只是 Stream 侧沿用的路径。
 */
export * from '../../../shared/docker/engine-api.ts'
