import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { HELP } from './cli.ts'

/**
 * **外人能看到的 Stream 只有两处**：npm 页面（渲染的是 `cli/README.md`）和 `stream --help`。
 * 仓库是公开文档的入口，npm 页面与命令行帮助都必须能带读者回到它。
 *
 * 所以这两处必须**自包含**——不能指望读者去别处补齐，因为没有别处。这道闸钉两件事：
 *
 *  1. 那条从零到能用的路必须还在（四步各自的判据命令）。**判据命令比散文更值得钉**：
 *     散文烂了只是难读，判据没了读者就只能靠"看起来好了"来判断，而这条链路上每一种坏法
 *     都是安静的（采到游客态数据、流不排班、能力显示可用但一跑就失败）。
 *  2. npm 元数据必须声明仓库入口；否则读者只能看到孤立的安装说明，无法继续查文档或贡献。
 */
const root = resolve(import.meta.dirname, '../..')
const readme = readFileSync(join(root, 'cli/README.md'), 'utf8')

describe('对外那两张脸（npm README / --help）', () => {
  // 四步各自的判据。这些字符串就是读者遇到麻烦时唯一能敲的东西。
  const JUDGEMENTS: Array<[string, string]> = [
    ['扩展装没装上', '/api/browser-capability'],
    ['流采没采到东西', '/refresh'],
    ['能力现在能不能用', '/api/conversion-kinds'],
    ['对话宿主怎么接', '/api/mcp'],
    // 装了 Stream 的人如果用自己的 Claude Code / Codex，这一步是他拿到"手艺"的唯一入口
    // （MCP 只给工具）。README 少了它，那批 skill 就只在我们仓库里活着。
    ['skill 怎么装进自己的 agent', '/api/skills'],
  ]

  it.each(JUDGEMENTS)('README 里还留着「%s」的判据（%s）', (_why, needle) => {
    expect(readme).toContain(needle)
  })

  // 这一条是被真实事故换来的：不给频道归属的流，本次会话在调度里、重启后就没了，
  // 而**没有任何一处会喊**。README 少了这句，用户只会看到"我订的流不见了"。
  it('README 说清了建流要带 channel_id', () => {
    expect(readme).toContain('channel_id')
  })

  it('--help 也是自包含的：四步都在，且指得出完整指南在哪', () => {
    for (const [, needle] of JUDGEMENTS) expect(HELP).toContain(needle.replace('/refresh', 'refresh'))
    expect(HELP).toMatch(/npmjs\.com\/package\/@streamapp\/stream|npm docs/)
  })

  it('cli/package.json 声明公开 repository / homepage，npm 页面能带读者回到文档入口', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'cli/package.json'), 'utf8'))
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/JaggerH/stream.git' })
    expect(pkg.homepage).toBe('https://github.com/JaggerH/stream#readme')
    // README 必须在出货清单里——它是外人唯一看得到的那份文档。
    expect(pkg.files).toContain('README.md')
  })
})
