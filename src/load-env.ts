import { existsSync } from 'node:fs'

/**
 * Make the gitignored `.env` the backend's secret source too. docker-compose already reads
 * `.env`, but the Node backend (where RSSHub runs in-process) did not — so secrets meant for
 * the backend (e.g. TELEGRAM_SESSION for RSSHub's telegram route) never reached `process.env`.
 *
 * `process.loadEnvFile` fills `process.env` WITHOUT overriding variables the launching shell
 * already set (verified), so anything exported from `~/.bashrc` still wins; `.env` only fills
 * the gaps. Imported first from the backend entries so it runs before any config/env read.
 */
const ENV_FILE = process.env.STREAM_ENV_FILE ?? '.env'
const loadEnvFile = (process as NodeJS.Process & { loadEnvFile?: (path: string) => void }).loadEnvFile
if (loadEnvFile && existsSync(ENV_FILE)) {
  try {
    loadEnvFile.call(process, ENV_FILE)
  } catch {
    /* malformed/locked .env — fall back to the shell environment */
  }
}
