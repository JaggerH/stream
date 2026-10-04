
## 说明（迁自 manifests.yaml 注释）

iqiyi 国内站 — 纯 http recipe（mesh.if.iqiyi.com）。迁自本地 RSSHub 路由
lib/routes/iqiyi/{search,cn-album}.ts。

- cn/search：明文 JSON 搜索，无签名，返回专辑（albumInfo），可拿 qipuId 喂给 cn-album。
- cn/album：tvg/v2/selector 是签名端点，用 compute.sign 算 md5(sorted params + &secret_key=howcuteitis)；
  compute.decode 把 data.videos[].data 按年分组拍平成 items[] 并把封面 regex 升清到 720x405。
  albumId 要数字 qipuId（省掉 RSSHub 从 a_*.html 抠 albumId 的 HTML 步；搜索结果里就有）。
