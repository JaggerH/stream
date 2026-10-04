# Stream 内置

进程内实现的 Source 化声明（方案 A：Provider 成员一律是 Source）。
每个源的 `fixed_params.mode` 对应 bootstrap 在 builtin adapter 上注册的实现函数；
名称/描述/参数模式住在这里（manifest 是元数据唯一的家），不进订阅目录（`discoverable: false`）。

`required: true` —— 核心插件：磁力解析/播放解析/转写/LLM/抓取都是进程内能力，不能被用户关掉。
开关锁定为开。
