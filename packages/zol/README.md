# @streamapp/zol

中关村在线（detail.zol.com.cn）· 产品库 · 按价格档列出一个品类的在售机型。

给一个价格档，返回产品库列表页上的机型，一行一款：型号（含容量）、参考价、详情链接、图。
今天只有手机一个品类（`zol-phones`）。

- **能力**：`search`，`key_param: price`。取数是 Tier-2 `kind:'html'` recipe，裸 GET 列表页，
  linkedom + CSS 选择器映射。免签名、免登录、无容器。
- **它在购买决策里管什么**：枚举全集那一步的**直查源**。recipe 的 `meta.catalog` 声明了三件事，
  宿主（`src/agent/purchase/universe-catalog.ts`）只读这张表、不认识这个站：
  - `category`：「手机 / phone」品类来问这份产品库；
  - `param` + `bands`：站上价格是固定四档（`0` / `2000` / `4600` / `7600`），宿主取与用户预算
    有交集的几档去问，再按每行的确切价格筛；
  - 不写 `exhaustive`：一档上千款、recipe 只翻 3 页，取回的是样本不是全集，回执据此标 truncated。
- **回的是什么**：`title` = 型号（取 `a.pic img` 的 alt，不带宣传语），`description` = 参考价纯数字。
  这是**目录标价**，不是街价，也没验过今天真在售——比价那一步会用实付价再切一次。
- **加一个品类**：再写一份同形 recipe（换列表页 URL 与 `category`），在它的 `meta.catalog` 里声明，
  宿主不用改。

站点改版时的排查顺序：(1) 反爬闸——上游回 185 字节的 200（meta-refresh 跳 `service.zol.com.cn/checking`），
`assert` 会把它报成 drift，不会安静地回 0 行；(2) 行选择器 `li[data-follow-id]` 还在不在（别放宽成 `li`，
会混进侧栏）；(3) `.price-row .price-type` 是否还是纯数字。夹具与判据在 `zol-phones.recipe.test.ts`。
