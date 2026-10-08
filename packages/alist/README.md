# OpenList（包 id 仍是 `alist`）

网盘聚合直链（内置托管容器，Stream 全权接管，不暴露 OpenList 自身 UI/密码）。

镜像是 OpenList，不是 AList：AList 2025-06 易主后社区分出的 fork，`/api` 与 AList v3 逐端点一致
（`shared/netdisk/alist-client.ts` 零改动），并内置只读 MCP。包 id / service 名 / 卷名 / 代码里的
`alist` 一律不改——那是本仓库内部的键，不是上游的名字。

## backend

- `image: openlistteam/openlist:latest` —— 设施官方镜像（§1.2：Stream 永不重新打包）。
- `service: alist` —— 同网络 DNS：`http://alist:5244`（仅内网，不发布宿主端口）。
- `health: /ping` —— 2xx = ready（返回 pong）。
- `env.MCP_ENABLE=true` —— 打开内置 MCP（streamable HTTP，`/mcp`，三个只读工具
  `openlist.fs.list` / `openlist.fs.get` / `openlist.fs.link`）。给对话侧直接翻网盘用；storage
  admin 与转存不在里面，那两样走本包代码。
- `volumes: alist-data:/opt/openlist/data` —— 存储挂载配置 + 账号数据持久化，重启不丢。
  **容器以 UID 1001 跑，启动时检查该目录可写，不可写直接退出**（entrypoint 打一段中英文错误）。
  从 `xhofe/alist` 的卷迁过来时文件是 root 的，先一次性
  `docker run --rm -v <卷名>:/v alpine chown -R 1001:1001 /v`；新建的卷 docker 会按镜像目录的
  属主初始化，不用管。
  **旧卷还有第二处要改**：AList ≥3.4x 把 `x_users.role` 存成 JSON 数组（`[2]`），OpenList 要整数，
  不改直接 panic `UNIQUE constraint failed: x_users.username`（它查不到 admin 就去建一个）。
  `sqlite3 data.db "update x_users set role=2 where username='admin'; update x_users set role=1 where username='guest'"`。
  AList 多出来的表（`x_roles` / `x_sessions` / `x_labels`…）OpenList 不认识、无害。
  这两步只对「从 AList 迁过来」成立；HTTP 面一致不等于 sqlite 面一致。
- 容器内二进制是 `./openlist`（`provision.ts` 的 `dockerAdminSet` 靠它重设 admin 密码；容器按
  `com.docker.compose.service=alist` 标签找，dev 下叫 `stream-alist-1`、standby 建的叫 `stream-alist`，
  都不叫 `alist`）。
- 内置 MCP 的探法：`/mcp` 走裸 `Authorization`（永久 token 在 `x_setting_items` 的 `token` 键），
  `initialize` 之后**必须再发一条 `notifications/initialized`**（202），否则 `tools/list` 的 result
  是 null 且不报错。
- `standby.idleMinutes: 240` —— 网盘挂载/播放随时可能来，不能像冷查询那样几十分钟就停——4 小时空闲
  才睡，避免播放中途或紧接着的下一次点播撞上频繁启停。trade-off：AList 没有自带管理 UI 的 host
  直发口（本插件未声明 `publish`），所以 standby 停它不影响外部可达性；但若日后为管理 UI 加
  `publish`，停机窗口里那个口也会跟着不可达，直到下次唤醒。

## token 从哪来

内置托管是唯一形态：token 不是用户填的，是宿主用托管的 admin 凭证登录换来的 48h JWT，存在
`settings.rows('alist').token`。登录要容器醒着，所以它有两个取的时机：

- **启动时顺手取一次**：`/ping` 2s 内答得上才取。standby 管着的容器这时多半在睡，**取不到是常态**，
  不算故障——日志里是 `alist 未就绪（/ping 不通），启动时不接管`。
- **用到时取**：宿主把同一条通道（`packages.alist.refresh`，内部 `withAwake` 后登录）经 `config.refresh`
  递给本包的 adapter、也递给 netdisk 域的 client。手里 token 为空时，第一次请求之前先经它取；
  401（JWT 过期）时经它换发。

所以「启动时 token 为空」的两个消费方都照常装配，不要再加「没 token 就不装配 / 就报错」的门——那会把
一次启动时序变成整个进程生命周期的失效，而且下次重启时容器多半还在睡。

地址和 token 都没有任何手工入口：`config.yaml` 里没有对应的键（写了 `alist_url` / `alist_token`
启动时会喊一声「不再被读取」），不读 `ALIST_URL` / `ALIST_TOKEN` 环境变量，没有写接口，配置行
`alist` 的写入一律被拒（所以通用的 `PUT /api/config/alist` 也写不进来）。别加回来——每一个这样的
入口都是「机器上碰巧设了个值就把网盘请求悄悄引到别处」的机会。

这个包没启用时没有网盘底座：`packages.alist.managed()` 为 false，`refresh` 抛「网盘底座包未启用」。

## 发布

`@streamapp/alist` 是 `"private": true`，不发 npm：第三方容器钳制（`backend.service` 由宿主指派、必须写 `mem`、
id 文法都不容许这个包今天的形状）与「用户层同名容器包该顶掉内置容器还是并存」都还没有设计，见
`project planning record`「带容器的内置包怎么走 npm 安装」。

构建链照样出 dist 备着：`activate.ts` 及其可达的模块（`adapter.ts` / `normalizer.ts`，加
`shared/netdisk/alist-client.ts` 与 `shared/package-sdk/` 里用到的纯函数）由 tsdown 打成单文件 `dist/index.js`，
`package.json#stream.code.entry` 指的就是它。**`provision.ts` 不在产物里**——接管内置 AList 容器、托管 admin
凭证是宿主直接 import 的编排，方向是宿主够进包，`activate.ts` 不 import 它。

- 构建：包内 `pnpm bundle`（= 仓库根 `pnpm packages:bundle` 只对这个目录）——`private` 不影响构建链，只挡发布。
- 内置层自己不读 dist，直接 import `./activate.ts`。
