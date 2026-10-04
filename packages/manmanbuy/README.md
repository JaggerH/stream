# @streamapp/manmanbuy

慢慢买（manmanbuy.com）· 全网比价关键词搜索。

搜一个商品名，返回各电商平台（京东 / 天猫 / 淘宝 / 拼多多 …）对它的报价与促销，
一行一个平台报价 —— 即"同一商品的跨平台比价"。

- **能力**：`search`（`provides: search-price`），`key_param: keyword`。宿主的 `price-search`
  Provider 行（MCP `price_search`、购买决策逐台比价）按这一格自动把它收进成员，宿主源码里不点它的名。
- **取数**：Tier-2 `kind:'html'` recipe，抓慢慢买优惠流页（`s.manmanbuy.com` 的 `c=discount` tab，
  服务端直出），linkedom + CSS 选择器映射。免签名、免登录、无容器。
- **为什么不是比价 tab**：站点的商品比价 tab（`c=search`）走带签名的 `prom2Extra` XHR 且要慢慢买
  登录态（否则 `7700 需登录验证`），成本高一级。优惠流每行本身就是"某平台对某商品的报价"，
  已满足比价意图。要精确到同一 SKU 分组，再考虑升级到浏览器 recipe 打比价 tab。

选择器用 `[class*="DiscountItemPC_..."]` 前缀匹配抗 CSS-module 哈希变动；站点改版导致列表抓空时，
按 `write-recipe` / `onboard-source` 的 html 档重新校准选择器。
