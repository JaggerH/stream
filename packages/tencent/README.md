
## 说明（迁自 manifests.yaml 注释）

腾讯视频（v.qq.com）— 纯 http recipe（pbaccess.video.qq.com）。
episode：GetPageData 走 page_id:vsite_episode_list，明文 JSON、无签名，UA/Origin 均非必需（不同于
该站 search 端点——那个端点缺这两个头会被拒 20607，此处不需要）。page_size=100 通常一页拿全；
compute.decode 把 module_list_datas 摊平成 items[]，并把 module_params.has_next（字符串
"true"/"false"）转成真 boolean 喂 pagination.hasMore——不转的话原始字符串 "false" 在 JS 里是
truthy，increment 引擎 `!getPath(...)` 那条 hasMore 判断会被绕过去，永远不停。page_num 超出真实
页数时服务器会绕回第 0 页而不是给空数组，所以必须靠这个 boolean 兜底停，不能只指望"空数组=
自然结束"那条内置规则。
