# 登录态在哪 —— 用户自己的浏览器 / broker cookie / 扫码面板

**浏览器档（3–5 级）已经没有"登录态怎么进去"这个问题了**：采集跑在**用户自己的 Chrome** 里，他在
那个站登着就是登着。没有注入、没有 profile 要管、没有指纹要对——因为那本来就是一个真人的浏览器。

所以这份文档现在只回答三件事：**谁持有这份登录**、**掉了谁去重登**、以及**这份登录能不能离开这个
浏览器**（那一条决定成本阶梯能不能停在更便宜的第 2 级）。

判"数据怎么取"(成本阶梯)是上游 `onboard-source` 的事;这里只管登录态。

代码锚点:`src/replay/transport.ts`(采集侧一句 cookie 都不注入,注释写着为什么)、
`src/replay/cookies.ts`(`parseCookieHeader` 补前导点 / `stripAcTokens`)、
`src/replay/browser.ts`(作者流程的 `injectCookies`)、`src/replay/http-fetch.ts`(HTTP 档的
cookieDomain 绑定)、`src/manifest/loader.ts`+`types.ts`(auth session `login: qr|cookie|oauth`)、
`src/auth/browser-qr-login-provider.ts` / `src/auth/browser-oauth-login-provider.ts`
+`src/kernel/plugins/auth.ts`(两支登录 provider 都登在哪个 tab 上)。

---

## 1. 登录态一共只有三个落脚处

| 哪一档 | 登录在哪 | 怎么建立 | 掉了怎么办 |
|---|---|---|---|
| **浏览器档**（3–5 级 canonical recipe） | **用户自己的 Chrome** | 用户像上任何一个网站那样登 | 他自己重登；或给这个 facility 声明 `login: qr`（Stream 弹扫码面板）/ `login: oauth`（Stream 替他点掉第三方入口，见 1.2） |
| **HTTP 档**（第 2 级 `kind:'http'`，以及 legacy fetch recipe 的 `cookieDomain`） | 后端的登录态库（`data/cookies.json`） | 后端在中继上向扩展取（`op:'cookiePull'`，见 `src/credentials/cookie-puller.ts`） | 用户在自己 Chrome 重登，同步自动跟上，**stream 侧零操作** |
| **作者流程 · 抓包**（`capturing.md`） | 形态 A（`cdp_*`）：**用户自己那个 Chrome**，经扩展中继；形态 B（仓库脚本）：**你自己**另起的那个带调试端口的 Chrome | 那个浏览器登着就行 | ——（形态 B 要抓一个"这个浏览器没登录"的会话，才用 `COOKIE_HEADER`+`COOKIE_DOMAIN`；形态 A 没有这一档，它就是用户的登录态） |

### 1.1 `login: qr` 扫到的是用户自己的浏览器

声明形状：`login: 'qr'` + `loginUrl` + `qrSelector`（`src/manifest/loader.ts`）。扫到哪里：

- 扫码开在**这个 facility 自己那条采集 lane 上**——**就是采集骑的那个 tab**（`bootstrap.ts` 里
  `openProfile` 直接去 `recipeSessions.acquire`）。于是"用户刚建立的这个会话"就是"下一次采集用的
  那个会话"，中间不需要任何搬运，也没有第二个浏览器可能拿错。
- 登完只是**释放**（不关）这个 tab，让它留在原地。
- **没有"等 cookie 落盘才算登录成功"这一步**：会话归用户自己的浏览器持久化，和它对待别的网站
  一模一样，Stream 不介入也不需要确认。
- `login: 'cookie'` 的 facility **不进扫码面板**（`facility-auth-view.ts` 显式过滤）：它的登录归用户在
  自己 Chrome 上重建，Stream 弹面板没有意义。

**面板只是"谁去重登"的路由，不是登录态的容器。** 别把 `login:` 读成"登录态存在哪"。

#### 扫码面板的三条实战约束（2026-07-29 活体逐条撞出来的）

**① 二维码要留静默区。** `elementShot` 严格裁到元素的 rect，而 QR 规范要求码四周有一圈**静默区**
（quiet zone）；元素自身没内边距时那圈白边正好被裁掉，**手机扫不出来**。现在 QR 那条传
`padRatio: 0.12`（短边 12%、16px 下限、夹回视口内）。多留白没有副作用（扫码器只找定位图案），
少留白直接失败，所以偏大给。

**② 码换了要重新推，不是"只抓一次"。** 平台会在第一次扫码之后**再压一张**（xhs 的设备/异地验证）。
只抓一次的话 Stream 手里攥着的还是第一张，用户对着一张已经作废的图怎么扫都不成。
**判据是"签名变了"，不是"这是第二次验证"**——后者今天叫这个名字、下个月叫别的，认它就是在追平台
的实现。签名 = `<img>` 的 `src`（读不到就退到 outerHTML 长度+尺寸）；**不比截图字节**，同一张码两次
截图未必字节相同（抗锯齿/动画/JPEG 量化），拿它当判据会把"还是那张"误报成"又换了"，前端就每隔几秒
闪一下。事件带 `again`，前端据此说"**不是你扫错了**"。

**③ 总有我们渲染不了的形态，所以必须留一条明路。** 滑块、短信、App 内确认——**不要去适配**：那是
平台改得最勤、盯得最紧的一段，也离"绕过验证"那条红线最近。面板给一个「在浏览器里完成」
（`POST /api/auth/facilities/:facility/focus`），把那个 tab 放到用户面前，他做完什么我们不需要知道
——**判定继续交给采集侧的 `loginCheck` 和对账器**。抢屏在这里正当：用户点击触发，且他点的就是
"去浏览器里弄"。

**④ 扫码流程占着 lane 时，采集当场退。** 它会占到用户扫完（分钟级），而搜索给每个成员的预算是
25 秒——排队的尽头一定是超时，还会把"你需要登录"这个唯一可操作的信息盖成一句"超时"。租借因此带
`purpose`：采集撞上 `login` 抛 `LaneBusyForLoginError`，被 `blockedOf` 映射成"需要登录"。

**⑤ 横幅不会自己翻——除非有人去问。** 「需要登录」是**健康账本的投影**，而账本只在一次采集跑完时
更新。定时采集的源靠下一轮 tick 自己翻；**只有搜索才跑的源没有任何东西会自己跑**，用户在浏览器里
登录回来了，横幅能一直挂着。`auth-reconciler.ts` 补的就是这个：三个触发点（扩展连上 / 每分钟一次 /
面板打开时读端点），证据阶梯是「lane 活着就用真判据 → 否则用 cookie 证据」，而**"问不出来"一律
保持横幅**（把扩展离线当成登录成功 = 用户一夜没开电脑，第二天所有登录提示自己消失）。

### 1.2 `login: oauth` 骑的是浏览器里**已有的第三方登录态**

声明形状：`login: 'oauth'` + `loginUrl` + `oauthButton` + `accountSelector`
（`src/manifest/loader.ts`；成例 `packages/groq/groq-create-key.recipe.json` 的 `meta.auth`）。
装配形状和 qr 那支完全一样：同一条采集 lane、同一个 Transport-backed 登录页
（`src/kernel/plugins/auth.ts`）。适用的场景是「这个站自己没有账号体系，登录就是点一下
`用 Google 继续`」——用户的 Google 登录态本来就在那个 Chrome 里，Stream 只是替他点。

四条别踩的：

- **provider 不认识任何一种验证方式。** 它只做三件事：开登录页 → 点第三方入口 → 轮询
  `LOGGED_IN`。中间冒出通行密钥、二次验证、服务条款屏，一律靠**把 tab 掀到前台 + 发一条
  `needsHuman`** 交给用户，然后继续等。加"认识某一屏并替用户点掉"的分支，等于给每一次
  平台改版留一个静默失败点。
- **`account` 不在 recipe 里。** 它是每个用户各一份的邮箱，而 recipe 是随包分发的。真正的值
  住在用户填的 `runtime_config`（groq 那格叫 `googleAccount`），由
  `resolveLoginAuthSpec`（`auth.ts`）在**每次发起登录时现取**——装配期读一次拿到的永远是
  那一刻的空值，且不报错、不降级，表现只是"自动选账号这个功能不存在"。
- **`account` 缺席是合法的常态**，语义是「不替用户自动选账号，让他自己在选择器上点」。
  Google 只有一个登录账号时本来就会跳过选择器，这条路径与之对齐。缺席时**整段跳过**，
  绝不能拿 undefined 去 `replace` 拼出 `[data-identifier="undefined"]`——那会把一次正常的
  降级伪装成一次失败的点击。
- **点第三方入口用页面内 `.click()`，不是可信点击。** 活体 2026-09-01：`cdp_act` 的 trusted
  click 对 `console.groq.com` 的 `#oauth-google` 连点两次都没生效（报 done、`elementFromPoint`
  也命中了按钮自己的 span，但 handler 一次都没跑），页面内 `.click()` 一次就成。

**Google 之外的提供方**（GitHub 等）不需要改 provider——`oauthButton` 本来就每站各写；
但选择器要**活体量**，别猜。

---

## 2. cookie 注入还剩哪两处（别再往浏览器档上套）

**采集浏览器不注入任何 cookie。** 这不是"暂时没做"，是没有必要——它带着用户的真实登录（`transport.ts`
的注释就是这么写的：注入是 CloakBrowser 为"一个用户从没登录过的浏览器"交的税）。**采集不出数，别往
cookie 这条线查**（→ `failure-atlas.md` §1.4 开头那段）。

还活着的两处：

- **HTTP 档**（`http-fetch.ts`）——服务端裸 fetch，broker cookie 由 `cookieDomain` **门控**：
  `hostMatchesDomain` 不过就直接抛。这是**绑定，不是装饰**——一份 recipe 不能拿 A 域的凭据去打 B 域。
- **作者 capture**——`injectCookies`（`browser.ts`），只在"我要抓一个这个浏览器没登录的会话"时才用。

### 2.1 带点域名不是细节 —— 无点 = 登录态到不了页面

注入的 cookie domain **必须带前导点**。无点 = **host-only cookie**:Chromium 只发给 apex 本身,
**不发给站点真正运行的子域**(`pan.quark.cn`/`www.xiaohongshu.com`)。症状是**页面全程游客而毫无报错**——
`cookieDomain: 'quark.cn'` 注入后,drive 接口回 `401 require login [guest]`,但 jar 看着填得好好的。

`parseCookieHeader`(`src/replay/cookies.ts`)**在源头统一补点**(幂等,已带点不重复补),所以
`cookieDomain` 声明成 apex(`quark.cn`)也对。历史上这条不变量**只活在调用方**,于是任何新写的注入路径
都会静默退化成 host-only。**教训:不变量只写在文档里而没被代码强制,迟早被绕过。**(2026-07-17 `6f7e159` 修。)

### 2.2 判"登录态到底成没成"——别信渲染,也别信 jar 读回

**探针只有一个可信:在真浏览器、目标同源页面里 in-page fetch 站点自己的接口,看返回。**
夸克: `drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=0` + `credentials:'include'`
→ 游客 `401 code 31001 require login [guest]`;登录 `200 code 0` + 真实文件列表。
(只认 cookie、不碰签名 → 红线安全;AList 同法。)

两个**会骗你**的判据,都实测栽过:

- ❌ **Playwright 的 `context.cookies(url)`**——它**不模拟 host-only 作用域**,把 host-only cookie
  报告成"对子域可见"(`ctx.cookies('https://pan.quark.cn')` 返回全部 25 个、`__puus` 赫然在列),
  而页面里 `document.cookie` **一个登录 cookie 都没有**。这个假读数骗掉整整一轮诊断,
  一度让人误判成"该站会话短命、cookie 注入不适用、得改扫码"。**要看就看 `document.cookie`。**
- ❌ **页面渲染**——SPA 会因别的原因跳转/降级(带着有效 cookie 打开 `pan.quark.cn/list` 也可能被弹回
  落地页),"看着像没登录"不等于没登录。

**归因纪律**:有反例在(同样的 cookie 在 AList / 用户自己 Chrome 能用),就**不该归因于"凭据本身不行"**,
先怀疑自己的注入。这条判断被用户以 AList 反例纠正过一次——反例胜过推理。

---

## 3. 还要判的那个问题:**这份登录能不能离开这个浏览器?**

平台把登录和"设备"绑定有两种做法:

- **只把设备指纹写进 cookie,请求时只读 cookie**(抖音:`s_v_web_id`)→ cookie 里有它就认,**不管
  发请求的是谁** → 这份会话**搬得走**。
- **每次请求实时读当前浏览器的 canvas/webgl/字体,和登录时算进 cookie 的那份对**(小红书:`a1` +
  Canvas+WebGL+字体多维)→ 换个执行环境用同一份 cookie **必被踢** → 这份会话**搬不走**。

**这条判据决定的是**成本阶梯能不能停在第 2 级：

| 会话搬得走吗 | 结论 |
|---|---|
| 搬得走（只读 cookie） | 服务端拿 broker cookie 重放可行 → 试试**第 2 级 / HTTP 档**，比浏览器便宜一个数量级 |
| 搬不走（实时校验指纹） | 只能留在**浏览器档**，在**用户自己那个**浏览器里跑——那里的指纹天然自洽，因为它本来就是那台机器 |

两个已验证的锚定案例：

- **抖音 = 会话搬得走。** 搜索端点有风控（HTTP 直连返 `status_code 2483 请先登录`），但它**不实时校验
  canvas**，只读 cookie 里的 `s_v_web_id`——所以 broker cookie 在别处也认。（它今天走的是浏览器档，
  因为搜索还要页面自己算 `a_bogus`；"能搬走"说的是登录态，不是签名。）
- **小红书 = 会话搬不走。** 实时读 Canvas+WebGL+字体多维,一份在别处登录时算出的 `a1` 对不上当前
  浏览器 → 拿它去别处必被踢。**所以 xhs 只能跑在用户自己的浏览器里**——不是因为我们伪装不好，
  是因为**不需要伪装**：那台机器就是登录时的那台机器。

---

## 4. 红线(与 [[project_legal_red_line_no_signature_forgery]] 一致)

- **红线内(不做)**:逆向平台的签名/防伪算法自己生成令牌(webmssdk 的 a_bogus、xhs 的 x-s);
  伪造/复刻**某台具体真机**的指纹去骗过实时校验。这是主动破解平台风控。
- **没有中间地带**:Stream 没有自己的浏览器可配身份(锁 seed、装字体、设 UA 这类操作**无处可做**)。
  我们只**驱动**用户的 Chrome，不改它的身份。
- 判据不变:**能靠"页面自己在真浏览器里算"就合法(自动化用户自己的浏览);要靠"抠出算法自己伪造"就是红线。**
  抖音 a_bogus 由页面自己算 → 合法;若去逆向 webmssdk 自算 → 红线。

---

## 5. 一句话决策

接一个**登录态**的 source 时，只问这两件事（不用问"登录怎么进来"——它在用户的浏览器里）：

1. **站外拿 broker cookie 重放得动吗？** 动得了 → 停在第 2 级（HTTP 档，`cookieDomain` 绑定）。
   动不了（实时校验指纹 / 风控）→ 浏览器档，在用户自己的 Chrome 里跑。
2. **掉线了要不要 Stream 出面？** 要（单会话站、用户不会自己发现）→ 看这个站怎么登：自家账号
   体系、扫码进 → `login: qr`，扫码面板扫在采集那条 lane 上；登录就是点一下"用 Google 继续"
   → `login: oauth`（§1.2），骑浏览器里已有的第三方登录态。用户自己重登就够 → `login: cookie`
   或干脆不声明。
