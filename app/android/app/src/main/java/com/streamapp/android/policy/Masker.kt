package com.streamapp.android.policy

import com.streamapp.android.agent.Rect
import com.streamapp.android.agent.UiNode

/**
 * Read-layer masking: the values of password and one-time-code fields never enter an outbound
 * frame. Masking happens here, before anything is serialized — once a value is in a frame it is
 * too late. Deterministic, so the screen digest computed over masked trees is stable, and the
 * digest itself leaks nothing.
 */
class Masker(private val detect: Detect) {

    companion object {
        /** The fixed mask that replaces a credential field's value wherever the tree is read. */
        const val MASK = "••••••"
        /** Digit runs of at least this length inside code-context text are one-time codes. */
        const val MIN_CODE_DIGITS = 4
        private val CODE_DIGITS = Regex("\\d{$MIN_CODE_DIGITS,}")
    }

    fun isInput(n: UiNode) = n.isEditable || n.role.endsWith("EditText") || n.className.endsWith("EditText")

    /** Whether typing into this node would hand a password or a one-time code to the agent. */
    fun isCredentialField(n: UiNode) = isInput(n) && detect.isCredentialField(n.isPassword, n.name, n.viewId)

    /** Digit runs inside one-time-code text become dots; everything else passes through. */
    fun maskCodeDigits(text: String) = if (detect.isCodeContext(text)) CODE_DIGITS.replace(text) { "•".repeat(it.value.length) } else text

    /** The masked read of a node's name: credential inputs get the fixed mask, other names get
     *  their code-context digit runs masked. */
    fun maskedName(n: UiNode) = if (isCredentialField(n)) MASK else maskCodeDigits(n.name)

    /** The masked read of a node's text (an input's value), same rules as [maskedName]. */
    fun maskedValue(n: UiNode) = if (isCredentialField(n)) MASK else maskCodeDigits(n.text)

    /** A masked copy of the tree for digests; the original nodes stay attached to their live
     *  counterparts and keep being handed out as refs. */
    fun maskTree(root: UiNode): UiNode =
        MaskedNode(root, maskedName(root), maskedValue(root), root.children.map { maskTree(it) })

    private class MaskedNode(
        n: UiNode,
        override val name: String,
        override val text: String,
        override val children: List<UiNode>,
    ) : UiNode {
        override val role = n.role
        override val className = n.className
        override val rect = n.rect
        override val isPassword = n.isPassword
        override val isEditable = n.isEditable
        override val isClickable = n.isClickable
        override val isScrollable = n.isScrollable
        override val viewId = n.viewId
    }

    /**
     * The screen areas a screenshot must cover before leaving the device: the display rects of
     * credential fields and of code-context text with digit runs. Returns them plus whether every
     * found credential area could actually be located — when not, the screenshot is not sent at
     * all and the op fails as `secure-window` (the FLAG_SECURE stance: content you cannot vouch
     * for does not leave the device).
     */
    fun areasToCover(root: UiNode?): Pair<List<Rect>, Boolean> {
        if (root == null) return emptyList<Rect>() to true
        val areas = mutableListOf<Rect>()
        var locatable = true
        fun walk(n: UiNode) {
            if (isCredentialField(n)) {
                if (n.rect.w <= 0 || n.rect.h <= 0) locatable = false else areas += n.rect
            } else if (n.text.isNotEmpty() && detect.isCodeContext(n.text) && CODE_DIGITS.containsMatchIn(n.text)) {
                if (n.rect.w <= 0 || n.rect.h <= 0) locatable = false else areas += n.rect
            }
            n.children.forEach(::walk)
        }
        walk(root)
        return areas to locatable
    }
}
