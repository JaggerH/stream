import { HelperClient, checkinOutcome } from './client.ts'

/** Each Stream instance owns its Helper connection; the process entry translates env into deployment config. */
export function helperClientFor(url?: string): HelperClient {
  return new HelperClient(url ?? 'http://127.0.0.1:18080')
}

export function makeDailyCheckin(
  helper: Pick<HelperClient, 'disableOwnSchedule' | 'runAll'>,
  now: () => Date = () => new Date(),
) {
  return async () => {
    // Stream owns the schedule. Reassert this before every run in case Helper's UI was changed.
    await helper.disableOwnSchedule()
    const { accounts } = await helper.runAll()
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now())
    return checkinOutcome(accounts, today)
  }
}
