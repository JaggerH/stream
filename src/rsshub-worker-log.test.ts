import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let dir: string
let logFile: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsshub-worker-log-'))
  logFile = path.join(dir, 'rsshub-worker.log')
  process.env.RSSHUB_WORKER_LOG_PATH = logFile
})

afterEach(() => {
  delete process.env.RSSHUB_WORKER_LOG_PATH
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('appendRsshubWorkerLog', () => {
  it('appends lines to the log file', async () => {
    const { appendRsshubWorkerLog } = await import('./rsshub-worker-log')
    appendRsshubWorkerLog('hello')
    appendRsshubWorkerLog('world')
    expect(fs.readFileSync(logFile, 'utf8')).toBe('hello\nworld\n')
  })

  it('rotates to .1 once the file exceeds the 5MB cap, keeping growth bounded', async () => {
    const { appendRsshubWorkerLog } = await import('./rsshub-worker-log')
    fs.writeFileSync(logFile, 'x'.repeat(5 * 1024 * 1024 + 1))
    appendRsshubWorkerLog('over the cap')

    expect(fs.existsSync(`${logFile}.1`)).toBe(true)
    expect(fs.statSync(`${logFile}.1`).size).toBe(5 * 1024 * 1024 + 1)
    expect(fs.readFileSync(logFile, 'utf8')).toBe('over the cap\n')
  })

  it('never throws even if the target directory is missing', async () => {
    const { appendRsshubWorkerLog } = await import('./rsshub-worker-log')
    process.env.RSSHUB_WORKER_LOG_PATH = path.join(dir, 'missing-subdir', 'log.log')
    expect(() => appendRsshubWorkerLog('should not throw')).not.toThrow()
  })
})
