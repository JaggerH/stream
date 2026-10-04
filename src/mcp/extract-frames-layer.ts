// src/mcp/extract-frames-layer.ts
//
// 「画面上写着什么」那一层（`frames`）**在 extract 回执上的落点**。
//
// ## 一句话：视频的正文在 frames 落定之前是不完整的，回执不许说「齐了」
//
// 转写落定后，视频会自动派生一条 `frames`（抽帧逐帧 OCR，见 src/conversions/derive.ts）——
// 幻灯片要点、新闻条、烧录字幕、图表数字全在那里，**转写一个字都拿不到**。
//
// 于是 extract 交出一份 `status: "done"` + 只有转写的 `result.text`，是在对模型撒谎：
// 它说的是「这条 item 的正文，给你」，而手里那份可能只是全部信息的零头。
//
// 活体两次，同一条 item（`54302ede4b47213a`，一条只有背景音乐的抖音新闻，字全在画面上）：
//   - 2026-08-29：回执里对 frames 只字不提 → 模型答「系统没有提供对视频画面做 OCR 的工具」，
//     而那一层当时已经跑完落地了。
//   - 2026-08-30：回执加了指路（「稍等片刻再用 get_conversions 取」）→ 模型**照样**在
//     `画面文字·抽取中` 的时候就把总结发了出来，总结的内容是那句 14 个字的歌词。
//
// 第二次证明了指路不够。这正是 `docs/AGENT-TOOLING.md` §3.1 那条不变量：**产品底线只能靠
// 结构保证，不能靠任何一档提示词**。所以落定的那一档不再「给半份 + 叮嘱一句」，而是
// **把画面文字直接拼进回执**——不指望模型自己再去调 `get_conversions`，上面那两次已经把
// 「赌它照做」这条路走死了。绝大多数调用都落在这一档：`extract-settle.ts` 会先在服务端
// 等到它好（活体样本的三分之二能等到），所以模型看到的通常就是齐活的那一份。
//
// ## 还在跑的那一档：**这时候绝不能叫模型再调一次**
//
// 走到「还在跑」，说明服务端那 90 秒预算已经花光了（见 `extract-settle.ts`）——也就是说
// 这条视频的画面文字层属于重尾那一批（活体样本里 215s / 578s / 861s 都有）。这时候叫它
// 「过几秒再调一次」是最坏的一句：模型没有 sleep，它会立刻重调，于是每次再冻 90 秒，
// 一条 861 秒的视频要来回十几次。**上一版就是这么写的，那正是「五张卡片」的直接成因。**
// 所以这一档一律叫它**停下来交回给用户**。
//
// 交回去的时候给不给正文，看这条的转写自己站不站得住（`transcriptStandsAlone`，判据由
// 调用方用 `framesGate` 那一份现成的判断算，见 `mcp-extras.ts`）：
//
//   - **站得住**（说话人在指屏幕那类：转写完整，画面上的字是补充）→ 正文照给，另挂一条
//     `on_screen_text: running` 说明还缺一层。扣着一份能读的转写等十几分钟没有道理。
//   - **站不住**（没转写 / 大段没人说话——用户报的那条只有背景音乐的新闻就是这一类）→
//     **不带 result**。这条视频的正文本来就全在画面上，给出去的那点字只会被当成全文总结掉。
//
// 纯函数：不碰 store、不认识 runner。谁去查那条记录是调用方的事。

/** 画面文字层此刻的样子；`undefined` = 这条 item 没有这一层（不是视频 / 还没派生）。 */
export type FramesState = 'queued' | 'running' | 'done' | 'error'

/** 调用方查到的那条 frames 记录（只要这几格）。 */
export interface FramesLayer {
  status: FramesState
  /** 帧文字轨（`done` 才有）。**空数组本身不是证据**——见 `probe`。 */
  track?: Array<{ at: number; text: string }>
  /** 这一层走到哪一级停的（`FramesProbe` 的子集）。
   *
   *  **必须读它，不能只看 `track`。** 这一层是一道逐级止损的梯子，四种「判为不抽」都落
   *  `ok: true` + 空轨（`src/conversions/converters/frames.ts` 头注）。只看空轨就会把
   *  **「没看过画面」讲成「画面上没有字」**——那正是这份回执最不该撒的谎，因为模型会照着
   *  它当场断言"视频里没有文字"，而真相可能是整屏通稿从没被人看过一眼。
   *
   *  活体 2026-08-30（item `091cde94499fbd0b`，丽江通报那条短新闻）：`stop: 'gate'`、
   *  `reason: 'dense_speech'`（378 字/分钟），一帧都没抽，而回执当时说的是「跑过了，
   *  画面上没有转写之外的字」。 */
  probe?: { stop?: string; ocrTried?: number }
}

/** 四级止损各自的人话。键就是 `FramesProbe.stop`（`gate` / `no_source` / `still_picture` /
 *  `no_new_text` / `done`），加一行判据就在这里加一行。 */
const NOT_SCANNED: Record<string, string> = {
  gate: '判为纯口播（语速密集、也没在指屏幕），没去看画面',
  no_source: '拿不到可抽帧的视频源，没抽',
  still_picture: '画面自始至终没变（固定机位），只抽了样、没有逐帧看',
}

/** 画面文字拼进回执时的长度上限。超了截断并指向 `get_conversions` 取全份——
 *  与 `EXTRACT_FULL_TEXT_CHARS` 同一个量级，理由也一样：回执体积是硬约束。 */
export const ON_SCREEN_TEXT_MAX_CHARS = 4000

/** `12.5` → `00:12`。轨里的 `at` 是秒，给模型看时间戳比给小数好对齐。 */
function stamp(at: number): string {
  const total = Math.max(0, Math.round(at))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** 把轨拼成一段带时间戳的文字。空轨返回 `undefined`——「探过没料」不该拼出一个空字符串
 *  装成正文（那读起来像"画面上什么都没有"，而两者在账上必须分得开）。 */
export function onScreenTextOf(track: readonly { at: number; text: string }[] | undefined): string | undefined {
  if (!track || track.length === 0) return undefined
  const joined = track.map((t) => `[${stamp(t.at)}] ${t.text}`).join('\n\n')
  return joined.length <= ON_SCREEN_TEXT_MAX_CHARS ? joined : `${joined.slice(0, ON_SCREEN_TEXT_MAX_CHARS)}…`
}

/**
 * 把画面文字层落到一份 extract 回执上。
 *
 * @param receipt - `extractImpl` 要交出去的那份（digest 之后的形状）。非对象一律原样退回。
 * @param handle - 这次 extract 的句柄（写进回执，深读时要照抄）。
 * @param layer - 画面文字层；`undefined` = 没有这一层，回执原样不动。
 * @param transcriptStandsAlone - 这条的转写离了画面文字能不能单独读（见头注）。只在
 *   「还在跑」那一档起作用；缺省按**站不住**处理——那是更安全的一侧（宁可少给一份正文，
 *   不可让一份零头被当成全文总结掉）。
 * @returns 处理过的回执；不该动时返回**同一个引用**。
 */
export function applyFramesLayer(
  receipt: unknown,
  handle: string,
  layer: FramesLayer | undefined,
  transcriptStandsAlone = false,
): unknown {
  if (layer === undefined) return receipt
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) return receipt
  const rec = receipt as Record<string, unknown>

  // 上游那条 extract 自己都还没好 → 这条本来就要再轮询一次，不用在这儿加戏。
  if (rec.status !== 'done') return receipt

  if (layer.status === 'queued' || layer.status === 'running') {
    // 走到这里 = 服务端已经等满了预算（见头注）。两档都**明确禁止再调一次**。
    const stillRunning
      = '这条视频屏幕上的字（幻灯片/新闻条/烧录字幕/图表数字）是另一层，已经在后台抽了一分多钟还没好——这类长视频要几分钟到十几分钟。'
        + '**别再调 extract 轮询它**（每调一次都要再等一分半，还是等不到），直接告诉用户这一层还在抽、过几分钟再问你要。'
    if (transcriptStandsAlone) {
      return {
        ...rec,
        on_screen_text: {
          status: 'running',
          note: `${stillRunning}上面的转写是完整的，可以先用，但**画面上的字还没算进去**——引用时说明这一点。`,
        },
      }
    }
    // **不带 result**：给了字，模型就会拿这半份去总结（活体 2026-08-30 实测）。
    return {
      status: 'running',
      item: handle,
      waiting_for: 'on_screen_text',
      note:
        `${stillRunning}而且**这条的正文基本全在画面上**（转写为空或大段没人说话），`
        + '现在手里这点字不能拿来总结、也不能据此下任何结论。',
    }
  }

  if (layer.status === 'error') {
    return {
      ...rec,
      on_screen_text: {
        status: 'error',
        note: `这条视频的画面文字那一层跑失败了（详情 get_conversions({item: "${handle}", kind: "frames"})）。这是后端失败，**不等于画面上没有字**——照实说，别当成"视频里没有文字"。`,
      },
    }
  }

  const text = onScreenTextOf(layer.track)
  // 空轨有两种完全不同的意思，**混起来就是在替模型编一句关于内容的断言**（见 `probe`）。
  const notScanned = NOT_SCANNED[layer.probe?.stop ?? '']
  return {
    ...rec,
    on_screen_text:
      text === undefined
        ? notScanned !== undefined
          ? {
              status: 'not_scanned',
              scanned: false,
              why: notScanned,
              note:
                `这一层${notScanned}。**别说"视频里没有文字"**——没人看过，这一格是"没验到"不是"验过了"。`
                + `详情 get_conversions({item: "${handle}", kind: "frames"})。`,
            }
          : {
              status: 'done',
              scanned: true,
              empty: true,
              note: `逐帧看过了（送了 ${layer.probe?.ocrTried ?? 0} 次 OCR），画面上没有转写之外的字。这一条是"验过了"，可以照说。`,
            }
        : {
            status: 'done',
            text,
            note: '屏幕上的字，按时间戳排。**这些字不在上面的转写里**——总结这条视频时必须把它们算进去，很多时候正文全在这儿。',
          },
  }
}
