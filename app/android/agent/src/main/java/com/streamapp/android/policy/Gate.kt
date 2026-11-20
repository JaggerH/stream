package com.streamapp.android.policy

import com.streamapp.android.agent.Rect
import com.streamapp.android.agent.UiNode

/** One ask exemption the caller granted: app (package or display name) × action kind. */
internal data class AskExemption(val app: String, val action: String)

/**
 * What the text tier read for a click the accessibility tree could not name: the labels drawn
 * inside the tapped rect ([labels], one entry per recognized line) and every line recognized on
 * the frame ([screen]) — the only "screen" a self-drawn page has. The labels are judged one by
 * one: joining them would let a commit hide inside a harmless neighbour's text.
 */
internal class TextTier(val labels: List<String>, val screen: String)

/**
 * The sensitive-action gate: for one gated op, which reasons require an approval request.
 * Structure outweighs the word tables; an unrecognized commit-shaped label still gates through
 * `commit-unrecognized` (better one extra approval than one slipped commit). Reasons are an open
 * set — the caller treats any reason it does not know as requiring approval.
 *
 * Action kinds group the reasons for exemptions and category ask lists: `commit`, `send`,
 * `install`, `setting`, `call`, `link`.
 */
internal class Gate(private val detect: Detect, private val categories: Categories) {

    fun kindOf(reason: String): String? = when (reason) {
        "commit-label", "commit-unrecognized", "dialog-confirm", "payment-label" -> "commit"
        "message-send" -> "send"
        "install" -> "install"
        "setting" -> "setting"
        "call" -> "call"
        "link-leave-app" -> "link"
        else -> null
    }

    /**
     * [target] is the node the action lands on (null for `scroll`), [typedText] the text a
     * `type` would enter, [pkg]/[title] the foreground or scoped app, [root] the current tree.
     * [blind] says the click's point had neither an accessibility label nor OCR text; [text] is
     * what the text tier read under the tapped rect instead, when the tree could not name it.
     */
    fun reasons(
        op: String,
        target: UiNode?,
        typedText: String?,
        pkg: String,
        title: String,
        root: UiNode?,
        blind: Boolean = false,
        text: TextTier? = null,
    ): List<String> {
        val cat = categories.of(pkg, title)?.name
        val out = mutableListOf<String>()
        val blindCommit = blind && cat != null && cat in BLIND_CLICK_CATEGORIES
        when (op) {
            "click", "invoke", "longPress" -> {
                val t = target
                if (t == null) {
                    // No node under the point. In a shopping / payment / finance app that is
                    // exactly where a self-drawn commit button lives: ask rather than guess.
                    if (blindCommit) out += "commit-unrecognized"
                    if (out.isNotEmpty() && cat != null && categories.askOf(cat).contains("commit")) out += "app-category-ask"
                    return out
                }
                if (isInput(t) || isTab(t) || isList(t)) return emptyList()
                if (text == null) {
                    out += labelReasons(t.name, t, cat, root, null)
                } else {
                    // The tree cannot name this point: every line drawn inside the tapped rect is
                    // a label of its own, judged like an accessibility label, with the frame's
                    // text standing in for the screen.
                    out += text.labels.flatMap { labelReasons(it, t, cat, root, text.screen) }.distinct()
                    if (out.isEmpty()) out += textTierDefaults(text, root, cat)
                }
                // The node under the point had no label and no OCR text named it either: the
                // structural fallback above could not see a drawn commit either way.
                if (blindCommit && out.none { kindOf(it) == "commit" }) out += "commit-unrecognized"
            }
            "type", "press" -> {
                // A newline (typed into the field, or the IME's Enter on it) submits in many
                // apps. The dispatcher routes only `press` Enter here — Back and Home are not
                // commits. A search field submits a query, not a commit; messaging and social
                // apps send; everywhere else the commit default applies.
                val t = target ?: return emptyList()
                val submit = op == "press" || typedText?.contains('\n') == true || typedText?.contains('\r') == true
                if (!submit || detect.isSearchField(t.name, t.viewId)) return emptyList()
                if (cat == "messaging" || cat == "social") out += "message-send"
                else out += "commit-unrecognized"
            }
            "setValue" -> {
                // Writing a slider's value is changing a setting, like clicking its track.
                val t = target ?: return emptyList()
                if (cat == "settings" && isSlider(t)) out += "setting"
            }
            "scroll", "swipe" -> {
                // Sliders such as 「滑动支付」/ "Slide to pay"; a list that scrolls is no slider.
                // A free swipe names its own start point, so a slider under that point counts too
                // (a settings slider is usually not scrollable).
                val targetNode = target
                val slider = root?.let { findSlider(it) } ?: if (targetNode != null && isSlider(targetNode)) targetNode else null
                if (slider != null) {
                    val (commit, money) = detect.commitParts(slider.name)
                    if (commit) {
                        out += "commit-label"
                        if (money || detect.hasCurrency(slider.name) || (root != null && detect.screenHasCurrency(root))) out += "payment-label"
                    }
                }
                // A scroll or swipe that lands on a slider changes its value in the Settings app.
                if (cat == "settings" && (root != null && hasScrollableSlider(root) || targetNode != null && isSlider(targetNode))) {
                    out += "setting"
                }
                // A free swipe whose start point neither tree names is judged like a blind click:
                // in an app where money or goods change hands that is where a drawn slide-to-pay
                // lives (the dispatcher has already let strokes that page a container through).
                if (op == "swipe" && blindCommit) out += "commit-unrecognized"
            }
            else -> {}
        }
        // The category table may mark kinds ask for apps in a category, above what the word
        // tables caught.
        if (out.isNotEmpty() && cat != null) {
            val ask = categories.askOf(cat)
            if (out.mapNotNull { kindOf(it) }.any { ask.contains(it) }) out += "app-category-ask"
        }
        return out
    }

    /** Whether the caller has exempted every kind this action's reasons belong to, for this app. */
    fun exempted(pkg: String, reasons: List<String>, exemptions: Set<AskExemption>): Boolean =
        reasons.mapNotNull { kindOf(it) }.isNotEmpty() &&
            reasons.mapNotNull { kindOf(it) }.all { kind -> exemptions.any { it.app == pkg && it.action == kind } }

    /** One label's share of a click's reasons: the word tables plus the structure signals of the
     *  node the action lands on. [screen] is the text tier's stand-in for the screen when the
     *  tree could not see it; null for an accessibility label, whose screen is [root]. */
    private fun labelReasons(label: String, t: UiNode, cat: String?, root: UiNode?, screen: String?): List<String> {
        val out = mutableListOf<String>()
        val claim = detect.isClaimLabel(label)
        val (commit, money) = detect.commitParts(label)
        if (commit) out += "commit-label"
        if (detect.isAffirmative(label) && screenAsksCommit(root, t)) out += "dialog-confirm"
        if (cat == "stores" && !claim && (detect.isInstallLabel(label) || detect.isAffirmative(label))) out += "install"
        if (isCallTarget(t, label)) out += "call"
        if (t.isClickable && detect.looksLikeURL(label) && cat != "browsers") out += "link-leave-app"
        if (cat == "settings" && (isSwitch(t) || detect.isSettingLabel(label) ||
                detect.isStepperLabel(label) || isStepperIcon(t, root) || isSlider(t))) out += "setting"
        // A claim is free by itself, but not when it stands in a payment confirmation:
        // the screen asks a commit question, so the same button is the pay step there.
        if (claim && screenAsksCommit(root, t)) out += "commit-label"
        // A payment: a commit that moves money by itself, or any commit or store install
        // on a screen that shows an amount.
        val moneyShown = detect.hasCurrency(label) || (root != null && detect.screenHasCurrency(root)) ||
            (screen != null && detect.hasCurrency(screen))
        if ((commit || out.contains("install")) && (money || moneyShown)) out += "payment-label"
        if (claim && out.contains("commit-label") && moneyShown) out += "payment-label"
        if (out.isEmpty() && unrecognizedCommit(t, root, label)) out += "commit-unrecognized"
        return out
    }

    /**
     * A text-tier label the tables leave free, in an app where a misread tap costs money or
     * goods. An affirmative (「确定」) on a self-drawn screen confirms whatever that screen asks,
     * so it keeps the blind click's conservative default — except on a screen that visibly
     * offers a cart and names no commit: there the 确定 only closes a spec sheet, the same free
     * step as the 加入购物车 beside it. An amount anywhere on the screen (or under the rect)
     * turns the affirmative into a payment confirmation. Elsewhere the click runs as before: the
     * blind rule does not reach apps outside [BLIND_CLICK_CATEGORIES] either.
     */
    private fun textTierDefaults(text: TextTier, root: UiNode?, cat: String?): List<String> {
        if (cat == null || cat !in BLIND_CLICK_CATEGORIES) return emptyList()
        if (text.labels.none { detect.isAffirmative(it) }) return emptyList()
        val money = detect.hasCurrency(text.screen) || (root != null && detect.screenHasCurrency(root))
        if (money) return listOf("payment-label")
        if (cartOnly(text.screen)) return emptyList()
        return listOf("commit-unrecognized")
    }

    /** A screen that offers a cart and names no commit: a spec sheet, where a confirmation button
     *  is the sheet's own. A commit word or an amount makes the same button a purchase step. */
    private fun cartOnly(screen: String) =
        detect.mentionsCart(screen) && !detect.mentionsCommit(screen) && !detect.hasCurrency(screen)

    // ---- structure ------------------------------------------------------------------

    private fun isInput(n: UiNode) = n.isEditable || n.role.endsWith("EditText")
    private fun isTab(n: UiNode) = n.role == "Tab" || n.className.substringAfterLast('.').startsWith("Tab")
    private fun isList(n: UiNode) = n.isScrollable || n.role.contains("List") || n.role.contains("Recycler")
    private fun isSwitch(n: UiNode) = n.className.substringAfterLast('.').let { it.contains("Switch") || it.contains("CheckBox") || it.contains("ToggleButton") || it.contains("RadioButton") }
    private fun isSlider(n: UiNode) = !n.isScrollable && sliderShape(n)
    private fun sliderShape(n: UiNode) = n.role.contains("Seek", true) || n.role.contains("Slider", true) ||
        n.className.substringAfterLast('.').let { it.contains("Seek") || it.contains("Slider") }

    /** A ＋ / － icon button beside a slider: the stepper's other form. */
    private fun isStepperIcon(t: UiNode, root: UiNode?): Boolean {
        if (root == null || !t.isClickable || t.name.trim() !in STEPPER_ICONS) return false
        var hit = false
        fun walk(n: UiNode) {
            if (hit) return
            if (isSlider(n) && beside(t.rect, n.rect)) { hit = true; return }
            n.children.forEach(::walk)
        }
        walk(root)
        return hit
    }

    /** Same row (the vertical ranges overlap by at least half the smaller height), close
     *  horizontally: how a stepper's ＋ / － sits at the ends of a slider. */
    private fun beside(a: Rect, b: Rect): Boolean {
        val overlap = minOf(a.y + a.h, b.y + b.h) - maxOf(a.y, b.y)
        if (overlap < minOf(a.h, b.h) / 2) return false
        val gap = maxOf(0, maxOf(a.x, b.x) - minOf(a.x + a.w, b.x + b.w))
        return gap <= ICON_GAP_PX
    }

    /** A slider that a `scroll` action could land on (declares its own scroll actions). */
    private fun hasScrollableSlider(root: UiNode): Boolean {
        var hit = false
        fun walk(n: UiNode) {
            if (hit) return
            if (n.isScrollable && sliderShape(n)) { hit = true; return }
            n.children.forEach(::walk)
        }
        walk(root)
        return hit
    }

    /** Whether the screen asks a commit question ("Delete this message?") somewhere other than the target. */
    private fun screenAsksCommit(root: UiNode?, target: UiNode?): Boolean {
        if (root == null) return false
        var found = false
        fun walk(n: UiNode) {
            if (found || n === target) return
            if (detect.isQuestion(n.name) && detect.mentionsCommit(n.name)) { found = true; return }
            n.children.forEach(::walk)
        }
        walk(root)
        return found
    }

    private fun hasEditableNonSearchInput(root: UiNode): Boolean {
        var found = false
        fun walk(n: UiNode) {
            if (found) return
            if (isInput(n) && !detect.isSearchField(n.name, n.viewId)) { found = true; return }
            n.children.forEach(::walk)
        }
        walk(root)
        return found
    }

    private fun findSlider(root: UiNode): UiNode? {
        var hit: UiNode? = null
        fun walk(n: UiNode) {
            if (hit != null) return
            if (isSlider(n) && detect.isCommitLabel(n.name)) { hit = n; return }
            n.children.forEach(::walk)
        }
        walk(root)
        return hit
    }

    /** A call target by resource id, mirroring the common ids of dialer buttons. */
    private fun isCallTarget(t: UiNode, label: String = t.name): Boolean {
        val id = t.viewId.lowercase()
        if (CALL_ID_PARTS.any { id.contains(it) }) return true
        return detect.isCallLabel(label)
    }

    /** The conservative fallback: a clickable button the tables cannot place, standing where
     *  commits stand — in a form or a confirmation dialog. Icon buttons count by structure. */
    private fun unrecognizedCommit(t: UiNode, root: UiNode?, label: String = t.name): Boolean {
        if (!t.isClickable && t.role != "Button") return false
        if (label.isNotEmpty()) {
            if (detect.isCommitLabel(label) || detect.isClaimLabel(label) || detect.isInstallLabel(label) || detect.isCallLabel(label) ||
                detect.isSettingLabel(label) || detect.isAffirmative(label) || detect.looksLikeURL(label) ||
                detect.isDismissal(label) || detect.isPlaceLabel(label) || detect.isSearchLabel(label)
            ) return false
        }
        if (root == null) return false
        return hasEditableNonSearchInput(root) || screenAsksCommit(root, t)
    }

    companion object {
        /** Apps where money or goods change hands: a click the trees cannot name is treated as a
         *  possible commit (one extra approval is cheaper than one slipped order). */
        private val BLIND_CLICK_CATEGORIES = setOf("shopping", "payments", "finance")

        private val CALL_ID_PARTS = listOf(
            "call_button", "callbutton", "call_action", "dial_button", "dialbutton",
            "dialpad_floating_action_button", "voice_call", "video_call", "start_call", "make_call",
        )

        /** Labels of a stepper's ＋ / － icon buttons. */
        private val STEPPER_ICONS = setOf("+", "-", "＋", "－", "−")
        /** How close horizontally a ＋ / － must be to the slider to count as its stepper (px). */
        private const val ICON_GAP_PX = 160
    }
}
