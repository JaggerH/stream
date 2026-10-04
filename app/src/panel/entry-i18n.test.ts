/**
 * 三个面板 bundle 的入口都必须副作用 import 一次 i18n。
 *
 * **为什么只能对源码文本断言**：`vitest.setup.ts` 在**全局**初始化了一次 i18n，于是测试里
 * 无论哪棵树 `t()` 都能解析出真字符串——渲染型单测**永远看不见**这个缺陷。而生产里每份 IIFE
 * bundle 有自己一套模块实例，入口没 import 就没有默认实例，`t('timeline.extract')` 会**原样
 * 画出 key**：按钮上写着 `timeline.extract`，不报错、不崩，只是像没做完。
 *
 * 实测过一次：详情 bundle（`detail-entry.tsx`）漏了这一行，活体上「转成文字」「下载」两个按钮
 * 都写着 key，而全套单测全绿。`movie-entry.tsx` 头注 §1 记的是同一个坑——记了两次还漏，说明
 * 它需要的是一道闸，不是又一段注释。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// 路径从本模块自己的位置推，不信 cwd：多 worktree 并行时 shell 的 cwd 会漂到别人那棵树。
const here = path.dirname(fileURLToPath(import.meta.url))

test.each(['entry.tsx', 'detail-entry.tsx', 'movie-entry.tsx'])(
  '%s 副作用 import 了 i18n（漏了就是按钮上写着 t() 的 key）',
  (entry) => {
    const src = readFileSync(path.join(here, entry), 'utf8')
    expect(src).toContain("import '../i18n/index.ts'")
  },
)
