#!/usr/bin/env node
/**
 * Fixture server for the browser-driver comparison bench.
 *
 * Everything is served from disk or rendered here — no external hosts, no
 * fonts, no CDNs — so the bench runs offline and always sees the same bytes.
 * Pages are shaped like the ones the shipped browser recipes target:
 * SSR result lists, a progressively rendered feed, a form, a consent overlay,
 * a list that re-renders itself, and a page of element states.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, 'fixtures', name)

const RESULT = (i) => ({
  title: `Result ${i} — a distinctive title about topic ${i}`,
  href: `/doc/${i}`,
  snippet: `Snippet ${i}: a two sentence summary that mentions topic ${i} and a few extra words so the payload is realistic.`,
})

function searchPage(q) {
  const rows = Array.from({ length: 10 }, (_, k) => RESULT(k + 1))
  const html = rows
    .map(
      (r) => `<div class="card"><h3><a href="${r.href}">${r.title}</a></h3><p data-sncf>${r.snippet}</p></div>`,
    )
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${q} - fixture search</title></head>
<body>
<form id="sf" action="/search"><input id="q" name="q" placeholder="Search" value="${q.replace(/[<>&"]/g, '')}"><button id="go" type="submit">Search</button></form>
<div id="rso">${q ? html : '<p id="empty">Type a query.</p>'}</div>
</body></html>`
}

// Card identity is a 16-hex id in the href, the shape the feed recipes key on
// (src/replay/card-id.ts). data-id stays a small number for readable selectors.
const hexId = (i) => i.toString(16).padStart(16, '0')

function feedPage() {
  const card = (i) =>
    `<a class="card" href="/explore/${hexId(i)}" data-id="${i}"><span class="t">Note ${i}</span><span class="s">by author ${i}</span></a>`
  const first = Array.from({ length: 20 }, (_, i) => card(i + 1)).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>fixture feed</title>
<style>.card{display:block;height:44px;line-height:44px;border-bottom:1px solid #ddd}</style></head>
<body><div id="feed">${first}</div>
<script>
  // Progressive render, like a real infinite feed: more cards land after paint.
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
  <button id="send" type="button">Send</button>
</form>
<div id="ok" hidden>Thanks, your message was sent.</div>
<script>
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
  // Same content, brand new nodes: the classic ref-invalidating update.
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (type, body) => {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  }
  try {
    if (url.pathname === '/search') return send('text/html; charset=utf-8', searchPage(url.searchParams.get('q') ?? ''))
    if (url.pathname === '/feed') return send('text/html; charset=utf-8', feedPage())
    if (url.pathname === '/form') return send('text/html; charset=utf-8', formPage)
    if (url.pathname === '/overlay') return send('text/html; charset=utf-8', overlayPage)
    if (url.pathname === '/churn') return send('text/html; charset=utf-8', churnPage)
    if (url.pathname === '/states') return send('text/html; charset=utf-8', statesPage)
    if (url.pathname === '/doc' || url.pathname === '/note' || url.pathname === '/explore' || url.pathname === '/') {
      return send('text/html; charset=utf-8', `<!doctype html><title>${url.pathname}</title><h1>${url.pathname}</h1>`)
    }
    const name = url.pathname.replace(/^\//, '')
    if (/^[a-z0-9-]+\.(html|css|js)$/.test(name)) return send('text/html; charset=utf-8', await readFile(fixture(name), 'utf8'))
    res.writeHead(404).end('not found')
  } catch {
    res.writeHead(500).end('fixture error')
  }
})

server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  const { port } = server.address()
  console.log(JSON.stringify({ port }))
})

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)))
