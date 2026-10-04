/**
 * 「内容本身没有」的错误类与鸭子判定。本体住 `shared/package-sdk/errors.ts`（宿主与包同吃一份，
 * 为什么是鸭子判见那边头注）；这里 re-export 给宿主既有 import 点（`member-pipeline.ts`、
 * `/api/media/play|dash` 的 404 分档）。
 */
export { ContentUnavailableError, isUnavailable } from '../../shared/package-sdk/errors.ts'
