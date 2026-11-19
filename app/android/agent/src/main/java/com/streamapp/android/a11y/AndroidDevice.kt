package com.streamapp.android.a11y

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.os.PowerManager
import android.view.Display
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.streamapp.android.AgentIndicator
import com.streamapp.android.StreamAgent
import com.streamapp.android.agent.*
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * `Device` over the live accessibility service. Ops arrive on the relay's worker thread; the
 * gesture and screenshot callbacks are awaited with latches.
 */
internal class AndroidDevice(private val ctx: Context, private val onStop: () -> Unit) : Device {
    /** The indicator, rebuilt when the service is replaced or the host swaps [StreamAgent.indicatorProvider]. */
    private val indicator = IndicatorSlot<StreamAccessibilityService>()
    private var lastShotAt = 0L
    private var wake: PowerManager.WakeLock? = null

    private fun svc(): StreamAccessibilityService =
        StreamAccessibilityService.instance ?: throw AgentError("a11y-off: 无障碍服务没开，到手机的 设置 → 无障碍 → Stream 打开")

    /** The live `AccessibilityNodeInfo` behind a node this device handed out. */
    private fun infoOf(node: UiNode): AccessibilityNodeInfo = when (node) {
        is AndroidNode -> node.info
        is HintlessNode -> node.inner.info
        else -> throw AgentError("action-failed: 不是这台设备给出的节点")
    }

    override fun ensureAwake() {
        val km = ctx.getSystemService(KeyguardManager::class.java)
        val pm = ctx.getSystemService(PowerManager::class.java)
        if (km.isKeyguardLocked && km.isDeviceSecure) throw AgentError("device-locked: 锁屏有密码，Stream 解不开；这台手机要去掉锁屏密码才能无人值守")
        val lock = wake ?: run {
            @Suppress("DEPRECATION")
            pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "stream:op")
                .also { it.setReferenceCounted(false); wake = it }
        }
        // Held for 2 minutes after the latest op, then the screen may sleep again.
        lock.acquire(120_000)
        if (!pm.isInteractive || km.isKeyguardLocked) {
            val before = WakeActivity.createdAt
            ctx.startActivity(Intent(ctx, WakeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val started = waitFor(1_500) { WakeActivity.createdAt != before }
            if (!started && km.isKeyguardLocked) {
                // The OS may have refused the background activity; a non-secure keyguard also yields to a swipe.
                val s = screenSize()
                try {
                    swipe(s.w / 2, s.h * 85 / 100, s.w / 2, s.h * 35 / 100, 300)
                } catch (e: AgentError) { /* judged by the keyguard state below */ }
            }
            waitFor(if (started) 3_000 else 1_500) { !km.isKeyguardLocked && pm.isInteractive }
            if (km.isKeyguardLocked) {
                if (!started && WakeActivity.createdAt == before) {
                    throw AgentError("blocked-by-os: 系统拦住了 Stream 从后台弹出界面，解不开锁屏。到 设置 → 应用 → Stream → 其他权限，打开「后台弹出界面」和「锁屏显示」")
                }
                throw AgentError("device-locked: 锁屏没能解开")
            }
            if (!pm.isInteractive) throw AgentError("device-locked: 屏幕没能点亮")
        }
    }

    private fun waitFor(ms: Long, cond: () -> Boolean): Boolean {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            if (cond()) return true
            Thread.sleep(50)
        }
        return cond()
    }

    override fun windows(): List<WindowInfo> {
        val listed = svc().windows.map { w -> w to facts(w) }
        val facts = listed.map { it.second }
        // An accessibility overlay holding input focus is the active window; the app under it is
        // still the one in front.
        val front = pickForeground(facts, ctx.packageName)?.id
        return listed.mapIndexedNotNull { i, (w, f) ->
            val pkg = f.pkg ?: return@mapIndexedNotNull null
            // Overlays and keyboards are listed (with their kind and z-order) so a caller can
            // tell them apart; they are never the foreground and never a scope target.
            val foreground = f.id == front || ((f.active || f.focused) && canBeForeground(f.type, pkg, ctx.packageName))
            // The system's "app isn't responding" dialog is a system window; report it as one and
            // name the app it is about where the phone can tell. The agent never taps its buttons.
            val anr = f.type == AccessibilityWindowInfo.TYPE_SYSTEM && anrDialog(w)
            // The host app's own windows are listed, marked, so a caller can tell it is in front;
            // the dispatcher never scopes or acts on them.
            WindowInfo(f.id, pkg, w.title?.toString() ?: pkg, foreground, self = pkg == ctx.packageName,
                type = if (anr) "system" else windowTypeName(w.type), layer = w.layer,
                anr = anr, appPackage = if (anr) anrOwner(facts, i, ctx.packageName) else null)
        }
    }

    /** Whether this system window is the ANR dialog: its title plus a bounded sample of its
     *  controls (the AOSP buttons carry `android:id/aerr_*`; a translated build is caught by its
     *  words). System windows are rare, so the sample costs little. */
    private fun anrDialog(w: AccessibilityWindowInfo): Boolean {
        val title = w.title?.toString().orEmpty()
        val root = w.root ?: return looksLikeAnr(title, emptyList(), emptyList())
        val labels = mutableListOf<String>()
        val ids = mutableListOf<String>()
        var budget = ANR_PROBE_NODES
        fun walk(n: AccessibilityNodeInfo, depth: Int) {
            if (budget <= 0 || depth > ANR_PROBE_DEPTH) return
            budget--
            n.text?.toString()?.takeIf { it.isNotBlank() }?.let { labels += it }
            n.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { labels += it }
            n.viewIdResourceName?.let { ids += it }
            for (k in 0 until n.childCount) {
                val c = n.getChild(k) ?: continue
                walk(c, depth + 1)
            }
        }
        walk(root, 0)
        return looksLikeAnr(title, labels, ids)
    }

    private fun facts(w: AccessibilityWindowInfo) =
        WindowFacts(w.id.toString(), w.type, w.root?.packageName?.toString(), w.isActive, w.isFocused)

    override fun windowBounds(windowId: String): Rect? =
        svc().windows.firstOrNull { it.id.toString() == windowId }?.let { w ->
            val r = android.graphics.Rect().also { w.getBoundsInScreen(it) }
            Rect(r.left, r.top, r.width(), r.height())
        }

    override fun windowRoot(windowId: String): UiNode? =
        svc().windows.firstOrNull { it.id.toString() == windowId }?.root?.let { AndroidNode.snapshot(it) }

    override fun treeVersion(): Long = StreamAccessibilityService.changes.version()

    override fun changedSince(version: Long, windowId: String, rect: Rect): Boolean =
        StreamAccessibilityService.changes.changedSince(version, windowId, rect)

    override fun scrolledSince(version: Long, windowId: String, rect: Rect): Boolean =
        StreamAccessibilityService.changes.scrolledSince(version, windowId, rect)

    override fun lastA11yEventMs(): Long? = StreamAccessibilityService.changes.lastEventAtMs()

    /** Re-reads the node from the app: gone, or showing another label, class or place, means the
     *  view behind it now holds something else (a recycled row) and the ref must not act. An
     *  input's label is its value, which our own setValue changes, so inputs skip that check. */
    override fun isCurrent(node: UiNode): Boolean {
        val snap = if (node is HintlessNode) node.inner else node as? AndroidNode ?: return false
        val live = snap.info
        if (!live.refresh()) return false
        val now = AndroidNode(live, emptyList())
        return now.className == snap.className && now.rect == snap.rect && (live.isEditable || now.name == snap.name)
    }

    /** The package of the window in front ([pickForeground]): the active window's, unless that is
     *  an overlay or the keyboard (a focusable overlay of the host is active while it takes input). */
    override fun foregroundPackage(): String? {
        val ws = svc().windows
        ws.firstOrNull { it.isActive }?.let { w ->
            val pkg = w.root?.packageName?.toString()
            if (canBeForeground(w.type, pkg, ctx.packageName)) return pkg
        }
        return pickForeground(ws.map(::facts), ctx.packageName)?.pkg
    }

    override fun lastUserInputMs(): Long? = StreamAccessibilityService.inputs.lastUserInputMs()

    override fun foregroundComponent(): String = StreamAccessibilityService.components.componentOf(foregroundPackage())

    override fun launch(packageName: String, fresh: Boolean): Boolean {
        val i = ctx.packageManager.getLaunchIntentForPackage(packageName)
            ?: throw AgentError("no-window-match: 手机上没装 $packageName")
        ctx.startActivity(i.addFlags(launchFlags(fresh)))
        return true
    }

    override fun scrollNode(node: UiNode, forward: Boolean): Boolean {
        val info = infoOf(node)
        val ids = info.actionList.map { it.id }.toSet()
        val directional = if (forward) android.R.id.accessibilityActionScrollDown
            else android.R.id.accessibilityActionScrollUp
        val generic = if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        val action = when {
            directional in ids -> directional
            generic in ids -> generic
            // The node does not offer this direction at all (e.g. an outer wrapper already at its
            // end); some such views still answer true to the action without moving.
            else -> return false
        }
        return info.performAction(action)
    }

    /** Click the node, or its nearest clickable ancestor: list rows often put the listener on a parent. */
    override fun click(node: UiNode): Boolean {
        var n: AccessibilityNodeInfo? = infoOf(node)
        while (n != null) {
            if (n.isClickable) return n.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            n = n.parent
        }
        return false
    }

    override fun setText(node: UiNode, text: String): Boolean {
        val info = infoOf(node)
        val args = android.os.Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
        return info.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    override fun focusedInput(): UiNode? {
        val f = svc().findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return null
        // A hint is not a value: `type` appends to the current text, and must not append to "搜索商家".
        val n = AndroidNode(f, emptyList())
        return if (f.isShowingHintText) HintlessNode(n) else n
    }

    override fun imeEnter(node: UiNode): Boolean =
        infoOf(node).performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)

    override fun tap(x: Int, y: Int, longPress: Boolean) =
        gesture(Path().apply { moveTo(x.coerceAtLeast(0).toFloat(), y.coerceAtLeast(0).toFloat()) }, if (longPress) 600 else 60)

    override fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long, holdMs: Long) {
        val ex = x2.coerceAtLeast(0).toFloat()
        val ey = y2.coerceAtLeast(0).toFloat()
        val move = Path().apply {
            moveTo(x1.coerceAtLeast(0).toFloat(), y1.coerceAtLeast(0).toFloat())
            lineTo(ex, ey)
        }
        if (holdMs <= 0) return gesture(listOf(GestureDescription.StrokeDescription(move, 0, durationMs)), durationMs)
        // The finger stops and rests before lifting: the velocity the view reads at ACTION_UP is
        // ~0, so the list moves by the dragged distance and does not fling on.
        gesture(listOf(
            GestureDescription.StrokeDescription(move, 0, durationMs, true),
            GestureDescription.StrokeDescription(Path().apply { moveTo(ex, ey) }, 0, holdMs, false),
        ), durationMs + holdMs)
    }

    private fun gesture(path: Path, durationMs: Long) =
        gesture(listOf(GestureDescription.StrokeDescription(path, 0, durationMs)), durationMs)

    /** Strokes are dispatched one after another, each as its own gesture: a continued stroke
     *  (`willContinue`) must follow its predecessor in a separate `dispatchGesture` call. */
    private fun gesture(strokes: List<GestureDescription.StrokeDescription>, durationMs: Long) {
        // Whatever touch events the system reports while this gesture is in flight are ours, not
        // the user's: they must not read as "the user is using the app".
        StreamAccessibilityService.inputs.gestureDispatched(System.currentTimeMillis(), durationMs)
        // The banner would swallow a tap that lands under it.
        val overlay = currentIndicator()
        overlay?.passThrough(true)
        try {
            var prev: GestureDescription.StrokeDescription? = null
            for (s in strokes) {
                val stroke = prev?.let { p -> continued(p, s) } ?: s
                dispatchOne(stroke)
                prev = stroke
            }
        } finally {
            overlay?.passThrough(false)
        }
    }

    private fun continued(prev: GestureDescription.StrokeDescription, next: GestureDescription.StrokeDescription) =
        try {
            prev.continueStroke(next.path, 0, next.duration, next.willContinue())
        } catch (e: IllegalStateException) {
            throw AgentError("gesture-failed: 手势参数不合法（${e.message}）")
        } catch (e: IllegalArgumentException) {
            throw AgentError("gesture-failed: 手势参数不合法（${e.message}）")
        }

    private fun dispatchOne(stroke: GestureDescription.StrokeDescription) {
        val durationMs = stroke.duration
        val done = CountDownLatch(1)
        val ok = AtomicBoolean(false)
        val g = try {
            GestureDescription.Builder().addStroke(stroke).build()
        } catch (e: IllegalArgumentException) {
            throw AgentError("gesture-failed: 手势参数不合法（${e.message}）")
        }
        val sent = svc().dispatchGesture(g, object : AccessibilityService.GestureResultCallback() {
            override fun onCompleted(d: GestureDescription) { ok.set(true); done.countDown() }
            override fun onCancelled(d: GestureDescription) { done.countDown() }
        }, null)
        if (!sent || !done.await(durationMs + 3_000, TimeUnit.MILLISECONDS) || !ok.get()) {
            throw AgentError("gesture-failed: 系统没执行这次手势（被别的手势打断，或无障碍服务失去了手势权限）")
        }
    }

    /** The live indicator; one built on a gone or replaced service, or by a replaced provider, is disposed. */
    private fun currentIndicator(): AgentIndicator? =
        indicator.sync(StreamAccessibilityService.instance, StreamAgent.indicatorProvider)

    override fun globalBack(): Boolean = svc().performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
    override fun globalHome(): Boolean = svc().performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)

    /** An all-black frame is retried once (the throttle spaces it 1.1 s later): an app's dark splash
     *  screen is black for a moment too, and is not a protected window. Both tries cover
     *  [maskedAreas]; the indicator stays out of the frame (hidden, else blanked). */
    override fun screenshot(maskedAreas: List<Rect>): Shot = captureWithout(currentIndicator(), maskedAreas) { areas ->
        try {
            shoot(areas, lastTry = false)
        } catch (_: AllBlack) {
            shoot(areas, lastTry = true)
        }
    }

    private class AllBlack : Exception()

    /** `takeScreenshot` allows about one call per second; calls are spaced 1.1 s apart rather than failed. */
    private fun shoot(maskedAreas: List<Rect>, lastTry: Boolean): Shot {
        val wait = lastShotAt + 1_100 - System.currentTimeMillis()
        if (wait > 0) Thread.sleep(wait)
        val done = CountDownLatch(1)
        val out = AtomicReference<Any>()
        val abandoned = AtomicBoolean(false)
        svc().takeScreenshot(Display.DEFAULT_DISPLAY, ctx.mainExecutor, object : AccessibilityService.TakeScreenshotCallback {
            override fun onSuccess(s: AccessibilityService.ScreenshotResult) {
                if (abandoned.get()) { s.hardwareBuffer.close(); return }
                out.set(s); done.countDown()
                // The waiter may have given up between the check and the set.
                if (abandoned.get() && out.getAndSet(null) != null) s.hardwareBuffer.close()
            }
            override fun onFailure(code: Int) { out.set(code); done.countDown() }
        })
        lastShotAt = System.currentTimeMillis()
        if (!done.await(5, TimeUnit.SECONDS)) {
            abandoned.set(true)
            (out.getAndSet(null) as? AccessibilityService.ScreenshotResult)?.hardwareBuffer?.close()
            throw AgentError("gesture-failed: 截图超时")
        }
        val r = out.get()
        if (r is Int) {
            if (r == AccessibilityService.ERROR_TAKE_SCREENSHOT_SECURE_WINDOW) throw AgentError("secure-window: 当前画面禁止截图（支付、密码页）")
            throw AgentError("gesture-failed: 截图失败，系统错误码 $r")
        }
        val shot = r as AccessibilityService.ScreenshotResult
        val buffer = shot.hardwareBuffer
        var hw: Bitmap? = null
        var bmp: Bitmap? = null
        try {
            hw = Bitmap.wrapHardwareBuffer(buffer, shot.colorSpace)
                ?: throw AgentError("gesture-failed: 截图缓冲读不出来")
            bmp = hw.copy(Bitmap.Config.ARGB_8888, false)
                ?: throw AgentError("gesture-failed: 截图缓冲读不出来")
            if (isAllBlack(bmp)) {
                if (!lastTry) throw AllBlack()
                throw AgentError("secure-window: 画面是全黑的，当前页面禁止截图（支付、密码页）或屏幕没亮")
            }
            // Masking at the pixel layer, before the frame exists: the covered rects are the
            // credential fields and code text the policy layer found in the tree.
            if (maskedAreas.isNotEmpty()) {
                val canvas = android.graphics.Canvas(bmp)
                val paint = android.graphics.Paint().apply { color = android.graphics.Color.BLACK }
                for (r in maskedAreas) canvas.drawRect(r.x.toFloat(), r.y.toFloat(), (r.x + r.w).toFloat(), (r.y + r.h).toFloat(), paint)
            }
            val bytes = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 80, it) }.toByteArray()
            return Shot(bytes, Rect(0, 0, bmp.width, bmp.height), ctx.resources.displayMetrics.density.toDouble())
        } finally {
            buffer.close()
            hw?.recycle()
            bmp?.recycle()
        }
    }

    /** A secure window comes back as a black frame rather than an error on some ROMs. */
    private fun isAllBlack(bmp: Bitmap): Boolean {
        for (iy in 0 until 16) for (ix in 0 until 16) {
            val p = bmp.getPixel((ix * (bmp.width - 1)) / 15, (iy * (bmp.height - 1)) / 15)
            if (android.graphics.Color.red(p) > 8 || android.graphics.Color.green(p) > 8 || android.graphics.Color.blue(p) > 8) return false
        }
        return true
    }

    override fun screenSize(): Rect = ctx.resources.displayMetrics.let { Rect(0, 0, it.widthPixels, it.heightPixels) }

    override fun touchSlop(): Int = android.view.ViewConfiguration.get(ctx).scaledTouchSlop

    override fun density(): Float = ctx.resources.displayMetrics.density

    override fun status(text: String?) {
        val provider = StreamAgent.indicatorProvider
        val shown = indicator.obtain(StreamAccessibilityService.instance, provider) { s -> provider.create(s, onStop) }
        shown?.show(text)
    }

    override fun sleep(ms: Long) = Thread.sleep(ms.coerceIn(0, 30_000))
}

/** The launch intent's flags. Resume (default): bring the app's task to the front as it was left.
 *  Fresh: clear the task, so the app starts at its launcher activity. */
internal fun launchFlags(fresh: Boolean): Int =
    if (fresh) Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
    else Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED

/** How much of a system window the ANR probe reads: enough for a dialog's message and buttons,
 *  never a whole page. */
private const val ANR_PROBE_NODES = 32
private const val ANR_PROBE_DEPTH = 4
