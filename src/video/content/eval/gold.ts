/**
 * Gold cases — hand-labeled from REAL corpus samples. These pin the structural
 * invariants (correct name↔link pairing, no truncated links, right facets), not
 * "does query X still return N results" (that drifts with the live index).
 */
import type { RawDownloadItem } from '../types.ts'
import type { GoldRow } from './metrics.ts'

export interface GoldCase {
  what: string
  item: RawDownloadItem
  expectRows: number
  gold: GoldRow[]
}

/** The 6-work digest that first exposed the offset-pairing + truncation bugs.
 *  上载新生 MUST pair with iuYRRvzMBzqu (not the preceding/following link). */
const DIGEST_6 = `入室抢劫.Home Invasion (2021) 1080p {tmdbid-126080}
链接：https://cloud.189.cn/t/niuINfA3EvIj（访问码：5mpm）入侵.Invasion.(2005) {tmdb-2940}
链接：https://cloud.189.cn/t/aeQNbyyyQ77b（访问码：bnm5）神盾局特工.Marvel's Agents of S.H.I.E.L.D. (2013) {tmdbid-1403}
链接：https://cloud.189.cn/t/y2Anaue2eEn2（访问码：en82）身为一个胖子 (2019) {tmdb-96958}
链接：https://cloud.189.cn/t/VRR36rjIjMBn（访问码：bn1p）上载新生.Upload.(2020) {tmdb-86248}
链接：https://cloud.189.cn/t/iuYRRvzMBzqu（访问码：9ik4）赏金姐妹花.Teenage Bounty Hunters.(2020) {tmdb-90766}
链接：https://cloud.189.cn/t/ryQnYjFjYBR3（访问码：gb1v）其他剧集电影分享如下https://docs.qq.com/smartsheet/DZm5tbkdoTGJoeFZN标签  #剧集 #合集 #刮销 #4k
大小：1t群聊：https://t.me/tianyiDrive
频道：https://t.me/tianyifc`

export const GOLD_CASES: GoldCase[] = [
  {
    what: 'pansou 6-work digest — offset pairing + link truncation + junk-link drop',
    item: { source: 'pansou', title: '入室抢劫.Home Invasion (2021) 1080p', content: DIGEST_6 },
    expectRows: 6, // 6 real works; docs.qq.com + 2× t.me dropped
    gold: [
      { nameHas: '入室抢劫', linkHas: 'niuINfA3EvIj', netdisk: 'tianyi', password: '5mpm' },
      { nameHas: '入侵', linkHas: 'aeQNbyyyQ77b', password: 'bnm5' },
      { nameHas: '神盾局特工', linkHas: 'y2Anaue2eEn2', password: 'en82' },
      { nameHas: '身为一个胖子', linkHas: 'VRR36rjIjMBn', password: 'bn1p' },
      { nameHas: '上载新生', linkHas: 'iuYRRvzMBzqu', password: '9ik4' }, // the offset test
      { nameHas: '赏金姐妹花', linkHas: 'ryQnYjFjYBR3', password: 'gb1v' },
    ],
  },
  {
    what: 'pansou single-resource — URL only in links[], name from title, blurb stripped',
    item: {
      source: 'pansou',
      title: '🗄 上载新生(四季合集)【AMZN.1080p】【内封简繁英】【悬疑/科幻】',
      content: '🗄 上载新生(四季合集)【AMZN.1080p】·📜介绍：本剧迎来精彩最终季……·\n💾夸克网盘·\n📁',
      links: [{ url: 'https://pan.quark.cn/s/f41020738c90', type: 'quark' }],
    },
    expectRows: 1,
    gold: [{ nameHas: '上载新生', linkHas: 'f41020738c90', netdisk: 'quark', quality: '1080p' }],
  },
  {
    what: 'btbtla paired-links — each desc a row, facets from desc, magnet needsResolve',
    item: {
      source: 'btbtla',
      title: '上载新生 第三季',
      links: [
        { url: 'https://www.btbtla.com/tdown/842351654.html', desc: '上载新生.第三季[全8集][简繁英字幕].Upload.S03.REPACK.2160p.Amazon.WEB-DL.DDP5.1.H.265-BlackTV\n\t[28.50GB]' },
        { url: 'https://www.btbtla.com/tdown/833147706.html', desc: '上载新生.第三季[全8集][简繁英字幕].Upload.S03.2160p.AMZN.WEB-DL.DDP.5.1.HDR10+.H.265-ColorTV\n\t[37.00GB]' },
      ],
    },
    expectRows: 2,
    gold: [
      { nameHas: 'BlackTV', linkHas: '842351654', netdisk: 'magnet', quality: '2160p', season: 3, coverageKind: 'pack' },
      { nameHas: 'ColorTV', linkHas: '833147706', netdisk: 'magnet', quality: '2160p', season: 3, coverageKind: 'pack' },
    ],
  },
  {
    what: 'pansou concatenated mirrors — one work, links glued with no separator → ONE named row',
    item: {
      source: 'pansou',
      title: '周五 动漫',
      content:
        '大主宰年番2 (2026)[热血 冒险 玄幻] 4K高码 更新4集 链接：https://pan.quark.cn/s/1e5baab0ca3bhttps://drive.uc.cn/s/abc123https://pan.baidu.com/s/1geZdlaJ',
    },
    expectRows: 1, // three glued links are MIRRORS of one work, not three works
    gold: [{ nameHas: '大主宰', linkHas: 'quark.cn/s/1e5baab0ca3b', netdisk: 'quark' }],
  },
  {
    what: 'flat torrent (nyaa) — title identity, single episode, magnet',
    item: {
      source: 'nyaa',
      title: '[SubsPlease] Sousou no Frieren - 12 (1080p) [9C6F5E2A].mkv',
      link: 'magnet:?xt=urn:btih:9C6F5E2AABCDEF0123456789ABCDEF0123456789&dn=frieren',
    },
    expectRows: 1,
    gold: [{ nameHas: 'Frieren', linkHas: 'btih:9C6F5E2A', netdisk: 'magnet', quality: '1080p', coverageKind: 'single' }],
  },
  {
    // regression: raw RSSHub torrents carry an HTML <a href> description in `content`.
    // The digest parser must NOT claim it (it would shred the markup into "<a href=" rows);
    // the magnet enclosure routes it to flat with a clean name + the magnet as the link.
    what: 'flat torrent WITH HTML description — must route flat, not digest (nyaa bug)',
    item: {
      source: 'nyaa',
      title: '[SubsPlease] Kimetsu no Yaiba - 07 (1080p) [A1B2C3D4].mkv',
      link: 'magnet:?xt=urn:btih:A1B2C3D4EF567890A1B2C3D4EF567890A1B2C3D4&dn=kny',
      content: '<a href="https://nyaa.si/view/2077734">#2077734</a> | 1.2 GiB | 2024-05',
    },
    expectRows: 1,
    gold: [{ nameHas: 'Kimetsu', linkHas: 'btih:A1B2C3D4', netdisk: 'magnet', quality: '1080p' }],
  },
]
