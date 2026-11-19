package com.streamapp.android.agent

internal class FakeDevice : Device {
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
    /** Accessibility scroll steps that moved something so far. A root read after one carries a
     *  marker row whose label counts them, so the dispatcher's content check sees the page move. */
    var moved = 0
    /** Runs at the start of every tree read, so a test can charge the read time or change the
     *  page between two reads. */
    var onRead: () -> Unit = {}
    override fun windowRoot(windowId: String): UiNode? {
        onRead()
        val r = roots[windowId] ?: return null
        if (moved == 0 || r !is FakeNode) return r
        return r.copy(children = r.children + FakeNode("TextView", "scrolled $moved", rect = Rect(0, 0, 1080, 2400)))
    }
    var bounds = mutableMapOf<String, Rect>()
    override fun windowBounds(windowId: String): Rect? = bounds[windowId]
    override fun treeVersion() = changes.version()
    override fun changedSince(version: Long, windowId: String, rect: Rect) = changes.changedSince(version, windowId, rect)
    override fun scrolledSince(version: Long, windowId: String, rect: Rect) = changes.scrolledSince(version, windowId, rect)
    override fun isCurrent(node: UiNode) = node !in changed
    /** Epoch ms of the last accessibility event the (fake) service saw, or null. */
    var lastEventAt: Long? = null
    override fun lastA11yEventMs(): Long? = lastEventAt
    override fun foregroundPackage() = fg
    var component: String? = null
    override fun foregroundComponent() = component ?: ((fg ?: "") + "/.Main")
    /** Runs inside [launch], after the foreground moved: a test can mark the window set changed. */
    var onLaunch: () -> Unit = {}
    override fun launch(packageName: String, fresh: Boolean): Boolean {
        rec(if (fresh) "launch $packageName fresh" else "launch $packageName")
        launchMakesForeground?.let { fg = it }
        onLaunch()
        return true
    }
    /** What [scrollNode] answers per call, in order; past the end, true. */
    var scrollAnswers = mutableListOf<Boolean>()
    /** Per accepted [scrollNode] call, in order, whether the content actually moves; past the end, true. */
    var scrollMoves = mutableListOf<Boolean>()
    /** Containers (by name) that accept every scroll action and never move. */
    val inert = mutableSetOf<String>()
    override fun scrollNode(node: UiNode, forward: Boolean): Boolean {
        rec("scrollNode ${node.name} ${if (forward) "forward" else "backward"}")
        val ok = if (scrollAnswers.isEmpty()) true else scrollAnswers.removeAt(0)
        if (ok && node.name !in inert && (scrollMoves.isEmpty() || scrollMoves.removeAt(0))) moved++
        return ok
    }
    override fun click(node: UiNode): Boolean { rec("click ${node.name}"); return clickable }
    override fun setText(node: UiNode, text: String): Boolean { rec("setText ${node.name}=$text"); return true }
    override fun focusedInput() = focused
    override fun imeEnter(node: UiNode): Boolean { rec("enter"); return true }
    override fun tap(x: Int, y: Int, longPress: Boolean) { rec("tap $x,$y long=$longPress") }
    override fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long, holdMs: Long) {
        rec(if (holdMs > 0) "swipe $x1,$y1->$x2,$y2 hold=$holdMs" else "swipe $x1,$y1->$x2,$y2")
    }
    override fun globalBack(): Boolean { rec("back"); return true }
    override fun globalHome(): Boolean { rec("home"); return true }
    override fun screenshot(maskedAreas: List<Rect>): Shot {
        val jpeg = if (maskedAreas.isEmpty()) byteArrayOf(1, 2, 3)
        // The covered areas leave a mark in the bytes, so tests can assert masking happened.
        else byteArrayOf(1, 2, 3) + byteArrayOf(maskedAreas.size.toByte())
        return Shot(jpeg, Rect(0, 0, 1080, 2400), 2.75)
    }
    override fun screenSize() = Rect(0, 0, 1080, 2400)
    var slop = 22
    override fun touchSlop() = slop
    override fun density() = 2.75f
    /** Epoch ms of the last user touch the service observed (Device.lastUserInputMs), or null. */
    var userInputAt: Long? = null
    override fun lastUserInputMs(): Long? = userInputAt
    override fun status(text: String?) { rec("status $text") }
    override fun sleep(ms: Long) { rec("sleep $ms") }
}

/** The settle wait, sped up for JVM tests (production defaults are on [Settle]). */
internal val FAST_SETTLE = Settle(pollMs = 5, quietMs = 10, capMs = 40)
