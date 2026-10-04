// 「浏览器这只手」与后端/插件握手时逐字节比对的 wire 常量——两侧唯一真相源。
// 过去后端（ext-relay.ts / ext-verify.ts）与扩展（ext-cdp.ts / backend-identity.ts）各抄一份，
// 靠「必须逐字节一致」的注释维系；收进这里后，两侧一律 import，漂移无从发生。

/** WS 子协议名。客户端 offer [RELAY_PROTOCOL, token]，服务端只回选协议名——token 不回显。 */
export const RELAY_PROTOCOL = 'browser-relay.v1'

/** 挑战应答的 HMAC 域分隔前缀：proof = HMAC-SHA256(token, VERIFY_PREFIX + nonce)。
 *  前缀是域分隔不是装饰：同一把 key 将来若被拿去签别的东西，没有前缀就可能让一处的合法
 *  应答变成另一处的有效凭证。 */
export const VERIFY_PREFIX = 'stream-browser-verify:'
