/**
 * Bounded log sink for the RSSHub worker's stdout/stderr.
 *
 * RSSHub's own winston File transports have no maxsize/maxFiles — left alone they grew
 * logs/error.log + logs/combined.log to 40GB (see incident 2026-07-23: a runaway
 * "uncaughtException: Error: write EPIPE" loop, triggered when the worker's console output
 * shared the container's real stdout/stderr fd and that pipe broke). RsshubClient now spawns
 * the worker with piped stdout/stderr (never touching the shared fd) and NO_LOGFILES=true
 * (RSSHub's documented off-switch for its own file transports), and drains both streams here
 * instead — capped at 5MB with a single rotated backup, so a runaway loop can burn at most
 * ~10MB instead of unbounded disk.
 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024

// Resolved per call (not at module load) so tests can point it at a scratch dir via env.
function logPath(): string {
  return process.env.RSSHUB_WORKER_LOG_PATH ?? path.resolve('logs/rsshub-worker.log')
}

export function appendRsshubWorkerLog(line: string): void {
  const target = logPath()
  try {
    const stat = fs.statSync(target, { throwIfNoEntry: false })
    if (stat && stat.size > MAX_BYTES) {
      fs.renameSync(target, `${target}.1`)
    }
    fs.appendFileSync(target, line.endsWith('\n') ? line : `${line}\n`)
  } catch {
    // Logging must never crash the process it's observing.
  }
}
