// capabilities/desktop/src/host-agent/versions.test.ts
//
// 平台清单本身是一份要维护的真相，且这已经是第四份（另三份：`binary.ts` 的
// `HOST_AGENT_PACKAGES`、`scripts/desktop-platforms.mjs`、`platforms/` 目录本身）。这份
// 清单从 `HOST_AGENT_PACKAGES`（唯一真相源）派生，并和 `platforms/` 目录实际内容做双向比对：
// 表里有目录没有 → 红；目录有表里没有 → 红。
//
// `optionalDependencies` 里每个平台包版本 == 平台包自己声明的 version 这条断言，已由
// `scripts/desktop-platforms.test.ts` 的「插件包 pin 的版本 = 各平台包自己的 version」钉着，
// 不在这里重复。
import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { HOST_AGENT_PACKAGES } from './binary.ts'

// src/host-agent/ → src/ → 包根。
const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

const PLATFORM_DIRS = Object.values(HOST_AGENT_PACKAGES).map((pkg) => pkg.replace('@streamapp/', ''))

describe('平台包版本不许和 optionalDependencies 分家', () => {
  it('HOST_AGENT_PACKAGES 派生的平台目录 与 platforms/ 目录实际内容一一对应', () => {
    const actualDirs = readdirSync(join(packageRoot, 'platforms'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    expect(PLATFORM_DIRS.slice().sort(), 'HOST_AGENT_PACKAGES 与 platforms/ 目录对不上').toEqual(actualDirs)
  })
})
