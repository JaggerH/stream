// S1（N3 返工）：空白实例 / 嵌入方不要开箱订阅——`deployment.seed_default_streams=false`
// 时不种影视频道的缺省流；缺省（含 `stream serve` 部署）行为不变，照种。
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStream, type Stream } from './index.ts'
import { readConfig } from '../bootstrap.ts'
import { VIDEO_RANKING_STREAMS } from '../store/types.ts'

const roots: string[] = []
const open: Stream[] = []
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => {})
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function makeConfig(root: string, seedDefaultStreams?: boolean): ReturnType<typeof readConfig> {
  const base = readConfig(join(root, 'config.yaml'), { STREAM_DATA_DIR: root })
  const config = {
    ...base,
    packages_dir: join(root, 'packages'),
    rsshub_catalog: '',
    deployment: { ...base.deployment, scheduler: false, ...(seedDefaultStreams === undefined ? {} : { seed_default_streams: seedDefaultStreams }) },
  }
  return config as ReturnType<typeof readConfig>
}

async function boot(seedDefaultStreams?: boolean): Promise<Stream> {
  const root = mkdtempSync(join(tmpdir(), 'seed-default-streams-'))
  roots.push(root)
  const s = await createStream({ dataDir: root, config: makeConfig(root, seedDefaultStreams), log: () => {} })
  open.push(s)
  return s
}

const listedIds = async (s: Stream): Promise<string[]> => {
  const r = await s.tools.call('stream_list', {})
  if (r.isError) throw new Error(String(JSON.stringify(r.content)))
  return ((r.value as { id: string }[]) ?? []).map((x) => x.id)
}

describe('deployment.seed_default_streams', () => {
  it('缺省（不传）：影视频道种上缺省流，stream_list 看得见', { timeout: 60_000 }, async () => {
    const ids = await listedIds(await boot())
    expect(ids).toEqual(expect.arrayContaining(VIDEO_RANKING_STREAMS.map((s) => s.id)))
  })

  it('false：空白实例一条都不种（嵌入方开箱即空）', { timeout: 60_000 }, async () => {
    const ids = await listedIds(await boot(false))
    expect(ids).toEqual([])
  })

  it('config.yaml 里写 deployment 键同样生效（嵌入方写文件的那条路）', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'seed-default-streams-yaml-'))
    roots.push(root)
    writeFileSync(join(root, 'config.yaml'), ['deployment:', '  seed_default_streams: false', ''].join('\n'))
    const s = await createStream({ dataDir: root, log: () => {} })
    open.push(s)
    expect(await listedIds(s)).toEqual([])
  })
})
