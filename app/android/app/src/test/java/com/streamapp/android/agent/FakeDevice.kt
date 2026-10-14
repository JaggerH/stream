package com.streamapp.android.agent

class FakeDevice : Device {
    val log = mutableListOf<String>()
    var wins = mutableListOf(WindowInfo("1", "com.sankuai.meituan", "美团", true))
    var roots = mutableMapOf<String, UiNode>()
    var fg: String? = "com.sankuai.meituan"
    var locked = false
    var focused: UiNode? = null
    var clickable = true
    var launchMakesForeground: String? = null

    override fun ensureAwake() { if (locked) throw AgentError("device-locked: 锁屏有密码，Stream 解不开"); log += "awake" }
    override fun windows() = wins.toList()
    override fun windowRoot(windowId: String) = roots[windowId]
    override fun foregroundPackage() = fg
    override fun foregroundComponent() = (fg ?: "") + "/.Main"
    override fun launch(packageName: String): Boolean { log += "launch $packageName"; launchMakesForeground?.let { fg = it }; return true }
    override fun click(node: UiNode): Boolean { log += "click ${node.name}"; return clickable }
    override fun setText(node: UiNode, text: String): Boolean { log += "setText ${node.name}=$text"; return true }
    override fun focusedInput() = focused
    override fun imeEnter(node: UiNode): Boolean { log += "enter"; return true }
    override fun tap(x: Int, y: Int, longPress: Boolean) { log += "tap $x,$y long=$longPress" }
    override fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long) { log += "swipe $x1,$y1->$x2,$y2" }
    override fun globalBack(): Boolean { log += "back"; return true }
    override fun globalHome(): Boolean { log += "home"; return true }
    override fun screenshot() = Shot(byteArrayOf(1, 2, 3), Rect(0, 0, 1080, 2400), 2.75)
    override fun screenSize() = Rect(0, 0, 1080, 2400)
    override fun status(text: String?) { log += "status $text" }
    override fun sleep(ms: Long) { log += "sleep $ms" }
}
