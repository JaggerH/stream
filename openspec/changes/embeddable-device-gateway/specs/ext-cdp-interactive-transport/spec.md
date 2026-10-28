## ADDED Requirements

### Requirement: cdp 动词可指到某台配对设备的浏览器

四个 cdp 动词（look / shot / act / pages）SHALL 接受目标写法 `device:<deviceId>/chrome[:<tabId>]`：
操作落在那台设备上在线的扩展绑定所代理的浏览器（多条绑定时取该设备的默认绑定，缺省则取最近连上的
一条）。带 `url` 的读取 SHALL 在那台设备的浏览器里开新标签。工具说明 SHALL 按宿主能力只在该档存在的
宿主上描述这一写法。

#### Scenario: 在远端设备的浏览器里开页面并读取
- **WHEN** 设备 A 有在线的扩展绑定，调用 cdp_look({target:'device:A/chrome', url, js})
- **THEN** 页面开在设备 A 的浏览器里，读取结果来自那张标签

#### Scenario: 设备浏览器不在线
- **WHEN** 目标设备没有在线的扩展绑定，调用任一 cdp 动词的 `device:<id>/chrome…` 档
- **THEN** 返回固定错误码 `device-browser-offline`，不落到本机浏览器执行

### Requirement: device 档的读取锁与登录动作

`kind:'login'` SHALL 在 `device:<id>/chrome[:<tabId>]` 档可用，语义与 `chrome` 档一致（origin 核对、
原子填写、读取锁）。登录动作期间该目标的读取锁 SHALL 按 `device:<id>/chrome:<tabId>` 记键。

#### Scenario: 登录期间锁住这个目标
- **WHEN** 对 `device:A/chrome:7` 执行 `kind:'login'` 尚未完成时，另一调用读取 `device:A/chrome:7`
- **THEN** 读取以登录进行中被拒绝，登录完成后照常
