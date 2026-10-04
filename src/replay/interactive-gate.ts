// 薄壳：动作闸门已搬进 shared/browser-relay/interactive-gate.ts（插件把 cdp_act 暴露给
// 任意 agent 时，这道二次确认闸就是唯一保险，必须与后端共用同一份）。消费者 import 不用改。
export * from '../../shared/browser-relay/interactive-gate.ts'
