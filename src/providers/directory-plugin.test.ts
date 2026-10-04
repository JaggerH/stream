import { describe, it, expect } from 'vitest'
import { createKernel, quiesceKernel } from '../kernel/context.ts'
import { ProviderDirectory } from './directory.ts'
import { providerDirectoryPlugin } from './directory-plugin.ts'
import { SYSTEM_IDENTITIES } from './system/index.ts'

const emptyStore = { listProviders: () => [], getProvider: () => null }

describe('providerDirectoryPlugin', () => {
  it('mounts as ctx.providerDirectory and disappears when the tree is disposed', async () => {
    const kernel = createKernel()
    expect(kernel.get('providerDirectory')).toBeUndefined()
    await kernel.plugin(providerDirectoryPlugin, { store: emptyStore, systemIdentities: SYSTEM_IDENTITIES })
    expect(kernel.providerDirectory).toBeInstanceOf(ProviderDirectory)
    expect(kernel.providerDirectory.isSystem('transcribe')).toBe(true)
    await quiesceKernel(kernel)
    expect(kernel.get('providerDirectory')).toBeUndefined()
  })
})
