
## 说明

No cookieDomain: the vodapi needs no login — a cookie-less request gets 200. Declaring a
domain anyway would ask the broker for credentials this source has no use for.

### 关于 request.headers 里的 User-Agent

**这里的 UA 不是伪装，是「躲进人群」。** 别把它读成"必须长这样才能过"。

荔枝的 WAF（Tencent EdgeOne）接受哪种 UA 是会变的，而且两个方向都变过——所以**任何"某站拦某类
UA"的结论都必须现测、并写上日期**，别照抄。实测同一 id、间隔 4s：

| UA | 2026-08-01 | 2026-08-05 |
|---|---|---|
| 浏览器样（Chrome Android / iPhone Safari） | 403 无 body | **200** |
| 无 UA | **200** | 567 |
| `Stream/1.0` / `okhttp/*` / App 自己的 token | 200 | 200 |

选 `okhttp/4.12.0` 的理由只有一个：**独一份的 UA 是免费的靶子**。`Stream/1.0` 全网只有我们在发，
站方要精确掐掉我们，加一条规则、零附带损失；`okhttp/4.12.0`（安卓 HTTP 客户端默认串）要拦就得
连带砍掉大片正常 App 流量。

参考——荔枝 App 自己按用途分了四个 UA（2026-08-05 手机抓明文 HTTP）：诊断接口
`LizhiFM/5.21.12_build156474 NetType/WIFI Language/zh`、埋点与拉封面 `Dalvik/2.1.0 (...)`、
测速 `LizhiFM Android cdn_test 156474`、拉音频流 `LizhiFM Android player 156474`。**别去精确
冒充其中任何一个**：带 build 号的串会随版本作废，而且业务 API 走 HTTPS，抓包里那几个都不是它。

## 说明（迁自 manifests.yaml 注释）

荔枝 FM 用户音频 — kind:'http' recipe (no browser)。
Migrated from the local-only RSSHub route lib/routes/lizhi/user.ts, which is why the
radar patterns below are carried over verbatim: the `podcast-feed` Provider reaches this
source by URL match ({mode:'auto', matches:'lizhi.fm/user/:id'}), not by source id, so
dropping them would silently break that Provider while the Stream member kept working.

## CDN：为什么要后端代理、为什么是这四台

`.lizhi.fm` 的音频直链不能直接甩给浏览器——上游有一批冷对象一律 403，必须由后端代理、Range
原样透传（见 `src/media/serving.ts` 那张表；本包在 `package.json#stream.serving` 里声明
`match: '.lizhi.fm'` 命中这条策略）。

**每台主机对每个文件各有各的状态，而且速度差着数量级**——所以这里必须是一组候选主机，不能写死
一台。实测（2026-08-05，同一时刻、同一个文件）：

| 主机 | 状态 | 速度 |
|---|---|---|
| cdn5.lizhi.fm | 403 | — （接口 `trackUrl` 给的就是它；换三集测又全 206，所以不是「这台死了」） |
| cdn101.lizhi.fm | 206 | 12.96 MB/s |
| cdn.gzlzfm.com | 206 | 104 KB/s |
| cdn102.lizhi.fm | 206 | 997 B/s（180s 拉不完 4MB） |

最快与最慢差一万三千倍。这批候选主机名不是猜的：是荔枝 App 自己在用的那批——它每次播放前用
`/audio_cover/cesu_hd.mp3` 挨个测速挑主机（UA `LizhiFM Android cdn_test`，2026-08-05 抓包）。
Stream 做同一件事的省钱版：不发探测请求，拿真实播放的字节当尺子。

**别试着给上游加 UA 来治这个 403——已经试过了，没用。** 拿手机抓到的荔枝 App 自己那个播放器
UA（`LizhiFM Android player 156474`）打 cdn5 上的同一个文件，两轮反序实测（2026-08-05，5 个
UA × 2 轮，间隔 6s）：第一轮 curl 与 player UA 都 403、其余 206，第二轮完全反序则**全部 206**。
同一个 UA 两种结果 = 变量不是 UA，是**位置**——冷对象第一次被要就 403，这一发顺带把它回源拉热，
后面就都通了（即上面那条「对未缓存区间一律 403」）。所以代理请求上游时不传自定义 UA 是对的，
不是漏了。

## RSSHub 路由为什么退役

荔枝的 web 端用户音频接口已经关掉了，`rsshub:lizhi/user/:id` 现在恒空——请求能 200，`data`
永远是空数组，不报错也不降级，看起来像"这个用户没发过东西"。本包的 `lizhi-user` 改走 App 的
`vodapi`（`https://m.lizhi.fm/vodapi/user/{id}`）顶上，同一个 facility 下两条路由并排的危害是
用户/上游装了旧目录仍会选中那条恒空的路由、拿到一个看似正常实则永远拉不到内容的源；本包在
`package.json#stream.retires` 里声明退役这条 RSSHub 目录项，让装载期直接拒收它。
