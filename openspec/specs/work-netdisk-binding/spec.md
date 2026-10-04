## Purpose

作品与网盘文件的绑定：绑定左侧按来源判别式分派、TMDb 分集清单可以充当左侧、转存落点按作品隔离、播放反查有统一入口。

## Requirements

### Requirement: 绑定左侧按来源判别式分派

系统 SHALL 用 `left` 上的 `kind` 判别式决定「集清单从哪来」，而不是假定它来自订阅流。
对齐引擎 SHALL NOT 认识 Stream —— 它只接受 `LeftEntry[]`。

#### Scenario: 订阅流左侧行为不变

- **WHEN** 绑定的 `left.kind === 'stream'`
- **THEN** 集清单来自 ItemStore（按 `streamId`），且匹配/订正/coverage 结果与本改动前逐字一致

#### Scenario: 存量 playlist 判别式读得出

- **WHEN** 存量绑定里 `left.kind === 'playlist'`
- **THEN** 读时归一为 `'stream'`，绑定照常同步；系统 SHALL NOT 因改名丢失任何存量绑定

#### Scenario: 未知 kind 不静默兜底

- **WHEN** `left.kind` 是系统不认识的值
- **THEN** 同步 SHALL 报错并指出该 kind，SHALL NOT 回落到任何默认左侧

### Requirement: TMDb 分集清单可作为绑定左侧

系统 SHALL 支持以 TMDb 权威分集清单作为绑定左侧，使未订阅的剧集也能绑定网盘目录。

#### Scenario: 剧集左侧行数等于权威集数

- **WHEN** 绑定 `left = { kind:'tmdb', id }` 且该 id 是剧集
- **THEN** 左侧行数等于 TMDb 的 `number_of_episodes`，每行带 `季/集号/标题`

#### Scenario: 超过 20 季分批取全

- **WHEN** 剧集季数 > 20（`append_to_response` 的上限）
- **THEN** 系统 SHALL 分批取，且左侧仍覆盖全部集，SHALL NOT 静默截断

#### Scenario: 电影是一行左侧

- **WHEN** 绑定 `left = { kind:'tmdb', id }` 且该 id 是电影
- **THEN** 左侧恰好 1 行，且 SHALL NOT 发出任何分集（`/tv/…`）请求

#### Scenario: 分集索引只在绑定时抓

- **WHEN** 用户打开影视详情页（`/api/items/:id/video-detail`）
- **THEN** 系统 SHALL NOT 因本能力发出任何额外 TMDb 请求 —— 分集索引是绑定的进料，不是详情页的内容

#### Scenario: 落盘的是投影，不是原始载荷

- **WHEN** 分集索引落盘
- **THEN** 只存对齐所需字段（季/集号/标题），SHALL NOT 存 overview / still_path / crew / guest_stars
  （原始 0.8–1.8MB/剧，投影后 2.4–32KB）

### Requirement: 转存落点按作品隔离

系统 SHALL 把一次转存投递到该作品专属的目录，因为绑定是「一个目录 ↔ 一个左侧」一对一。

#### Scenario: 转存建作品子目录

- **WHEN** 从找资源转存一条分享
- **THEN** 文件落进 `<落点>/<作品名>/`，而不是所有作品共用一个 `<落点>`

### Requirement: 播放反查统一入口

两种左侧产出的绑定 SHALL 经同一个播放反查入口（`findByLeftKey` → `PlayableHit`），
播放侧 SHALL NOT 因左侧来源分叉。

#### Scenario: tmdb 绑定的集可播

- **WHEN** 一部剧集有 `kind:'tmdb'` 绑定且某集已配上网盘文件
- **THEN** 该集在影视详情页可播，与经 Stream 绑定配上的集走同一条播放路径

### Requirement: 绑定入口可被用户找到

系统 SHALL 在用户实际做决定的地方暴露绑定入口，而不是只存在于 API。

#### Scenario: 影视二级页有绑定入口

- **WHEN** 用户打开一部电影/剧集的二级页
- **THEN** 页面 SHALL 显示该作品的绑定状态；未绑定时 SHALL 给出可达的「绑定网盘」入口

#### Scenario: Alist 插件页列出绑定

- **WHEN** 用户打开 Alist 插件配置页
- **THEN** SHALL 显示该网盘上已有的绑定列表入口（本改动前完全没有暴露）
