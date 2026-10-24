/**
 * 测试用：一个认领表可以随时换掉的 `LinkRecognizer`。认领表归实例（生产里是 `ctx.sources.links`），单测没有实例，
 * 就在测试文件里自己持一份——`setTable` / `setDebug` 只换这一份的来源，不碰任何别的测试。
 */
import { LinkRecognizer, type LinkDebug } from './recognize.ts'
import type { LinkTableEntry } from '../replay/recipe-package.ts'

export function settableRecognizer(): {
  links: LinkRecognizer
  setTable: (f: () => LinkTableEntry[]) => void
  setDebug: (f: (e: LinkDebug) => void) => void
} {
  let table: () => LinkTableEntry[] = () => []
  let debug: (e: LinkDebug) => void = () => {}
  return {
    links: new LinkRecognizer(() => table(), (e) => debug(e)),
    setTable: (f) => { table = f },
    setDebug: (f) => { debug = f },
  }
}
