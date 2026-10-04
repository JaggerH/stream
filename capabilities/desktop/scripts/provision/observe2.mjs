// 逐个 attach 到扩展的 service worker，问它自己是谁。
// 为什么不靠 target url 里那串 id 直接认领：headless 里同时跑着若干 component 扩展，
// 它们的 background 也叫 background.js——单看 URL 分不出哪个是我们的。
// 让每个 SW 自报 chrome.runtime.id + manifest.name，是唯一不靠猜的判法。
const port = process.argv[2] || '9222';
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const sws = list.filter((t) => t.type === 'service_worker');

for (const t of sws) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const answer = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 10000);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression:
              'JSON.stringify({id: chrome.runtime.id, name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version})',
            awaitPromise: true,
            returnByValue: true,
          },
        }),
      );
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) {
        clearTimeout(timer);
        resolve(msg.result?.result?.value ?? JSON.stringify(msg));
      }
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(e); };
  }).catch((e) => 'ERR ' + e.message);
  ws.close();
  console.log(`${t.url}\n  -> ${answer}`);
}
