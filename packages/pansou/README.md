# PanSou

Search-only netdisk resource search (no credentials, no login).

## backend

- `backend.image` is pinned to an OCI digest for the self-built image. Its source is
  [fish2018/pansou](https://github.com/fish2018/pansou), licensed MIT; replacing the
  image requires reviewing the upstream source and publishing a new digest, rather than
  moving a tag in place.
- `env.CHANNELS` —— Default Telegram channel pool: the TG channels pansou searches when no
  per-request `channels` param is given. Curated from the upstream reference config. Add/remove
  channels here; they take effect on next `docker compose up -d` (compose regenerated from this
  descriptor).
- `env.ENABLED_PLUGINS` —— PanSou built-in indexer plugins to enable (non-TG web scrapers). Each is
  a Go plugin in the pansou repo (`plugin/<name>/`).
- `standby.idleMinutes: 30` —— 冷查询型：调用零散、单次搜索几秒内完事，没有播放/挂载那种"随时要来"
  的时效压力——30 分钟闲置够覆盖同一会话内的连续几次搜索，又不会长期占着容器空转。
- 外部 PanSou —— 设环境变量 `PANSOU_URL`（adapter 自己读，排在宿主给的容器地址之前）。宿主的
  `config.yaml` 里没有这个包的配置键，写了 `pansou_url` 启动时会 warn 一声、不生效。

## 资源搜索

`searchSources` 声明 `pansou-search` 在资源搜索里的展示键 / 标签 / 查询参数 / 条目形状（`digest`：一条
消息 = 片名 + 一串网盘链接，频道名进发现池）；manifest 的 `provides: [search-download]` 让资源搜索行的
auto 段收它。

**出处字段由本包拼**：adapter 在每条结果上补宿主认的通用字段——`origin`（Telegram 消息
`https://t.me/<频道>/<消息号>`）、`channel_url`（频道页）、`provider`（非 Telegram 命中取 `unique_id` 的插件名）。
宿主只读这三格，不认识盘搜上游的 `message_id` / `unique_id`（`adapter.ts` 的 `withOrigin`）。

## 发布

`@streamapp/pansou` 是 `"private": true`，不发 npm：第三方容器钳制（`backend.service` 由宿主指派、必须写 `mem`、
id 文法）与「用户层同名容器包该顶掉内置容器还是并存」都还没有设计，见 `project planning record`「带容器的内置包怎么走
npm 安装」。

构建链照样出 dist 备着：`activate.ts` + `adapter.ts` + `normalizer.ts`（及 `shared/package-sdk/` 里用到的纯函数）
由 tsdown 打成单文件 `dist/index.js`，`package.json#stream.code.entry` 指的就是它。容器地址与 standby 唤醒经
`ctx.backendUrl` / `ctx.withAwake` 拿，宿主单例不进 bundle。

- 构建：包内 `pnpm bundle`（= 仓库根 `pnpm packages:bundle` 只对这个目录）——`private` 不影响构建链，只挡发布。
- 用户 `stream add @streamapp/pansou` 装到比内置更高的版本 → 用户层的声明与代码顶掉内置那份（内置代码跳过）；
  相等或更低 → 内置为准。内置层自己不读 dist，直接 import `./activate.ts`。
