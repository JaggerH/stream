package com.streamapp.android.agent

import org.json.JSONObject
import java.util.Base64

val ANDROID_OPS = listOf(
    "windows", "scopeWindow", "focusApp", "find", "invoke", "setValue", "type", "clearInput",
    "click", "scroll", "press", "readSubtree", "screenshot", "url", "sleep", "status",
)

private val NO_WAKE = setOf("status", "sleep", "windows", "url")

/** HyperOS's 关联启动 prompt (`com.miui.wakepath.ui.ConfirmStartActivity`) the first time one app opens another. */
private const val HYPEROS_CONFIRM = "com.miui.securitycenter"

/**
 * The op table (see the plan's Task 4 table). One instance per connection; it owns the scoped
 * window and the current ref snapshot. Ops run one at a time, so it needs no locking.
 */
class Dispatcher(private val raw: Device) {
    /** The app (and optional title substring) the agent limited itself to. An Activity change
     *  replaces the window, so the scope is re-resolved against `windows()` on every use. */
    private data class Scope(val process: String, val title: String?)
    private var scope: Scope? = null
    /** A found node, bound to the scope, window and screen-change version it was found under. */
    private class Hit(val node: UiNode, val scope: Scope, val windowId: String, val version: Long)
    private val refs = RefTable<Hit>()
    /** [raw] behind the current request's cancel token; replaced at the start of every dispatch. */
    private var device: Device = raw

    fun dispatch(op: String, args: JSONObject, cancel: Cancel = Cancel()): Any? {
        device = CancellableDevice(raw, cancel)
        if (op !in ANDROID_OPS) throw AgentError("unknown op: $op")
        if (op !in NO_WAKE) device.ensureAwake()
        return when (op) {
            "windows" -> device.windows().map { it.toMap() }
            "scopeWindow" -> {
                val match = obj(args, "match")
                val w = resolveWindow(match)
                scope = Scope(w.process, if (match.has("title")) match.getString("title") else null)
                mapOf("window" to w.toMap())
            }
            "focusApp" -> mapOf("ok" to focusApp(str(obj(args, "match"), "process")))
            "find" -> find(A11yQuery.from(obj(args, "query")))
            "invoke" -> {
                val node = resolveRef(str(args, "ref"))
                if (!device.click(node)) throw AgentError("action-failed: 节点不可点，换坐标点击")
                settle(args, "invoke")
            }
            "setValue" -> {
                val ref = str(args, "ref")
                if (!device.setText(resolveRef(ref), str(args, "text"))) throw AgentError("not-editable: $ref 不接受 ACTION_SET_TEXT")
                settle(args, "value")
            }
            "type" -> {
                refuseMessage(args)
                val node = focused()
                if (!device.setText(node, node.text + str(args, "text"))) throw AgentError("not-editable: 焦点输入框不接受 ACTION_SET_TEXT")
                settle(args, "value")
            }
            "clearInput" -> {
                refuseMessage(args)
                if (!device.setText(focused(), "")) throw AgentError("not-editable: 焦点输入框不接受 ACTION_SET_TEXT")
                settle(args, "value")
            }
            "click" -> {
                refuseMessage(args)
                val r = rect(obj(args, "rect"))
                when (args.optString("button", "left")) {
                    "left" -> device.tap(r.centerX, r.centerY, longPress = false)
                    "right" -> device.tap(r.centerX, r.centerY, longPress = true)
                    else -> throw AgentError("unsupported-key: 安卓没有中键")
                }
                settle(args, "coords")
            }
            "scroll" -> {
                refuseMessage(args)
                scroll(str(args, "dir"), int(args, "amount"))
                settle(args, "coords")
            }
            "press" -> {
                refuseMessage(args)
                val key = str(args, "key")
                val done = when (key) {
                    "Back" -> device.globalBack()
                    "Home" -> device.globalHome()
                    "Enter" -> device.imeEnter(focused())
                    else -> throw AgentError("unsupported-key: $key（安卓只认 Back / Home / Enter）")
                }
                if (!done) throw AgentError("action-failed: 系统没执行 $key")
                mapOf("via" to "coords")
            }
            "readSubtree" -> readSubtree(scopedRoot(), obj(args, "spec"))
            "screenshot" -> device.screenshot().let {
                mapOf("base64" to Base64.getEncoder().encodeToString(it.jpeg), "window" to it.window.toMap(), "scale" to it.scale)
            }
            "url" -> device.foregroundComponent()
            "sleep" -> { device.sleep(long(args, "ms")); null }
            "status" -> { device.status(if (args.isNull("text")) null else args.optString("text")); emptyMap<String, Any?>() }
            else -> throw AgentError("unknown op: $op")
        }
    }

    private fun find(q: A11yQuery): Map<String, Any?> {
        val s = scope
        val win = scopedWindow()
        // Read before the snapshot: a change while it is being built must also stale its refs.
        val version = device.treeVersion()
        val root = device.windowRoot(win.id) ?: throw AgentError("no-window-match: 限定的窗口已经不在了，重新 scopeWindow")
        val hits = findAll(root, q)
        val ids = refs.snapshot(hits.map { Hit(it, s!!, win.id, version) })
        val els = hits.mapIndexed { i, n ->
            mapOf("ref" to ids[i], "role" to n.role, "name" to n.name, "className" to n.className, "rect" to n.rect.toMap())
        }
        val out = mutableMapOf<String, Any?>("elements" to els)
        if (hits.isEmpty() && !win.foreground) {
            out["unbuilt"] = "a11y-unbuilt: 限定的窗口不在前台，空结果不可采信"
        }
        return out
    }

    /** The node behind [ref], only while the screen it was found on is still the screen in front:
     *  same scope, same window, no window change or scroll over it since, and the node unchanged. */
    private fun resolveRef(ref: String): UiNode {
        val hit = refs.resolve(ref)
        fun stale(why: String): Nothing = throw StaleRefException("stale-ref: $ref $why; find it again")
        if (hit.scope != scope) stale("was found under another scope")
        if (scopedWindow().id != hit.windowId) stale("belongs to a window that is no longer the scoped one")
        if (device.changedSince(hit.version, hit.windowId, hit.node.rect)) stale("predates a window change or a scroll over it")
        if (!device.isCurrent(hit.node)) stale("now shows something else (the node was recycled)")
        return hit.node
    }

    private fun focusApp(pkg: String): Boolean {
        // The old scope belongs to whatever app was in front; never let a later find search it.
        scope = null
        device.launch(pkg)
        // Bounded by attempts (25 x 200 ms), not by the wall clock.
        repeat(25) {
            if (device.foregroundPackage() == pkg) {
                scope = Scope(pkg, null)
                return true
            }
            device.sleep(200)
        }
        if (device.foregroundPackage() == pkg) {
            scope = Scope(pkg, null)
            return true
        }
        if (device.foregroundPackage() == HYPEROS_CONFIRM) {
            throw AgentError("blocked-by-os: 澎湃 OS 在问「Stream 想要打开 $pkg，是否允许？」——到手机上点「始终允许」（每个 App 一次），再试")
        }
        throw AgentError("blocked-by-os: 启动 $pkg 后它没有到前台。可能是系统拦住了后台弹出界面：到 设置 → 应用 → Stream → 其他权限 打开「后台弹出界面」")
    }

    private fun scroll(dir: String, amount: Int) {
        val area = scope?.let { device.windowBounds(scopedWindow().id) } ?: device.screenSize()
        val x = area.centerX
        val hi = area.y + area.h * 7 / 10
        val lo = area.y + area.h * 3 / 10
        val (from, to) = when (dir) {
            "down" -> hi to lo
            "up" -> lo to hi
            else -> throw AgentError("missing arg: dir 必须是 up 或 down")
        }
        repeat(amount.coerceIn(1, 10)) {
            device.swipe(x, from, x, to, 300)
            device.sleep(150)
        }
    }

    private fun settle(args: JSONObject, via: String): Map<String, Any?> {
        val expect = args.optJSONObject("expect") ?: return mapOf("via" to via)
        device.sleep(300)
        val root = scope?.let { runCatching { device.windowRoot(scopedWindow().id) }.getOrNull() }
            ?: device.windows().firstOrNull { it.foreground }?.let { device.windowRoot(it.id) }
        val hit = root != null && findAll(root, A11yQuery.from(expect)).isNotEmpty()
        return mapOf("via" to via, "confirmed" to hit)
    }

    private fun resolveWindow(m: JSONObject): WindowInfo {
        val process = if (m.has("process")) m.getString("process") else null
        val title = if (m.has("title")) m.getString("title") else null
        val hits = device.windows().filter { w ->
            (process == null || w.process.equals(process, ignoreCase = true)) && (title == null || w.title.contains(title))
        }
        return when (hits.size) {
            0 -> throw AgentError("no-window-match: 没有窗口匹配 $m")
            1 -> hits[0]
            else -> throw AgentError("ambiguous-window: ${hits.size} 个窗口都匹配，请用 title 指名一个；候选：" + hits.joinToString("、") { "「${it.title}」" })
        }
    }

    /** The window the scope currently points at: among the app's windows, the foreground one, else the first. */
    private fun scopedWindow(): WindowInfo {
        val s = scope ?: throw AgentError("no-scope: 还没限定搜索范围，先 scopeWindow / focusApp")
        val hits = device.windows().filter { w ->
            w.process.equals(s.process, ignoreCase = true) && (s.title == null || w.title.contains(s.title))
        }
        return hits.firstOrNull { it.foreground } ?: hits.firstOrNull()
            ?: throw AgentError("no-window-match: 限定的应用 ${s.process} 现在没有窗口")
    }

    private fun scopedRoot(): UiNode {
        val id = scopedWindow().id
        return device.windowRoot(id) ?: throw AgentError("no-window-match: 限定的窗口已经不在了，重新 scopeWindow")
    }

    private fun focused(): UiNode = device.focusedInput() ?: throw AgentError("not-editable: 没有获得焦点的输入框")

    private fun refuseMessage(args: JSONObject) {
        if (args.optString("deliver") == "message") throw AgentError("unsupported-deliver: 安卓没有消息投递，去掉 deliver")
    }

    private fun need(o: JSONObject, k: String) { if (!o.has(k) || o.isNull(k)) throw AgentError("missing arg: $k") }
    private fun obj(o: JSONObject, k: String): JSONObject { need(o, k); return o.getJSONObject(k) }
    private fun str(o: JSONObject, k: String): String { need(o, k); return o.getString(k) }
    private fun int(o: JSONObject, k: String): Int { need(o, k); return o.getInt(k) }
    private fun long(o: JSONObject, k: String): Long { need(o, k); return o.getLong(k) }
    private fun rect(o: JSONObject) = Rect(o.getInt("x"), o.getInt("y"), o.getInt("w"), o.getInt("h"))
}

fun WindowInfo.toMap(): Map<String, Any?> = mapOf("id" to id, "process" to process, "title" to title, "foreground" to foreground)
