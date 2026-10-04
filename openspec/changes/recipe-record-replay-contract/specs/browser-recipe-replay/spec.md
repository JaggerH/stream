## REMOVED Requirements

### Requirement: Record and Replay 使用同一 Recipe 契约
**Reason**: 它的 "Record" 指的是 CloakBrowser 时代的 `record explore` / `translate` 链路——
那个子命令于 2026-07-28 随「Stream 改成骑用户自己的 Chrome」退役，`explore-*.json` 与 `.xhr.json`
今天没有任何产出方。围绕 browser-use history 与 UNTRANSLATED 的场景随之失效。
**Migration**: 编写侧改由**探索图编译**承接（见新增要求「探索图编译成可重放的 Recipe」）；
其中仍然成立的那条——Validate 与 Replay 必须共用同一个 runner——由新增要求
「Validate 与 Replay 共用同一个 runner」原样承接，判据不变。

## ADDED Requirements

### Requirement: 探索图编译成可重放的 Recipe

系统 SHALL 能把一次探索产出的草稿图（`ExploreDraft`：`states[] + transitions[]`）编译成一份
**canonical Recipe**，使「AI 探一遍」的结果直接成为可重放的东西，而不是停在草稿文件里。

编译 SHALL 在 `transitions` 上求一条从 `draft.start` 到目标状态的路径，并把该路径上每条 transition
的 `steps` 按序串成 Recipe 的 `steps[]`。编译产物 SHALL 直接通过 `validateRecipe`，
SHALL NOT 需要人手改写成 steps 才跑得起来。

系统 SHALL NOT 在本能力里生成 `observers`：探索记录的是「怎么走」与「怎么认状态」，
**不含数据提取**。因此编译产物服务的是**动作类** Recipe；采集类 Recipe 不在本能力范围。

#### Scenario: 从草稿图编译出可重放的 Recipe

- **WHEN** 对一份含 `start` 且目标状态可达的草稿图发起编译
- **THEN** 产出是一份通过 `validateRecipe` 的 canonical Recipe，其 `steps[]` 与所选路径逐条对应，
  且无需人手改写即可交给运行侧

#### Scenario: 不可达时明说，不产出空 Recipe

- **WHEN** 草稿图里目标状态没有任何 transition 路径可达（或 `start` 缺失）
- **THEN** 编译以明确的结论失败并指出原因，SHALL NOT 产出一份 steps 为空的 Recipe

#### Scenario: 不生成 observers

- **WHEN** 编译一份草稿图
- **THEN** 产物 SHALL NOT 含凭空生成的 observers；若该 Recipe 需要采集，缺失是显式的而不是被默认值填上的

### Requirement: 混合运行优先级：静态 Recipe 优先，图为 fallback

运行侧 SHALL 采用混合的取路顺序：**存在与该目标对应的明确 Recipe 时只走那份 Recipe**；
只有在历史里没有对应记录时，才转为**带图选路**（按状态图在运行期选择下一步）。

判「是否存在对应 Recipe」的键 SHALL 与 Repair 的账本键同源（`facility + recipeId`）。
两份判据分家的后果是「账本说这个源有 Recipe、路由说没有」这类**两边单看都正常**的错位。

#### Scenario: 有明确 Recipe 时只走它

- **WHEN** 目标对应一份已装载的 Recipe
- **THEN** 运行侧直接重放该 Recipe，不进入图选路

#### Scenario: 没有记录时带图选路

- **WHEN** 历史里没有任何与该目标对应的 Recipe，但本机有该 facility 的状态图
- **THEN** 运行侧按状态图选择下一步，而不是直接失败

#### Scenario: 优先级判据与账本键同源

- **WHEN** 改动「是否存在对应 Recipe」的判据键
- **THEN** 存在一条测试因 Repair 账本键与它不一致而变红

### Requirement: Validate 与 Replay 共用同一个 runner

Validate 与 Replay SHALL 使用同一个正式 runner（`RecipeRunner`），两者 SHALL 只在 visibility 与
`onWall` hook 上不同，SHALL NOT 各自持有一套解释器——用另一个解释器验过的 Recipe，
「验证通过」说的不是线上会发生什么。

旧 `actions + harvest` 形状的 Recipe SHALL 在进入 runner 之前被**显式翻译**成 canonical 形状，
翻译结果 SHALL 与手写的 canonical Recipe 走完全相同的执行路径。

#### Scenario: 同一份旧形 Recipe 两条路同一个结论

- **WHEN** 同一份旧 `actions + harvest` Recipe 分别经 validate 与经线上 replay
- **THEN** 两者得到同一个 outcome

#### Scenario: 旧形 Recipe 走同一条路

- **WHEN** validate 或 replay 拿到一份旧形 Recipe
- **THEN** 它先被显式翻译成 canonical 形状再进同一个 runner，行为不静默改变

### Requirement: Repair 以 Recipe 为失败单元

Repair 状态 SHALL 以 `facility + recipeId + version` 为键记录，而不是以 Source id。每条状态
SHALL 列出受影响的 Source。

理由是复用：一份 private Recipe 可以被多个语义 Source 共用。按 Source 记账时，一次漂移只会记在
**碰巧先失败的那个 Source** 头上，其余共用它的 Source 继续被判健康——故障是同一个，账却分散在
几个地方，任何一处都攒不够隔离阈值。

#### Scenario: 共享 detail 漂移

- **WHEN** 一份被 Home 与 Search 共用的 private detail Recipe 的 observer path 漂移
- **THEN** repair ledger 记录一条 `{facility, recipeId, version}` 故障，并标注 Home/Search 均受影响

#### Scenario: 新版本清账

- **WHEN** 一份被隔离的 Recipe 以更高 version 重新装载
- **THEN** 该键的隔离被解除，受影响的所有 Source 一起恢复
