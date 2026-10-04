/**
 * html 小工具的本体住 `shared/package-sdk/html.ts`（包里的 normalizer 与宿主同吃一份）；
 * 这里 re-export 给宿主既有 import 点。
 */
export { extractImages, extractLinks, firstLink, toText, stripImages } from '../../shared/package-sdk/html.ts'
