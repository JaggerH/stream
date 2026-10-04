// 薄壳：relay 本体已搬进 shared/browser-relay/relay.ts（好让插件也能起同一份中继）。
// 三个消费者（serve.ts / kernel/plugins/harvest.ts / replay/observer-pipeline.ts）import 不用改。
export * from '../../shared/browser-relay/relay.ts'
