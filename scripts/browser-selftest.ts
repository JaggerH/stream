import { makeLauncher } from '../src/replay/browser.ts'

/** Stage 0: prove the browser presents no obvious automation signals. No cookies. */
async function main() {
  const launcher = makeLauncher({ userDataDir: '' })
  const { page, close } = await launcher.launch('https://bot.sannysoft.com/')
  try {
    const signals = await (page as unknown as {
      evaluate: (fn: () => unknown) => Promise<unknown>
    }).evaluate(() => ({
      webdriver: (navigator as { webdriver?: unknown }).webdriver,
      hasChrome: 'chrome' in window,
      languages: navigator.languages,
      plugins: navigator.plugins.length,
    }))
    console.log('Stage 0 automation signals:', JSON.stringify(signals, null, 2))
  } finally {
    await close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
