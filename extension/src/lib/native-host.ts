/**
 * 与 `stream-desktop` 的 native messaging 通道 —— **扩展认识后端身份的唯一来路**。
 *
 * 为什么不是「问后端要」：那正是被换掉的东西。以前扩展 `POST /api/ext/token` 向对端索取
 * 握手 secret，对端返回什么就用什么——本机任何进程抢到 `127.0.0.1:8900` 就拿到了这条通道的
 * 全部能力（任意页面 `Runtime.evaluate`，也就是用户的全部登录态）。
 *
 * 修法抄 Claude Code 的 IDE 集成对 CVE-2025-52882 的那一版：**带外通道走文件系统**——
 * `data/ext-relay-token` 只有同一个用户读得到。扩展读不了文件，但**能拉起一个本机可执行
 * 文件**，而那个文件是我们自己的（清单里 `allowed_origins` 钉死本扩展 id，清单本身写在
 * 操作系统指定的位置）。冒充者要伪造它得先能改你的注册表/配置目录——到那一步它直接读
 * `data/cookies.json` 更省事，绕这条路没有收益。**门槛从「抢一个端口」抬到「改你的机器」。**
 *
 * Chrome 自己负责 wire 上的 4 字节长度前缀，这里收发的就是 JSON 对象本身。
 */

/** 与 `--register` 写进清单的名字一致（`app/host-agent/src/register.rs` 的默认值）。
 *
 *  **这个 id 和 Rust 侧那份必须一起改**：它被写进每一台配对过的机器上的浏览器 native
 *  messaging 清单与注册表。两侧不同步时扩展再也找不到那个 host——拿不到 relay token、
 *  一个候选都不问、而且**不报错**，症状是"扩展装着但全站游客态"。改了就得让每台机器
 *  重新 `--register` 一次。 */
export const NATIVE_HOST_NAME = 'com.stream.desktop'

/** host 的应答形状（`app/host-agent/src/nativemsg.rs`）。失败也是一条正常应答，不是异常。 */
export type HostReply =
  | { ok: true; token?: string; version?: string; source?: string }
  | { ok: false; error?: string }

export class NativeHostUnavailable extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'NativeHostUnavailable'
  }
}

/**
 * 从 host 取 ext-relay token。
 *
 * **绝不回退到向后端索取**。回退等于把这道锁变成装饰：冒充者只要让 native 那条路失败
 * （它根本不需要做什么——没注册就是失败），扩展就会乖乖回去问它要 token。所以这里只有
 * 两种结局：拿到 token，或者抛 `NativeHostUnavailable` 让上层停在原地并说清楚原因。
 */
export async function nativeHostToken(): Promise<string> {
  const reply = await send({ op: 'token' })
  if (!reply.ok) throw new NativeHostUnavailable(reply.error ?? 'native host refused')
  if (!reply.token) throw new NativeHostUnavailable('native host returned no token')
  return reply.token
}

/** host 在不在（popup 的配对状态用）。不抛，只回结论 + 人能读懂的原因。 */
export async function nativeHostStatus(): Promise<{ paired: boolean; reason?: string }> {
  try {
    await nativeHostToken()
    return { paired: true }
  } catch (e) {
    return { paired: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 一次 native messaging 往返。`sendNativeMessage` 的失败走 `chrome.runtime.lastError`
 * 而不是异常（清单没装、host 起不来、host 崩了都在这里），所以必须显式读它——不读的话
 * 表现是 `response` 为 undefined 而错误信息静静丢掉，最难查的那种。
 */
function send(message: Record<string, unknown>): Promise<HostReply> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, (response?: HostReply) => {
        const err = chrome.runtime.lastError
        if (err) {
          reject(new NativeHostUnavailable(`${NATIVE_HOST_NAME}: ${err.message ?? 'unknown error'}`))
          return
        }
        if (!response || typeof response !== 'object') {
          reject(new NativeHostUnavailable(`${NATIVE_HOST_NAME}: empty reply`))
          return
        }
        resolve(response)
      })
    } catch (e) {
      // 没有 nativeMessaging 权限之类的同步抛错
      reject(new NativeHostUnavailable(`${NATIVE_HOST_NAME}: ${e instanceof Error ? e.message : String(e)}`))
    }
  })
}
