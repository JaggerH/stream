/**
 * Day 1 spike: validate RSSHub lib import + fetch a no-cookie route.
 *
 * Run:
 *   cd ../RSSHub && pnpm install   # one-time
 *   cd ../stream
 *   pnpm spike:rsshub
 *
 * Verifies:
 *   1. ../../RSSHub/lib/pkg.ts is importable via tsx
 *   2. pkg.init() / pkg.request() actual API surface
 *   3. data shape returned (whether normalized JSON or RSS XML string)
 *   4. for a no-cookie route, full end-to-end works
 */

async function main() {
  const pkgPath = process.env.RSSHUB_PKG
  if (!pkgPath) throw new Error('set RSSHUB_PKG to the RSSHub lib/pkg.ts path before running this spike')
  console.log(`[spike-rsshub] step 1: importing ${pkgPath}`)

  const pkg = await import(pkgPath)

  console.log('[spike-rsshub] pkg exports:', Object.keys(pkg).sort())
  console.log('[spike-rsshub] has init:', typeof pkg.init)
  console.log('[spike-rsshub] has request:', typeof pkg.request)
  console.log('[spike-rsshub] has registerRoute:', typeof pkg.registerRoute)

  if (typeof pkg.init === 'function') {
    console.log('\n[spike-rsshub] step 2: calling init()')
    await pkg.init()
  }

  const testRoute = process.argv[2] ?? '/zhihu/hot'
  console.log(`\n[spike-rsshub] step 3: fetching ${testRoute}`)

  const data = await pkg.request(testRoute)

  console.log('[spike-rsshub] data type:', typeof data)
  if (typeof data === 'string') {
    console.log('[spike-rsshub] string length:', data.length)
    console.log('[spike-rsshub] first 500 chars:', data.slice(0, 500))
    console.log(
      '\n[spike-rsshub] ⚠️  request() returned a STRING (likely RSS XML).',
      'Need to find lower-level API to get normalized Data object.'
    )
  } else if (data && typeof data === 'object') {
    console.log('[spike-rsshub] keys:', Object.keys(data))
    if (Array.isArray(data.item)) {
      console.log(`[spike-rsshub] ✓ data.item is an array of ${data.item.length} items`)
      console.log('[spike-rsshub] first item:')
      console.log(JSON.stringify(data.item[0], null, 2).slice(0, 1000))
    } else {
      console.log('[spike-rsshub] data sample:', JSON.stringify(data).slice(0, 500))
    }
  }

  console.log('\n[spike-rsshub] ✓ spike completed')
}

main().catch((e) => {
  console.error('[spike-rsshub] failed:', e)
  process.exit(1)
})
