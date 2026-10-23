/**
 * 进程级共享资源（design D4）。一个进程只该有一份的东西——RSSHub worker、isolated-vm、Chrome 发现、进程信号——
 * 将收进这里，由调用方建一次、传给多个实例（任务 2.1）。
 *
 * 今天它还是空的：那几样仍住在各自模块的模块级状态里。先把形状立起来，`createStream` 的 `runtime` 参数与
 * 「不传就自建、关实例时一起关」的所有权规则从第一天就是对的，后面往里搬东西不改调用方。
 */
export interface StreamRuntime {
  /** 释放 runtime 持有的进程级资源。只该由创建它的一方调。 */
  close(): Promise<void>
}

export function createRuntime(): StreamRuntime {
  return { close: async () => {} }
}
