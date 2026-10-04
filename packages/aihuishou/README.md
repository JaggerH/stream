# @streamapp/aihuishou

爱回收（aihuishou.com）· 二手回收 · 型号最高回收价。

给一个型号名，返回爱回收对它的「最高回收价」（最好机况），一行一个型号。它是购买决策
（斩杀线）残值格的第二条腿：`provides: search-resale`，由 `resale-search` Provider 行扇出，
与 `@streamapp/zhuanzhuan` 并列——两家都命中时取高的那个，出处逐个列（`src/agent/purchase/resale-pick.ts`）。

- **能力**：`search`（`provides: search-resale`），`key_param: keyword`
- **取数**：Tier-3 浏览器 recipe。估价只在 App / 小程序 / 手机站 H5 里，桌面站是落地页；手机站的
  `recycle-products/search-v11` 带 `Ahs-*` 签名头，站外直打回 `1001 鉴权参数缺失`。所以在用户自己的
  Chrome 里打开 `m.aihuishou.com/n/#/search?type=Recycle`，往搜索框敲型号名，页面自己签、自己发，
  network observer 拦响应。**不逆向签名**（法律红线），**不需要登录**（游客态就回价）。
- **回的是什么**：`maxPrice` = 站上「最高回收价」= 最好机况下平台愿意出的价，是残值的上限。
- **0 条是合法的**：平台没收录（尤其残值格会去问上一代 / 上两代机型）→ `allowEmpty`。「读不到了」
  由第三步的等待判据单独抛错（页面既没出「最高回收价」也没出「没有找到」）。

站点改版时的排查顺序：(1) `input[type=search]` 还在不在（loggedIn 与第一步都靠它）；(2) 有/无结果
两句文案是否还是「最高回收价」/「没有找到」；(3) `search-v11` 的路径与 `data.products[].maxPrice`
形状。类名一律别用——全是 CSS-module 哈希。
