/**
 * Stream Companion 扩展的固定 id（wxt.config manifest.key 公钥派生，见 extension/wxt.config.ts）。
 *
 * **唯一真相源**：这个值同时是 `/api/ext/verify` / `/api/ext/cookies` 的 Origin 门控依据，
 * 也是 host-agent `--register` 写进 native messaging manifest 的 `allowed_origins`——那是
 * Chrome 认这条链路的唯一准入闸门。别在别处再抄一份：抄两份意味着某天两边漂了，症状是
 * 「扩展握手正常、native messaging 却不认它」或反过来，而且没有任何一处会报错。
 *
 * 单独成一个模块（不放在 `serve.ts` 里）是因为 `bootstrap.ts` 也要用它（起对话工作台时把它
 * 传给桌面控制插件去 `--register`），而 `serve.ts` 本身 import 了 `bootstrap.ts`——放在
 * `serve.ts` 里会造成循环 import。
 */
export const STREAM_EXTENSION_ID = 'dmhlfkdjljnilhnfajjpaobehenbokij'
