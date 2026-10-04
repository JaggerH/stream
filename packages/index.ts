/**
 * 内置包代码入口的静态表。**字面量 import**——这样 esbuild 能把它们打进发行 bundle、
 * tsc 也全覆盖（第三方包走的是另一条：运行时动态 import 它自带的预打包 JS，P4 才开）。
 * 加一个带 code 槽位的内置包 = 这里加一行。
 */
import type { ActivateFn } from '../src/packages/activate.ts'
import { activate as pansou } from './pansou/activate.ts'
import { activate as douyinTiktokDownloadApi } from './Douyin_TikTok_Download_API/activate.ts'
import { activate as alist } from './alist/activate.ts'
import { activate as eastmoney } from './eastmoney/activate.ts'
import { activate as netease } from './netease/activate.ts'
import { activate as bilibili } from './bilibili/activate.ts'
import { activate as xhs } from './xhs/activate.ts'
import { activate as xueqiu } from './xueqiu/activate.ts'
import { activate as telegram } from './telegram/activate.ts'
import { activate as firecrawl } from './firecrawl/activate.ts'
import { activate as hackernews } from './hackernews/activate.ts'
import { activate as v2ex } from './v2ex/activate.ts'
import { activate as rsshub } from './rsshub/activate.ts'
import { activate as cloudflare } from './cloudflare/activate.ts'
import { activate as xunlei } from './xunlei/activate.ts'
import { activate as shooter } from './shooter/activate.ts'
import { activate as omdb } from './omdb/activate.ts'

export const BUILTIN_ACTIVATIONS = new Map<string, ActivateFn>([
  ['pansou', pansou],
  ['Douyin_TikTok_Download_API', douyinTiktokDownloadApi],
  ['alist', alist],
  ['eastmoney', eastmoney],
  ['netease', netease],
  ['bilibili', bilibili],
  ['xhs', xhs],
  ['xueqiu', xueqiu],
  ['telegram', telegram],
  ['firecrawl', firecrawl],
  ['hackernews', hackernews],
  ['v2ex', v2ex],
  ['rsshub', rsshub],
  ['cloudflare', cloudflare],
  ['xunlei', xunlei],
  ['shooter', shooter],
  ['omdb', omdb],
])
