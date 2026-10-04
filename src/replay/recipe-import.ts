import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { Recipe } from './recipe.ts'
import { isCanonicalBrowserRecipe } from './recipe.ts'
import { validateRecipe } from './recipe-store.ts'
import { parseStreamDescriptor } from '../packages/descriptor.ts'
import { assertInstallable, isAllowedPackageFile, readHostVersion, PACKAGE_CODE_ENTRY } from './recipe-install.ts'
import type { OccupiedNames } from '../packages/activate.ts'
import { summarizeBackend, type BackendSummary } from '../packages/container-policy.ts'
import { TRUST_SIDECAR, type PackageTrust } from './recipe-package.ts'

/** Per-file size ceiling. Recipes/manifests are hand-sized text; anything bigger
 *  is either a mistake or a payload we don't want to unpack blindly. */
const MAX_ENTRY_BYTES = 1024 * 1024

/** What the user sees BEFORE anything touches disk: who wrote it, which domains
 *  the recipes may talk to, and what kinds of actions they perform. */
export interface PackageInfo {
  facility: string
  author?: string
  cookieDomain?: string
  /** every hostname the package's recipes can reach (entryUrl + goto + cookieDomain) */
  domains: string[]
  /** union of action kinds across all recipes (goto/scroll/openItems/type/submit) */
  actionKinds: string[]
  /** sourceIds provided by the package */
  sources: string[]
  /** 这个包带代码时才有——与 tarball 那条路的 preview 同一形状。带代码是这份确认里最重的
   *  一格：确认页看不见它，用户就是在不知情下批准了执行第三方代码。 */
  code?: { entry: string; adapters: string[]; normalizers: string[] }
  /** 这个包带容器时才有——与 tarball 那条路的 preview 同一形状、同一把尺（`summarizeBackend`）。
   *  给的是**钳制后**的值：落盘的就是它。 */
  backend?: BackendSummary
}

export interface ImportResult {
  /** absolute path of the installed package folder */
  installed: string
}

// ── minimal zip reader (stored + deflate) ─────────────────────────────────────

interface ZipEntry { name: string; data: Buffer }

function readZip(buf: Buffer): ZipEntry[] {
  // EOCD: scan backwards (comment can pad the tail, max 64 KiB)
  let eocd = -1
  const floor = Math.max(0, buf.length - 22 - 65536)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip: bad central-directory record')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8')
    p += 46 + nameLen + extraLen + commentLen

    assertSafePath(name)
    if (name.endsWith('/')) continue // directory entry
    if (uncompSize > MAX_ENTRY_BYTES) {
      throw new Error(`zip entry "${name}" exceeds the ${MAX_ENTRY_BYTES / 1024} KiB size limit — refusing to unpack`)
    }

    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28)
    const raw = buf.subarray(dataStart, dataStart + compSize)
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw)
    else throw new Error(`zip entry "${name}": unsupported compression method ${method}`)
    if (data.length > MAX_ENTRY_BYTES) {
      throw new Error(`zip entry "${name}" inflates past the size limit — refusing to unpack`)
    }
    entries.push({ name, data })
  }
  return entries
}

/** zip-slip guard: no absolute paths, no drive letters/backslashes, no `..` segments. */
function assertSafePath(name: string): void {
  if (name.startsWith('/') || name.includes('\\') || /^[a-zA-Z]:/.test(name)
    || name.split('/').includes('..')) {
    throw new Error(`zip entry "${name}" escapes the extraction directory (zip-slip) — refusing to unpack`)
  }
}

// ── package parsing (in memory, nothing on disk yet) ──────────────────────────

interface ParsedPackage {
  info: PackageInfo
  /** entry path (root folder stripped) → contents */
  files: Map<string, Buffer>
}

function hostOf(url: string): string {
  return new URL(url.replace(/\{[^}]+\}/g, 'x')).hostname // {param} holes can't parse as-is
}

function withinDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain)
}

function parsePackage(zipPath: string, hostVersion: string | undefined, occupied: OccupiedNames): ParsedPackage {
  const entries = readZip(readFileSync(zipPath))

  const pkgEntry = entries.find(e => posix.basename(e.name) === 'package.json')
  if (!pkgEntry) throw new Error(`${zipPath}: no package.json found — not a recipe package`)
  const root = posix.dirname(pkgEntry.name) // '.' when the zip has no wrapper folder

  const pkgJson = JSON.parse(pkgEntry.data.toString('utf-8')) as Record<string, unknown> & { stream?: { author?: string } }
  // 统一描述 + 与 tarball 那条路**同一把尺**（白名单 / schemaVersion / hostVersion / 容器格钳制 /
  // 代码格）。两条路各判一次就会出现「tarball 装不进、zip 能装进」这种静默不一致。
  const desc = parseStreamDescriptor(pkgJson, zipPath)
  const facility = desc.facility ?? desc.id
  const label = desc.pkgName ?? facility

  const files = new Map<string, Buffer>()
  for (const e of entries) {
    const rel = root === '.' ? e.name : e.name.startsWith(root + '/') ? e.name.slice(root.length + 1) : null
    if (rel) files.set(rel, e.data)
  }
  const bad = [...files.keys()].filter((p) => !isAllowedPackageFile(p))
  if (bad.length) {
    throw new Error(
      `package "${label}": files outside the whitelist: ${bad.join(', ')} — a package carries data plus at most one declared code entry (${PACKAGE_CODE_ENTRY})`,
    )
  }
  const backend = assertInstallable(label, desc, { hostVersion, hasCodeEntry: files.has(PACKAGE_CODE_ENTRY), occupied })
  if (backend) {
    // 落盘的 package.json 必须是**钳制后**的那份（service 已指派、卷已加前缀、standby 已兜底）：
    // 装载器和 provisioner 读的是盘上这个文件，写原始声明就等于确认页给的和实际跑的是两份字节。
    // 与 tarball 那条路同一条不变量（见 installRecipePackage 的写盘分支）。
    const rawStream = (pkgJson.stream ?? {}) as Record<string, unknown>
    files.set(
      'package.json',
      Buffer.from(JSON.stringify({ ...pkgJson, stream: { ...rawStream, backend } }, null, 2) + '\n'),
    )
  }

  const domains = new Set<string>()
  const actionKinds = new Set<string>()
  const sources: string[] = []
  if (desc.cookieDomain) domains.add(desc.cookieDomain)

  for (const [rel, data] of files) {
    if (!rel.endsWith('.recipe.json')) continue
    let recipe: Recipe
    try {
      recipe = validateRecipe(rel, JSON.parse(data.toString('utf-8')))
    } catch (e) {
      throw new Error(`package "${label}": ${rel}: ${(e as Error).message}`)
    }
    sources.push(recipe.sourceId)
    // A kind:'desktop' recipe drives a LOCAL app via the OS a11y tree — it reaches no network
    // host, so there is nothing to disclose in the install-time domain review.
    if (recipe.kind === 'desktop') continue
    // The domains this package will touch, for the install-time permission review. An
    // http/html recipe has no entryUrl and an optional cookieDomain — the host it actually
    // reaches is its request URL, so that is what must be disclosed. (An html recipe's
    // per-row detail pages are same-site links off that listing, covered by the same host.)
    if (recipe.cookieDomain) domains.add(recipe.cookieDomain)
    if (recipe.kind === 'http' || recipe.kind === 'html') {
      domains.add(hostOf(recipe.request.url))
      continue
    }
    domains.add(hostOf(recipe.entryUrl))
    if (recipe.kind === 'browser') {
      const steps = isCanonicalBrowserRecipe(recipe) ? recipe.steps : recipe.actions
      for (const a of steps) {
        actionKinds.add(a.kind)
        if (a.kind === 'goto') {
          const host = hostOf(a.url)
          domains.add(host)
          if (!withinDomain(host, recipe.cookieDomain)) {
            throw new Error(
              `package "${label}": ${rel}: goto targets ${host}, outside the declared ` +
              `cookieDomain "${recipe.cookieDomain}" — refusing to import`,
            )
          }
        }
      }
    }
  }

  return {
    info: {
      facility,
      // author 只在旧形描述里（统一描述不带它），从原始 stream 上直接读——解析产物没有这一格。
      author: pkgJson.stream?.author,
      cookieDomain: desc.cookieDomain,
      domains: [...domains],
      actionKinds: [...actionKinds],
      sources,
      ...(desc.code && {
        code: { entry: desc.code.entry, adapters: desc.code.adapters ?? [], normalizers: desc.code.normalizers ?? [] },
      }),
      ...(backend && { backend: summarizeBackend(backend) }),
    },
    files,
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/** Validate + summarize a package zip WITHOUT installing anything.
 *  `hostVersion` 默认取宿主自己的版本；参数只为测试留出把宿主摆到任意一侧的口子。
 *  `occupiedNames` **必填**、没有默认值：唯一可能的默认是一张空表，而空表 = 什么都不占 =
 *  撞名那道闸门整条失效。接线的人必须显式回答「已经有谁占着」——内置那一层
 *  （`occupiedByBuiltins(packages)`）**加上**已装的第三方那一层（`withInstalled(...)`）。 */
export function inspectPackage(zipPath: string, occupiedNames: OccupiedNames, hostVersion = readHostVersion()): PackageInfo {
  return parsePackage(zipPath, hostVersion, occupiedNames).info
}

/**
 * Import a recipe package zip into `destDir/<facility>/`. All trust-boundary
 * checks (zip-slip, size caps, file whitelist, descriptor schema, hostVersion,
 * 容器格钳制, 代码格申报一致, cross-domain goto) run before `confirm` is asked and
 * before anything is written; a false confirm installs nothing. 这套判据与 npm
 * tarball 那条路（recipe-install.ts）是**同一份代码**，不是两份长得像的实现。
 */
export function importPackage(
  zipPath: string,
  destDir: string,
  opts: { confirm: (info: PackageInfo) => boolean; occupiedNames: OccupiedNames; hostVersion?: string },
): ImportResult {
  const { info, files } = parsePackage(zipPath, opts.hostVersion ?? readHostVersion(), opts.occupiedNames)

  if (!opts.confirm(info)) {
    throw new Error(`import of "${info.facility}" cancelled — not confirmed by user`)
  }

  const target = join(destDir, info.facility)
  if (existsSync(target)) {
    throw new Error(`package "${info.facility}" is already installed at ${target} — remove it first to reinstall`)
  }

  try {
    for (const [rel, data] of files) {
      const out = join(target, rel)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, data)
    }
    // zip 无从核官方源（npm 那条路核得上才不写旁注，见 TRUST_SIDECAR 头注），而凭据闸把「旁注缺席」
    // 读成官方——不写就等于任何自称 @streamapp/* 的 zip 都能拿到内置层的登录态。一律写 false：
    // 名字是官方的、来源却只是一个本地文件，照第三方处置；第三方 scope 的包本来就不算官方，多这一份无害。
    const trust: PackageTrust = { official: false, reason: 'zip 导入无从核官方源' }
    writeFileSync(join(target, TRUST_SIDECAR), JSON.stringify(trust, null, 2) + '\n')
  } catch (e) {
    rmSync(target, { recursive: true, force: true }) // no half-installed packages
    throw e
  }

  return { installed: target }
}
