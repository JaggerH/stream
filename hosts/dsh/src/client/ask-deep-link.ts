/**
 * 进门时地址栏上带的那一句：`?stream-ask=<urlencoded>`。
 *
 * 这个参数名现在只有本文件定义；Stream 前端已不再产生这种深链（独立页没有对话）。留着
 * 这条消费路径是给外部/手写链接用——谁拼出一个带这个参数的 URL 跳进来，这里仍然会把它
 * 当一句话喂给对话面。
 *
 * **读完就把参数从地址栏抹掉**（`history.replaceState`）。不抹的后果是刷新一次就再发一遍，
 * 而用户按 F5 的时候完全不觉得自己在发消息。
 */

/** 深链参数名。 */
export const ASK_QUERY_PARAM = 'stream-ask'

/**
 * 取出并清掉地址栏上那一句。
 * @param loc - 地址（默认当前页；测试传一个假的）。
 * @param history - 用来抹参数的 history（默认当前页的）。
 * @returns 那一句，没有则 `undefined`。
 */
export function takeAskFromLocation(
  loc: { href: string } = window.location,
  history: { replaceState: (data: unknown, unused: string, url: string) => void } = window.history,
): string | undefined {
  let url: URL
  try {
    url = new URL(loc.href)
  } catch {
    return undefined
  }
  const text = url.searchParams.get(ASK_QUERY_PARAM)
  if (text === null || text === '') return undefined
  url.searchParams.delete(ASK_QUERY_PARAM)
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  return text
}
