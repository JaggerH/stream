# 百度网盘（`@streamapp/baidu`）

## 这个包出什么

- **recipe** `baidu-share`：一条百度分享 → 判决对象 `{validity, files, reason}`，带提取码时匿名解锁。
- **一条 Provider 行** `netdisk-verify-baidu`（`package.json#stream.providers`）：serveKey `baidu-verify`，
  是调用点 `netdisk.share.verify` 的默认行之一，成员是本包的 `baidu-share`。

## 能力边界

百度几乎每条分享都锁着提取码。没有提取码时只能判"链接是否存在"，看不进去就返回 `unknown`，绝不判死。
百度没有转存、播放、跳转这几条行，所以这几个调用点遇到百度的链接时如实回答"不支持"。

## 改这里要注意

- **行 id 不能改。** 用户库里存着这条行和它的编排，启动时按 id 认成同一条系统行。改了 id，旧行会被当成"代码删了"清掉。
- 身份与调用点由 `src/packages/netdisk-providers.real.test.ts` 对真实包钉着。
