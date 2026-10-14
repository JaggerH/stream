package com.streamapp.android.agent

import org.json.JSONObject
import java.util.Base64

val ANDROID_OPS = listOf(
    "windows", "scopeWindow", "focusApp", "find", "invoke", "setValue", "type", "clearInput",
    "click", "scroll", "press", "readSubtree", "screenshot", "url", "sleep", "status",
)

private val NO_WAKE = setOf("status", "sleep", "windows", "url")

/**
 * The op table (see the plan's Task 4 table). One instance per connection; it owns the scoped
 * window and the current ref snapshot. Ops run one at a time, so it needs no locking.
 */
class Dispatcher(private val device: Device) {
    private var scope: String? = null
    private val refs = RefTable<UiNode>()

    fun dispatch(op: String, args: JSONObject): Any? {
        if (op !in ANDROID_OPS) throw AgentError("unknown op: $op")
        if (op !in NO_WAKE) device.ensureAwake()
        return when (op) {
            "windows" -> device.windows().map { it.toMap() }
            "scopeWindow" -> {
                val w = resolveWindow(obj(args, "match"))
                scope = w.id
                mapOf("window" to w.toMap())
            }
            "focusApp" -> mapOf("ok" to focusApp(str(obj(args, "match"), "process")))
            "find" -> find(A11yQuery.from(obj(args, "query")))
            "invoke" -> {
                val node = refs.resolve(str(args, "ref"))
                if (!device.click(node)) throw AgentError("action-failed: 节点不可点，换坐标点击")
                settle(args, "invoke")
            }
            "setValue" -> {
                val ref = str(args, "ref")
                if (!device.setText(refs.resolve(ref), str(args, "text"))) throw AgentError("not-editable: $ref 不接受 ACTION_SET_TEXT")
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
                when (val key = str(args, "key")) {
                    "Back" -> device.globalBack()
                    "Home" -> device.globalHome()
                    "Enter" -> device.imeEnter(focused())
                    else -> throw AgentError("unsupported-key: $key（安卓只认 Back / Home / Enter）")
                }
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
        val root = scopedRoot()
        val hits = findAll(root, q)
        val ids = refs.snapshot(hits)
        val els = hits.mapIndexed { i, n ->
            mapOf("ref" to ids[i], "role" to n.role, "name" to n.name, "className" to n.className, "rect" to n.rect.toMap())
        }
        val out = mutableMapOf<String, Any?>("elements" to els)
        if (hits.isEmpty() && device.windows().none { it.id == scope && it.foreground }) {
            out["unbuilt"] = "a11y-unbuilt: 限定的窗口不在前台，空结果不可采信"
        }
        return out
    }

    private fun focusApp(pkg: String): Boolean {
        device.launch(pkg)
        val deadline = System.currentTimeMillis() + 5_000
        while (true) {
            if (device.foregroundPackage() == pkg) {
                device.windows().firstOrNull { it.process == pkg && it.foreground }?.let { scope = it.id }
                return true
            }
            if (System.currentTimeMillis() >= deadline) return false
            device.sleep(200)
        }
    }

    private fun scroll(dir: String, amount: Int) {
        val area = scope?.let { device.windowRoot(it)?.rect } ?: device.screenSize()
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
        val root = scope?.let { device.windowRoot(it) }
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

    private fun scopedRoot(): UiNode {
        val id = scope ?: throw AgentError("no-scope: 还没限定搜索范围，先 scopeWindow / focusApp")
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
