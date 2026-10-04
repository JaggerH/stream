/**
 * 排期编辑器：**先选形状，再填数字**，cron 表达式由它写出来。
 *
 * 为什么不是一个 cron 输入框：`0 45 9 * * 1-5` 这串东西没人一眼读得出「工作日 09:45」，
 * 而写错一位（比如 6 段写成 5 段）后端确实会 400，但**写成合法却不是你要的那个时刻**没有任何
 * 东西会拦——它会安安静静按错的排期跑下去。所以默认路径是预设，原始表达式留成逃生口
 * （复杂表达式确实存在），且逃生口边打边校验、边打边给人话。
 *
 * 三条：预设与自定义共用同一个「人话 + 接下来三次」的预览（改到什么就看到什么）；预览算不出来
 * 时如实说，不编；保存只发 `schedule` 那一个键的差异（整行回发的原因见 `api.tasks.ts`）。
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Button } from '../acrylic/button.tsx'
import { Input } from '../acrylic/input.tsx'
import {
  compilePreset, parseCronPreset, validateCron, validatePreset, weekdayLabel,
  PRESET_KINDS, PRESET_LABELS, type Preset, type PresetKind,
} from '../../lib/cronFriendly.ts'
import { NextRuns, scheduleSentence } from './SchedulePreview.tsx'

/** 打开编辑器时停在哪一档：读得回预设就停在那一档，读不回来就是自定义档。 */
function seed(schedule: string): { kind: PresetKind | 'raw'; preset: Preset } {
  const p = parseCronPreset(schedule)
  if (p) return { kind: p.kind, preset: p }
  return { kind: 'raw', preset: { kind: 'daily', hour: 9, minute: 0 } }
}

/** 换档时尽量留住已经填好的时刻——选了「每天 09:45」再改成「每周」不该把 09:45 抹掉。 */
function morph(prev: Preset, kind: PresetKind): Preset {
  const hour = 'hour' in prev ? prev.hour : 9
  const minute = 'minute' in prev ? prev.minute : 0
  switch (kind) {
    case 'everySeconds': return { kind, n: 30 }
    case 'everyMinutes': return { kind, n: 5 }
    case 'hourly': return { kind, minute }
    case 'daily': return { kind, hour, minute }
    case 'weekly': return { kind, weekdays: prev.kind === 'weekly' ? prev.weekdays : [1, 2, 3, 4, 5], hour, minute }
    case 'monthly': return { kind, day: prev.kind === 'monthly' ? prev.day : 1, hour, minute }
  }
}

function NumberBox({
  label, value, min, max, onChange, testId, width = 'w-16',
}: {
  label: string; value: number; min: number; max: number
  onChange: (v: number) => void; testId: string; width?: string
}): ReactElement {
  return (
    <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <Input
        type="number" min={min} max={max} value={Number.isFinite(value) ? value : ''}
        data-testid={testId} aria-label={label}
        className={`${width} h-7 px-2 text-[13px]`}
        // 空输入不写成 0：0 是一个**合法的时刻**，用户还在删数字的中途就被悄悄改成「整点」了。
        // NaN 会被 validatePreset 挡住，于是保存键停用、错误话直接写在下面。
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
      />
      {label}
    </label>
  )
}

/** 时/分两格。**收的是两个数、回的是两个数**——收一个 Preset 再展开的写法过不了类型：
 *  Preset 是判别联合，展开一个联合值会把 kind 一起变宽。 */
function TimeFields({
  hour, minute, onChange,
}: { hour: number; minute: number; onChange: (t: { hour: number; minute: number }) => void }): ReactElement {
  return (
    <>
      <NumberBox label="时" value={hour} min={0} max={23} testId="sched-hour" onChange={(h) => onChange({ hour: h, minute })} />
      <NumberBox label="分" value={minute} min={0} max={59} testId="sched-minute" onChange={(m) => onChange({ hour, minute: m })} />
    </>
  )
}

/**
 * @param onChange - **嵌进别人的表单时用这个**（任务编辑器）。每次表达式变化都报上去，
 *   合法给字符串、不合法给 null——宿主据此禁用自己的保存键。给了它就不画自带的
 *   「保存排期 / 取消」，因为那时候排期只是别人表单里的一个字段，自己另有一个保存动作；
 *   两个保存键并排站着，用户按哪个都不知道后果是什么。
 */
export function ScheduleEditor({
  taskId, schedule, timezone, busy = false, onCancel, onSave, onChange,
}: {
  taskId: string
  schedule: string
  timezone?: string
  busy?: boolean
  onCancel?: () => void
  onSave?: (schedule: string) => void
  onChange?: (schedule: string | null) => void
}): ReactElement {
  const initial = useMemo(() => seed(schedule), [schedule])
  const [kind, setKind] = useState<PresetKind | 'raw'>(initial.kind)
  const [preset, setPreset] = useState<Preset>(initial.preset)
  const [raw, setRaw] = useState(schedule)

  const presetErr = kind === 'raw' ? null : validatePreset(preset)
  const expr = kind === 'raw' ? raw.trim() : presetErr ? null : compilePreset(preset)
  const rawErr = kind === 'raw' ? validateCron(raw) : null
  const err = presetErr ?? rawErr
  const sentence = expr !== null && err === null ? scheduleSentence(expr, timezone) : null

  // 嵌入档：把当前结果报给宿主表单。**`onChange` 不进依赖数组**——调用方多半传的是内联
  // 箭头函数，每次渲染都是新引用，进了依赖就是每渲染一次报一次，宿主 setState 再触发渲染，
  // 一个自己喂自己的死循环。要报的是"表达式变了"，所以只盯 expr / err。
  const report = useRef(onChange)
  report.current = onChange
  useEffect(() => { report.current?.(err === null ? expr : null) }, [expr, err])

  return (
    <div data-testid={`task-schedule-editor-${taskId}`} className="flex flex-col gap-2.5 rounded-lg bg-[var(--acr-card-nested)] p-3">
      <div className="flex flex-wrap gap-1">
        {PRESET_KINDS.map((k) => (
          <Button
            key={k} type="button" size="small" variant={kind === k ? 'secondary' : 'ghost'}
            data-testid={`sched-kind-${k}`}
            onClick={() => { setKind(k); setPreset((p) => morph(p, k)) }}
          >
            {PRESET_LABELS[k]}
          </Button>
        ))}
        {/* 逃生口。它排在最后而不是第一个：预设是默认路径，原始表达式是复杂情形的出口，
            不是给所有人的入口。 */}
        <Button
          type="button" size="small" variant={kind === 'raw' ? 'secondary' : 'ghost'}
          data-testid="sched-kind-raw"
          onClick={() => { setKind('raw'); setRaw(expr ?? schedule) }}
        >
          自定义表达式
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {kind === 'everySeconds' && preset.kind === 'everySeconds' && (
          <NumberBox label="秒一次" value={preset.n} min={1} max={59} testId="sched-n" onChange={(n) => setPreset({ kind: 'everySeconds', n })} />
        )}
        {kind === 'everyMinutes' && preset.kind === 'everyMinutes' && (
          <NumberBox label="分钟一次" value={preset.n} min={1} max={59} testId="sched-n" onChange={(n) => setPreset({ kind: 'everyMinutes', n })} />
        )}
        {kind === 'hourly' && preset.kind === 'hourly' && (
          <NumberBox label="分（每小时）" value={preset.minute} min={0} max={59} testId="sched-minute" onChange={(minute) => setPreset({ kind: 'hourly', minute })} />
        )}
        {kind === 'monthly' && preset.kind === 'monthly' && (
          <>
            <NumberBox label="日" value={preset.day} min={1} max={31} testId="sched-day" onChange={(day) => setPreset({ ...preset, day })} />
            <TimeFields hour={preset.hour} minute={preset.minute} onChange={(t) => setPreset({ ...preset, ...t })} />
          </>
        )}
        {kind === 'weekly' && preset.kind === 'weekly' && (
          <>
            <div className="flex flex-wrap gap-1">
              {[0, 1, 2, 3, 4, 5, 6].map((d) => {
                const on = preset.weekdays.includes(d)
                return (
                  <Button
                    key={d} type="button" size="small" variant={on ? 'secondary' : 'ghost'}
                    aria-pressed={on} data-testid={`sched-weekday-${d}`}
                    onClick={() => setPreset({
                      ...preset,
                      weekdays: on ? preset.weekdays.filter((x) => x !== d) : [...preset.weekdays, d].sort((a, b) => a - b),
                    })}
                  >
                    {weekdayLabel(d)}
                  </Button>
                )
              })}
            </div>
            <TimeFields hour={preset.hour} minute={preset.minute} onChange={(t) => setPreset({ ...preset, ...t })} />
          </>
        )}
        {kind === 'daily' && preset.kind === 'daily' && (
          <TimeFields hour={preset.hour} minute={preset.minute} onChange={(t) => setPreset({ ...preset, ...t })} />
        )}
        {kind === 'raw' && (
          <Input
            data-testid="sched-raw" aria-label="cron 表达式" value={raw}
            spellCheck={false} autoComplete="off"
            className="h-7 w-64 px-2 font-mono text-[12px]"
            onChange={(e) => setRaw(e.target.value)}
          />
        )}
      </div>

      {/* 预览：边改边看。**校验没过就什么都不预览**——一句照着半截表达式编出来的人话
          比没有更坏。 */}
      {err !== null ? (
        <div data-testid="sched-error" className="text-[12px] text-destructive">{err}</div>
      ) : (
        <div className="flex flex-col gap-0.5">
          <div className="text-[13px] text-foreground" data-testid="sched-sentence">
            {sentence ?? '这条表达式合法，但超出了能翻成人话的范围——请照下面的触发时刻确认它是不是你要的'}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground" data-testid="sched-expr">{expr}</div>
          {expr !== null && <NextRuns schedule={expr} timezone={timezone} testId="sched-next" />}
        </div>
      )}

      {/* 嵌入档不画自带的动作键——理由见 `onChange` 那条注释。 */}
      {onChange === undefined && (
        <div className="flex items-center gap-2">
          <Button
            type="button" size="small" variant="default" data-testid={`sched-save-${taskId}`}
            disabled={busy || err !== null || expr === null || expr === schedule}
            onClick={() => { if (expr !== null) onSave?.(expr) }}
          >
            {busy ? '保存中…' : '保存排期'}
          </Button>
          <Button type="button" size="small" variant="ghost" data-testid={`sched-cancel-${taskId}`} onClick={onCancel}>
            取消
          </Button>
        </div>
      )}
    </div>
  )
}
