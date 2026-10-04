import type { StateGraph } from './state-graph.ts'

/**
 * 内置的全局状态图。**与站点无关**——写一次,所有 recipe 都认得(spec §3.5)。
 *
 * Cloudflare 分三档而不是一档,因为它们的处置**相反**:
 *
 * | 档 | 处置 | 混成一档的代价 |
 * |---|---|---|
 * | js-challenge | 等,几秒自己过 | 去点一个不存在的东西 |
 * | turnstile    | 点一下再等     | 干等到超时 |
 * | banned       | **立刻终止**   | **每次运行都耗光整份预算** |
 *
 * 三档靠 `absent` 撑开互斥:更具体的那档在场时,更宽的那档必须为假,否则两档一起命中
 * → 永远 `ambiguous` → 一档都清不掉,而症状是"这个源莫名其妙进冷却"。
 *
 * **特征只用拦截页独有的结构,不用词面**(spec §5)。词面判据会在正常页面上误触,
 * 而全局状态误触**毁的是全部源**,查起来毫无线索。
 *
 * 三档都写了 `group: CF_GROUP`,**为的是不跟本地状态互斥**。省略 `group` 等于落进那个空串
 * 默认组,而默认组的含义是「和所有人互斥」——本地图里没写 group 的状态一并进去,于是
 * 「站点首页」和「CF 封禁页」会被判成撞车。这不是罕见情形:CF 的拦截页是**同源返回**的,
 * URL 一个字都不变,靠 url 特征认的本地状态在封禁页上照样为真。撞车之后 `identify` 回
 * `ambiguous`,死路那一档就永远报不出来。
 */
export const CF_GROUP = 'global/cf'

/** 同一条选择器要出现两次:turnstile 认它「在」,js-challenge 认它「不在」——互斥就是这么撑开的,
 *  两处写岔了就会两档一起命中。点击那条**故意**不含 `input[...]`(那是隐藏的回填字段,点不得)。 */
const TURNSTILE = '.cf-turnstile, #cf-turnstile, input[name="cf-turnstile-response"]'

export const BUILTIN_STATES: StateGraph = {
  states: [
    {
      id: 'cf/js-challenge',
      group: CF_GROUP,
      note: 'Cloudflare 正在跑 JS 挑战，等它自己过',
      features: [
        { kind: 'dom', selector: '#challenge-running, #cf-challenge-running, [id^="cf-chl-widget"]' },
        { kind: 'dom', selector: TURNSTILE, absent: true },
      ],
    },
    {
      id: 'cf/turnstile',
      group: CF_GROUP,
      note: 'Cloudflare Turnstile 要点一下',
      features: [{ kind: 'dom', selector: TURNSTILE }],
    },
    {
      id: 'cf/banned',
      group: CF_GROUP,
      // 死路:认出来就停。这一档再等也没用，多等一秒都是白花的。
      deadEnd: 'Cloudflare 已封禁这个出口（1020 / blocked），这条路今天走不通',
      features: [
        { kind: 'dom', selector: '.cf-error-overview, #cf-error-details, [data-translate="error"]' },
      ],
    },
  ],
  transitions: [
    // 逃生口:都没有 `to`——清完落在哪取决于本来要去哪。
    { from: 'cf/js-challenge', steps: [{ kind: 'wait', ms: 6000 }] },
    {
      from: 'cf/turnstile',
      steps: [
        // **先等再点,不是保守是必须。** 在 widget 就绪之前点下去会把它**打进失败态**,
        // 之后重做多少次全废;而"就绪没有"从 DOM 里看不出来——实测对话框打开后 DOM 连续
        // 9.3 秒一个字节不动,复选框却正从「空」→「转圈」→「可点」。页面不肯说,但它在画。
        // 逃生口的词汇里没有 `settle`(那是动作步才有的),所以这里用一个固定的等。
        { kind: 'wait', ms: 3000 },
        // **靶子是 CF 自己命名的那个隐藏 input 的父元素,不是站点容器。**
        // `#cf-turnstile` 是站点自己起的名(Groq 恰好这么叫),换个站就叫别的;
        // `input[name="cf-turnstile-response"]` 才是 CF 的命名,跨站点稳定。
        // widget 活在 closed shadow root 里,内部一个节点都查不到——"宿主 rect + 偏移"
        // 是唯一可行的定位法,不是偷懒。
        {
          kind: 'click',
          selector: ':has(> input[name="cf-turnstile-response"])',
          // widget 实测 300×72,复选框在**最左侧**方块区,中间是「请验证您是真人」那行字。
          // 点中心 = 点在文字上,实测 12 秒无反应;左侧一秒通过。36 = 72/2,横纵都取半个行高。
          position: { x: 36, y: 36 },
        },
        { kind: 'wait', ms: 4000 },
      ],
    },
  ],
}
