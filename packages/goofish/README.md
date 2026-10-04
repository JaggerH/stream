# @streamapp/goofish

闲鱼（goofish.com）· 二手交易 · 型号挂牌中位价。

给一个型号名，回**一行**：这个型号在闲鱼在售挂牌价的中位数（剔除全新/未拆封、剔除标题不含型号名的
配件与不相干帖）。它是购买决策（斩杀线）残值格的第三条腿：`provides: search-resale`，由
`resale-search` Provider 行扇出，与转转、爱回收并列。

- **口径不同于回收价**：转转 / 爱回收给的是平台**回收价**（最好机况、平台愿意出的价，偏低）；闲鱼
  给的是**个人卖家要价**（偏高，成交通常略低）。两端合起来才是残值的区间；下游多源命中取高的那个、
  出处逐个列（`src/agent/purchase/resale-pick.ts`），basis 里带着各自的口径文字。
- **取数**：Tier-4 浏览器 recipe。搜索走阿里 mtop 签名接口且必须登录，所以在用户自己登录着的
  Chrome 里调页面自带的 `window.lib.mtop.request`，签名全由它算，**仓库里一行签名都没有**。
  聚合在页内做：筛标题、剔全新、取中位数，回一行，title 就是传进来的型号名。
- **前置**：用户的 Chrome 里闲鱼登着。游客态搜索永远「加载中」并弹登录 iframe——recipe 的 `wall`
  就钉在那个 iframe 上，会报成「需要登录」而不是漂移。
- **0 条是合法的**：冷门机 / 上代机没人挂 → `allowEmpty`，残值格退回按买入价。接口没回 / 形状变
  由 evaluate 自己抛错。

站点改版时的排查顺序：(1) `window.lib.mtop` 还在不在；(2) 头部头像 `[class*="user-order-container"] img`
与登录 iframe `mini_login` 两个信号；(3) 响应里 `data.resultList[].data.item.main.{exContent.title,
clickParam.args.price}` 的形状。

## 卖家侧动作 recipe（只经 `run_action_recipe` / `/api/recipes/action` 跑，两个选择面都不出现）

| recipe | 做什么 | 接口 | 调用方 |
|---|---|---|---|
| `goofish-publish` | 上架一件电子资料商品（标题 / 描述 / 价 / 图），回 itemId | `mtop.idle.pc.idleitem.publish` | data-packs `list.py` |
| `goofish-edit` | 改在售商品的标题 / 描述 / 价，itemId 不变，图片沿用 | `mtop.taobao.idle.pc.detail` 读图 → `mtop.idle.pc.idleitem.edit` | data-packs `list.py --edit` |
| `goofish-polish` | 擦亮（一天一次） | `mtop.taobao.idle.item.polish` | data-packs `polish.py` |

三条都在 `/publish` 页上跑（`lib.mtop` 在那页自签）。两个坑：
- **`itemTextDTO.titleDescSeparate` 必须 `true`**，否则闲鱼无视 `title`、拿描述前 30 字当标题。
- **个人号 `quantity` 只能是 1**，填多件回 `MULTI_INVENTORY_ITEM_CAN_NOT_PUBLISH`；多库存要鱼小铺。
