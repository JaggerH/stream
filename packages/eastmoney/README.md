# @streamapp/eastmoney — 东方财富网上交易

东方财富（`eastmoneysec.com`）网上交易的 Stream 包：一条登录 recipe + 一格代码槽位，没有 Source 清单、不出内容。

## 两格能力

| 格 | 是什么 |
|---|---|
| `eastmoney-login.recipe.json` | facility `eastmoney` 的**登录入口**（`meta.login: true`，同时 `meta.action: true`——登录会踢掉同账号的其它会话，是不可撤回的副作用，所以走二次确认闸）。在用户自己的 Chrome 里做：认图形验证码、让站点的安全控件自己算密码、选最长的会话时长。资金账号 / 交易密码从用户手填的 `eastmoney` 配置格读（`runtime_config.ref`）。 |
| `activate.ts`（`package.json#stream.code`） | 交出三个**动作**：`calendar`（今天可申的新股 / 可转债日历）、`subscribe`（申购）、`repo`（逆回购）。全局名 `eastmoney:<键>`，由用户定时任务行指到；什么时候跑、用哪一格账号、要不要真下单全在任务行里，包只回答"能干什么"。参数从任务绑的配置 row 来，`live` 缺省 false——忘了配等于不下单。 |

会话最长 3 小时，掉会话是常态：动作在建会话那一步探到 302 就 `ctx.login('eastmoney')`，宿主找到上面那条登录
recipe、跑掉、刷新 cookie 快照，然后**只重做建会话**这一步，不重跑动作本身（重跑一个已下过一半单的动作就是重复下单）。
登录态只经 `ctx.cookieFor('eastmoneysec.com')` 拿，域申报在 `stream.credentials`。

## 发布

npm 上的这个包带一份预编译的代码槽位：`activate.ts` + `client.ts` + `trading.ts` 由 tsdown 打成单文件 `dist/index.js`，
`package.json#stream.code.entry` 指的就是它；tarball 里只有 `dist/index.js`、`eastmoney-login.recipe.json`、`README.md`
与 `package.json`（这个包没有 `manifests.yaml`，`prepack` 闸对此不报错）。宿主类型只 `import type`，编译期抹掉；
宿主单例一律经 `ctx`。

- 构建：包内 `pnpm bundle`（= 仓库根 `pnpm packages:bundle` 只对这个目录）。
- 发布：`npm publish --access public`，`prepack` 闸自动核产物在且非空、独占 `dist/`、tarball 过安装门白名单。
- **首发由人做一次，CI 不代劳**——这个包公不公开是生意上的决定，`release-recipes.yml` 只跟已经在 npm 上的包
  走版本：首发之后 bump `version` 合 `main` 才会自动发。
- 用户 `stream add @streamapp/eastmoney` 装到比内置更高的版本 → 用户层的声明与代码顶掉内置那份（内置代码跳过）；
  相等或更低 → 内置为准。内置层自己不读 dist，直接 import `./activate.ts`。
