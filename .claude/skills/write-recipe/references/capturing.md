# 抓包：找出页面自己在跟哪个接口要数据

**这一节是「抓包」的唯一说法**，两种形态都在这儿（`observing.md`、`authoring-loop.md`、
`authoring.md`、`onboard-source` 都指回这里）。

写 recipe 的本质是：**把页面自己发的那一个请求，之后由我们照样再发一遍**。所以动笔之前必须
拿到三样东西，而这三样只能当场看，猜不出来：

1. **数据到底从哪个 URL 来** —— 常常不在你猜的那个域名上。实测（HN）：地址栏是
   `hn.algolia.com`，真正拿数据的是 `UJ5WYC0L7X-1.algolianet.com/1/indexes/Item_dev/query`。
2. **请求长什么样** —— method、参数、翻页那一格叫什么、POST body 里有什么。
3. **回包长什么样** —— 条目挂在哪个 dot-path、字段叫什么。**必须照真实回包抄**，凭记忆猜
   dot-path 是这条线上最常见的返工。

**别 bare-curl 一个带签名 / 过 WAF 的 XHR** —— 回来的是验证页，不是 JSON。抓包必须在真浏览器里。

---

## 形态 A：只装了 npm 包（走 MCP 的 `cdp_*`）

不需要任何仓库脚本，全程在**用户自己那个 Chrome** 里。三步，实测于 2026-09-05（HN + Algolia）。

### A1. 开页面 + 装拦截器 —— **必须是同一次调用**

```js
cdp_look({ target:'chrome', url:'https://hn.algolia.com/', interactive:true, js: `(() => {
  window.__cap = [];
  const of = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const res = await of.apply(this, arguments);
    try { window.__cap.push({ via:'fetch', method:(init&&init.method)||'GET', url,
      headers:(init&&init.headers)||null, body:init&&init.body?String(init.body):null,
      status:res.status, text: await res.clone().text() }); } catch (e) {}
    return res;
  };
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send,
        oh = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m,u){ this.__m=m; this.__u=u; this.__h={}; return oo.apply(this,arguments) };
  XMLHttpRequest.prototype.setRequestHeader = function (k,v){ (this.__h||(this.__h={}))[k]=v; return oh.apply(this,arguments) };
  XMLHttpRequest.prototype.send = function (b) {
    this.addEventListener('load', () => window.__cap.push({ via:'xhr', method:this.__m, url:this.__u,
      headers:this.__h, body:b?String(b):null, status:this.status, text:this.responseText }));
    return os.apply(this,arguments);
  };
  return { installed: true };
})()` })
// → { value:{installed:true}, target:'chrome:<tabId>', kept:true }
```

**为什么必须同一次调用**：`cdp_look` 的 eval 发生在导航之后。分两次调（先开、再装）中间那段
时间里页面已经把请求发完了，你装了个只能等下一次的拦截器。

**`interactive:true` 不是可选的**：默认档读完就把 tab 关了，而后面两步都要这个 tab 还在。
回执里的 `target` 就是接下来用的地址。

### A2. 让页面自己去发那个请求（可信输入）

```js
cdp_act({ target:'chrome:<tabId>', kind:'type', domain:'hn.algolia.com',
          selector:'input[type="search"]', text:'anthropic' })
```

搜索、翻页、点开详情——**哪个动作会让它去取数据就做哪个**。用 `cdp_act` 而不是页面内合成
事件：合成的 `.click()` 拿不到 user-activation，很多站的这一步会不响应（见 SKILL.md 的坑表）。

### A3. 读出来

```js
cdp_look({ target:'chrome:<tabId>', js: `(async () => {
  await new Promise(r => setTimeout(r, 2500));
  return (window.__cap||[]).map(c => ({ via:c.via, method:c.method, url:c.url.slice(0,140),
    status:c.status, body:c.body?c.body.slice(0,300):null, head:(c.text||'').slice(0,200),
    len:(c.text||'').length }));
})()` })
```

按 **`len` 排序，最大的那条通常就是数据**。实测那一条：

```
POST 200 https://UJ5WYC0L7X-1.algolianet.com/1/indexes/Item_dev/query?x-algolia-agent=…
body {"query":"anthropic","analyticsTags":["web"],"page":0,"hitsPerPage":30,…}
text {"hits":[{"title":"Anthropic acquires Bun","url":"…","author":"…","points":2192,…
```

一次就把三样都拿到了：**URL**、**请求 body**（`"page":0` 直接告诉你翻页那一格叫 `page`、
从 0 起）、**回包结构**（`hits[].title/url/author/points`）。

### A4.（可选但推荐）页面内重放一次，验翻页那一格

写进 recipe 之前，把抓到的请求原样再发一次、只改翻页那一格——**这一步能在写代码之前就否掉
一个猜错的 `pagination`**：

```js
cdp_look({ target:'chrome:<tabId>', js: `(async () => {
  const c = (window.__cap||[]).filter(x => /indexes/.test(x.url)).slice(-1)[0];
  const body = JSON.parse(c.body); body.page = 1;
  const r = await fetch(c.url, { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'},
                                 body: JSON.stringify(body) });
  const j = await r.json();
  return { status:r.status, page:j.page, nbPages:j.nbPages, hits:(j.hits||[]).length };
})()` })
// 实测 → { status:200, page:1, nbPages:34, hits:30 }   ← pagination 猜对了
```

**坑：跨域重放别加 `credentials:'include'`。** 实测加了就是 `TypeError: Failed to fetch`——
跨域带凭据要求对端回 `Access-Control-Allow-Credentials` 且 origin 不能是通配，多数数据接口
不满足。同源才需要它；这类"页面 → 另一个域"的数据接口一律不要加。看起来像接口挂了，其实是
自己加的那一格。

### A5. 首屏加载时就发完了的那种

A1 装拦截器时它已经飞过去了，`__cap` 是空的。两条：

- **先看 URL**：`performance.getEntriesByType('resource')` 列得出所有请求（`initiatorType` 是
  `fetch`/`xmlhttprequest` 的那些），**但没有 body**。`transferSize` 最大的那条通常就是数据。
  是 GET 的话到这儿其实已经够了——URL 就是全部。
- **再让它重发一次**：装完拦截器后用 SPA 内部的交互（换关键词、切 tab、点翻页）触发同一个
  接口，就回到 A2。**别用 `cdp_act kind:'goto'` 或刷新**——页面一重载，`window.__cap` 和你
  装的那个拦截器一起没了。

### 两个会让你以为"工具坏了"的现场

- **`refuse to attach tab <id>: not in the session tab group`** —— 那个 tab 不在 Stream 的会话
  标签组里（用户自己拖出去了，或它本来就是用户自己开的）。不是权限故障：重新用
  `cdp_look({target:'chrome', url, interactive:true})` 开一个，或把它拖回组里。
- **`__cap` 一直是空的** —— 十有八九是 A1 分成了两次调用，或者中间刷新过页面。先确认
  `window.__cap` 还在（`cdp_look` 读一下 `typeof window.__cap`），再确认 A2 那个动作真的
  触发了取数（`cdp_act` 回的是 `status:'done'` 还是 `'not-found'`）。

---

## 形态 B：有 Stream 源码检出（仓库脚本）

脚本更省事的地方只有一处：**把完整回包落盘**（控制台预览截断在 400 字符，嵌套对象看不全）。
它连的是**你自己另起的**那个带调试端口的 Chrome，不是用户日常那个。

```bash
chrome --user-data-dir=/tmp/stream-chrome --remote-debugging-port=9333 &
pnpm exec tsx scripts/recipe-capture.ts "<entryUrl>"                 # 列出每一个 JSON XHR
pnpm exec tsx scripts/recipe-capture.ts "<entryUrl>" "<urlSubstr>"   # 完整 body → data/capture-dump.json
```

- `SETTLE_MS`（默认 3000）：慢 SPA 的数据 XHR 发得晚，加大它。
- `WARM_URL`：有的站把深链拦在"先访问过首页拿到反爬 cookie"之后（douyin），先热一下源。
- `SHOT=<path>`：settle 之后截一张图——**一条 XHR 都没抓到时，页面本身就是答案**（登录墙？
  验证页？），不截图就得靠猜，一轮一轮地烧。
- `COOKIE_HEADER` + `COOKIE_DOMAIN`：要抓一个"这个浏览器没登录"的会话时才用。

DOM 那条支线（`kind:'dom'` observer）对应的是 `scripts/recipe-dom-capture.ts`，同样只有形态 B
有；形态 A 里用 `cdp_look({inventory:true})` 认元素、自己落一个稳定选择器（见 `drive-live-ui`）。
