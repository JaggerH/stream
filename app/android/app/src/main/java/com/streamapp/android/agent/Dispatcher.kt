package com.streamapp.android.agent

import com.streamapp.android.policy.AskExemption
import com.streamapp.android.policy.PolicyContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

val ANDROID_OPS = listOf(
    "windows", "scopeWindow", "focusApp", "find", "invoke", "setValue", "type", "clearInput",
    "click", "scroll", "press", "readSubtree", "screenshot", "url", "sleep", "status",
)

private val NO_WAKE = setOf("status", "sleep", "windows", "url")

/** Ops that answer even while the caller has set busy: only the always-available observability
 *  and timing ops; everything else fails as `device-busy`. Control frames never reach here. */
private val BUSY_PASS = setOf("status", "sleep")

/** Ops the sensitive gate inspects before any device action. `press` counts through its Enter
 *  key only — the dispatcher routes just that key through the gate; Back and Home are not
 *  commits, though they still answer to deny-category visibility. */
private val GATED = setOf("click", "invoke", "setValue", "type", "clearInput", "scroll", "press")

/** HyperOS's 关联启动 prompt (`com.miui.wakepath.ui.ConfirmStartActivity`) the first time one app opens
 *  another. Matched by activity; the bare package counts only when its activity is not known yet. */
private const val HYPEROS_CONFIRM = "com.miui.securitycenter"

/**
 * The op table (see the plan's Task 4 table). One instance per connection; it owns the scoped
 * window and the current ref snapshot. Ops run one at a time, so it needs no locking.
 *
 * With a [PolicyContext] the dispatcher also runs the sensitive checks, in this order: keyguard
 * (existing), busy, app visibility (deny categories), the credential-field refusal, the approval
 * credential's four checks, then the ask gate — before any gesture or accessibility action.
 * A null [policy] disables all of that and exists for the JVM unit tests only; production
 * (RelayService) always supplies one.
 */
class Dispatcher(private val raw: Device, private val policy: PolicyContext? = null) {
    /** The app (and optional title substring) the agent limited itself to. An Activity change
     *  replaces the window, so the scope is re-resolved against `windows()` on every use. */
    private data class Scope(val process: String, val title: String?)
    /** A found node, bound to the scope, window and screen-change version it was found under. */
    private class Hit(val node: UiNode, val scope: Scope, val windowId: String, val version: Long)
    private val refs = RefTable<Hit>()
    private var scope: Scope? = null
    /** [raw] behind the current request's cancel token; replaced at the start of every dispatch. */
    private var device: Device = raw

    /** Per-connection policy state. The relay builds a fresh Dispatcher per connection, so a
     *  disconnect clears busy and every granted exemption on its own. */
    @Volatile private var busyReason: String? = null
    private val askExemptions = mutableSetOf<AskExemption>()
    private val financeVisible = mutableSetOf<String>()

    fun dispatch(op: String, args: JSONObject, cancel: Cancel = Cancel()): Any? {
        device = CancellableDevice(raw, cancel)
        if (op !in ANDROID_OPS) throw AgentError("unknown op: $op")
        if (op !in NO_WAKE) device.ensureAwake()
        busyReason?.let { reason ->
            if (op !in BUSY_PASS) throw AgentError("device-busy: 执行端置忙，等审批期间不执行新动作" + reasonPart(reason), "device-busy")
        }
        return when (op) {
            "windows" -> device.windows().filter { appVisible(it.process, it.title) }.map { it.toMap() }
            "scopeWindow" -> {
                val match = obj(args, "match")
                val w = resolveWindow(match)
                requireAppVisible(w.process, w.title)
                scope = Scope(w.process, if (match.has("title")) match.getString("title") else null)
                mapOf("window" to w.toMap())
            }
            "focusApp" -> {
                val pkg = str(obj(args, "match"), "process")
                requireAppVisible(pkg)
                mapOf("ok" to focusApp(pkg))
            }
            "find" -> find(A11yQuery.from(obj(args, "query")))
            "invoke" -> {
                val ref = str(args, "ref")
                gated(op, args, checkCredential = false, target = { fresh -> resolveRef(ref, fresh) }) { t ->
                    if (!device.click(t!!)) throw AgentError("action-failed: 节点不可点，换坐标点击")
                    settle(args, "invoke")
                }
            }
            "setValue" -> {
                val ref = str(args, "ref")
                gated(op, args, checkCredential = true, target = { fresh -> resolveRef(ref, fresh) }) { t ->
                    if (!device.setText(t!!, str(args, "text"))) throw AgentError("not-editable: $ref 不接受 ACTION_SET_TEXT")
                    settle(args, "value")
                }
            }
            "type" -> {
                refuseMessage(args)
                val text = str(args, "text")
                gated(op, args, checkCredential = true, target = { _ -> focused() }) { t ->
                    if (!device.setText(t!!, t.text + text)) throw AgentError("not-editable: 焦点输入框不接受 ACTION_SET_TEXT")
                    settle(args, "value")
                }
            }
            "clearInput" -> {
                refuseMessage(args)
                gated(op, args, checkCredential = true, target = { _ -> focused() }) { t ->
                    if (!device.setText(t!!, "")) throw AgentError("not-editable: 焦点输入框不接受 ACTION_SET_TEXT")
                    settle(args, "value")
                }
            }
            "click" -> {
                refuseMessage(args)
                val r = rect(obj(args, "rect"))
                gated(op, args, checkCredential = false, target = { _ -> pointTarget(r) }) { _ ->
                    when (args.optString("button", "left")) {
                        "left" -> device.tap(r.centerX, r.centerY, longPress = false)
                        "right" -> device.tap(r.centerX, r.centerY, longPress = true)
                        else -> throw AgentError("unsupported-key: 安卓没有中键")
                    }
                    settle(args, "coords")
                }
            }
            "scroll" -> {
                refuseMessage(args)
                gated(op, args, checkCredential = false, target = { _ -> null }) { _ ->
                    scroll(str(args, "dir"), int(args, "amount"))
                    settle(args, "coords")
                }
            }
            "press" -> {
                refuseMessage(args)
                val key = str(args, "key")
                if (key !in setOf("Back", "Home", "Enter")) {
                    throw AgentError("unsupported-key: $key（安卓只认 Back / Home / Enter）")
                }
                // Navigation too answers to deny-category visibility, before anything happens.
                val info = appInfo()
                requireAppVisible(info.pkg, info.title)
                if (key == "Enter") {
                    // The Enter that sends a message or submits a form is a commit: the same
                    // judgment and the same approval flow as a typed newline.
                    return gated(op, args, checkCredential = false, target = { _ -> focused() }) { t ->
                        if (!device.imeEnter(t!!)) throw AgentError("action-failed: 系统没执行 $key")
                        mapOf("via" to "coords")
                    }
                }
                val done = when (key) {
                    "Back" -> device.globalBack()
                    "Home" -> device.globalHome()
                    else -> throw AgentError("unsupported-key: $key（安卓只认 Back / Home / Enter）")
                }
                if (!done) throw AgentError("action-failed: 系统没执行 $key")
                mapOf("via" to "coords")
            }
            "readSubtree" -> {
                if (scope == null) requireAppVisible(device.foregroundPackage() ?: "")
                val p = policy?.masker
                readSubtree(scopedRoot(), obj(args, "spec"),
                    maskName = { n -> p?.maskedName(n) ?: n.name },
                    maskValue = { n -> p?.maskedValue(n) ?: n.text })
            }
            "screenshot" -> screenshot(args)
            "url" -> {
                requireAppVisible(device.foregroundPackage() ?: "")
                device.foregroundComponent()
            }
            "sleep" -> { device.sleep(long(args, "ms")); null }
            "status" -> { device.status(if (args.isNull("text")) null else args.optString("text")); emptyMap<String, Any?>() }
            else -> throw AgentError("unknown op: $op")
        }
    }

    // ---- policy ---------------------------------------------------------------------

    private data class AppInfo(val pkg: String, val title: String, val category: String?)

    private fun appInfo(): AppInfo {
        val p = policy
        val s = scope
        if (s != null) {
            val w = runCatching { scopedWindow() }.getOrNull()
            if (w != null) return AppInfo(w.process, w.title, p?.categories?.of(w.process, w.title)?.name)
        }
        val fg = device.foregroundPackage()
        val w = fg?.let { f -> device.windows().firstOrNull { it.process == f } }
        return AppInfo(fg ?: "", w?.title ?: fg ?: "", fg?.let { p?.categories?.of(it, w?.title ?: it)?.name })
    }

    /** The window whose masked tree the gate judges and the digests hash: the scoped window,
     *  else the foreground one. */
    private fun digestRoot(): UiNode? {
        val s = scope
        if (s != null) {
            val w = runCatching { scopedWindow() }.getOrNull()
            if (w != null) return device.windowRoot(w.id)
        }
        return foregroundRoot()
    }

    private fun foregroundRoot(): UiNode? =
        (device.windows().firstOrNull { it.foreground } ?: device.windows().firstOrNull())
            ?.let { device.windowRoot(it.id) }

    /** Whether the caller may see this app at all. Deny categories (finance, passwords, the
     *  user's block list) are invisible; a finance app with a task-level visibility exemption
     *  from the caller is visible again — passwords and blocked never get there, the grant
     *  itself is refused. */
    private fun appVisible(pkg: String, title: String? = null): Boolean {
        val p = policy ?: return true
        return !p.categories.isDenied(pkg, title) || pkg in financeVisible
    }

    private fun requireAppVisible(pkg: String, title: String? = null) {
        if (!appVisible(pkg, title)) throw AgentError("app-denied: ${pkg.ifEmpty { "当前应用" }} 对调用方不可见（敏感类目缺省拒阅，或已被用户拉黑）", "app-denied")
    }

    /**
     * The gated-op runner. With an approval credential: the credential-field refusal first
     * (nothing about a password or code field is negotiable, and it must not consume anything),
     * then the four checks, then the fresh ref resolution and execution. Without: resolve the
     * target, refuse credential fields, run the ask gate — a hit fails as `approval-required`
     * with a semantics receipt, unless the caller exempted this app × action kind.
     */
    private fun <T> gated(
        op: String,
        args: JSONObject,
        checkCredential: Boolean,
        target: (Boolean) -> UiNode?,
        execute: (UiNode?) -> T,
    ): T {
        val p = policy ?: return execute(target(true))
        val info = appInfo()
        // Deny outranks everything below it, including an approval credential.
        requireAppVisible(info.pkg, info.title)
        val approval = args.optJSONObject("approval")
        if (approval != null && op in GATED) {
            // Gate order (design D1): the credential field is refused before the credential is
            // even checked — a write to a password or code field never consumes anything, and a
            // lenient ref resolution cannot preempt the screen check below.
            if (checkCredential) refuseCredentialField(target(false))
            checkApproval(op, args, approval)
            val t = target(true)
            p.consume(approval.getString("id"))
            return execute(t)
        }
        val t = target(true)
        if (checkCredential) refuseCredentialField(t)
        val reasons = p.gate.reasons(op, t, args.optString("text", ""), info.pkg, info.title, digestRoot())
        if (reasons.isNotEmpty() && !p.gate.exempted(info.pkg, reasons, askExemptions)) throw approvalRequired(op, args, info, t, reasons)
        return execute(t)
    }

    /** Credential fields are unwritable, by approval or exemption as much as by anything else. */
    private fun refuseCredentialField(t: UiNode?) {
        val p = policy ?: return
        if (t != null && p.masker.isCredentialField(t)) {
            throw AgentError("credential-field-denied: 该输入框是密码或验证码字段，Stream 不代写；到手机上自己输入", "credential-field-denied")
        }
    }

    /** The four checks, in order; any failure executes nothing and consumes nothing. */
    private fun checkApproval(op: String, args: JSONObject, a: JSONObject) {
        val p = policy!!
        fun fail(code: String, why: String): Nothing = throw AgentError("$code: $why", code)
        val id = a.optString("id")
        val binding = a.optString("bindingDigest")
        val screen = a.optString("screenDigest")
        val expiresAt = a.optLong("expiresAt", Long.MIN_VALUE)
        if (id.isEmpty() || binding.isEmpty() || screen.isEmpty() || expiresAt == Long.MIN_VALUE)
            fail("approval-mismatch", "凭据不完整（id / bindingDigest / screenDigest / expiresAt）")
        if (System.currentTimeMillis() >= expiresAt) fail("approval-expired", "凭据已过期（以执行端时钟比对 expiresAt=$expiresAt）")
        if (p.bindingDigest(op, args) != binding) fail("approval-mismatch", "凭据与本设备、本会话、本 op 或本次参数不符")
        if (p.isConsumed(id)) fail("approval-used", "这份批准已执行过一次")
        val root = digestRoot()
        if (root == null || p.screenDigest(p.masker.maskTree(root)) != screen) fail("approval-stale", "批准之后屏幕已经变化，请重新发起审批")
    }

    /** The `approval-required` receipt: structured semantics, no screen text, no tree, no
     *  credential values — the control label comes from the masked tree, trimmed. */
    private fun approvalRequired(op: String, args: JSONObject, info: AppInfo, target: UiNode?, reasons: List<String>): AgentError {
        val p = policy!!
        val app = JSONObject().put("id", info.pkg).put("name", info.title)
        if (info.category != null) app.put("category", info.category)
        val sem = JSONObject().put("op", op).put("app", app).put("reasons", JSONArray(reasons))
        if (target != null) {
            sem.put("control", JSONObject().put("role", target.role).put("label", p.masker.maskedName(target).take(LABEL_MAX)))
        }
        val root = digestRoot()
        if (root != null) {
            sem.put("bindingDigest", p.bindingDigest(op, args))
            sem.put("screenDigest", p.screenDigest(p.masker.maskTree(root)))
            // A masked snapshot of the page as it stood at the ask; a FLAG_SECURE page (or an
            // unreachable screen) simply omits the reference.
            val (areas, locatable) = p.masker.areasToCover(root)
            if (locatable) {
                try {
                    val shot = device.screenshot(areas)
                    sem.put("snapshotRef", p.putSnapshot(shot.jpeg, shot.window, shot.scale))
                } catch (_: Exception) { /* no snapshot is fine */ }
            }
        }
        return AgentError("approval-required: 动作命中敏感判定（${reasons.joinToString("、")}），等批准后原样重发并附凭据", "approval-required", sem)
    }

    /** The deepest node covering [r]'s centre — what a coordinate tap would land on. */
    private fun pointTarget(r: Rect): UiNode? {
        val px = r.centerX
        val py = r.centerY
        var hit: UiNode? = null
        fun consider(n: UiNode) {
            if (n.rect.w <= 0 || n.rect.h <= 0) return
            if (px >= n.rect.x && px < n.rect.x + n.rect.w && py >= n.rect.y && py < n.rect.y + n.rect.h) {
                if (hit == null || n.rect.w * n.rect.h <= hit!!.rect.w * hit!!.rect.h) hit = n
            }
            n.children.forEach(::consider)
        }
        digestRoot()?.let { consider(it) }
        return hit
    }

    // ---- control frames (busy, exemptions) ------------------------------------------

    fun setBusy(busy: Boolean, reason: String?) {
        busyReason = if (busy) (reason ?: "") else null
    }

    /** Replaces the whole exemption state an empty grant revokes everything. A grant touching
     *  an exempt-proof object is refused as a whole and changes nothing. */
    fun grantExemptions(ask: List<AskExemption>, financeVisibleApps: List<String>) {
        val p = policy
        if (p != null) {
            for (f in financeVisibleApps) {
                val cat = p.categories.of(f)?.name
                if (cat == "passwords" || cat == "blocked") {
                    throw AgentError("exemption-invalid: $f 属 $cat 类目，可见性不可豁免", "exemption-invalid")
                }
            }
            for (a in ask) if (a.app.isEmpty() || a.action.isEmpty()) {
                throw AgentError("exemption-invalid: ask 豁免需要 app 与动作类目", "exemption-invalid")
            }
        }
        askExemptions.clear()
        askExemptions.addAll(ask)
        financeVisible.clear()
        financeVisible.addAll(financeVisibleApps)
    }

    private fun reasonPart(reason: String) = if (reason.isEmpty()) "" else "（$reason）"

    // ---- reads ----------------------------------------------------------------------

    private fun maskName(n: UiNode): String = policy?.masker?.maskedName(n) ?: n.name

    private fun find(q: A11yQuery): Map<String, Any?> {
        val s = scope
        if (s == null) requireAppVisible(device.foregroundPackage() ?: "")
        val win = scopedWindow()
        requireAppVisible(win.process, win.title)
        // Read before the snapshot: a change while it is being built must also stale its refs.
        val version = device.treeVersion()
        val root = device.windowRoot(win.id) ?: throw AgentError("no-window-match: 限定的窗口已经不在了，重新 scopeWindow")
        val hits = findAll(root, q)
        val ids = refs.snapshot(hits.map { Hit(it, s!!, win.id, version) })
        val els = hits.mapIndexed { i, n ->
            mapOf("ref" to ids[i], "role" to n.role, "name" to maskName(n), "className" to n.className, "rect" to n.rect.toMap())
        }
        val out = mutableMapOf<String, Any?>("elements" to els)
        if (hits.isEmpty() && !win.foreground) {
            out["unbuilt"] = "a11y-unbuilt: 限定的窗口不在前台，空结果不可采信"
        }
        return out
    }

    /** The node behind [ref]. Fresh resolution also demands the screen it was found on still be
     *  in front; a lenient one (the credential-field pre-check on an approval resend) only
     *  demands the ref still belong to this scope and this ref generation. */
    private fun resolveRef(ref: String, fresh: Boolean = true): UiNode {
        val hit = refs.resolve(ref)
        fun stale(why: String): Nothing = throw StaleRefException("stale-ref: $ref $why; find it again")
        if (hit.scope != scope) stale("was found under another scope")
        if (!fresh) return hit.node
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
        val front = device.foregroundComponent()
        if (front.contains(".wakepath.ui.ConfirmStartActivity") || front == HYPEROS_CONFIRM) {
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

    /** Reads a screenshot: by `snapshotRef` the caller keeps from an `approval-required` receipt,
     *  else a fresh shot with the credential areas covered; content that cannot be vouched for
     *  does not leave the device. */
    private fun screenshot(args: JSONObject): Map<String, Any?> {
        val p = policy
        val ref = if (args.has("snapshotRef")) args.getString("snapshotRef") else null
        if (ref != null && p != null) {
            val snap = p.getSnapshot(ref)
                ?: throw AgentError("stale-ref: 快照已不在保留期内（只保留最近 ${PolicyContext.SNAPSHOT_KEEP} 张），重新触发一次审批", "stale-ref")
            return mapOf(
                "base64" to Base64.getEncoder().encodeToString(snap.jpeg),
                "window" to snap.window.toMap(), "scale" to snap.scale,
            )
        }
        requireAppVisible(device.foregroundPackage() ?: "")
        val root = foregroundRoot()
        val (areas, locatable) = p?.masker?.areasToCover(root) ?: (emptyList<Rect>() to true)
        if (p != null && !locatable) {
            throw AgentError("secure-window: 画面含凭据内容且无法确保遮盖完整，不出图", "secure-window")
        }
        return device.screenshot(areas).let {
            mapOf("base64" to Base64.getEncoder().encodeToString(it.jpeg), "window" to it.window.toMap(), "scale" to it.scale)
        }
    }

    private fun need(o: JSONObject, k: String) { if (!o.has(k) || o.isNull(k)) throw AgentError("missing arg: $k") }
    private fun obj(o: JSONObject, k: String): JSONObject { need(o, k); return o.getJSONObject(k) }
    private fun str(o: JSONObject, k: String): String { need(o, k); return o.getString(k) }
    private fun int(o: JSONObject, k: String): Int { need(o, k); return o.getInt(k) }
    private fun long(o: JSONObject, k: String): Long { need(o, k); return o.getLong(k) }
    private fun rect(o: JSONObject) = Rect(o.getInt("x"), o.getInt("y"), o.getInt("w"), o.getInt("h"))

    private companion object {
        /** The receipt's control label is masked text trimmed to this bound. */
        const val LABEL_MAX = 64
    }
}

fun WindowInfo.toMap(): Map<String, Any?> = mapOf("id" to id, "process" to process, "title" to title, "foreground" to foreground)
