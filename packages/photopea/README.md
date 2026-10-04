# @streamapp/photopea — 免费网页版 PS 当抠图 / 摆放引擎

三条**动作 recipe**，都在用户自己的 Chrome 里驱动 [Photopea](https://www.photopea.com/)，不经过任何 AI 模型：

| recipe | 做什么 | 关键参数 |
|---|---|---|
| `photopea-run` | **通用**：图片 + 一段 Photoshop 风格脚本 + 导出格式 → 文件。下面两条是它的定型用法 | `files`（本地路径，大图 / 多图）或 `images`（data URL，小图）、`script` `format` `width`/`height`（可选） |
| `photopea-cutout` | 魔棒按边线抠白底 → 透明 PNG | `image`（data URL）、`tolerance`（默认 24）、`seed`（默认 `4,4`）、`keep`（护材质的多边形，可选） |
| `photopea-place` | 新建画幅，把图层按目标四角（透视）/ 矩形落进去 → PNG 或带图层的 PSD | `width` `height` `images` `layers` `format` |
| `photopea-mask` | **切层**：整幅层按多边形 / 魔棒选区裁掉选区外（抗锯齿、可 feather / contract），`erase` 再按魔棒擦几块（残留底色、锯齿边），`duplicate`+`offset` 做补丁层；`within`（一个多边形）把这层最后再裁到这块领地里；`group`（`"柜台/主岛台"` 这样的路径）出 PSD 时按路径建嵌套图层组（同组的层在栈里要挨着，层名组名全文档唯一）→ PNG 或分层 PSD | `width` `height` `files`/`images` `masks` `format` |

三条都回 `items[0].file` = 导出文件在**后端那台机器上**的绝对路径（`<dataDir>/action-artifacts/…`，7 天后回收，要留就搬走）。文件由 recipe 的 `output.files` 声明、宿主落盘；base64 **不会**出现在回执里——回执会原样进 run 账本，账本拒收超过 1MB 的结果。

## 怎么跑

走 `POST /api/recipes/action`（和 MCP 的 `run_action_recipe` 同一个闭包），`confirmed:true` 才真跑；
超过 25s 会回 `{status:'running', runId}`，去 `GET /api/recipes/action/<runId>` 轮询（实测抠图 3s、两层摆放 3s，一般等不到那一步）。

**图怎么交进去，按大小分两条路：**

- **`files`（本地绝对路径，按换行拼）——整幅层、几十 MB、几十张，走这里。** 它是 recipe 里一步 `setFiles`
  （CDP `DOM.setFileInputFiles`）：浏览器进程直接读盘，宿主页把 `File` 读成 ArrayBuffer 直接 postMessage 给
  Photopea 开成文档，**一个字节都不经 base64、不经扩展的控制通道、不占脚本预算**。路径是后端机器上的
  （WSL 的 `/mnt/c/...`、`/home/...` 宿主自动翻成 Windows 侧认的）。
- **`images`（data URL，按换行拼）——小图、临时图。** 它走 params 进 `evaluate` 表达式：一张 1.3MB 的 PNG
  编成 1.7MB 字符串，整个参数袋是一条 CDP 消息，还挤在页内求值 30s 预算里。**别用它传整幅层**。

两者可以同时给，序号 `img<i>` 先排 files 再排 images。`photopea-run` 只给 `files` 时 curl 就够：

```sh
curl -s -X POST 127.0.0.1:8900/api/recipes/action -H 'content-type: application/json' \
  -d '{"sourceId":"photopea-run","confirmed":true,"params":{"files":"/mnt/c/x/a.png\n/mnt/c/x/b.png","width":"3200","height":"1440","format":"psd","script":"app.echoToOE(\"layers=\" + app.activeDocument.layers.length);"}}' \
  | jq -r '.items[0].file'
```

`photopea-cutout` / `photopea-place` 今天还只收 data URL，用 node 拼：

```js
// cutout.js  —  node cutout.js in.png out.png [tolerance] [keepJson]
const fs = require('fs'); const [inp, outp, tolerance, keep] = process.argv.slice(2)
const params = { image: 'data:image/png;base64,' + fs.readFileSync(inp).toString('base64') }
if (tolerance) params.tolerance = tolerance; if (keep) params.keep = keep
fetch('http://127.0.0.1:8900/api/recipes/action', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sourceId: 'photopea-cutout', params, confirmed: true }) })
  .then(r => r.json()).then(r => { fs.copyFileSync(r.items[0].file, outp); console.log(r.items[0].bounds) })
```

```js
// place.js  —  node place.js spec.json out.png
// spec = { width, height, format?, images: ['a.png', ...], layers: [ {image:0, name, src?:[[x,y]×4], quad:[[x,y]×4]} | {image:0, rect:[x,y,w,h]} ] }
const fs = require('fs'); const [specPath, outp] = process.argv.slice(2); const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
const params = { width: String(spec.width), height: String(spec.height), layers: JSON.stringify(spec.layers),
  images: spec.images.map(p => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')).join('\n') }
if (spec.format) params.format = spec.format
fetch('http://127.0.0.1:8900/api/recipes/action', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sourceId: 'photopea-place', params, confirmed: true }) })
  .then(r => r.json()).then(r => fs.copyFileSync(r.items[0].file, outp))
```

小图可以直接 curl：

```sh
curl -s -X POST 127.0.0.1:8900/api/recipes/action -H 'content-type: application/json' \
  -d "{\"sourceId\":\"photopea-cutout\",\"confirmed\":true,\"params\":{\"image\":\"data:image/png;base64,$(base64 -w0 in.png)\"}}" \
  | jq -r '.items[0].file' | xargs -I{} cp {} out.png
```

### 例：做菜台子落进 3200×1440 的梯形 + 前立面

源图 `不锈钢柜台03.png`（2048×775 白底）。先抠、再摆（**先抠再摆**：白底还是一整块、连着左上角，默认种子一发就干净；先摆再抠的话白底被切成几块孤岛（腿两侧的三角）、四周是透明不是白，默认种子 `4,4` 点在透明上什么都抠不掉——实测输出和输入逐字节相同。给每块孤岛各一个种子才追平，多此一举）：

```json
{ "width": 3200, "height": 1440, "images": ["cut.png"],
  "layers": [
    { "image": 0, "name": "front", "src": [[90,656],[1955,656],[1955,775],[90,775]], "rect": [704,1224,1792,216] },
    { "image": 0, "name": "top",   "src": [[259,286],[1785,286],[1955,656],[90,656]], "quad": [[832,720],[2368,720],[2496,1224],[704,1224]] }
  ] }
```

`src` 是源图上要取的那一块的四角（TL,TR,BR,BL），`quad` 是它在画幅里落到的四角；`rect` 是矩形的简写。底层在前。

## photopea-run 怎么写脚本

```js
// run.js  —  FORMAT=psd WIDTH=3200 HEIGHT=1440 node run.js script.jsx out.psd a.png [b.png ...]
const fs = require('fs'); const [scriptPath, outp, ...imgs] = process.argv.slice(2)
const params = { script: fs.readFileSync(scriptPath, 'utf8'),
  images: imgs.map(p => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')).join('\n') }
if (process.env.FORMAT) params.format = process.env.FORMAT
if (process.env.WIDTH) { params.width = process.env.WIDTH; params.height = process.env.HEIGHT }
fetch('http://127.0.0.1:8900/api/recipes/action', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sourceId: 'photopea-run', params, confirmed: true }) })
  .then(r => r.json()).then(r => { fs.copyFileSync(r.items[0].file, outp); console.log(r.items[0].echoes) })
```

**装入规则（脚本开始前的状态）**

| 参数 | 装入后 | 脚本开始时的 `activeDocument` |
|---|---|---|
| 只给 `images` | 第 i 张 = `app.documents[BASE + i]`（`BASE` = 标签里你本来开着的文档数），文档名 `~stream~img<i>`、它唯一的层叫 `img<i>` | 第 0 张 |
| 给了 `width`/`height` | `app.documents[BASE]`（文档名 `~stream~canvas`）是这么大的透明画布，第 i 张是它的一层 `img<i>`（img0 在最底，`d.layers.getByName("img0")` 取） | 画布 |

脚本**原样**执行；跑完导出**当时的** `activeDocument`（要导别的先 `app.activeDocument = app.documents[k]`）。`app.echoToOE("…")` 的字符串进 `items[0].echoes`，用它把 bounds / 层数打回来核。

**报错**：脚本里能抓的异常（`No layer with a name img0` 这类）会以 `脚本抛错: …` 报回；引擎内部死掉的（下表「死」那一列）Photopea 不报错也不回音，recipe 到时限（`timeoutMs`，默认 20s）抛「没跑完 + 脚本前 200 字 + 已收到的回音」。所以**多打 echo**：死在哪一句，看最后一条回音就知道。

**Photopea 脚本 = Photoshop 脚本子集（DOM + 一部分 `executeAction` 描述符）。** 实测（2026-09-19）：

| 能用 | 备注 |
|---|---|
| `app.open(dataURL)`、`app.documents.add(w,h,72,name,NewDocumentMode.RGB,DocumentFill.TRANSPARENT)`、`app.activeDocument = …`、`doc.close()` | `open` 异步：recipe 已替你等到文档就绪 |
| `doc.resizeCanvas` / `resizeImage` / `crop` / `trim(TrimType.TRANSPARENT)` / `flatten` / `mergeVisibleLayers` / `activeLayer =` | |
| `doc.saveToOE("png" | "jpg:0.8" | "webp" | "psd")` | recipe 末尾替你调，脚本里一般不用 |
| `layer.translate` / `resize(w%,h%,AnchorPosition.X)` / `rotate` / `duplicate()` / `duplicate(otherDoc, ElementPlacement.PLACEATBEGINNING)` / `remove` / `rasterize` | `duplicate(otherDoc)` **保位置保像素**（摆放靠它）；返回的对象**不是**目标文档里那一层，改名要 `otherDoc.layers[0].name = …` |
| `layer.opacity` / `blendMode` / `name` / `visible`；`layers.getByName`；`artLayers.add()`；`layerSets.add()` | |
| `layer.adjustCurves([[0,0],[128,150],[255,255]])` / `adjustLevels` / `adjustBrightnessContrast` / `invert` / `applyGaussianBlur` | |
| 文字层：`artLayers.add()` → `kind = LayerKind.TEXT` → `textItem.contents/size` | |
| `selection.select(polygon[, SelectionType.EXTEND | DIMINISH | INTERSECT])` / `selectAll` / `invert` / `expand` / `contract` / `feather` / `deselect` / `clear`（删像素）/ `fill(SolidColor)` | `bounds` 的四个元素是 UnitValue，取 `.value` |
| `executeAction`：`setd`（魔棒，见 cutout 的描述符）、`Dlt `、`Mk  `（新层）、`Dplc`、`slct`（按名选层）、`move`（层偏移）、`GsnB`、`Crvs` | `Crvs` 空描述符不报错但也没看出效果，曲线用 `layer.adjustCurves` |

| 会死（脚本静默终止，只有超时） | 用什么代替 |
|---|---|
| `executeAction AddT`（魔棒加选） | 多个种子各 `setd` 一次各清一遍；多边形能 `SelectionType.EXTEND` |
| `executeAction Trnf`（自由变换 / 透视） | 仿射用 `layer.resize/rotate/translate`；透视在 Photopea 外算（photopea-place 就是这么做的） |
| **图层蒙版**：`Mk  ` At `Msk `（Usng `RvlS` / `HdSl` / 不给 / stringID `make`+`channel`+`mask` 四种写法，2026-09-24）。**别再试了**：三个独立的开源实现（`attalla1/photopea-mcp-server` 34 个工具、`sportiz91/photopea-api`、`autopea`）都没有蒙版这一档，后者直接写明 Action Manager 整体不可用 | 选区 → `invert` → `clear` 直接擦（photopea-mask）：抗锯齿和 feather 都在，只是破坏性的；要能手拖的缝，导 PSD 后在 Photopea 里把该层透明度转成蒙版 |
| `executeAction ClrR`（色彩范围）、`Fl  `（填充） | 魔棒 + `selection.fill` |
| **把层移进已有的图层组**：`layer.move(set, ElementPlacement.INSIDE)` 会在原处多复制一份（原层不动）；`layer.duplicate(set, INSIDE)` 再 `remove` 原层，组里是空的、层丢了；`set.layerSets.add()` 建出来的子组落在顶层（2026-09-29） | Ctrl+G 那条动作：`slct`（按名选层，第二层起加 `selectionModifier`=`addToSelection`）→ `Mk  ` 一个 `layerSection`、`From` 当前选中——选中的层就进了新组；嵌套组从最深的往上逐级编（photopea-mask 的 `group` 就是这么实现的） |
| **关单独一层的眼睛**：`layer.visible = false`（设 true 也一样）、`executeAction Hd  / Shw `（按名 / 按序号 / 按当前层引用都试过，2026-09-28）——效果全是「独显」开关（等同 Alt 点眼睛）：第一次只剩这一层可见、其余全关，第二次全部恢复 | 不透明度 0（`layer.opacity = 0`，photopea-mask 的 `hidden` 就是这么实现的）：看不见、不进导出的合成，PSD 里要看时把不透明度拉上来 |
| `doc.channels`（连 `.length` 都死）、`selection.store/load` | 别碰通道 |
| 没有选区时读 `selection.bounds` | 先 `selectAll` 或先确认有选区 |
| `app.open(url, null, true)`（asSmart 贴入） | 不死，但会把图**缩放**（2048 宽贴进 3200 画布缩到 1407）——要保像素用 `duplicate(otherDoc)` |

## 一张常驻标签，人和脚本共用

四条 recipe 共用一条 lane = **一张** `photopea.com/api/` 标签，里面嵌一整份 Photopea（iframe 铺满标签）。它是**常驻**的
（`session.keepAlive`）：不闲置回收、不被腾位置挤掉、跑出 blocked 也不关，**后端重启也不关**（它的 tabId 落在
`<dataDir>/keepalive-lanes.json`：关停时留着、启动就认领、下一轮原地骑回去）——只有你自己关掉它，下一轮才重开。
别再另开一张 photopea.com 给人看：每开一次就是一次 ~10MB 的整页加载，开勤了 photopea.com 会掐连接
（标签变成「无法访问此网站 / ERR_CONNECTION_CLOSED」）或出真人验证。

- **脚本只碰自己的文档。** 本轮建的文档都叫 `~stream~…`；开头只关上轮崩掉留下的 `~stream~` 文档，你开着的文档不动。
  本轮的文档从 `app.documents[BASE]` 起（`BASE` = 你开着的文档数，用户脚本里直接可用）。
- **`keep: "<名字>"`**：跑完把导出的那份改成这个名字**留在标签里**、切到前面，给人看、给人改（`--open` 就靠它）；
  不给 `keep` 就把本轮的临时文档全关掉。留下的文档不会被下一轮关，看完自己 Ctrl+W。
- **别在脚本跑的那几秒里切文档**：脚本按「当前文档」干活，你在它跑的时候切走，它会切到你的文档上。
- **标签死了**（连接被掐断成错误页）：recipe 第一句就认出来、报「去那张标签按一次刷新」。刷新是人来按，不自动重载——
  自动重载正是撞墙的来源。

## 机制（改 recipe 之前读）

- **宿主页是 `photopea.com/api/`（同源轻页），Photopea 嵌在它里面的 iframe 里。** photopea.com 顶层不听 postMessage、`app` 也不是全局，脚本 API 只对嵌入方开放；同源 iframe 让顶层能直接 `contentWindow.postMessage` 并按 `e.source` 收回音。lane 是 persistent + `keepAlive` + `rideCurrentPage`，iframe 跨轮常热（应一声就复用，4s 不应就换新）。photopea.com 顶层也别想绕：页面全局 297 个变量里没有 `app`（`ppp` 只是界面偏好），给自己 postMessage 脚本只收到自己的回声（2026-09-26 在已登录的顶层标签里复测）。
- **二进制直接 postMessage 就开成文档。** Photopea 的消息 API：字符串当脚本执行，ArrayBuffer 当文件打开（实测 2026-09-24：投一个 PNG 的 ArrayBuffer，`docs` 0→1、尺寸对、文档名 `file`、层名 `Background`——所以装入后还得改名）。`files` 那条路靠的就是它；`app.open(dataURL)` 只留给 `images`。
- **每段脚本末尾追加 `echoToOE(随机标记)`，等标记不等 `done`。** `done` 在 `app.open` / `documents.add` 这类异步动作上会先于完成发出；脚本抛错时 Photopea 既不报错也不发 done——所以每段都带超时，超时把已收到的回音抛出来。文档就绪靠轮询 `app.documents.length`。
- **Photopea 的 executeAction 只认一部分 Photoshop 描述符。** 认：`setd`（魔棒）。不认（脚本静默死）：`AddT`（加选）、`Trnf`（变换）。`d.channels`、无选区时读 `selection.bounds` 也会让脚本死掉。`bounds` 的元素是 UnitValue，取 `.value`。
- **透视不在 Photopea 里做。** `Trnf` 不认，`asSmart` 贴入会缩放（2048 宽贴进 3200 画布被缩到 1407）。所以单应变换在宿主页 canvas 上算（逆向映射 + 双线性、预乘 alpha），画成画幅坐标的整幅 PNG，再 `app.open` 成文档、`layer.duplicate(scene)` 进画布——duplicate 保位置保像素。Photopea 在这一步提供的是文档 / 图层 / PSD 导出。
- **后台标签定时器 ≥1s 一跳**：脚本里所有等待都是事件驱动（message），别加 `sleep` 轮询。
- **魔棒 vs 阈值抠图**：本质都是颜色泛洪，区别在于只从种子连通生长 + 抗锯齿边 + `keep` 多边形能把已知材质圈出来让泛洪停在边线上。实测柜台03 容差 24 不带 keep 就干净（台面前沿纯白高光线、腿的亮面都在）；`keep` 是保险，沿真实轮廓**内缩** 2–3px，外扩会留白边。
