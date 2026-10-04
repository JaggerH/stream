import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { StreamItem } from './types.ts'

function yamlEscape(s: string): string {
  // 简化处理: 用 JSON.stringify 包多行/特殊字符
  if (/[:\n"'#&*?|<>=!%@`]/.test(s) || s.includes('\n')) {
    return JSON.stringify(s)
  }
  return s
}

function buildFrontmatter(item: StreamItem): string {
  const lines: string[] = ['---']
  lines.push(`stream: ${item.stream_id}`)
  lines.push(`source_route: ${item.source_route}`)
  if (item.url) lines.push(`source_url: ${item.url}`)
  lines.push(`timestamp: ${item.timestamp}`)
  lines.push(`fetched_at: ${item.fetched_at}`)
  lines.push(`title: ${yamlEscape(item.title)}`)
  if (item.author) lines.push(`author: ${yamlEscape(item.author)}`)
  lines.push(`read: false`)
  lines.push(`type: stream-item`)
  lines.push('---')
  return lines.join('\n')
}

export async function writeItemToVault(
  item: StreamItem,
  vaultDir: string
): Promise<string> {
  await mkdir(vaultDir, { recursive: true })

  const datePrefix = item.timestamp.slice(0, 10)
  const filename = `${datePrefix}-${item.id}.md`
  const path = join(vaultDir, filename)

  const fm = buildFrontmatter(item)
  const body = item.body_text ?? ''

  const content =
    fm +
    '\n\n' +
    `# ${item.title}\n\n` +
    body +
    (item.url ? `\n\n[Source](${item.url})\n` : '\n')

  await writeFile(path, content, 'utf-8')
  return path
}
