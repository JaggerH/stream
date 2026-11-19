package com.streamapp.android.agent

import com.streamapp.android.OccupancyHint
import com.streamapp.android.policy.AskExemption
import com.streamapp.android.policy.PolicyContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

internal val ANDROID_OPS = listOf(
    "windows", "scopeWindow", "focusApp", "find", "invoke", "setValue", "type", "clearInput",
    "click", "scroll", "press", "readSubtree", "screenshot", "url", "sleep", "status",
)

/** Capabilities past their first version; the rest are at v1. */
private val CAP_VERSIONS = mapOf("ui.tree" to 4, "app.launch" to 2)

/** The capability manifest the hello declares: only what [ANDROID_OPS] actually back. `ui.tree`
 *  (windows / find / readSubtree), `ui.act` (click / invoke / scroll / press), `screen.shot`,
 *  `app.launch` (focusApp), `app.in_use` (the `app-in-use` refusal), `input.text` (setValue / type /
 *  clearInput). No notification posting or intent running: there are no ops for them.
 *
 *  `app.launch` is at v2: focusApp takes `fresh: true` (open at the launcher activity, task cleared).
 *  `ui.tree` is at v2: find elements carry control values (`checked`, `range`, `state`) and a found
 *  label brings its row's value-bearing controls along (`values`).
 *  `ui.tree` is at v3: find elements carry `hintText` / `isShowingHintText` / `viewId` /
 *  `editable`, windows carry `type` / `layer`, both replies carry `viewport`, refs persist across
 *  reads and carry over by identity, stale errors carry `semantics.kind`, actions relocate a ref
 *  in place and wait for the screen to settle (`settled` / `changedDuringRead` / `effect`).
 *  `ui.tree` is at v4: `scroll` takes `until` (bounded scroll-until with a receipt), and a system
 *  ANR dialog's `windows` row carries `anr: true` plus the app package it is about. */
internal val ANDROID_CAPS = listOf("ui.tree", "ui.act", "screen.shot", "app.launch", "app.in_use", "input.text")
    .map { com.streamapp.android.protocol.Capability(it, CAP_VERSIONS[it] ?: 1) }


private val NO_WAKE = setOf("status", "sleep", "windows", "url")

/** Window kinds a caller may scope to (and that scope resolution matches): the keyboard and
 *  accessibility overlays are listed by `windows` but never scoped, searched or acted on. */
private val SCOPEABLE_TYPES = setOf("application", "system")

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
internal class Dispatcher(
    private val raw: Device,
    private val policy: PolicyContext? = null,
    private val occupancy: Occupancy = Occupancy(),
    private val settleTiming: Settle = Settle(),
    /** The clock the scroll-until bounds read; tests advance it without waiting. */
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    /** The app (and optional title substring) the agent limited itself to. An Activity change
     *  replaces the window, so the scope is re-resolved against `windows()` on every use. */
    private data class Scope(val process: String, val title: String?)
    /** A found node, bound to the scope it was found under (window and read version are the
     *  ref table's business). */
    private class Hit(val node: UiNode, val scope: Scope)
    private val refs = RefTable<Hit>()
    private var scope: Scope? = null
    /** [raw] behind the current request's cancel token; replaced at the start of every dispatch. */
    private var device: Device = raw
    /** Set when the last ref resolution relocated the node in a fresh read; the settle receipt
     *  reports it as `relocated: true`, once. */
    private var relocatedLast = false
    /** The screen's fingerprint just before a gated action ran — the settle wait compares. */
    private var preActionPrint: List<ElementFp>? = null

    /** Per-connection policy state. The relay builds a fresh Dispatcher per connection, so a
     *  disconnect clears busy and every granted exemption on its own. */
    @Volatile private var busyReason: String? = null
    private val askExemptions = mutableSetOf<AskExemption>()
    private val financeVisible = mutableSetOf<String>()

    fun dispatch(op: String, args: JSONObject, cancel: Cancel = Cancel()): Any? {
        device = CancellableDevice(raw, cancel)
        relocatedLast = false
        preActionPrint = null
        if (op !in ANDROID_OPS) throw AgentError("unknown op: $op")
        if (op !in NO_WAKE) device.ensureAwake()
        busyReason?.let { reason ->
            if (op !in BUSY_PASS) throw AgentError("device-busy: 执行端置忙，等审批期间不执行新动作" + reasonPart(reason), "device-busy")
        }
        // Occupancy for the action ops — the app the action would land on (the scoped app, else
        // the foreground one) — before anything happens. focusApp and scopeWindow judge their own
        // target inside their branch; this is here rather than in gated() so it holds without a
        // policy too (the JVM tests run one).
        if (op in GATED || op == "press") {
            val info = appInfo()
            requireAppNotInUse(op, info.pkg, info.title)
        }
        return when (op) {
            // The host app's own windows are listed too, marked `self` — the one place they appear.
            // Every row carries `viewport` (the screen the windows sit on) beside its type and layer.
            "windows" -> {
                val vp = device.screenSize().let { mapOf("width" to it.w, "height" to it.h) }
                device.windows().filter { it.self || appVisible(it.process, it.title) }.map { it.toMap() + ("viewport" to vp) }
            }
            "scopeWindow" -> {
                val match = obj(args, "match")
                val w = resolveWindow(match)
                requireAppVisible(w.process, w.title)
                requireAppNotInUse("scopeWindow", w.process, w.title)
                scope = Scope(w.process, if (match.has("title")) match.getString("title") else null)
                mapOf("window" to w.toMap())
            }
            "focusApp" -> {
                val pkg = str(obj(args, "match"), "process")
                requireAppVisible(pkg)
                requireAppNotInUse("focusApp", pkg)
                val fresh = args.optBoolean("fresh", false)
                val ok = focusApp(pkg, fresh)
                if (fresh) mapOf("ok" to ok, "fresh" to true) else mapOf("ok" to ok)
            }
            "find" -> find(A11yQuery.from(obj(args, "query")))
            "invoke" -> {
                val ref = str(args, "ref")
                gated(op, args, checkCredential = false, target = { fresh, reloc -> resolveRef(ref, fresh, reloc) }) { t ->
                    if (!device.click(t!!)) throw AgentError("action-failed: 节点不可点，换坐标点击")
                    settle(args, "invoke")
                }
            }
            "setValue" -> {
                val ref = str(args, "ref")
                gated(op, args, checkCredential = true, target = { fresh, reloc -> resolveRef(ref, fresh, reloc) }) { t ->
                    if (!device.setText(t!!, str(args, "text"))) throw AgentError("not-editable: $ref 不接受 ACTION_SET_TEXT")
                    settle(args, "value")
                }
            }
            "type" -> {
                refuseMessage(args)
                val text = str(args, "text")
                gated(op, args, checkCredential = true, target = { _, _ -> focused() }) { t ->
                    if (!device.setText(t!!, t.text + text)) throw AgentError("not-editable: 焦点输入框不接受 ACTION_SET_TEXT")
                    settle(args, "value")
                }
            }
            "clearInput" -> {
                refuseMessage(args)
                gated(op, args, checkCredential = true, target = { _, _ -> focused() }) { t ->
                    if (!device.setText(t!!, "")) throw AgentError("not-editable: 焦点输入框不接受 ACTION_SET_TEXT")
                    settle(args, "value")
                }
            }
            "click" -> {
                refuseMessage(args)
                val r = rect(obj(args, "rect"))
                gated(op, args, checkCredential = false, target = { _, _ -> pointTarget(r) }) { _ ->
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
                gated(op, args, checkCredential = false, target = { _, _ -> null }) { _ ->
                    val dir = str(args, "dir")
                    val until = args.optString("until", "").trim()
                    val r = if (until.isEmpty()) scroll(dir, int(args, "amount"))
                    else scrollUntil(dir, until, untilMaxSteps(args), untilTimeoutMs(args))
                    settle(args, if (r["method"] == SCROLL_GESTURE) "coords" else "a11y") + r
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
                preActionPrint = readTree(digestRoot()).fps
                if (key == "Enter") {
                    // The Enter that sends a message or submits a form is a commit: the same
                    // judgment and the same approval flow as a typed newline.
                    return gated(op, args, checkCredential = false, target = { _, _ -> focused() }) { t ->
                        if (!device.imeEnter(t!!)) throw AgentError("action-failed: 系统没执行 $key")
                        settle(args, "coords")
                    }
                }
                val done = when (key) {
                    "Back" -> device.globalBack()
                    "Home" -> device.globalHome()
                    else -> throw AgentError("unsupported-key: $key（安卓只认 Back / Home / Enter）")
                }
                if (!done) throw AgentError("action-failed: 系统没执行 $key")
                settle(args, "coords")
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
        val w = fg?.let { f -> windows().firstOrNull { it.process == f } }
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
        foregroundWindow()?.let { device.windowRoot(it.id) }

    private fun foregroundWindow(): WindowInfo? = windows().let { ws -> ws.firstOrNull { it.foreground } ?: ws.firstOrNull() }

    /** The windows the agent may scope, search and act on: every window but the host app's own. */
    private fun windows(): List<WindowInfo> = device.windows().filterNot { it.self }

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

    /** The occupancy check: an app holding the foreground that the user touched in the last
     *  [IN_USE_RECENT_MS] is theirs — an op that would take the screen fails as `app-in-use`
     *  instead of stealing it (their touches, not our injected gestures: `Device.lastUserInputMs`
     *  already excludes those). No touch fact at all means we cannot say anyone is using it —
     *  the check fails open. Suspending, waiting and retrying are the caller's decision.
     *
     *  Before that, the embedding app's [Occupancy.hint] is asked about the target and about the
     *  app in front (the embedding app itself, when it is in front): a `true` is the same refusal.
     *  With [Occupancy.anyRecentTouch] on, a recent touch on whatever app is in front refuses too. */
    private fun requireAppNotInUse(op: String, pkg: String, title: String? = null) {
        // Read only when needed: without a hint the order of reads is what it always was.
        val fg by lazy { device.foregroundPackage() }
        occupancy.hint()?.let { hint ->
            for (candidate in listOfNotNull(pkg.ifEmpty { null }, fg).distinctBy { it.lowercase() }) {
                val busy = try { hint.inUse(candidate) } catch (_: RuntimeException) { null }
                if (busy == true) throw appInUse(op, candidate, title.takeIf { candidate.equals(pkg, ignoreCase = true) })
            }
        }
        val last = device.lastUserInputMs() ?: return
        if (System.currentTimeMillis() - last > IN_USE_RECENT_MS) return
        val front = fg
        if (front?.equals(pkg, ignoreCase = true) == true) throw appInUse(op, pkg, title)
        if (front != null && occupancy.anyRecentTouch()) throw appInUse(op, front, null)
    }

    private fun appInUse(op: String, pkg: String, title: String?): AgentError {
        val app = JSONObject().put("id", pkg).put("name", title?.takeIf { it.isNotBlank() && title != pkg } ?: pkg)
        return AgentError("app-in-use: $pkg 正被用户在前台使用，Stream 不抢；等用户用完再试", "app-in-use",
            JSONObject().put("op", op).put("app", app))
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
        target: (fresh: Boolean, relocate: Boolean,) -> UiNode?,
        execute: (UiNode?) -> T,
    ): T {
        val p = policy ?: run {
            preActionPrint = readTree(digestRoot()).fps
            return execute(target(true, true))
        }
        val info = appInfo()
        // Deny outranks everything below it, including an approval credential.
        requireAppVisible(info.pkg, info.title)
        val approval = args.optJSONObject("approval")
        if (approval != null && op in GATED) {
            // Gate order (design D1): the credential field is refused before the credential is
            // even checked — a write to a password or code field never consumes anything, and a
            // lenient ref resolution cannot preempt the screen check below. A fresh resolution
            // never relocates under a credential: the approval binds the screen it was approved on.
            if (checkCredential) refuseCredentialField(target(false, false))
            checkApproval(op, args, approval)
            val t = target(true, false)
            p.consume(approval.getString("id"))
            preActionPrint = readTree(digestRoot()).fps
            return execute(t)
        }
        val t = target(true, true)
        if (checkCredential) refuseCredentialField(t)
        val reasons = p.gate.reasons(op, t, args.optString("text", ""), info.pkg, info.title, digestRoot())
        if (reasons.isNotEmpty() && !p.gate.exempted(info.pkg, reasons, askExemptions)) throw approvalRequired(op, args, info, t, reasons)
        preActionPrint = readTree(digestRoot()).fps
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
        // A hit without a value of its own (a row's title) brings the value-bearing controls of
        // its row along, each with a ref of its own in the same snapshot.
        val parents = parentsOf(root)
        val rows = hits.map { if (hasValue(it)) emptyList() else rowValues(it, root, parents) }
        val nodes = hits.toMutableList()
        val index = java.util.IdentityHashMap<UiNode, Int>()
        hits.forEachIndexed { i, n -> index.putIfAbsent(n, i) }
        for (v in rows.flatten()) if (!index.containsKey(v)) { index[v] = nodes.size; nodes += v }
        // Fingerprints drive the ref carry-over: the whole read's, plus each reported node's.
        val read = readTree(root)
        val byNode = java.util.IdentityHashMap<UiNode, ElementFp>()
        read.entries.forEach { (n, fp) -> byNode.putIfAbsent(n, fp) }
        val fps = nodes.map { byNode[it] ?: fpFallback(it) }
        val shortEdge = shortEdgeOf(device.screenSize())
        val ids = refs.snapshot(nodes.map { Hit(it, s!!) }, fps, read.fps, win.id, version, shortEdge, device::changedSince)
        val masker = policy?.masker
        val els = hits.mapIndexed { i, n ->
            val el = linkedMapOf<String, Any?>("ref" to ids[i], "role" to n.role, "name" to maskName(n), "className" to n.className, "rect" to n.rect.toMap())
            n.hintText.takeIf { it.isNotEmpty() && masker?.isCredentialField(n) != true }?.let { el["hintText"] = it }
            if (n.isShowingHint) el["isShowingHintText"] = true
            readableResourceId(n.viewId)?.let { el["viewId"] = it }
            el["editable"] = n.isEditable
            el += valueFields(n)
            if (rows[i].isNotEmpty()) el["values"] = rows[i].map { v ->
                val m = linkedMapOf<String, Any?>("ref" to ids[index[v]!!], "role" to v.role)
                maskName(v).takeIf { it.isNotEmpty() }?.let { m["name"] = it }
                m["rect"] = v.rect.toMap()
                m += valueFields(v)
                m
            }
            el
        }
        val out = mutableMapOf<String, Any?>("elements" to els)
        out["viewport"] = device.screenSize().let { mapOf("width" to it.w, "height" to it.h) }
        if (hits.isEmpty() && !win.foreground) {
            out["unbuilt"] = "a11y-unbuilt: 限定的窗口不在前台，空结果不可采信"
        }
        return out
    }

    /**
     * The node behind [ref]. Fresh resolution also demands the screen it was found on still be
     * in front; a lenient one (the credential-field pre-check on an approval resend) only
     * demands the ref still belong to this scope. When the node is no longer where it was
     * found — and [relocate] is allowed — the dispatcher looks it up again in a fresh read by
     * identity ([relocate]): the same control keeps the action, the reply reports `relocated`.
     * Not allowed with an approval credential: the credential binds the screen it was approved
     * on, and a relocated target would sidestep that binding.
     */
    private fun resolveRef(ref: String, fresh: Boolean = true, relocate: Boolean = true): UiNode {
        val hit = refs.resolve(ref)
        fun stale(kind: String, why: String): Nothing = throw StaleRefException("stale-ref: $ref $why; find it again", kind, ref)
        if (hit.value.scope != scope) stale(STALE_REF_RETIRED, "was found under another scope")
        if (!fresh) return hit.value.node
        val win = scopedWindow()
        if (win.id != hit.windowId) stale(STALE_REF_RETIRED, "belongs to a window that is no longer the scoped one")
        val scrolledOver = device.scrolledSince(hit.version, hit.windowId, hit.fp.rect)
        if (scrolledOver) stale(STALE_ELEMENT_MOVED, "a scroll ran over it (list rows recycle)")
        if (!device.changedSince(hit.version, hit.windowId, hit.fp.rect) && device.isCurrent(hit.value.node)) {
            return hit.value.node
        }
        if (!relocate) stale(STALE_ELEMENT_MOVED, "no longer where it was found")
        val again = relocateRef(hit, win) ?: stale(STALE_ELEMENT_MOVED, "no longer where it was found (no unique match now)")
        relocatedLast = true
        return again
    }

    /** Finds [hit]'s control in a fresh read of the scoped window and re-binds the ref to it.
     *  Null when nothing uniquely matches. */
    private fun relocateRef(hit: Tracked<Hit>, win: WindowInfo): UiNode? {
        val version = device.treeVersion()
        val root = device.windowRoot(win.id) ?: return null
        val read = readTree(root)
        val before = refs.lastReadOf(win.id).ifEmpty { listOf(hit.fp) }
        val found = relocate(hit.fp, before, read.fps, shortEdgeOf(device.screenSize())) as? Relocation.Found ?: return null
        val node = read.nodeAt(found.index)
        refs.refresh(hit.ref, Hit(node, hit.value.scope), read.fps[found.index], version)
        return node
    }

    private fun focusApp(pkg: String, fresh: Boolean): Boolean {
        // The old scope belongs to whatever app was in front; never let a later find search it.
        scope = null
        // A fresh launch of the app already in front replaces its page: until the window set has
        // changed, "it is in front" still describes the page being torn down.
        val wasFront = fresh && device.foregroundPackage() == pkg
        val before = device.treeVersion()
        device.launch(pkg, fresh)
        fun arrived() = device.foregroundPackage() == pkg &&
            (!wasFront || device.changedSince(before, "", Rect(0, 0, 0, 0)))
        // Bounded by attempts (25 x 200 ms), not by the wall clock.
        repeat(25) {
            if (arrived()) {
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

    /**
     * Scrolls the scoped window (else the foreground one) by [amount] steps. Accessibility first:
     * the window's scroll candidates ([scrollCandidates]: an inner list before the wrapper around
     * it, then by on-screen area) get `ACTION_SCROLL_DOWN`/`UP` (or `FORWARD`/`BACKWARD`) — no
     * touch, nothing under the finger can be clicked, no fling. An action's "true" proves nothing
     * (an outer wrapper of a nested-scrolling page may accept it and stay put), so every step is
     * checked against the content on screen. A candidate that refuses its first step, or accepts it
     * without anything moving, gives way to the next. A candidate declaring only the opposite
     * direction is at this end: when nothing else moved, the reply is `steps: 0, end: true` with no
     * gesture. Otherwise, when none moves, a gesture, with `a11y: "refused"` or `"no-effect"`. A later step refused or without effect is the end of the
     * content: the scroll stops there, `end: true`.
     */
    private fun scroll(dir: String, amount: Int): Map<String, Any?> {
        val forward = when (dir) {
            "down" -> true
            "up" -> false
            else -> throw AgentError("missing arg: dir 必须是 up 或 down")
        }
        val steps = amount.coerceIn(1, 10)
        // Unscoped: only a window actually in front (never a background one, never the host's own).
        val win = if (scope != null) scopedWindow() else windows().firstOrNull { it.foreground }
        val bounds = win?.let { device.windowBounds(it.id) } ?: device.screenSize()
        val root = win?.let { device.windowRoot(it.id) }
        val candidates = if (win != null && root != null) scrollCandidates(root, bounds) else emptyList()
        var noEffect = false
        var atEnd = false
        for (c in candidates.take(MAX_SCROLL_CANDIDATES)) {
            val wid = win!!.id
            val offers = if (forward) c.scrollsForward else c.scrollsBackward
            val opposite = if (forward) c.scrollsBackward else c.scrollsForward
            // Only the other way declared: the content is already at this end.
            if (!offers) { if (opposite) atEnd = true; continue }
            val area = visiblePart(c.rect, bounds) ?: continue
            var before = contentPrint(device.windowRoot(wid), area)
            if (!device.scrollNode(c, forward)) continue
            val first = awaitMove(wid, area, before)
            if (first == null) { noEffect = true; continue }
            before = first
            var done = 1
            var end = false
            while (done < steps) {
                val next = if (device.scrollNode(c, forward)) awaitMove(wid, area, before) else null
                if (next == null) { end = true; break }
                before = next
                done++
            }
            val out = mutableMapOf<String, Any?>("method" to SCROLL_A11Y, "steps" to done)
            if (end) out["end"] = true
            return out
        }
        // Nothing moved and a container says it is at this end: so is the scroll, no gesture.
        if (atEnd) return mapOf("method" to SCROLL_A11Y, "steps" to 0, "end" to true)
        val area = candidates.firstOrNull()?.let { visiblePart(it.rect, bounds) } ?: bounds
        val g = swipeGeometry(area, forward, device.touchSlop(), device.density())
        repeat(steps) {
            device.swipe(g.x, g.from, g.x, g.to, SWIPE_MS, SWIPE_HOLD_MS)
            device.sleep(150)
        }
        val out = mutableMapOf<String, Any?>("method" to SCROLL_GESTURE, "steps" to steps)
        if (candidates.isNotEmpty()) out["a11y"] = if (noEffect) "no-effect" else "refused"
        return out
    }

    /**
     * `scroll` with `until`: one scroll step at a time until the wanted text is visible on screen,
     * stopping at the first of three bounds — the content's end (two steps leave the tree
     * unchanged), `maxSteps` (default [UNTIL_DEFAULT_STEPS]) or `timeoutMs` (default
     * [UNTIL_DEFAULT_MS]) — so the caller's own op timeout never has to be the thing that ends it.
     * The receipt says whether the text was found, how many steps ran, why scrolling stopped and a
     * few labels still visible there. One step per check is the point, so the ordinary `amount`
     * argument plays no part here.
     */
    private fun scrollUntil(dir: String, until: String, maxSteps: Int, timeoutMs: Long): Map<String, Any?> {
        val win = if (scope != null) scopedWindow() else windows().firstOrNull { it.foreground }
        val bounds = win?.let { device.windowBounds(it.id) } ?: device.screenSize()
        val deadline = now() + timeoutMs
        var scrolls = 0
        var idle = 0
        var method: String? = null
        fun root(): UiNode? = win?.let { device.windowRoot(it.id) }
            ?: windows().firstOrNull { it.foreground }?.let { device.windowRoot(it.id) }

        var current = root()
        untilHit(current, until)?.let { return untilFound(it, 0, null) }
        while (true) {
            if (scrolls >= maxSteps) return untilMiss(current, scrolls, method, "steps")
            if (now() >= deadline) return untilMiss(current, scrolls, method, "time")
            val before = current ?: return untilMiss(null, scrolls, method, "no-window")
            val print = contentPrint(before, bounds)
            val step = scroll(dir, 1)
            scrolls++
            method = (step["method"] as? String) ?: method
            val after = root()
            current = after
            // Two consecutive steps over an unchanged tree are the end of the content.
            if (contentPrint(after, bounds) == print) idle++ else idle = 0
            untilHit(after, until)?.let { return untilFound(it, scrolls, method) }
            if (idle >= 2) return untilMiss(after, scrolls, method, "end")
        }
    }

    /** The first visible node whose name (or text) contains [needle], case-insensitively. */
    private fun untilHit(root: UiNode?, needle: String): UiNode? {
        if (root == null) return null
        var hit: UiNode? = null
        fun walk(n: UiNode) {
            if (hit != null) return
            if (n.isVisible && (n.name.contains(needle, ignoreCase = true) || n.text.contains(needle, ignoreCase = true))) {
                hit = n
                return
            }
            n.children.forEach(::walk)
        }
        walk(root)
        return hit
    }

    private fun untilFound(node: UiNode, scrolls: Int, method: String?): Map<String, Any?> {
        val out = linkedMapOf<String, Any?>("found" to true, "scrolls" to scrolls)
        method?.let { out["method"] = it }
        out["match"] = linkedMapOf(
            "name" to maskName(node).take(LABEL_MAX),
            "role" to node.role,
            "rect" to node.rect.toMap(),
        )
        return out
    }

    private fun untilMiss(root: UiNode?, scrolls: Int, method: String?, stopped: String): Map<String, Any?> {
        val out = linkedMapOf<String, Any?>("found" to false, "scrolls" to scrolls, "stopped" to stopped)
        method?.let { out["method"] = it }
        out["visible"] = visibleLabels(root)
        return out
    }

    /** A few labels still on screen, last in document order (the bottom of the page) — where a
     *  scroll that did not find its target stopped. Masked and bounded like a receipt's control. */
    private fun visibleLabels(root: UiNode?): List<String> {
        val names = LinkedHashSet<String>()
        fun walk(n: UiNode) {
            if (!n.isVisible) return
            val name = maskName(n)
            if (name.isNotBlank()) names += name.take(LABEL_MAX)
            n.children.forEach(::walk)
        }
        root?.let(::walk)
        return names.toList().takeLast(VISIBLE_LABEL_COUNT)
    }

    private fun untilMaxSteps(args: JSONObject) =
        args.optInt("maxSteps", UNTIL_DEFAULT_STEPS).coerceIn(1, UNTIL_MAX_STEPS)

    private fun untilTimeoutMs(args: JSONObject) =
        args.optLong("timeoutMs", UNTIL_DEFAULT_MS).coerceIn(0, UNTIL_MAX_MS)

    /** Waits for the content inside [area] of window [windowId] to differ from [before], then for it
     *  to settle (an animated scroll still running). The settled print, or null when nothing moved
     *  within [SCROLL_SETTLE_POLLS] polls. */
    private fun awaitMove(windowId: String, area: Rect, before: List<String>): List<String>? {
        var last = before
        var moved = false
        // Up to SCROLL_SETTLE_POLLS polls to see a change, then as many again for it to settle.
        repeat(2 * SCROLL_SETTLE_POLLS) { i ->
            device.sleep(SCROLL_POLL_MS)
            val now = contentPrint(device.windowRoot(windowId), area)
            if (moved && now == last) return now
            if (now != before) moved = true
            last = now
            if (!moved && i + 1 >= SCROLL_SETTLE_POLLS) return null
        }
        return if (moved) last else null
    }

    /**
     * The post-action quiet wait (design informed by Mika's ChangeWait — see the openspec
     * change). Waits until accessibility events have been quiet for [Settle.quietMs] and the
     * tree fingerprint differs from the one before the action ([preActionPrint]); stops at
     * [Settle.capMs] at the latest, so a page whose events never stop (a countdown, a progress
     * bar) does not hold the op. The reply reports `settled`, `changedDuringRead` and, from the
     * fingerprints, `effect`; `expect` is judged after the wait, and a relocation reports
     * `relocated: true` once.
     */
    private fun settle(args: JSONObject, via: String): Map<String, Any?> {
        val before = preActionPrint
        val out = LinkedHashMap<String, Any?>()
        out["via"] = via
        var changed = false
        var settled = false
        var last = before
        if (before != null) {
            val end = System.currentTimeMillis() + settleTiming.capMs
            while (true) {
                device.sleep(settleTiming.pollMs)
                val now = System.currentTimeMillis()
                val quietFor = device.lastA11yEventMs()?.let { now - it } ?: Long.MAX_VALUE
                val cur = readTree(printRoot()).fps
                if (cur != before) changed = true
                last = cur
                if (quietFor >= settleTiming.quietMs && changed) { settled = true; break }
                if (now >= end) break
            }
            out["settled"] = settled
            out["changedDuringRead"] = changed
            out["effect"] = effectOf(before, last ?: before)
        }
        if (relocatedLast) out["relocated"] = true
        relocatedLast = false
        val expect = args.optJSONObject("expect")
        if (expect != null) {
            val root = printRoot()
            out["confirmed"] = root != null && findAll(root, A11yQuery.from(expect)).isNotEmpty()
        }
        return out
    }

    /** The window the settle wait and `expect` read: the scoped one, else the foreground one. */
    private fun printRoot(): UiNode? =
        runCatching { scope?.let { device.windowRoot(scopedWindow().id) } }.getOrNull()
            ?: windows().firstOrNull { it.foreground }?.let { device.windowRoot(it.id) }

    private fun resolveWindow(m: JSONObject): WindowInfo {
        val process = if (m.has("process")) m.getString("process") else null
        val title = if (m.has("title")) m.getString("title") else null
        val hits = windows().filter { w ->
            w.type in SCOPEABLE_TYPES &&
                (process == null || w.process.equals(process, ignoreCase = true)) && (title == null || w.title.contains(title))
        }
        return when (hits.size) {
            0 -> throw AgentError("no-window-match: 没有窗口匹配 $m")
            1 -> hits[0]
            else -> throw AgentError("ambiguous-window: ${hits.size} 个窗口都匹配，请用 title 指名一个；候选：" + hits.joinToString("、") { "「${it.title}」" })
        }
    }

    /** The window the scope currently points at: among the app's windows, the foreground one, else
     *  the first scopeable one (the keyboard and accessibility overlays are never the target). */
    private fun scopedWindow(): WindowInfo {
        val s = scope ?: throw AgentError("no-scope: 还没限定搜索范围，先 scopeWindow / focusApp")
        val hits = windows().filter { w ->
            w.type in SCOPEABLE_TYPES &&
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

        /** How recently the user must have touched the screen for their foreground app to count
         *  as "in use". A reader who has not touched anything this long is not interrupted. */
        const val IN_USE_RECENT_MS = 10_000L
    }
}

/** The embedding app's say in the occupancy check, read per op: its [hint] (see
 *  `StreamAgent.occupancyHint`) and the any-recent-touch policy (see `StreamAgent.anyRecentTouchOccupies`).
 *  The defaults leave the agent's own check alone. */
internal class Occupancy(
    val hint: () -> OccupancyHint? = { null },
    val anyRecentTouch: () -> Boolean = { false },
)

internal fun WindowInfo.toMap(): Map<String, Any?> {
    val m = mutableMapOf<String, Any?>("id" to id, "process" to process, "title" to title, "foreground" to foreground, "type" to type, "layer" to layer)
    if (self) m["self"] = true
    if (anr) {
        m["anr"] = true
        appPackage?.let { m["appPackage"] = it }
    }
    return m
}

internal const val SCROLL_A11Y = "a11y"
internal const val SCROLL_GESTURE = "gesture"
private const val SWIPE_MS = 300L
/** The finger rests this long at the end of a scroll swipe before lifting: no fling. */
internal const val SWIPE_HOLD_MS = 100L
/** A scroll swipe shorter than this many touch slops is refused: too close to a tap. */
internal const val MIN_SWIPE_SLOPS = 4
/** The swipe runs this far (dp) inside the area's right edge — clear of the row content most
 *  apps make tappable, and clear of the system's edge back-gesture zone. */
internal const val EDGE_BAND_DP = 48

/** The part of [r] inside [bounds], or null when they do not overlap. */
internal fun visiblePart(r: Rect, bounds: Rect): Rect? {
    val x1 = maxOf(r.x, bounds.x)
    val y1 = maxOf(r.y, bounds.y)
    val x2 = minOf(r.x + r.w, bounds.x + bounds.w)
    val y2 = minOf(r.y + r.h, bounds.y + bounds.h)
    return if (x2 > x1 && y2 > y1) Rect(x1, y1, x2 - x1, y2 - y1) else null
}

/** How many scroll candidates a scroll tries before falling back to a gesture. */
internal const val MAX_SCROLL_CANDIDATES = 3
/** After an accessibility scroll step: polls this far apart, this many times, for the content to
 *  change (and as many again for it to settle). */
internal const val SCROLL_POLL_MS = 100L
internal const val SCROLL_SETTLE_POLLS = 6

/** Scroll-until bounds: defaults, clamps, and how many labels a miss reports. */
internal const val UNTIL_DEFAULT_STEPS = 20
internal const val UNTIL_MAX_STEPS = 50
internal const val UNTIL_DEFAULT_MS = 15_000L
internal const val UNTIL_MAX_MS = 60_000L
internal const val VISIBLE_LABEL_COUNT = 5

/**
 * The containers a scroll tries, best first: the visible scrollable nodes under [root] not known
 * to scroll sideways and with some part on screen. Ordered by on-screen area (tree order on a
 * tie), except that a scrollable nested inside another and covering at least half of it comes
 * before it: a page whose collapsing toolbar wraps the list in an outer scroll view is scrolled
 * through the list, not the wrapper (the wrapper may accept the action and move nothing).
 */
internal fun scrollCandidates(root: UiNode, bounds: Rect): List<UiNode> {
    class C(val node: UiNode, val area: Long, val ancestors: List<C>)
    val all = mutableListOf<C>()
    fun walk(n: UiNode, ancestors: List<C>) {
        var inner = ancestors
        if (n.isScrollable && n.isVisible && n.scrollAxis != AXIS_HORIZONTAL) {
            val v = visiblePart(n.rect, bounds)
            if (v != null) {
                val c = C(n, v.w.toLong() * v.h, ancestors)
                all += c
                inner = ancestors + c
            }
        }
        n.children.forEach { walk(it, inner) }
    }
    walk(root, emptyList())
    val byArea = all.sortedByDescending { it.area }
    val out = LinkedHashSet<C>()
    fun emit(c: C) {
        if (c in out) return
        byArea.filter { d -> c in d.ancestors && d.area * 2 >= c.area }.forEach(::emit)
        out += c
    }
    byArea.forEach(::emit)
    return out.map { it.node }
}

/** A cheap fingerprint of what is on screen inside [area]: each visible node overlapping it, by
 *  class, label, id and position. A scroll that moved anything changes it; null [root] (the window
 *  is gone) prints empty. */
internal fun contentPrint(root: UiNode?, area: Rect): List<String> {
    val out = mutableListOf<String>()
    fun walk(n: UiNode) {
        if (!n.isVisible) return
        if (n.rect.intersects(area)) out += "${n.className}|${n.name}|${n.viewId}|${n.rect.x},${n.rect.y},${n.rect.w},${n.rect.h}"
        n.children.forEach(::walk)
    }
    root?.let(::walk)
    return out
}

internal data class SwipeGeometry(val x: Int, val from: Int, val to: Int)

/** Where a fallback scroll swipe runs inside [area]: vertically from 70% to 30% of its height
 *  (reversed for up), at an x inside the area's right edge band. Refused (`action-failed`) when the
 *  stroke would be shorter than [MIN_SWIPE_SLOPS] touch slops — the app could read it as a tap. */
internal fun swipeGeometry(area: Rect, forward: Boolean, touchSlop: Int, density: Float): SwipeGeometry {
    val hi = area.y + area.h * 7 / 10
    val lo = area.y + area.h * 3 / 10
    val min = MIN_SWIPE_SLOPS * touchSlop.coerceAtLeast(1)
    if (hi - lo < min) {
        throw AgentError("action-failed: 可滚动区域太矮（滑动距离 ${hi - lo}px，不到触摸阈值的 $MIN_SWIPE_SLOPS 倍 ${min}px），手势会被当成点击，不滑")
    }
    val inset = (EDGE_BAND_DP * density).toInt().coerceAtLeast(1)
    val x = (area.x + area.w - inset).coerceAtLeast(area.centerX)
    return if (forward) SwipeGeometry(x, hi, lo) else SwipeGeometry(x, lo, hi)
}
