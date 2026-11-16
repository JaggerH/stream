## ADDED Requirements

### Requirement: Android 执行端是可嵌入的库

Android 执行端 SHALL 以 Android 库模块 `:agent` 提供：协议、op 派发、无障碍服务、提示条、敏感动作闸门、中继连接、
配对与凭据存储都在库内；库的 manifest SHALL 声明中继前台服务、无障碍服务（连同其配置 XML）、开机接收器与唤醒 Activity
及其所需权限，经 manifest 合并进入宿主 APK。宿主 SHALL 只需依赖该库即可在自己的进程里运行执行端，无需复制代码。
Stream 自己的应用 SHALL 是包着该库的外壳，applicationId、组件全名与行为不变。

#### Scenario: 宿主应用依赖库即可编译
- **WHEN** 一个独立的 Gradle 构建（不同 applicationId）以依赖坐标引入 `:agent` 并调用 `StreamAgent`
- **THEN** 构建成功，产物的 manifest 含库的服务、接收器与权限，资产含策略数据文件

#### Scenario: Stream 应用拆分前后等价
- **WHEN** 比较拆分前后 Stream release APK 的合并 manifest
- **THEN** 组件全名、导出属性、权限、intent-filter 与 queries 相同，仅资源引用名可不同且取值相同

### Requirement: 唯一的公共入口

库 SHALL 以 `com.streamapp.android.StreamAgent` 为唯一入口，提供：用一次性配对码配对并保存凭据（阻塞调用，不自动连接）、
探测后端可达、查询与清除配对、启动与停止连接、读取状态快照、订阅状态变化。状态 SHALL 包含是否已配对、连接阶段
（空闲 / 连接中 / 已连接 / 重连中 / 被移除 / 后台启动被拒）、状态文字、无障碍服务是否启用与设备健康（读不到时为空）。
订阅 SHALL 立即回送当前状态，并在连接阶段、配对或无障碍服务变化时回送；关闭返回的句柄 SHALL 停止回送。
库内其余声明 SHALL 不属于公共 API（Kotlin `internal`）。

#### Scenario: 订阅状态
- **WHEN** 宿主订阅状态后连接经历连接中、已连接、断开重连
- **THEN** 监听者依次收到对应阶段的状态，状态文字与通知中的文字一致

#### Scenario: 未配对时旧状态不误导
- **WHEN** 设备已取消配对，而连接最后的状态文字仍是已连接
- **THEN** 状态快照的显示文字为未配对

### Requirement: 用户可见文字可由宿主覆盖

无障碍服务名与描述、连接通知的频道名 / 标题 / 初始文字、后台启动被拒的提示与提示条的停止按钮文字 SHALL 来自库的
字符串资源，宿主以同名资源覆盖。连接通知 SHALL 打开宿主的启动 Activity。

#### Scenario: 宿主改名
- **WHEN** 宿主在自己的资源里定义同名的无障碍服务名
- **THEN** 系统无障碍设置里显示宿主给的名字

### Requirement: 实验性挂钩保持现有行为

库 SHALL 提供挂钩：提示条的构造者（缺省为现有提示条）、用户停止的通知（在执行端完成中止之后调用）与占用提示
（本版不读取）。未设置挂钩时行为 SHALL 与拆分前一致。

#### Scenario: 用户在提示条上点停止
- **WHEN** 宿主设置了用户停止监听者，用户点了提示条上的停止
- **THEN** 执行端照旧发出中止帧并取消手上的 op，随后监听者被通知一次
