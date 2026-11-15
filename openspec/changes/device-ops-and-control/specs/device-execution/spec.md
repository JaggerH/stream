## ADDED Requirements

### Requirement: 设备 agent 对状态目录单实例

Linux 设备 agent SHALL 在进入设备模式前对状态目录加互斥锁（flock，非阻塞）：同一状态目录只允许一个
agent 进程。拿不到锁 SHALL 打一行清楚的日志并以非零码退出，SHALL NOT 进入重连循环。锁 SHALL 随进程
退出（正常退出与被杀）由内核释放，SHALL NOT 依赖要清理的锁文件。

#### Scenario: 同一状态目录起第二个 agent
- **WHEN** 一个 agent 已在运行（持有锁），第二个 agent 用同一状态目录启动
- **THEN** 第二个进程打一行日志说明已有实例占用后退出，退出码非零；第一个进程不受影响

#### Scenario: 第一个进程退出后锁释放
- **WHEN** 持锁进程退出（含被杀），之后一个新的 agent 用同一状态目录启动
- **THEN** 新进程正常拿到锁并进入设备模式
