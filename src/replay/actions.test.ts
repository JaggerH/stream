import { describe, it, expect } from 'vitest'
import {
  runActions,
  RecipeGuardError,
  FeatureDriftError,
  ScrollStuckError,
  StepExpectError,
  makeRandom,
  type PageDriver,
  type RandomSource
} from './actions.ts'
import type { RecipeAction } from './recipe.ts'

// Helper fake driver
class FakePageDriver implements PageDriver {
  calls: { name: string; args: any[] }[] = [];
  existsMap: Record<string, boolean> = {};
  onScrollOnce?: () => void;

  async goto(url: string, waitUntil?: string): Promise<void> {
    this.calls.push({ name: 'goto', args: [url, waitUntil] });
  }
  async scrollOnce(px: number): Promise<void> {
    this.calls.push({ name: 'scrollOnce', args: [px] });
    if (this.onScrollOnce) this.onScrollOnce();
  }
  async openItem(selector: string, index: number): Promise<void> {
    this.calls.push({ name: 'openItem', args: [selector, index] });
  }
  clickHits = true;
  async click(selector: string, position?: { x: number; y: number }): Promise<boolean> {
    this.calls.push({ name: 'click', args: [selector, position] });
    return this.clickHits;
  }
  async back(): Promise<void> {
    this.calls.push({ name: 'back', args: [] });
  }
  typeHits = true;
  async type(selector: string, text: string): Promise<boolean> {
    this.calls.push({ name: 'type', args: [selector, text] });
    return this.typeHits;
  }
  submitHits = true;
  async submit(selector: string): Promise<boolean> {
    this.calls.push({ name: 'submit', args: [selector] });
    return this.submitHits;
  }
  async sleep(ms: number): Promise<void> {
    this.calls.push({ name: 'sleep', args: [ms] });
  }
  async exists(selector: string): Promise<boolean> {
    this.calls.push({ name: 'exists', args: [selector] });
    return this.existsMap[selector] !== false; // defaults to true unless specified
  }
  async moveMouse(x: number, y: number): Promise<void> {
    this.calls.push({ name: 'moveMouse', args: [x, y] });
  }
  async setFiles(selector: string, paths: string[]): Promise<{ name: string; type: string; size: number }[]> {
    this.calls.push({ name: 'setFiles', args: [selector, paths] });
    return paths.map((p) => ({ name: p.split(/[\\/]/).pop()!, type: 'image/png', size: 7 }));
  }
}

describe('actions runner', () => {
  it('scroll stops on each of the three conditions', async () => {
    // 1. Target reached condition
    {
      const driver = new FakePageDriver();
      const action: RecipeAction = {
        kind: 'scroll',
        dwell_s: [1, 2],
        maxTimes: 10,
        noProgressStop: 3
      };
      // Stub rnd to return fixed values
      const rnd: RandomSource = {
        int: (min, max) => min
      };
      // harvest target reached after 2 scrolls
      let count = 0;
      const harvest = {
        get done() {
          return count >= 2;
        },
        get size() {
          return count;
        }
      };
      driver.onScrollOnce = () => {
        count++;
      };
      const trace = await runActions([action], driver, rnd, harvest, { cookieDomain: 'example.com' });
      expect(trace[0].note).toBe('scroll stop: target reached after 2');
      expect(driver.calls.filter(c => c.name === 'scrollOnce').length).toBe(2);
    }

    // 2. No progress stop condition
    {
      const driver = new FakePageDriver();
      const action: RecipeAction = {
        kind: 'scroll',
        dwell_s: [1, 2],
        maxTimes: 10,
        noProgressStop: 3
      };
      const rnd: RandomSource = {
        int: (min, max) => min
      };
      // harvest size never increases
      const harvest = {
        done: false,
        size: 5
      };
      const trace = await runActions([action], driver, rnd, harvest, { cookieDomain: 'example.com' });
      expect(trace[0].note).toBe('scroll stop: no progress after 3');
      expect(driver.calls.filter(c => c.name === 'scrollOnce').length).toBe(3);
    }

    // 3. Max times reached condition
    {
      const driver = new FakePageDriver();
      const action: RecipeAction = {
        kind: 'scroll',
        dwell_s: [1, 2],
        maxTimes: 5,
        noProgressStop: 10
      };
      const rnd: RandomSource = {
        int: (min, max) => min
      };
      // harvest size increases slowly, doesn't hit target
      let size = 0;
      const harvest = {
        done: false,
        get size() {
          return ++size;
        }
      };
      const trace = await runActions([action], driver, rnd, harvest, { cookieDomain: 'example.com' });
      expect(trace[0].note).toBe('scroll stop: max times reached after 5');
      expect(driver.calls.filter(c => c.name === 'scrollOnce').length).toBe(5);
    }
  });

  // A driver that reports scroll geometry — turns on the geometry-driven control loop.
  // The state machine's stop/continue decision is DOM-based (scroll position + loaded
  // height), not "did the XHR harvest grow", so "flat harvest" no longer means "stop".
  class GeomDriver extends FakePageDriver {
    scrollY = 0;
    scrollHeight = 100000;
    viewportH = 800;
    async scrollProbe() {
      return { scrollY: this.scrollY, viewportH: this.viewportH, scrollHeight: this.scrollHeight };
    }
  }

  it('does not scroll at all when the harvest already reached its target', async () => {
    // An entry observer can hand over the whole SSR first batch before a single scroll (xhs feeds
    // its first ~33 notes into __INITIAL_STATE__ and never requests them). Scrolling anyway burns a
    // dwell and drags more feed into a browsing session that never asked for it.
    const driver = new GeomDriver();
    const rnd: RandomSource = { int: (min) => min };
    const harvest = { done: true, size: 33 };
    const action: RecipeAction = { kind: 'scroll', dwell_s: [2, 4], maxTimes: 20, noProgressStop: 3 };
    const trace = await runActions([action], driver, rnd, harvest, { cookieDomain: 'x.com' });
    expect(trace[0].note).toBe('scroll skipped: target already reached (33)');
    expect(driver.calls.filter(c => c.name === 'scrollOnce').length).toBe(0);
  });

  it('keeps scrolling past flat rounds while below the loaded bottom (fixes "没滚够")', async () => {
    // Feed is far taller than the viewport; each scroll really advances the page but the
    // harvest count stays flat. OLD logic quit at noProgressStop=3; the fix must keep going
    // (a flat round below the bottom = "haven't reached the load trigger", not "the end").
    const driver = new GeomDriver();
    driver.onScrollOnce = () => { driver.scrollY += 800; };
    const rnd: RandomSource = { int: (min) => min };
    const harvest = { done: false, size: 5 };
    const action: RecipeAction = { kind: 'scroll', dwell_s: [0, 0], maxTimes: 5, noProgressStop: 3 };
    const trace = await runActions([action], driver, rnd, harvest, { cookieDomain: 'x.com' });
    expect(trace[0].note).toBe('scroll stop: max times reached after 5');
    expect(driver.calls.filter(c => c.name === 'scrollOnce').length).toBe(5);
  });

  it('stops at "reached end" when at the loaded bottom and nothing new loads', async () => {
    const driver = new GeomDriver();
    driver.scrollHeight = 1000;
    driver.scrollY = 1000; // already at the bottom of loaded content
    driver.onScrollOnce = () => { driver.scrollY = 1000; };
    const rnd: RandomSource = { int: (min) => min };
    const harvest = { done: false, size: 5 };
    const action: RecipeAction = { kind: 'scroll', dwell_s: [0, 0], maxTimes: 20, noProgressStop: 3 };
    const trace = await runActions([action], driver, rnd, harvest, { cookieDomain: 'x.com' });
    expect(trace[0].note).toBe('scroll stop: reached end after 3');
    expect(driver.calls.filter(c => c.name === 'scrollOnce').length).toBe(3);
  });

  it('resets the at-bottom stall when a new batch loads', async () => {
    const driver = new GeomDriver();
    driver.scrollHeight = 1000;
    driver.scrollY = 1000;
    let size = 5;
    let round = 0;
    driver.onScrollOnce = () => {
      round++;
      if (round === 3) { driver.scrollHeight = 2000; size += 1; } // batch lands: grew + no longer at bottom
      else if (round > 3) driver.scrollY = 2000;                  // walk down to the new bottom
    };
    const rnd: RandomSource = { int: (min) => min };
    const harvest = { done: false, get size() { return size; } };
    const action: RecipeAction = { kind: 'scroll', dwell_s: [0, 0], maxTimes: 10, noProgressStop: 3 };
    const trace = await runActions([action], driver, rnd, harvest, { cookieDomain: 'x.com' });
    // Without the reset it would stop 'reached end after 4'; the round-3 batch resets the
    // stall, so the end is only declared after 3 more flat bottoms → after 6.
    expect(trace[0].note).toBe('scroll stop: reached end after 6');
  });

  it('records per-scroll stats (count, dwell, at-bottom rounds, size curve) on the trace', async () => {
    const driver = new GeomDriver();
    driver.scrollHeight = 1000;
    driver.scrollY = 1000;
    let size = 0;
    driver.onScrollOnce = () => { size += size < 2 ? 1 : 0; }; // grows to 2 then flat
    const rnd: RandomSource = { int: (min) => min };
    const harvest = { done: false, get size() { return size; } };
    const action: RecipeAction = { kind: 'scroll', dwell_s: [3, 3], maxTimes: 20, noProgressStop: 3 };
    const trace = await runActions([action], driver, rnd, harvest, { cookieDomain: 'x.com' });
    const s = trace[0].scroll!;
    expect(s.scrolls).toBe(s.sizeCurve.length);
    expect(s.sizeCurve).toEqual([1, 2, 2, 2, 2]); // grew to 2, then 3 flat at-bottom rounds → end
    expect(s.atBottomRounds).toBe(5);
    expect(s.dwellMs).toBe(s.scrolls * 3000);
    expect(s.stopReason).toContain('reached end');
  });

  it('bails as stuck when the page will not scroll and we are not at the bottom', async () => {
    const driver = new GeomDriver();
    driver.onScrollOnce = () => { /* scrollY stays 0 — the scroll isn't moving the page */ };
    const rnd: RandomSource = { int: (min) => min };
    const harvest = { done: false, size: 0 };
    const action: RecipeAction = { kind: 'scroll', dwell_s: [0, 0], maxTimes: 20, noProgressStop: 3 };
    await expect(
      runActions([action], driver, rnd, harvest, { cookieDomain: 'x.com' })
    ).rejects.toThrow(ScrollStuckError);
  });

  it('off-domain goto throws RecipeGuardError', async () => {
    const driver = new FakePageDriver();
    const action: RecipeAction = { kind: 'goto', url: 'https://malicious.com/hack' };
    const rnd: RandomSource = { int: (min, max) => min };
    const harvest = { done: false, size: 0 };

    await expect(
      runActions([action], driver, rnd, harvest, { cookieDomain: 'example.com' })
    ).rejects.toThrow(RecipeGuardError);

    // Valid subdomain/domain matches should pass
    const validAction: RecipeAction = { kind: 'goto', url: 'https://sub.example.com/ok' };
    await runActions([validAction], driver, rnd, harvest, { cookieDomain: 'example.com' });
    expect(driver.calls[0].name).toBe('goto');
    expect(driver.calls[0].args[0]).toBe('https://sub.example.com/ok');
  });

  it('openItems draws count via rnd and calls back per item', async () => {
    const driver = new FakePageDriver();
    const action: RecipeAction = {
      kind: 'openItems',
      selector: '.item',
      count: [2, 5],
      dwell_s: [1, 3],
      back: true
    };
    const values = [3, 0, 1, 1, 2, 2, 3]; // n=3, then index=0, dwell=1, index=1, dwell=2, index=2, dwell=3
    let valIdx = 0;
    const rnd: RandomSource = {
      int: (min, max) => values[valIdx++]
    };
    const harvest = { done: false, size: 0 };

    const trace = await runActions([action], driver, rnd, harvest, { cookieDomain: 'example.com' });
    expect(trace[0].draws).toEqual([3, 0, 1, 1, 2, 2, 3]);

    const openCalls = driver.calls.filter(c => c.name === 'openItem');
    const backCalls = driver.calls.filter(c => c.name === 'back');
    expect(openCalls.length).toBe(3);
    expect(backCalls.length).toBe(3);
    expect(openCalls[0].args).toEqual(['.item', 0]);
    expect(openCalls[1].args).toEqual(['.item', 1]);
    expect(openCalls[2].args).toEqual(['.item', 2]);
  });

  it('feature.exists=false throws FeatureDriftError with step index', async () => {
    const driver = new FakePageDriver();
    driver.existsMap['.search-btn'] = false; // missing feature

    const actions: RecipeAction[] = [
      { kind: 'submit', selector: '.form' },
      { kind: 'type', selector: '.search-input', text: 'query', feature: { selector: '.search-btn' } }
    ];
    const rnd: RandomSource = { int: (min, max) => min };
    const harvest = { done: false, size: 0 };

    try {
      await runActions(actions, driver, rnd, harvest, { cookieDomain: 'example.com' });
      expect.fail('Should have thrown FeatureDriftError');
    } catch (err) {
      expect(err).toBeInstanceOf(FeatureDriftError);
      const driftErr = err as FeatureDriftError;
      expect(driftErr.step).toBe(1);
      expect(driftErr.feature.selector).toBe('.search-btn');
    }
  });

  it("goto url '{kw}' hole substituted from opts.params", async () => {
    const driver = new FakePageDriver();
    const action: RecipeAction = { kind: 'goto', url: 'https://example.com/search?q={kw}' };
    const rnd: RandomSource = { int: (min, max) => min };
    const harvest = { done: false, size: 0 };

    await runActions([action], driver, rnd, harvest, {
      cookieDomain: 'example.com',
      params: { kw: 'hello-world' }
    });

    expect(driver.calls[0].name).toBe('goto');
    expect(driver.calls[0].args[0]).toBe('https://example.com/search?q=hello-world');
  });

  // `click` = 点一个具名元素（操作表单需要的那个动作），与 openItems「打开信息流第 N 条」不是一回事。
  it('click 把 position 原样交给 driver；省略即 undefined（= 中心，今天的行为）', async () => {
    const driver = new FakePageDriver();
    const rnd: RandomSource = { int: (min) => min };
    const harvest = { done: false, size: 0 };

    const actions: RecipeAction[] = [
      { kind: 'click', selector: '#create' },
      { kind: 'click', selector: '#widget', position: { x: 36, y: 36 } },
    ];
    await runActions(actions, driver, rnd, harvest, { cookieDomain: 'example.com' });

    const clicks = driver.calls.filter(c => c.name === 'click');
    expect(clicks.map(c => c.args)).toEqual([
      ['#create', undefined],
      ['#widget', { x: 36, y: 36 }],
    ]);
  });

  it('click 没命中任何元素 → trace 里说清楚，而不是静默继续', async () => {
    const driver = new FakePageDriver();
    driver.clickHits = false;
    const rnd: RandomSource = { int: (min) => min };
    const harvest = { done: false, size: 0 };

    const trace = await runActions([{ kind: 'click', selector: '#gone' }], driver, rnd, harvest, {
      cookieDomain: 'example.com',
    });
    expect(trace[0].kind).toBe('click');
    expect(trace[0].note).toContain('#gone');
  });

  it('type 没命中任何元素 → trace 里说清楚，而不是静默把文本打到别处', async () => {
    const driver = new FakePageDriver();
    driver.typeHits = false;
    const rnd: RandomSource = { int: (min) => min };
    const harvest = { done: false, size: 0 };

    const trace = await runActions([{ kind: 'type', selector: '#gone', text: 'hi' }], driver, rnd, harvest, {
      cookieDomain: 'example.com',
    });
    expect(trace[0].kind).toBe('type');
    expect(trace[0].note).toContain('#gone');
  });

  it('setFiles：{files} 按换行拆成多条路径交给 driver，trace 记下页面真拿到的文件', async () => {
    const driver = new FakePageDriver();
    const rnd: RandomSource = { int: (min) => min };
    const harvest = { done: false, size: 0 };

    const trace = await runActions([{ kind: 'setFiles', selector: '#stream-files', paths: '{files}' }], driver, rnd, harvest, {
      cookieDomain: 'example.com',
      params: { files: 'C:\\a\\层1.png\n\nC:\\a\\层2.png\n' },
    });
    expect(driver.calls.find((c) => c.name === 'setFiles')?.args).toEqual(['#stream-files', ['C:\\a\\层1.png', 'C:\\a\\层2.png']]);
    expect(trace[0].kind).toBe('setFiles');
    expect(trace[0].note).toContain('2 file(s)');
    expect(trace[0].note).toContain('层2.png');
  });

  it('setFiles：参数为空 → 跳过、不碰 driver，但 trace 里说了', async () => {
    const driver = new FakePageDriver();
    const rnd: RandomSource = { int: (min) => min };
    const harvest = { done: false, size: 0 };

    const trace = await runActions([{ kind: 'setFiles', selector: '#stream-files', paths: '{files}' }], driver, rnd, harvest, {
      cookieDomain: 'example.com',
      params: { files: '' },
    });
    expect(driver.calls.some((c) => c.name === 'setFiles')).toBe(false);
    expect(trace[0].note).toContain('skipped');
  });

  it('setFiles：参数袋里根本没有这个洞 → 字面 "{files}" 不许当路径交给 CDP（它对不存在的路径不报错），当没给', async () => {
    const driver = new FakePageDriver();
    const rnd: RandomSource = { int: (min) => min };
    const harvest = { done: false, size: 0 };

    const trace = await runActions([{ kind: 'setFiles', selector: '#stream-files', paths: '{files}' }], driver, rnd, harvest, {
      cookieDomain: 'example.com',
      params: {},
    });
    expect(driver.calls.some((c) => c.name === 'setFiles')).toBe(false);
    expect(trace[0].note).toContain('{files} 没填上');
  });

  it('setFiles：driver 说不了 CDP → 抛，不静默跳过', async () => {
    const driver = new FakePageDriver();
    (driver as { setFiles?: unknown }).setFiles = undefined;
    const rnd: RandomSource = { int: (min) => min };
    const harvest = { done: false, size: 0 };

    await expect(
      runActions([{ kind: 'setFiles', selector: '#stream-files', paths: 'C:\\a.png' }], driver, rnd, harvest, { cookieDomain: 'example.com' }),
    ).rejects.toThrow(/setFiles/);
  });

  it('submit 没命中任何元素 → trace 里说清楚', async () => {
    const driver = new FakePageDriver();
    driver.submitHits = false;
    const rnd: RandomSource = { int: (min) => min };
    const harvest = { done: false, size: 0 };

    const trace = await runActions([{ kind: 'submit', selector: '#gone' }], driver, rnd, harvest, {
      cookieDomain: 'example.com',
    });
    expect(trace[0].kind).toBe('submit');
    expect(trace[0].note).toContain('#gone');
  });

  // step.expect —— 步骤级"等它引发的事发生"。补的是一个真实缺口:feature 只查一次(漂移检测),
  // observeOpened/waitForFeature 是真等待但 recipe 够不着。语义抄 Playwright 的 waitFor({state})。
  describe('step.expect', () => {
    /** exists 在第 `flipAt` 次调用起翻面 —— 用来模拟"迟到才出现"和"过一会儿才消失"。 */
    class FlipDriver extends FakePageDriver {
      n = 0
      constructor(private readonly flipAt: number, private readonly initial: boolean) { super() }
      async exists(): Promise<boolean> {
        return ++this.n >= this.flipAt ? !this.initial : this.initial
      }
    }
    const rnd: RandomSource = { int: (min) => min }
    const harvest = { done: false, size: 0 }
    /** 拿到抛出的那个错误本身（要断言消息内容时用；没抛就是测试失败）。 */
    const caught = async (p: Promise<unknown>): Promise<Error> => {
      try { await p } catch (e) { return e as Error }
      throw new Error('expected a throw, got none')
    }

    it('特征迟到几轮才出现 → 等到它,步骤继续', async () => {
      const driver = new FlipDriver(3, false)
      const trace = await runActions(
        [{ kind: 'click', selector: '#go', expect: { selector: '#late', timeout: 2000 } }],
        driver, rnd, harvest, { cookieDomain: 'x.com' },
      )
      expect(driver.n).toBeGreaterThanOrEqual(3)
      expect(trace[0].note).toContain('expect ok')
    })

    it("state:'gone' 等它消失 —— Turnstile 过了之后那个隐藏 input 就是直接从 DOM 移除的", async () => {
      const driver = new FlipDriver(2, true)
      const trace = await runActions(
        [{ kind: 'click', selector: '#go', expect: { selector: '#widget', state: 'gone', timeout: 2000 } }],
        driver, rnd, harvest, { cookieDomain: 'x.com' },
      )
      expect(trace[0].note).toContain('expect ok')
    })

    // ↓ 判据的**区分力**。活体代价见 recipe.ts 的 StepExpect.alreadyThere：一个动作前就成立的
    // expect 永远不会失败,四步全绿而结果全错,失败最后以两步之外的另一副面孔出现。
    it('判据在动作前就已成立 → 当场断,并说清它恒真（而不是一路绿到底）', async () => {
      class AlwaysThere extends FakePageDriver {
        clicked = 0
        async exists(): Promise<boolean> { return true }
        async click(): Promise<boolean> { this.clicked++; return true }
      }
      const driver = new AlwaysThere()
      await expect(runActions(
        [{ kind: 'click', selector: '#go', expect: { selector: '#already', timeout: 500 } }],
        driver, rnd, harvest, { cookieDomain: 'x.com' },
      )).rejects.toThrow(/恒真|动作前/)
      expect(driver.clicked).toBe(0) // 断在动手之前 —— 判据不成立就别去改页面状态
    })

    it('显式 alreadyThere:true → 放行（作者说了他知道它本来就在）', async () => {
      class AlwaysThere extends FakePageDriver {
        async exists(): Promise<boolean> { return true }
      }
      const trace = await runActions(
        [{ kind: 'click', selector: '#go', expect: { selector: '#already', alreadyThere: true, timeout: 500 } }],
        new AlwaysThere(), rnd, harvest, { cookieDomain: 'x.com' },
      )
      expect(trace[0].note).toContain('expect ok')
    })

    // "列表里多了一行"用 present 表达必然恒真（选择器本来就命中着旧的那些行）。这是那次事故里
    // 真正需要的判据形状：数量必须**严格变多**。
    it('countIncreases:动作后命中数必须严格大于动作前', async () => {
      let n = 2
      class Rows extends FakePageDriver {
        async click(): Promise<boolean> { n = 3; return true }
        async evalJson(): Promise<unknown> { return n }
      }
      const trace = await runActions(
        [{ kind: 'click', selector: '#new', expect: { selector: 'tr', countIncreases: true, timeout: 2000 } }],
        new Rows(), rnd, harvest, { cookieDomain: 'x.com' },
      )
      expect(trace[0].note).toContain('expect ok')
      expect(trace[0].note).toContain('2→3')
    })

    it('countIncreases:数量没变 → 断。这正是"确定点了但没建成"的那一刻', async () => {
      class Stuck extends FakePageDriver {
        async evalJson(): Promise<unknown> { return 2 }
      }
      const err = await caught(runActions(
        [{ kind: 'click', selector: '#new', expect: { selector: 'tr', countIncreases: true, timeout: 300 } }],
        new Stuck(), rnd, harvest, { cookieDomain: 'x.com' },
      ))
      expect(err).toBeInstanceOf(StepExpectError)
      // 报的必须是它**实际量的那件事**：数量没变多（2→2），不是"元素没出现"——那个选择器一直都在。
      expect(err.message).toContain('没有变多')
      expect(err.message).toContain('2→2')
      expect(err.message).not.toContain('没有出现')
    })

    // 站点几乎总会说清它为什么拒绝，而那句话活不过几秒 —— 等判据超时（15s）再去看，证据早过期了。
    // 活体：智谱建 key 弹「创建失败，apiKey名称[…]重复」，3 秒消失，失败截图只拍到一个空壳弹窗。
    it('errorSurface:等待期间站点喊的那句话被带进失败消息', async () => {
      let ticks = 0
      class Toasting extends FakePageDriver {
        async exists(): Promise<boolean> { return false }
        async evalJson(expr: string): Promise<unknown> {
          // toast 只在头两轮存在，之后消失 —— 正是它骗过"事后再看"的方式
          if (expr.includes('.el-message')) return ++ticks <= 2 ? ['创建失败，apiKey名称[x]重复'] : []
          return 0
        }
      }
      const err = await caught(runActions(
        [{ kind: 'click', selector: '#ok', expect: { selector: '#row', errorSurface: '.el-message', timeout: 600 } }],
        new Toasting(), rnd, harvest, { cookieDomain: 'x.com' },
      ))
      expect(err.message).toContain('站点报错')
      expect(err.message).toContain('名称[x]重复')
    })

    it('errorSurface 声明了、但一条报错都没出现 → 说出这件事（动作可能根本没抵达）', async () => {
      class Silent extends FakePageDriver {
        async exists(): Promise<boolean> { return false }
        async evalJson(): Promise<unknown> { return [] }
      }
      const err = await caught(runActions(
        [{ kind: 'click', selector: '#ok', expect: { selector: '#row', errorSurface: '.el-message', timeout: 300 } }],
        new Silent(), rnd, harvest, { cookieDomain: 'x.com' },
      ))
      expect(err.message).toContain('一条都没出现')
    })

    // settle:动作前的闸门。判据是"变过了 + 停住了",逐帧比字节 —— 因为 Turnstile 的 widget 在
    // closed shadow root 里,DOM 什么都看不见,但它在画。
    it('settle:空 → 转圈(每帧都变) → 定住,等到定住才动手', async () => {
      const frames = ['empty', 'empty', 'spin1', 'spin2', 'spin3', 'ready', 'ready', 'ready', 'ready']
      let i = 0
      class Painted extends FakePageDriver {
        clickedAt = -1
        async shotOf(): Promise<string | null> { return frames[Math.min(i++, frames.length - 1)] }
        async click(): Promise<boolean> { this.clickedAt = i; return true }
      }
      const driver = new Painted()
      const trace = await runActions(
        [{ kind: 'click', selector: '#cb', settle: { selector: '#cb', stableFrames: 3, intervalMs: 0 } }],
        driver, rnd, harvest, { cookieDomain: 'x.com' },
      )
      expect(trace[0].note).toContain('settle settled')
      // 'ready' 连着出现三帧之后才点 —— 转圈那几帧每帧都变,不会被误当成"停住"
      expect(driver.clickedAt).toBeGreaterThanOrEqual(8)
    })

    it("settle:一直是初始那一帧 → 不能算「停住了」（它只是还没开始画）", async () => {
      class Never extends FakePageDriver {
        async shotOf(): Promise<string | null> { return 'empty' }
      }
      const trace = await runActions(
        [{ kind: 'click', selector: '#cb', settle: { selector: '#cb', stableFrames: 2, intervalMs: 0, timeout: 30 } }],
        new Never(), rnd, harvest, { cookieDomain: 'x.com' },
      )
      expect(trace[0].note).toContain('settle timeout')
    })

    /**
     * `alreadyStable` —— 显式放宽掉"变过了"那一半。
     *
     * 存在的理由：变化由**上一步**触发（点一下那张图，它重新加载），而上一步自己比那次重绘
     * 还慢时，等这一步开始看，画面早就是终态了 —— 基线就是终态，"变过了"永远不成立，于是
     * 必然空等到 timeout 再放行，**而且全程静默**（timeout 不致命）。活体（2026-09-03，
     * 东财登录）：连续三次 step#1 都是 15.0s+，探针打开才看见
     * `settle timeout 15056ms/52帧` —— 52 帧一次都没变过，而那一步真正干活只要 2.7 秒。
     *
     * 上面那条「一直是初始那一帧 → timeout」是它的对照：**同一份画面序列，只差这个开关**，
     * 一个 timeout、一个当场 settled。两条一起才说清这个开关到底放宽了什么。
     */
    it('settle:开了 alreadyStable → 一直是同一帧就算「停住了」，不再空等到超时', async () => {
      class Never extends FakePageDriver {
        async shotOf(): Promise<string | null> { return 'empty' }
      }
      const trace = await runActions(
        [{ kind: 'click', selector: '#cb', settle: { selector: '#cb', stableFrames: 2, intervalMs: 0, timeout: 30, alreadyStable: true } }],
        new Never(), rnd, harvest, { cookieDomain: 'x.com' },
      )
      expect(trace[0].note).toContain('settle settled')
    })

    /**
     * `click.synthetic` —— 不发真鼠标，页内 `el.click()`。
     *
     * 存在的理由是三个数量级的差距（活体 2026-09-03 东财登录，同一轮运行）：可信点击是 11 次
     * 往返，每个鼠标事件都要浏览器先做命中测试、而命中测试要等一帧，后台标签没帧可等 ——
     * 7.0–35.1 秒；同一轮里 `type`（键盘，不需要命中测试）只要 9–164ms。
     */
    it('click.synthetic:页内 el.click()，一条鼠标事件都不发', async () => {
      const seen: string[] = []
      class Ev extends FakePageDriver {
        async evalJson(expr: string): Promise<unknown> { seen.push(expr); return true }
        async click(): Promise<boolean> { throw new Error('不该走可信点击') }
      }
      const trace = await runActions(
        [{ kind: 'click', selector: '#go', synthetic: true }],
        new Ev(), rnd, harvest, { cookieDomain: 'x.com' },
      )
      expect(trace[0].note).toContain('click(synthetic) ok: #go')
      expect(seen[0]).toContain('el.click()')
    })

    /** 选择器没命中要如实报 missed，不能因为"求值成功了"就当成点到了。 */
    it('click.synthetic:元素不在 → missed，不是静默成功', async () => {
      class None extends FakePageDriver {
        async evalJson(): Promise<unknown> { return false }
      }
      const trace = await runActions(
        [{ kind: 'click', selector: '#nope', synthetic: true }],
        new None(), rnd, harvest, { cookieDomain: 'x.com' },
      )
      expect(trace[0].note).toContain('click(synthetic) missed')
    })

    /**
     * 驱动不支持页内求值 → **硬失败**，绝不悄悄退回可信点击。
     * 退回去等于把一个已经声明"我要快"的步骤又变回 7–35 秒，且没有一处会说它没生效。
     */
    it('click.synthetic:驱动不会页内求值 → 抛，不退回可信点击', async () => {
      class NoEval extends FakePageDriver {
        evalJson = undefined
        async click(): Promise<boolean> { throw new Error('不该走可信点击') }
      }
      await expect(runActions(
        [{ kind: 'click', selector: '#go', synthetic: true }],
        new NoEval() as never, rnd, harvest, { cookieDomain: 'x.com' },
      )).rejects.toThrow(/evalJson|页内求值/)
    })

    /** 放宽的只有"变过了"那一半：**转圈那种每帧都在变的照样等**，否则它就成了恒真闸门。 */
    it('settle:开了 alreadyStable 仍要求连着几帧不变（转圈的不放行）', async () => {
      let i = 0
      class Spinning extends FakePageDriver {
        async shotOf(): Promise<string | null> { return `f${i++}` } // 每帧都不同
      }
      const trace = await runActions(
        [{ kind: 'click', selector: '#cb', settle: { selector: '#cb', stableFrames: 2, intervalMs: 0, timeout: 30, alreadyStable: true } }],
        new Spinning(), rnd, harvest, { cookieDomain: 'x.com' },
      )
      expect(trace[0].note).toContain('settle timeout')
    })

    // 活体教训:step#0 的 expect 在元素**刚挂上 DOM** 时就满足,那一瞬 rect 还是 0x0、截不出图。
    // 早先把 null 当"元素不在"直接放弃,闸门形同虚设(实测 3ms 就放行),又变成早点。
    it('settle:元素刚挂上还没有盒子 → 继续等,不是当作"不在"直接放行', async () => {
      const seq: (string | null)[] = [null, null, null, 'empty', 'spin', 'ready', 'ready', 'ready']
      let i = 0
      class LateLayout extends FakePageDriver {
        clickedAt = -1
        async shotOf(): Promise<string | null> { return seq[Math.min(i++, seq.length - 1)] }
        async click(): Promise<boolean> { this.clickedAt = i; return true }
      }
      const driver = new LateLayout()
      const trace = await runActions(
        [{ kind: 'click', selector: '#cb', settle: { selector: '#cb', stableFrames: 2, intervalMs: 0 } }],
        driver, rnd, harvest, { cookieDomain: 'x.com' },
      )
      expect(trace[0].note).toContain('settle settled')
      expect(driver.clickedAt).toBeGreaterThanOrEqual(7) // 等到 'ready' 连着两帧
    })

    it('settle:driver 不会截图 → 说 unsupported,不假装等过了', async () => {
      const trace = await runActions(
        [{ kind: 'click', selector: '#cb', settle: { selector: '#cb' } }],
        new FakePageDriver(), rnd, harvest, { cookieDomain: 'x.com' },
      )
      expect(trace[0].note).toContain('settle unsupported')
    })

    it('retryEvery:目标还没准备好接手势时,重做动作而不是干等', async () => {
      // Turnstile 的复选框约 2s 才可点,而这 2s 里 DOM 一个字节不动 —— 没有信号可等。
      // 模拟:前两次点击无效,第三次才让 expect 满足。
      class LateTarget extends FakePageDriver {
        clicks = 0
        async click(): Promise<boolean> { this.clicks++; return true }
        async exists(): Promise<boolean> { return this.clicks >= 3 }
      }
      const driver = new LateTarget()
      const trace = await runActions(
        [{ kind: 'click', selector: '#cb', expect: { selector: '#submit', timeout: 3000, retryEvery: 20 } }],
        driver, rnd, harvest, { cookieDomain: 'x.com' },
      )
      expect(driver.clicks).toBe(3)
      expect(trace[0].note).toContain('第 3 次动作后')
    })

    it('不带 retryEvery → 只等,动作只做一次', async () => {
      class Once extends FakePageDriver {
        clicks = 0
        n = 0
        async click(): Promise<boolean> { this.clicks++; return true }
        async exists(): Promise<boolean> { return ++this.n >= 3 }
      }
      const driver = new Once()
      await runActions(
        [{ kind: 'click', selector: '#cb', expect: { selector: '#s', timeout: 2000 } }],
        driver, rnd, harvest, { cookieDomain: 'x.com' },
      )
      expect(driver.clicks).toBe(1)
    })

    it('stepIndex:报错指向它在整份 recipe 里的真实下标(runner 一步一调,本地下标恒为 0)', async () => {
      const driver = new FakePageDriver()
      driver.existsMap['#never'] = false
      await expect(
        runActions([{ kind: 'click', selector: '#b', expect: { selector: '#never', timeout: 30 } }],
          driver, rnd, harvest, { cookieDomain: 'x.com', stepIndex: 3 }),
      ).rejects.toThrow(/step#3 /)
    })

    it('上限内没发生 → 就在这一步断掉,报出是哪一步、等的是什么', async () => {
      const driver = new FakePageDriver()
      driver.existsMap['#never'] = false
      const actions: RecipeAction[] = [
        { kind: 'click', selector: '#a' },
        { kind: 'click', selector: '#b', expect: { selector: '#never', timeout: 40 } },
        { kind: 'click', selector: '#c' },
      ]
      await expect(runActions(actions, driver, rnd, harvest, { cookieDomain: 'x.com' })).rejects.toThrow(
        /step#1 expect 未满足：#never/,
      )
      // 断在这里就不该再往下走 —— 后面那些步骤只会以无关的症状失败
      expect(driver.calls.filter((c) => c.name === 'click').map((c) => c.args[0])).toEqual(['#a', '#b'])
    })
  })

  it('makeRandom same seed → identical draws across two runs', () => {
    const seed = 42;
    const r1 = makeRandom(seed);
    const r2 = makeRandom(seed);

    const draws1: number[] = [];
    const draws2: number[] = [];

    for (let i = 0; i < 50; i++) {
      draws1.push(r1.int(1, 1000));
      draws2.push(r2.int(1, 1000));
    }

    expect(draws1).toEqual(draws2);
  });
});
