/**
 * 本地 fixture 站：可操作性检查的集成测试用。全部页面离线渲染，没有外部字体 / CDN / 请求。
 *
 * 页面形状是按真实站点上栽过的四种假成功裁的：覆盖层挡住按钮、禁用 / 隐藏 / 全透明的按钮、
 * 视口外的元素、以及会把自己的节点整批换掉的列表。表单那页另有一个把输入值改写的字段，
 * 用来验证写入后的回读。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const RESULT = (i: number) => ({
  title: `Result ${i} — a distinctive title about topic ${i}`,
  href: `/doc/${i}`,
  snippet: `Snippet ${i}: a two sentence summary that mentions topic ${i} and a few extra words so the payload is realistic.`,
})

function searchPage(q: string): string {
  const rows = Array.from({ length: 10 }, (_, k) => RESULT(k + 1))
    .map((r) => `<div class="card"><h3><a href="${r.href}">${r.title}</a></h3><p data-sncf>${r.snippet}</p></div>`)
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${q} - fixture search</title></head>
<body>
<form id="sf" action="/search"><input id="q" name="q" placeholder="Search" value="${q.replace(/[<>&"]/g, '')}"><button id="go" type="submit">Search</button></form>
<div id="rso">${q ? rows : '<p id="empty">Type a query.</p>'}</div>
</body></html>`
}

const hexId = (i: number) => i.toString(16).padStart(16, '0')

function feedPage(): string {
  const card = (i: number) =>
    `<a class="card" href="/explore/${hexId(i)}" data-id="${i}"><span class="t">Note ${i}</span><span class="s">by author ${i}</span></a>`
  const first = Array.from({ length: 20 }, (_, i) => card(i + 1)).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>fixture feed</title>
<style>.card{display:block;height:44px;line-height:44px;border-bottom:1px solid #ddd}</style></head>
<body><div id="feed">${first}</div>
<script>
  setTimeout(() => {
    const feed = document.getElementById('feed');
    for (let i = 21; i <= 30; i++) {
      const a = document.createElement('a');
      a.className = 'card'; a.href = '/explore/' + i.toString(16).padStart(16, '0'); a.dataset.id = String(i);
      a.innerHTML = '<span class="t">Note ' + i + '</span><span class="s">by author ' + i + '</span>';
      feed.appendChild(a);
    }
  }, 1500);
</script></body></html>`
}

const formPage = `<!doctype html><html><head><meta charset="utf-8"><title>fixture form</title></head>
<body>
<form id="f">
  <label for="name">Name</label><input id="name" name="name">
  <label for="email">Email</label><input id="email" name="email" type="email">
  <label for="msg">Message</label><textarea id="msg" name="msg"></textarea>
  <label for="upper">Code</label><input id="upper" name="upper">
  <button id="send" type="button">Send</button>
</form>
<div id="ok" hidden>Thanks, your message was sent.</div>
<script>
  document.getElementById('upper').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
  document.getElementById('send').addEventListener('click', () => {
    const filled = ['name','email','msg'].every((id) => document.getElementById(id).value.trim() !== '');
    document.getElementById('ok').hidden = !filled;
    if (filled) document.getElementById('ok').textContent = 'Thanks ' + document.getElementById('name').value + ', your message was sent.';
  });
</script></body></html>`

const overlayPage = `<!doctype html><html><head><meta charset="utf-8"><title>fixture overlay</title></head>
<body>
<div class="card"><h3><a href="/doc/1">Result 1</a></h3><p>body text</p></div>
<button id="next">Next page</button>
<div id="consent-banner" style="position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:10">
  <div style="position:absolute;left:0;top:0;width:100%;height:120px;background:#fff">
    We use cookies. <button id="accept">Accept</button>
  </div>
</div>
<script>
  document.getElementById('accept').addEventListener('click', () => document.getElementById('consent-banner').remove());
  document.getElementById('next').addEventListener('click', () => { document.title = 'page 2'; });
</script></body></html>`

const churnPage = `<!doctype html><html><head><meta charset="utf-8"><title>fixture churn</title></head>
<body>
<div id="list">${Array.from({ length: 8 }, (_, i) => `<button class="row" data-id="${i + 1}">Row ${i + 1}</button>`).join('')}</div>
<div id="clicked"></div>
<script>
  setTimeout(() => {
    const list = document.getElementById('list');
    const rows = [...list.children].map((el) => el.cloneNode(true));
    list.replaceChildren(...rows);
    rows.forEach((el) => el.addEventListener('click', () => {
      document.getElementById('clicked').textContent = 'clicked ' + el.dataset.id;
    }));
  }, 800);
  document.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (row) document.getElementById('clicked').textContent = 'clicked ' + row.dataset.id;
  });
</script></body></html>`

const statesPage = `<!doctype html><html><head><meta charset="utf-8"><title>fixture states</title></head>
<body>
<button id="ok">Enabled</button>
<button id="off" disabled>Disabled</button>
<button id="ghost" style="display:none">Hidden</button>
<button id="faded" style="opacity:0">Invisible</button>
<div id="log"></div>
<script>
  for (const id of ['ok','off','ghost','faded']) {
    document.getElementById(id).addEventListener('click', () => { document.getElementById('log').textContent = 'clicked ' + id; });
  }
</script></body></html>`

const scrollPage = `<!doctype html><html><head><meta charset="utf-8"><title>fixture scroll</title>
<style>body{margin:0} .spacer{height:3000px;background:linear-gradient(#fff,#eee)}</style></head>
<body>
<div class="spacer"></div>
<button id="deep" style="display:block;margin:40px auto">Deep button</button>
<div id="log"></div>
<script>
  document.getElementById('deep').addEventListener('click', () => { document.getElementById('log').textContent = 'deep'; });
</script></body></html>`

const offscreenPage = `<!doctype html><html><head><meta charset="utf-8"><title>fixture offscreen</title></head>
<body>
<button id="fixed-out" style="position:fixed;left:-9999px;top:20px">Offscreen</button>
<button id="in-flow">In flow</button>
<div id="log"></div>
<script>
  for (const id of ['fixed-out','in-flow']) document.getElementById(id).addEventListener('click', () => { document.getElementById('log').textContent = id; });
</script></body></html>`

const vanishPage = `<!doctype html><html><head><meta charset="utf-8"><title>fixture vanish</title></head>
<body>
<div id="wrap"><button id="vanish">Vanish</button></div>
<div id="log"></div>
<script>
  // 按下即把目标搬走：鼠标松开时原节点已经不在文档里，页面不会得到一次 click。
  document.getElementById('vanish').addEventListener('mousedown', (e) => { e.target.parentNode.remove(); });
  window.__before = 'ready';
</script></body></html>`

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
}

export interface ActionabilitySite {
  base: string
  close(): Promise<void>
}

export async function startActionabilitySite(): Promise<ActionabilitySite> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const send = (type: string, body: string) => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }
    switch (url.pathname) {
      case '/search':
        return send('text/html; charset=utf-8', searchPage(url.searchParams.get('q') ?? ''))
      case '/feed':
        return send('text/html; charset=utf-8', feedPage())
      case '/form':
        return send('text/html; charset=utf-8', formPage)
      case '/overlay':
        return send('text/html; charset=utf-8', overlayPage)
      case '/churn':
        return send('text/html; charset=utf-8', churnPage)
      case '/states':
        return send('text/html; charset=utf-8', statesPage)
      case '/scroll':
        return send('text/html; charset=utf-8', scrollPage)
      case '/offscreen':
        return send('text/html; charset=utf-8', offscreenPage)
      case '/vanish':
        return send('text/html; charset=utf-8', vanishPage)
      default:
        return send('text/html; charset=utf-8', page(url.pathname, `<h1>${url.pathname}</h1>`))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
