# 归档 / 整理 / 撤销 / 纯享

入口是 `netdisk-library` SKILL.md 的分诊表；这里是「把一个目录整理好」那一档的落地判断。
字段契约在工具描述里，这里只写**描述里没有的判断**。

**要看某个目录长什么样，`netdisk_browse` 只吃 `path`。** 这条线上到处是 setId，顺手传
`netdisk_browse {setId}` 会被 schema 直接拒（报错告诉你该传什么）。绑定目录的路径是
`netdisk_bindings` 回执里的 `dirPath`，拿它当 `path`。

## 1. 永远先预览，再执行

**`reconcile_status` 是只读预览，不动任何文件，随便调。** `reconcile_execute` 才动文件。
**影视绑定要用 binding 形式**：`show: 'binding:<setId>'`（setId 来自 `netdisk_bindings`）——
影视绑定没有 show 配置，不会出现在无参列举里，拿名字也找不到。

讲结果就一句话：**搬 N、删 M、改名 K、待定 P**。数字取 `counts.move` / `deleteDup + deleteLoser +
deleteRedundant + replace` / 从执行回执里拿 `renamed` / `pending`。

`counts.move` 已经是总数，`moveClaimed` / `moveSecondary` / `movePureCut` 是它的**明细**——
把明细和总数并排报出来就是把同一批文件数了两遍。

**`counts.replace` 和 `pendingKind: 'replace'` 是两个东西。** 前者是**计划要做**的替换，进删除数；
后者是**想替换但比不出质量、卡住了**的待定卡，在 `pending` 里，不进删除数。一轮里
`counts.replace = 0` 而有 11 张 `pendingKind:'replace'` 是常态——把那 11 张算进删除数，
就是把 11 个还没决定的动作报成了要发生的删除。

**每个数字都还没发生。** 预览之后必须说"要不要执行"，不能说"已经整理好了"。

**预览与执行之间别动这个绑定。** 中间只要有东西写了盘（尤其 `netdisk_follow run` 转存了新文件、
或用户自己传了几集），执行时重新规划出的就不是你核过的那份 plan 了。两条一起用：

- 中间隔久了（核清单 + 等用户点头常常十几分钟）就**重新预览一次**再执行；
- 执行时把 `reconcile_status` 回执里的 `planFingerprint` 原样传给 `reconcile_execute` 的
  `expectFingerprint`——plan 变了就会被拒、一步都不走，而不是照着一份没人看过的计划删文件。
- **`reconcile_decide` 也会让指纹作废**：裁决落账后重新规划出的 plan，待定卡会变成搬/删，哈希必变。
  所以顺序是 status → decide → **再 status 一次** → 拿新的 `planFingerprint` 去 execute。

## 2. 将删清单逐条核，这是这条线上唯一不可逆的动作

`plannedDeletes[]` 把每条删除摊成一对：`path`（会消失的那份）和 `keptPath`（留下的那份），
两侧的体积与时长各一格（`sizeBytes`/`durationS` 是消失那份，`keptSizeBytes`/`keptDurationS`
是留下那份），外加 `kind` / `episode` / `basis`。**逐条问一句：这两份是同一集吗？**

- **两侧 `durationS` 不相等 → 停。** 这是最硬的一条：同一集的两个版本时长**精确相等**（0 秒差），
  不是"接近"。
- **`keptSizeBytes` < `sizeBytes`（留小删大）→ 停。** 正常是留下更大那份（例：删 1.39G 留 3.16G）。
- `episode` 两边不一致，或者干脆缺席 → 停下来问人。删的必须是**落选副本**，不能是**另一集**。
- `keptPath` 与 `path` 落在**两个不同的季目录**里 → 跨季错判的签名，停（见 SKILL.md 的复发判据）。
- `kind: 'delete-redundant'` 没有 `keptPath`，这是**故意的**：留下的不是另一个文件，是源站自己。
- `durationS` 某一格**缺席**，说明规划器手里没有那条候选——那是"没数据"，不是 0，别拿它当判据。
  **缺席 = 这条没核到**：「不相等 → 停」在缺席时不会触发，别把"没报警"当成"核过了"；这类条目
  按没核过处理（报给用户时单列出来）。
- `plannedDeletesTruncated: true` → 你手里不是全部。**用 `deletesOffset` 翻下一页**
  （`reconcile_status {show, deletesOffset: 50}`，一页最多 50 条，`plannedDeletesTotal` 是总数），
  翻到 `plannedDeletesTruncated: false` 为止。不翻就如实说"没核完"，**不许**说"我核过了"。

**机器为什么选了这一份做正主，就写在每条的 `basis` 上**（`quality-loser-of:…` / `size-dup-of:…` /
`decision:prefer:…`），不用去账本或面板找。

**时长也可能是坏的，而它是这些判据的基石。** 探测失败会给出离谱的值（活体见过 601639s ≈ 167 小时，
一集综艺才 1–2 小时）。两条推论方向相反，别混：
- 两侧精确相等 → **极强的证据**，因为坏值不会碰巧相等；
- 单看一个离谱的时长 → 那是**探测失败**，不是"这两份不是同一集"。这类文件归档器自己会推去
  `pending`（`replace`），不会删。

## 3. 改名会改变引擎读的证据，所以执行完要再预览一次

归档器给判成 `auto` 的认领加 `SxxExx - ` 前缀（原文件名原样跟在后面）。**前缀本身就是下一轮的证据。**
所以：**执行完之后再 `reconcile_status` 一次**，第二轮预览干净了才算完——尤其是第一次给存量绑定加前缀那次。

第二轮如果冒出一批 `delete-loser`，**十有八九是纯享 / 花絮被当成了正片的副本**（加了前缀之后
"名字与集标题一致"这一档恒站在正主那边）。不要执行它，回到第 4 条。

已经带着**正确**前缀的文件不会被再改；带**错误**前缀的（名字写 S03E14、引擎判它是 S03E15）
不改名，出 `pending`（`evidence-conflict`）——名字和引擎打架时不许机器单方面改写证据。
同一道闸还核「文件名的第N期 = 清单这一集的第M期」（`qi-conflict:` 依据），不等也出卡。

**执行完除了再预览，还要核一遍前缀对不对**：`plannedDeletes` 只覆盖删除，搬运与改名不在里面，
而刻错的前缀比删错一份更难撤（错号成了下一轮的证据）。判法：同步回执里每条 `auto` 的
`rightFile` 文件名期号 vs `leftTitle` 期号，逐条比，不等的就是刻错的——出现就整轮
`reconcile_undo_run` 撤回，别手工改名。

## 4. 纯享、花絮、top10、加更、直播都不是集

- **纯享**由归档器自己搬去 `<作品>/纯享/S<nn>/`，**不加编号前缀**（前缀是"这是第几集"的断言），
  计数在 `movePureCut` 一格。它**顶掉落选副本那一路**：引擎判成同集 loser 的纯享文件不走
  `delete-loser` / `replace`，直接上货架。
  两个例外：引擎把它认成了某一集的**正主**（有的节目就把纯享版列进节目单）时它就是那一集；
  **季号答不出来**时不搬，留在 `season-unresolved` 那一行。
- **其余那些（花絮 / top10 / 加更 / 直播）原地不动**，归档器不管它们。用户要清理时，
  **列清单让他拍板再删**，别替他决定——删进网盘回收站约 10 天可捞，但那是兜底不是许可。

## 5. `pending` 卡按 `pendingKind` 分档，处理方式完全不同

**这些卡会被裁决器先裁一遍**：`evidence-conflict`/`duration-collision`/`no-duration` 三档（追更那
一路还有 `follow-candidate`）在归档之后、或手动调 `reconcile_adjudicate`，会先被问一次模型、
过代码闸后自动落决定——等你看到卡片时，那批已经答得出来的多半已经被裁掉了，手里剩的是模型
拿不准（`unsure`）或被闸拒收的那部分。判据与代码闸细节见 `docs/MATCHING.md` "End-of-round adjudication" 一节，
这里讲的仍是**人**接手之后该怎么分档处理。

**先看 `pendingKind`，别一律当成"要我裁的卡"**——有的什么都不用做。分布随节目千差万别，
活体一轮 25 张卡是 `evidence-conflict` 10 / `replace` 11 / `swap-hold` 4，一张
`season-unresolved` 都没有。

- **`replace`**（第二货架上已有同集身份的一份，两份**比不出高下**——时长不同或探不到）→
  属于**判断**档，一律**先问用户**，别自动裁。可以先用 `netdisk_transcribe` 听头尾各两分钟再摆证据。
- **`swap-hold`**（目标目录已有同名文件，本轮搬进去会撞名）→ **什么都不用做。**
  执行完那个位置就腾空了，下一轮它自己落位。**别对它调 `reconcile_decide`**——那是一件纯多余、
  且可能有害的事。
- **`no-duration`**（时长还没探到）→ 状态不是问句，下一轮续探，不用管。
- **`duration-collision`**（时长撞上某一集、名字过不了地板）→ 问的是"这到底是不是那一集"，
  按下面 `evidence-conflict` 的同一套口径处理；答"不是"就 `not-episode`，它下轮按"清单里没有它"走。
- **`evidence-conflict`**（名字和引擎打架，或一份文件的证据指向好几集）→ 这是**逐文件**的裁决。
  把证据摆出来问用户，或者证据足够时用 `reconcile_decide`。
  它的裁决口径分层：**逻辑推论**才可以不问就裁（字节全等的重复、时长与节目单差在几秒内且名字对得上、
  文件名明显坏掉）；**判断**一律先问（时长远超节目单的合集、多个候选争同一格、名字和时长互相矛盾）。
  裁决要**一次批量发**（`decisions` 数组），不是一卡一次调用。
  分不出来还想再取证据时，`netdisk_transcribe` 能听这份文件头尾各两分钟。
- **`season-unresolved`**（这份文件所在的文件夹判不出属于哪一季）→ **不要逐文件裁**。
  整个文件夹根本没进过匹配器，逐个裁没有意义。让用户给文件夹起一个带季号的名字、
  或者把它挪进 `S<nn>/`，然后重新预览。
- **`pendingKind` 是上面没写的值 → 读卡上的 `reason`**，它是完整的一句人话，说清了这张卡为什么
  卡在这儿。别按"看起来像哪一档"套上面的处理方式。

（`suspect-dir` 不在这份清单里：它是**目录级**的一条判断，回执把它折进 `suspectDirs[]`，
每条自带 `hint` 讲下一步，别把它当成 N 张卡。）

## 6. 出错了整轮撤回

`reconcile_undo_run(runId)` 把一轮的动作倒序走回去：文件移回原处、`SxxExx - ` 改名还原、
被清空删掉的目录重建。**删除撤不回来**（回收站里的东西这条路捞不出）。

`runId` 两个来源：`reconcile_execute` 的回执，或 `netdisk_follow view` 的 `lastRuns[].archived.runId`
（追更那一轮也会归档，归错了就撤那个）。

回执里的 `resync` 有**三个值**，不是是非题：`'done'` = 撤完重新匹配过了；`'skipped'` = 本来就不用
（那一轮不是影视绑定）；`'failed'` = **需要但没做成**，此时分集清单还指着撤销刚放弃的路径、播放会 404，
要如实报出来并去调 `netdisk_sync`，`resyncError` 说为什么。

同一个 `runId` 撤两次不是撤了两遍，第二次那些行已经用掉了。

## 7. 报数字之前先 `netdisk_sync`

文件一动，其它所有视图报的都还是**上一次同步**的画面。归档执行完（或追更转存完、或用户手动上传完）
**先 `netdisk_sync` 一次**，再报"配上 N/M"——数字用它的 `bySeason`，**不要用自己数的**。

它不动任何文件，不确定画面是不是最新的时候随便调。
`orphanFiles` 很大通常意味着**命名把匹配规则打败了**，那是 `netdisk_residue` + `netdisk_preview_spec` /
`netdisk_apply_spec` 那条路要解决的事（先 preview 再 apply，人工订正在两边都被钉住不动）。
