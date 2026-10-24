import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 库入口的导出清单钉成快照（design D7）：`src/engine/index.ts` 就是 `@streamapp/engine` 的全部公开面，
 * 多导出一个名字 = 多一个外部调用方会依赖、以后改不动的东西。改这张表要显式改这里。
 *
 * 按源码文本数，不按运行期 `Object.keys(import(...))`：类型导出在运行期不存在，而它们恰恰是公开面的大头。
 */
function exportedNames(src: string): string[] {
  const names = new Set<string>()
  for (const m of src.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1])
  }
  for (const m of src.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  if (/^export\s+\*/m.test(src)) names.add('*')
  return [...names].sort()
}

describe('@streamapp/engine 公开面', () => {
  it('导出清单与快照一致（不许 `export *`）', () => {
    const src = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8')
    expect(exportedNames(src)).toEqual(
      [
        'CreateStreamOptions',
        'Stream',
        'StreamCapabilities',
        'StreamDevices',
        'StreamHostHooks',
        'StreamRuntime',
        'StreamSecrets',
        'StreamTools',
        'ToolAnnotations',
        'ToolCallContext',
        'ToolDescriptor',
        'ToolProgress',
        'ToolResult',
        'createRuntime',
        'createStream',
      ].sort(),
    )
  })
})
