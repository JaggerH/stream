# @streamapp/zhuanzhuan

转转（zhuanzhuan.com）· 二手回收 · 型号最高回收价。

给一个型号名，返回转转回收对它（及同系列相近型号）的「最高回收价」，一行一个型号。
它是购买决策（斩杀线）里**残值**那一格的来源：`provides: search-resale`，由
`resale-search` Provider 行扇出，**不并进比价档**——「新品各平台报价」和「二手值多少」
是两种意图，混排会让模型把回收价当成一个便宜的购买选项。

- **能力**：`search`（`provides: search-resale`），`key_param: keyword`
- **取数**：Tier-2 `kind:'http'` recipe，裸 GET
  `app.zhuanzhuan.com/zzopen/zzbmlogic/getWordkeySearchResultNew?keyword=…`。无签名、无登录、
  无 cookie、无容器。
- **回的是什么**：`maxPrice` = 站上标注的「最高回收价」，即**最好机况**（全新/99 新）下的回收
  报价，是残值的**上限**，不是随便一台旧机能卖到的数。消费端（`src/kernel/plugins/agent.ts`
  的 `residual`）把它当今日残值上限用，并在回执 `basis` 里如实写明。
- **型号归一**：接口自己会把「红米 Turbo 5」分成 Turbo 5 / Turbo 5 Max、把「一加 Ace 6」连上一代
  Ace 5 一起回。**消费端必须按名字精确对**（去空格、大小写不敏感），拿第一行当答案会把
  Max 版的价安到标准版头上。
- **别换的接口**：同站 `queryMaxPrice` 恒回「服务异常」；`searchAssociatePage` 只回联想词。

接口变形（`respData.keyWordResult` 不再是数组、或 `maxPrice` 消失）时按 `onboard-source`
第 2 级重新侦察：在用户 Chrome 里开回收首页搜一次，看 `zzbmlogic/*` 里哪条带价格。
