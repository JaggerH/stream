
## 说明

1lou（BT 之家 1LOU 站）关键词搜索 — `kind:http` recipe，打站点搜索页自己用的 JSON 接口，无浏览器。

- **接口**：`https://www.1lou.me/search/api/search.php?q=<关键词>&page=<n>&sort=newest`，
  回 `{ok, data:{total, page, page_size:50, hits:[{tid, fid, subject, username, create_date, files, …}]}}`。
  `create_date` 是秒级时间戳，行链接由 `tid` 拼成 `https://www.1lou.me/thread-<tid>.htm`（与站内 `threadPath` 一致）。
- **别打旧入口**：`/search.htm?keyword=` 会挂到超时不回；`/search-<关键词>.htm` 302 到 `/search/?legacy=…`，
  那是一张空壳单页应用，行全靠上面那个接口画，所以 HTML 选择器取不到任何行。
- **下载在帖子页里**：行只给帖子链接。帖子正文里是种子附件（`attach-download-<id>.htm`），不是 `magnet:`，
  所以宿主通用的 magnet 下载解析认领不了它。
- **搜索后端不稳**：同一时段整个 `/search/` 会连着回 504（用户自己的 Chrome 里一样），恢复后照常出数；
  504 时这一轮就是失败，不是选择器坏了。
- 样本与守卫：`__fixtures__/search-api.json`（活体接口原样回包）+ `1lou-search.test.ts`。
