import { describe, it, expect } from 'vitest'
import { speakerScript } from './speaker-script.ts'

const seg = (start: number, end: number, text: string, speaker?: string) => ({ start, end, text, speaker })

describe('speakerScript：segments → 给模型看的对话稿', () => {
  it('连续同一个说话人的句子并成一段，时间戳取这一段第一句', () => {
    const out = speakerScript([
      seg(12, 15, '你好', '徐不弃'),
      seg(15, 20, '今天聊点别的', '徐不弃'),
      seg(100, 104, '好啊', '李三'),
    ])
    expect(out.transcript).toBe('[00:12] 徐不弃：你好 今天聊点别的\n[01:40] 李三：好啊')
  })

  // 「说话人 N」的 N 必须和前端 useSpeakerMap 用的是同一个口径（按总发言时长降序的名次），
  // 否则用户在认名列表里看到的「说话人 2」和模型嘴里的「说话人 2」不是同一个人。
  it('未认领的簇按总发言时长排名给序号名，并标 anonymous', () => {
    const out = speakerScript([
      seg(0, 10, 'a', 'SPEAKER_05'), // 10s → 第二
      seg(10, 40, 'b', 'SPEAKER_01'), // 30s → 第一
    ])
    expect(out.speakers).toEqual([
      { label: 'SPEAKER_01', name: '说话人 1', anonymous: true },
      { label: 'SPEAKER_05', name: '说话人 2', anonymous: true },
    ])
    expect(out.transcript).toBe('[00:00] 说话人 2：a\n[00:10] 说话人 1：b')
  })

  it('已认领的簇（标签就是人名）不算匿名，也不参与序号命名', () => {
    const out = speakerScript([seg(0, 30, 'a', '徐不弃'), seg(30, 40, 'b', 'SPEAKER_02')])
    expect(out.speakers).toEqual([
      { label: '徐不弃', name: '徐不弃', anonymous: false },
      { label: 'SPEAKER_02', name: '说话人 2', anonymous: true },
    ])
  })

  it('没有 speaker 的段照样出稿，只是不带名字前缀', () => {
    const out = speakerScript([seg(5, 9, '一段没归名的话')])
    expect(out.transcript).toBe('[00:05] 一段没归名的话')
    expect(out.speakers).toEqual([])
  })

  it('空输入回空稿空名单（不是抛错、也不是一行空前缀）', () => {
    expect(speakerScript([])).toEqual({ transcript: '', speakers: [] })
  })

  it('超过一小时的时间戳仍然只出 mm:ss（分钟继续累加，不回绕）', () => {
    const out = speakerScript([seg(3725, 3730, 'x', 'A')])
    expect(out.transcript).toBe('[62:05] A：x')
  })
})
