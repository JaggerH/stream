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
    val changes = ChangeLog()
    fun windowChanged() = changes.windowsChanged()
    fun scrolled(windowId: String, area: Rect) = changes.scrolled(windowId, area)
    /** Nodes whose live counterpart no longer shows what the snapshot recorded. */
    val changed = mutableSetOf<UiNode>()
    /** Runs after every logged call, so a test can abort or change the screen mid-op. */
    var after: (String) -> Unit = {}

    private fun rec(s: String) { log += s; after(s) }

    override fun ensureAwake() { if (locked) throw AgentError("device-locked: 锁屏有密码，Stream 解不开"); rec("awake") }
    override fun windows() = wins.toList()
    override fun windowRoot(windowId: String) = roots[windowId]
    var bounds = mutableMapOf<String, Rect>()
    override fun windowBounds(windowId: String): Rect? = bounds[windowId]
    override fun treeVersion() = changes.version()
    override fun changedSince(version: Long, windowId: String, rect: Rect) = changes.changedSince(version, windowId, rect)
    override fun isCurrent(node: UiNode) = node !in changed
    override fun foregroundPackage() = fg
    override fun foregroundComponent() = (fg ?: "") + "/.Main"
    override fun launch(packageName: String): Boolean { rec("launch $packageName"); launchMakesForeground?.let { fg = it }; return true }
    override fun click(node: UiNode): Boolean { rec("click ${node.name}"); return clickable }
    override fun setText(node: UiNode, text: String): Boolean { rec("setText ${node.name}=$text"); return true }
    override fun focusedInput() = focused
    override fun imeEnter(node: UiNode): Boolean { rec("enter"); return true }
    override fun tap(x: Int, y: Int, longPress: Boolean) { rec("tap $x,$y long=$longPress") }
    override fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long) { rec("swipe $x1,$y1->$x2,$y2") }
    override fun globalBack(): Boolean { rec("back"); return true }
    override fun globalHome(): Boolean { rec("home"); return true }
    override fun screenshot() = Shot(byteArrayOf(1, 2, 3), Rect(0, 0, 1080, 2400), 2.75)
    override fun screenSize() = Rect(0, 0, 1080, 2400)
    override fun status(text: String?) { rec("status $text") }
    override fun sleep(ms: Long) { rec("sleep $ms") }
}
