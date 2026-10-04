## Purpose

recipe 包的市场面：按关键词发现或按包名直装、安装前的确认与高风险二次确认、安装生效反馈与已装包管理，以及支撑它们的端点。

## Requirements

### Requirement: Recipe 市场入口

系统 SHALL 在侧栏「管理」分组中提供一个 recipe 市场入口，其路径为 `/recipes`，与插件/频道/Provider 管理并列。该入口 SHALL 可通过 URL 直接进入并在刷新后保持。

#### Scenario: 从侧栏进入市场页

- **WHEN** 用户点击侧栏「管理」分组下的 recipe 市场入口
- **THEN** 主区域渲染市场页，且浏览器地址变为 `/recipes`

#### Scenario: 直接访问 URL

- **WHEN** 用户在地址栏直接打开 `/recipes`
- **THEN** 应用进入市场页，且侧栏该入口显示为选中态

#### Scenario: 后端未启用该能力时呈现未启用空态

- **WHEN** 用户进入市场页而后端未注入 recipe 包能力依赖（端点返回服务不可用）
- **THEN** 页面呈现「功能未启用」空态，而 SHALL NOT 呈现为请求错误

### Requirement: 按关键词发现 recipe 包

市场页 SHALL 提供一个搜索输入。当输入不构成包名时，系统 SHALL 通过后端搜索端点按关键词检索带 `stream-recipe` 约定关键词的 npm 包，并列出结果（含包名、版本、描述）。

#### Scenario: 关键词搜到结果

- **WHEN** 用户在搜索框输入 `xhs` 并提交
- **THEN** 结果区列出匹配的 recipe 包，其中包含 `@streamapp/xhs`

#### Scenario: 搜索无结果时提示按名安装

- **WHEN** 关键词搜索返回空结果
- **THEN** 结果区 SHALL 提示「刚发布的包可能尚未进入 npm 搜索索引，可直接粘贴完整包名安装」

#### Scenario: 搜索失败不影响页面其余部分

- **WHEN** 搜索端点返回错误
- **THEN** 结果区显示错误提示，且已装区仍正常展示

### Requirement: 按包名直接安装

当搜索输入形如 npm 包名（`@scope/name` 或裸包名）时，系统 SHALL 在结果区直接给出针对该包名的安装项，而不要求该包出现在搜索索引中。系统 SHALL NOT 为此提供第二个输入控件。

#### Scenario: 输入 scoped 包名

- **WHEN** 用户在搜索框输入 `@streamapp/telegram`
- **THEN** 结果区给出「安装 @streamapp/telegram」项，点击后进入安装确认流程

#### Scenario: 索引未收录的新包仍可安装

- **WHEN** 某包刚发布、关键词搜索查不到，用户输入其完整包名
- **THEN** 系统仍可对该包发起 preview 并完成安装

### Requirement: 安装确认呈现

发起安装时，系统 SHALL 先调用 preview 端点，并在确认对话框中展示：包名与版本、facility、**钳制后**的限流、每个 recipe 的 id/描述/能力/参数、带写副作用的标识、以及该包将覆盖的内置源 id 列表。对话框 SHALL 明示能力与副作用为包作者自述、宿主不予核实。

#### Scenario: 确认框展示 preview 全部风险信息

- **WHEN** 用户对一个包发起安装且 preview 成功返回
- **THEN** 对话框展示该包的版本、facility、钳制后的限流值、每个 recipe 的能力，以及全部将被覆盖的内置源 id

#### Scenario: 披露自述限制

- **WHEN** 安装确认对话框打开
- **THEN** 对话框内 SHALL 出现「能力与副作用由包作者自述，宿主不核实」意义的说明文字

#### Scenario: preview 失败不进入安装

- **WHEN** preview 端点返回错误（如包不存在、schema 超版本、含白名单外文件）
- **THEN** 系统展示该错误且 SHALL NOT 调用 install 端点

#### Scenario: preview 进行中显示进度且不重复请求

- **WHEN** 用户对某包发起安装，preview 尚未返回
- **THEN** 界面显示进行中状态，且此期间重复触发同一包的安装 SHALL NOT 产生第二次 preview 请求

### Requirement: 高风险安装的二次确认

系统 SHALL 将安装分为两档。当包内任一 recipe 声明写副作用（`effects` 含 `write`），或该包将覆盖内置源且包名不以 `@streamapp/` 开头时，系统 SHALL 要求二次确认后才允许执行安装；二次确认的操作控件文案 SHALL 点名具体风险，而不能仅为「确认」。其余情况 SHALL 允许一次点击完成安装。

#### Scenario: 只读且不覆盖的包一键安装

- **WHEN** 包内所有 recipe 均无写副作用，且不覆盖任何内置源
- **THEN** 用户在确认对话框中单次点击「安装」即执行安装

#### Scenario: 带写副作用的包需二次确认

- **WHEN** 包内存在声明 `effects: ['write']` 的 recipe，用户点击「安装」
- **THEN** 系统 SHALL NOT 立即安装，而是展示复述「该包会写入我的账户」的确认控件，仅在用户再次确认后才调用 install

#### Scenario: 第三方包覆盖内置源需二次确认

- **WHEN** 包名不以 `@streamapp/` 开头且 preview 的覆盖列表非空，用户点击「安装」
- **THEN** 系统 SHALL NOT 立即安装，而是展示点名被替换源 id 的确认控件，仅在用户再次确认后才调用 install

#### Scenario: 官方包覆盖内置源不额外罚站

- **WHEN** 包名以 `@streamapp/` 开头、覆盖内置源，且其 recipe 均无写副作用
- **THEN** 用户单次点击即可完成安装

### Requirement: 安装生效与反馈

用户确认后，系统 SHALL 携带 preview 返回的 confirm 凭据调用 install 端点。安装成功后 SHALL 刷新已装列表并给出成功反馈；安装失败 SHALL 展示后端返回的错误原因且不改变已装列表。

#### Scenario: 安装成功

- **WHEN** 用户完成确认且 install 返回成功
- **THEN** 对话框关闭、给出成功提示，且该包出现在已装区

#### Scenario: 安装失败保持原状

- **WHEN** install 返回错误（如 confirm 凭据不匹配）
- **THEN** 系统展示错误原因，且已装列表内容不变

### Requirement: 已装包管理

市场页 SHALL 列出已安装的 recipe 包，每项含包名、版本、facility 及其提供的源 id。系统 SHALL 支持卸载已装包，并在存在更新时于该项内提示可更新版本。

#### Scenario: 列出已装包

- **WHEN** 用户进入市场页
- **THEN** 已装区列出每个已安装包的包名、版本、facility 与其提供的源 id

#### Scenario: 卸载

- **WHEN** 用户对某已装包执行卸载并确认
- **THEN** 系统调用卸载端点，成功后该项从已装区消失

#### Scenario: 提示可更新

- **WHEN** 某已装包在 registry 上存在更高版本
- **THEN** 该项内显示可更新到的版本号

#### Scenario: 更新复用安装确认流程

- **WHEN** 用户对某可更新包点击更新
- **THEN** 系统对新版本发起 preview 并进入同一确认对话框，包括对新版本重新执行风险分档判定

### Requirement: npm 搜索代理端点

系统 SHALL 提供一个后端端点，按调用方给出的关键词检索 recipe 包。该端点 SHALL 由服务端固定限定 `stream-recipe` 关键词并固定使用配置的 registry 地址，SHALL NOT 接受调用方传入任意 URL 或任意 registry 地址。

#### Scenario: 按关键词检索

- **WHEN** 调用方以关键词请求该端点
- **THEN** 端点返回该关键词下带 `stream-recipe` 约定关键词的包列表（含包名、版本、描述）

#### Scenario: 拒绝任意地址转发

- **WHEN** 调用方试图通过参数指定其他 URL 或 registry 主机
- **THEN** 端点 SHALL 忽略该输入并仍只访问已配置的 registry

#### Scenario: 未接线时明确不可用

- **WHEN** 后端未注入 recipe 包能力依赖
- **THEN** 该端点返回服务不可用错误而非静默失败

### Requirement: 已装包列出端点

系统 SHALL 提供一个后端端点，返回当前已安装的 recipe 包清单，每项含包名、版本、facility 与该包提供的源 id 列表。

#### Scenario: 返回已装清单

- **WHEN** 调用方请求该端点且用户层装有 recipe 包
- **THEN** 端点返回每个包的包名、版本、facility 与其源 id 列表

#### Scenario: 无已装包

- **WHEN** 用户层没有任何已安装的 recipe 包
- **THEN** 端点返回空列表而非错误
