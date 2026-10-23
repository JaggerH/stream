/**
 * 认领页：读 `#n=<nonce>`，交给 SW（它经全部已连绑定交回 Stream，见 lib/claim.ts），显示结果。
 *
 * 页面本身什么都不判：它只是证明「这个 profile 里的这个扩展实例打开了这串 URL」。认领成功后 profile 由 SW
 * 记进存储，这张标签留给用户自己关——自动关掉的话，用户连「认出来的是哪个」都来不及看。
 */
import { parseClaimHash } from './hash.ts'

const box = document.getElementById('box')!
const status = document.getElementById('status')!
const detail = document.getElementById('detail')!

function show(kind: 'ok' | 'err', title: string, text: string): void {
  box.className = kind
  status.textContent = title
  detail.textContent = text
}

const nonce = parseClaimHash(location.hash)
if (!nonce) {
  show('err', '这个链接不完整', '认领页要由 Stream 打开（面板上的「识别 profile」）。')
} else {
  chrome.runtime
    .sendMessage({ type: 'claim', nonce })
    .then((r: { ok: boolean; profileDir?: string; profileName?: string; error?: string } | undefined) => {
      if (r?.ok) show('ok', `已识别：${r.profileName}（${r.profileDir}）`, '可以关掉这个标签了。')
      else show('err', '没能识别', r?.error ?? '扩展没有回应')
    })
    .catch((e: unknown) => show('err', '没能识别', e instanceof Error ? e.message : String(e)))
}
