
## 说明（迁自 manifests.yaml 注释）

bt0(不太灵影视)— 纯 http recipe。站点从 (1-9)bt0.com 搬到 web{n}.mukaku.com（Vue SPA），
数据走 JSON API `/prod/api/v1/`；每请求必带站点 JS 写死的常量 app_id + identity（axios 拦截器
逐请求追加，非按访客生成，照抄即站点自身行为）。迁自本地 RSSHub 路由 lib/routes/bt0/{tlist,search}.ts。
domain 固定 web2（2/3/5 可达，默认 2）；站方换掉那两个常量时需去 assets/index-*.js grep `app_id=` 重抠。
