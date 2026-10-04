
## 说明（迁自 manifests.yaml 注释）

Hugging Face Spaces 搜索 — 纯 http recipe（明文 JSON，huggingface.co/api/spaces，无签名）。
迁自本地 RSSHub 路由 lib/routes/huggingface/spaces.ts。响应是根级数组 SpaceItem[]，用 itemsAt:""
取根（引擎空路径=identity）。只保留默认过滤（sdk/hardware/running=all，无需引擎侧过滤），search 由
接口完成。
