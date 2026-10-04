import { pathToFileURL } from 'node:url'
import { runTranslate } from './translate.ts'
import { formatReport, runValidate } from './validate.ts'

/**
 * `record` — the recipe-authoring CLI.
 *
 * It used to have two more commands, both of which existed only because Stream ran its own
 * browser: `login` (sit in front of a CloakBrowser window and log into the profile Stream
 * harvested with) and `explore` (drive a browser-use agent against that window over CDP).
 * Harvesting now rides the user's own Chrome, so logging in is something they do in their
 * browser like on any other site — there is no Stream-owned profile left to seed.
 */
export type ParsedArgs =
  | { command: 'translate'; facility: string; history?: string }
  | { command: 'validate'; sourceId: string }

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...args] = argv
  if (command === 'translate') {
    const [facility, maybeFlag, maybeHistory, extra] = args
    if (!facility || extra) throw new Error('Usage: record translate <facility> [--history <path>]')
    if (maybeFlag == null) return { command, facility }
    if (maybeFlag !== '--history' || !maybeHistory) throw new Error('Usage: record translate <facility> [--history <path>]')
    return { command, facility, history: maybeHistory }
  }
  if (command === 'validate') {
    const [sourceId, extra] = args
    if (!sourceId || extra) throw new Error('Usage: record validate <sourceId>')
    return { command, sourceId }
  }
  throw new Error(`Unknown command: ${command ?? '(missing)'}`)
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed.command === 'translate') {
    const out = await runTranslate(parsed.facility, { historyPath: parsed.history })
    console.error(`[record] recipe draft -> ${out}`)
    return 0
  }

  const report = await runValidate(parsed.sourceId)
  console.error(formatReport(parsed.sourceId, report))
  return report.ok ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exitCode = 1
    },
  )
}
