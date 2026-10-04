# Recipe

登录态浏览器的 recipe 兜底采集引擎。

无独立 facility：签名 / 登录门禁站点（小红书、雪球…）的 recipe 源都归在这个插件下。
源来自 `recipes/` 包，这里只补插件级 name/description（manifest 是元数据唯一的家）。
无 backend → 进程内（用户自己的 Chrome + ext-cdp 中继），不生成容器。
