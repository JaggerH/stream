# android-scroll-until-claim-labels

## Why

真机购物 App 上的两次实测暴露了同一类问题：设备把「做完了」和「没做到」混在一起，调用方只能靠
自己的总超时兜底。

- 调用方在无限长的信息流里用 `scroll` 找「排序」，一次一次地滑。`scroll` 只能表示「我滑了 N 步」，
  不能表示「滑到哪了、看到什么、还要不要继续」；信息流没有底，调用方的总超时先到，41 秒后只拿回
  `host op timed out`，什么都没带回来。
- 领券按钮「确认领取235元」被判成提交 + 付款：`确认` 在提交词表里，按钮上又有券的面额。领券不花钱，
  用户认为是常规操作，却每次都要人审批；真正的去结算、提交订单、立即支付仍必须照旧拦。
- 系统弹出「应用无响应」时，`windows` 里的那一行与普通系统窗口没有区别：调用方看不出手机是在等
  用户处理一个 ANR，还是只是有一个系统浮层。

## What Changes

- **`scroll` 增加 `until` 模式（可选，向后兼容）**：给了 `until` 就一次滑一步，直到屏幕上可见节点的
  name 或 text 包含该串（大小写不敏感）。上限取先到者：次数 `maxSteps`（缺省 20，最大 50）、时长
  `timeoutMs`（缺省 15000 ms，最大 60000 ms）；到顶/到底（连续两次滑动后树不变）也停。回执带
  `found`、`scrolls`、`stopped`（`end` / `steps` / `time` / `no-window`）、未找到时最多五个仍在屏幕上的
  打码标签 `visible`，找到时带 `match: {name, role, rect}`。没给 `until` 时行为、参数与回执完全不变。
- **领取类标签不算提交、不算动钱**：Detect 增加领取判定（中：领取 / 领券 / 立即领 / 去领 / 抢券 /
  领红包，含「确认领取…」；英：claim / collect / get coupon），这类标签不算 commit、不算 movesMoney，
  即使带券面额与货币符号。例外照拦：同一标签里还有付款 / 开通 / 购买 / 订阅 / 续费类词
  （「领取并开通会员 ¥9.9」），或该控件所在的屏幕在问一个提交问题（支付确认对话框）。
- **ANR 对话框可识别**：`windows` 回执把系统的「应用无响应」对话框标成 `type: "system"` 并带
  `anr: true`；能拿到时带 `appPackage`（弹窗针对的应用包名），拿不到就不填。只报告，不自动点任何按钮。
- **能力版本**：`ui.tree` 升到 v4（新增的 `until` 与 `anr` / `appPackage` 是 v4 字段；老调用方不看
  新字段即可）。

## Capabilities

### Modified Capabilities

- `android-recipe-replay`：`scroll` 的有界 `until` 模式与回执；`windows` 对 ANR 对话框的标注。
- `device-sensitive-semantics`：领取类标签的判定与例外。

## Impact

- `app/android/agent/src/main/java/com/streamapp/android/agent/Dispatcher.kt`（`scroll` 分支、
  `scrollUntil`、回执、能力版本）、`Device.kt`（`WindowInfo.anr` / `appPackage`）、`Dispatcher.toMap`。
- `app/android/agent/src/main/java/com/streamapp/android/a11y/WindowKinds.kt`（`looksLikeAnr`、
  `anrOwner`）、`AndroidDevice.kt`（`windows` 里对系统窗口的有界探测）。
- `app/android/agent/src/main/java/com/streamapp/android/policy/{Detect,Gate}.kt` 与
  `assets/policy/words.json`（领取词表与例外）。
- 测试：`ScrollUntilTest`、`DispatcherTest`、`WindowKindsTest`、`DetectTest`、`PolicyGateTest`；
  协议层 `src/http/device-routes.test.ts` 钉住新字段原样透传。
- 兼容性：`until`、`maxSteps`、`timeoutMs`、`anr`、`appPackage` 全部可选；没有它们的请求与回执不变。
