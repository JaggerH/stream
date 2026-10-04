import { defineConfig } from 'tsdown'

/**
 * **必须逐字等于 `package.json` 的 `name`**：DSH 宿主按包名建条目、按包名认领注册
 * （`window.__ModuleLoader__.load({ id })`），对不上的症状是
 * `bundle ... loaded without registering "<name>"`（响亮，整页起不来）。
 * 这条由 `test/contract.test.ts` 钉着。
 */
const PACKAGE_ID = '@streamapp/dsh-plugin-stream-ui'

/**
 * DSH 的浏览器插件不是普通 ESM：宿主页面用一个自带的模块装载器把每个客户端包注册进去，
 * 形状是 `window.__ModuleLoader__.load({ id, factory: (require) => { …; return module.exports } })`
 * ——依赖经 factory 的 `require` 参数取（react / react-jsx-runtime / @deepseek-ai/*），
 * 而不是 import 语句。这份 banner/footer 就是那个信封；产物里的 CJS body 由 rolldown 生成。
 *
 * 抄自 `@deepseek-ai/dsh-client-ui-aqua` / `-ui-skill` 已发布的 `lib/client.js`（逐字比对过
 * 头尾），因为它们用的是 DSH monorepo 私有的 `tsdown.client.ts` 帮手，外部包拿不到。
 */
const CLIENT_BANNER = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(PACKAGE_ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;`

const CLIENT_FOOTER = `		return module.exports;
	}
});`

/** 客户端产物里**绝不能**打进去的东西：宿主已经有一份，重复一份 react 会当场崩。 */
const CLIENT_EXTERNAL = [/^react($|\/)/, /^@deepseek-ai\//]

export default defineConfig([
  {
    // host 半边：普通 ESM，宿主用 node import 装载。
    entry: ['src/index.ts'],
    format: 'esm',
    outDir: 'lib',
    dts: true,
    // 两份配置并行跑，共用一个 outDir：谁开 clean 谁就可能在对方写完之后把它删掉
    // （产物文件名是固定的四个，本来也不需要清）。
    clean: false,
    external: CLIENT_EXTERNAL,
  },
  {
    // 浏览器半边：CJS body 包进 ModuleLoader 信封。
    entry: { client: 'src/client/index.tsx' },
    format: 'cjs',
    outDir: 'lib',
    dts: true,
    clean: false,
    external: CLIENT_EXTERNAL,
    // cjs 档默认把 `dependencies` 自动 external——普通 npm 依赖会落成裸 `require("…")`,
    // 而宿主 ModuleLoader 的 require 只认 react / `@deepseek-ai/*`,解析不了就当场抛、
    // 整个插件注册失败。非宿主依赖一律打进产物。这条由 `test/client-bundle.build.test.ts` 钉着。
    noExternal: ['schemastery'],
    outputOptions: {
      // 只包 JS 那一份：`.d.ts` 也走同一条输出管线，套上信封会被 dts 插件当语法错误。
      banner: (chunk) => (chunk.fileName.endsWith('.js') ? CLIENT_BANNER : ''),
      footer: (chunk) => (chunk.fileName.endsWith('.js') ? CLIENT_FOOTER : ''),
      entryFileNames: '[name].js',
    },
  },
])
