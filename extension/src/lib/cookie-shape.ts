/**
 * 一条 cookie 交给 Stream 时的形状。
 *
 * 只有一个出口用它：`cookiePull`（后端主动来取，走中继）。**再加第二个出口就共用它，别另写
 * 一份**——两份实现漂移了不会有任何测试报警，表现是"某个域的登录态在一条路上好使、另一条
 * 不好使"，而两边单看都正常。
 *
 * 字段照抄 `chrome.cookies.Cookie` 里后端用得上的那些。`hostOnly` 尤其不能丢：没有它就分不出
 * 「`.quark.cn`（带点，发给所有子域）」和「`quark.cn`（host-only，只发 apex）」，注入回去时
 * 会变成全程游客态——这个坑真踩过。
 */
export function serializeCookie(c: chrome.cookies.Cookie): Record<string, unknown> {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: c.expirationDate,
    hostOnly: c.hostOnly,
    session: c.session,
  }
}
