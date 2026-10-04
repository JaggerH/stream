// research present 的频道视图。与 MovieChannel 同形：按 present 判路进来，
// 自己拥有二级子路由 /c/<channelId>/run/<streamId>/<runId>——走 MovieChannel 的
// /c/<id>/item/<id> 同一套 useSubRoute 机制（parseFrom/toPath 两个纯函数 + 一个
// SubRouteLocation），不是自己另起一套 pushState/popstate。
//
// 路径带 streamId 是因为一个频道能绑多个流（研究 run 按目录分流）——只编 runId 的话，
// 深链/刷新落地时组件手里没有 streamId，没法知道去哪个流下面取这个 run。
//
// 数据是 **live** 的：每次进来现读，不入库。因此没有未读、没有订阅——
// 这是 live stream 的代价，spec 里明确接受了。
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { fetchLiveItems, type LiveItem } from '../research/artifact.ts'
import { ResearchRunDetail } from './ResearchRunDetail.tsx'
import { ChannelTitleMenu } from './ChannelTitleMenu.tsx'
import { ChannelConfigPanel } from './manage/ChannelConfigPanel.tsx'
import { ChannelTabs, type ChannelTab } from './manage/ChannelTabs.tsx'
import { Searchbar } from './acrylic/searchbar.tsx'
import { useWs } from '../hooks/useWs.ts'
import { useSubRoute, useSubRouteLocation } from '../hooks/useSubRoute.ts'
import { api, type Connection } from '../lib/api.ts'
import type { ChannelView } from '../lib/types.ts'
import { runIdFromGuid } from '@research/run-guid.ts'

type ResearchRoute = { kind: 'home' } | { kind: 'run'; streamId: string; runId: string }

/** base + 该子树内已有的 pathname → 频道 base（`/c/<id>`）。与 `videoBaseFrom` 同形。 */
export function researchBaseFrom(pathname: string): string {
  const seg = pathname.split('/') // ['', 'c', '<id>', ...]
  return seg[1] === 'c' && seg[2] ? '/c/' + seg[2] : pathname
}

/** 纯解析：pathname → 选择。导出以便测试不碰 window.location（与 videoRouteFrom 同形）。 */
export function researchRouteFrom(pathname: string): ResearchRoute {
  const seg = pathname.split('/') // ['', 'c', '<id>', 'run', '<streamId>', '<runId>']
  const subpath = seg[1] === 'c' && seg[2] ? seg.slice(3) : []
  if (subpath[0] === 'run' && subpath[1] && subpath[2]) {
    return { kind: 'run', streamId: decodeURIComponent(subpath[1]), runId: decodeURIComponent(subpath[2]) }
  }
  return { kind: 'home' }
}

/** 纯拼路径：base + 选择 → 完整路径（与 videoToPathFrom 同形）。 */
export function researchToPathFrom(base: string, r: ResearchRoute): string {
  if (r.kind === 'home') return base
  const prefix = base === '/' ? '' : base
  return `${prefix}/run/${encodeURIComponent(r.streamId)}/${encodeURIComponent(r.runId)}`
}

export function ResearchChannel({ channel, conn, onChannelsChanged }: {
  channel: ChannelView
  conn: Connection
  /** 管理面板改完频道后重拉名录。不给 = 改完这一页不知道（标题还是旧的、流列表还是旧的），
   *  所以宿主有名录就一定要接上去。 */
  onChannelsChanged?: () => void
}): ReactNode {
  // 二级选择走 useSubRoute：从路径播种（深链/刷新落在详情，不塌回列表）、和浏览器前进/后退
  // 保持同步。路径存哪由外层决定（主应用是地址栏），base 因此也从那个存放处读，不直接读
  // window.location——否则面板宿主场景里会拿错 base（见 MovieChannel 头注同一处理由）。
  const subRouteLocation = useSubRouteLocation()
  const toPath = useCallback(
    (r: ResearchRoute) => researchToPathFrom(researchBaseFrom(subRouteLocation.pathname()), r),
    [subRouteLocation],
  )
  const { selection: route, navigate } = useSubRoute<ResearchRoute>(researchRouteFrom, toPath)

  const [items, setItems] = useState<LiveItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<ChannelTab>('content')
  const streamIds = channel.streams.map((s) => s.id)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const per = await Promise.all(streamIds.map((s) => fetchLiveItems(conn, s)))
      setItems(per.flat().sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    // streamIds 是每次渲染新算出的数组，进依赖会因引用变化无限重查；按 join 后的字符串锁身份。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, streamIds.join(',')])

  useEffect(() => { void reload() }, [reload])

  // live-changed：后端推的是「变了」这个事实，不是数据。只有本频道绑的流才重查——
  // 广播是无主题的，人人都收得到，过滤是这一层的事。
  useWs(
    api.wsUrl(conn),
    useCallback((m) => {
      if (m.type !== 'live-changed') return
      if (streamIds.includes(m.streamId)) void reload()
    }, [reload, streamIds]),
  )

  // 顶栏那个搜索框只筛**已经取回来的这一批**：live 档一次就把整份 run 列表读回来了，没有
  // 分页，本地筛就是全量筛，不需要再打一次接口。
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (items === null || q === '') return items
    return items.filter((it) => it.title.toLowerCase().includes(q))
  }, [items, query])

  // 详情态先判——不等列表加载完。深链/刷新落地时列表大概率还没取回来，但用户要看的是
  // 详情，不该被列表的 loading 态挡在前面。
  //
  // 详情态**不画顶栏**（与影视档同）：`ResearchRunDetail` 自带返回键，再叠一条带频道名和
  // 搜索框的顶栏，等于给一页详情配一个筛列表的输入框。
  if (route.kind === 'run') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <ResearchRunDetail
            conn={conn}
            streamId={route.streamId}
            runId={route.runId}
            onBack={() => { navigate({ kind: 'home' }) }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏与音乐/影视档同一格：照 DSH 对话页那条 navbar（标题行 32px + 上留白 12px、没有
          图标也没有下边框）。数值是抄过来的，不是各画各的——三个 Present 在同一个壳里换来
          换去，顶栏差一个像素都会看见跳。 */}
      <div className="flex h-8 shrink-0 items-center gap-2 px-4 pt-3 pb-0 box-content">
        <ChannelTitleMenu
          title={channel.label}
          onRefresh={() => { void reload() }}
          // live 档没有"抓取"这回事——现读不入库，刷新就是再读一次。
          refreshLabel="重新读取"
          exportChannel={{ conn, id: channel.id }}
          className="min-w-0 flex-1"
        />
        <Searchbar
          size="large"
          className="w-56 max-w-[48%] shrink-0"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
          placeholder="搜索 run"
          aria-label="搜索 run"
        />
      </div>
      {/* 标题栏正下方那条「内容 | 配置」——配置从齿轮开的抽屉改成了分页，见 ChannelTabs 头注。 */}
      <ChannelTabs value={tab} onChange={setTab} />
      {tab === 'config' ? (
        // **只在配置页开着时挂**：它组件体里就调 `useChannels()`，常挂着会强迫每一个宿主
        // 都套一层 `ChannelsProvider`（含只想画个 run 列表的测试）。
        <div className="min-h-0 flex-1 overflow-auto">
          <ChannelConfigPanel
            conn={conn}
            channelId={channel.id}
            showHeader={false}
            onChanged={onChannelsChanged}
            onDeleted={() => { setTab('content') }}
          />
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-auto">
        {error !== null ? (
          <div style={{ padding: 24, fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #d33)' }}>读不到研究数据：{error}</div>
        ) : shown === null ? (
          <div style={{ padding: 24, fontSize: 13, opacity: 0.7 }}>载入中…</div>
        ) : shown.length === 0 ? (
          <div style={{ padding: 24, fontSize: 13, opacity: 0.7 }}>
            {query.trim() === '' ? '这个目录里还没有 run。' : '没有匹配的 run。'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 16 }}>
            {shown.map((it) => (
              <button key={it.id} type="button" data-research-run-row
                // `it.id` 是 feed guid（`research-run:<runId>`），不是 run id。剥前缀用
                // shared/ 那一份（后端拼的是同一份），别在这里写字面量——那只是把前缀抄成第二份。
                onClick={() => { navigate({ kind: 'run', streamId: it.stream_id, runId: runIdFromGuid(it.id) }) }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18))', background: 'transparent',
                  color: 'inherit', cursor: 'pointer',
                }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{it.title}</div>
                {it.body_text !== undefined && (
                  <div style={{ fontSize: 11, opacity: 0.7, whiteSpace: 'pre-wrap', marginTop: 4 }}>{it.body_text}</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  )
}
