## ADDED Requirements

### Requirement: 领取类标签不算提交、不算动钱

执行端的敏感判定 SHALL 把领取类标签当作不提交、不动钱的动作。中文词表：领取、領取、领券、領券、
立即领、立即領、去领、去領、抢券、搶券、领红包、領紅包、领取红包、領取紅包、领优惠券、領優惠券、
领福利、領福利、领奖、領獎、领取奖励、領取獎勵；英文词表：claim、collect、get coupon、get the coupon、
get coupons、collect coupon、collect coupons、claim coupon、grab coupon、claim reward、collect reward、
get reward。判定按中文去标点/数字/货币符号后的包含关系，或拉丁文按词（短语按连续词）匹配；标签里带
券面额、金额或货币符号不改变结论。命中领取类的标签 SHALL NOT 产生 `commit-label`、`payment-label`
或 `movesMoney`，也 SHALL NOT 因为「词表未识别的提交候选」而落入 `commit-unrecognized`。

例外 SHALL 照旧拦截，并至少产生 `commit-label`：判定 SHALL 先移除标签里的领取词，以及紧挨在领取词
前面的 确认 / 確認 / 立即 / 去，再把剩下的部分当成一个独立标签判断；剩余部分命中提交词（中文的
`cjkCommitPrefixes` 核心词，英文的 commit verb / commit phrase）或钱词，或命中书面例外词表时，整条标签
仍是提交。书面例外词表 SHALL 至少含：提交、订单、訂單、兑换、兌換、拼单、拼單、拼团、拼團、参团、
參團、确认收货、確認收貨、结账、結賬、結帳，以及付款 / 开通 / 购买 / 订阅 / 续费类词（中文：支付、
付款、购买、开通、開通、订阅、訂閱、订购、訂購、续费、續費、自动续费、自動續費、升级、升級、结算、
下单等；英文：pay、payment、charge、buy、purchase、checkout、order、subscribe、renew、activate、
upgrade、redeem、top up 等）。该控件所在的屏幕正在问一个提交问题（支付确认对话框）时，领取标签也
SHALL 照旧拦截。带货币符号或屏幕显示金额时，例外 SHALL 同时产生 `payment-label`。

判定 SHALL NOT 只依赖例外词表：没有列进例外词表的提交词，只要在移除领取词后的剩余部分里出现，仍要
拦下（这是为了不让词表追着新动词跑）。

#### Scenario: 领券按钮放行
- **WHEN** 一次 `click`/`invoke` 的目标是「确认领取235元」，屏幕上没有提交问题
- **THEN** 动作照常执行，没有 `approval-required`，没有 `commit-label` / `payment-label`

#### Scenario: 英文领券放行
- **WHEN** 目标是 "Get coupon ¥235" 或 "Collect"，且不在支付确认对话框里
- **THEN** 动作照常执行

#### Scenario: 领取并开通仍要审批
- **WHEN** 目标是「领取并开通会员 ¥9.9」（或 "claim and subscribe"）
- **THEN** 回复 `approval-required`，`semantics.reasons` 含 `commit-label`，带金额时还含 `payment-label`

#### Scenario: 领取词包着的提交仍要审批
- **WHEN** 目标是「提交订单并领红包」「领券并提交」「确认订单 领取优惠」「积分兑换 领取」「领取并下单」
- **THEN** 回复 `approval-required`，`semantics.reasons` 含 `commit-label`，动作没有执行

#### Scenario: 只剩领取词与修饰词时放行
- **WHEN** 目标是「确认领取235元」「领券」「立即领」「去领取」，屏幕上没有提交问题
- **THEN** 动作照常执行，既没有 `commit-label` 也没有 `payment-label`

#### Scenario: 支付确认对话框里的领取仍要审批
- **WHEN** 目标是「确认领取235元」，但屏幕上另一处正在问「确认支付 ¥235 吗？」
- **THEN** 回复 `approval-required`，`semantics.reasons` 含 `commit-label`

#### Scenario: 真正的支付按钮不变
- **WHEN** 目标是「去结算」「提交订单」「立即支付 ¥129」「确认付款」
- **THEN** 回复 `approval-required`，与本次改动前一致
