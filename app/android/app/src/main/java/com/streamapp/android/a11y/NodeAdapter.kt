package com.streamapp.android.a11y

import android.view.accessibility.AccessibilityNodeInfo
import com.streamapp.android.agent.Rect
import com.streamapp.android.agent.UiNode

/**
 * A snapshot of one `AccessibilityNodeInfo` subtree. Children are read once, when the snapshot
 * is built, so a query walks plain objects instead of making a binder call per child per query.
 * `info` stays attached for actions.
 */
class AndroidNode(val info: AccessibilityNodeInfo, override val children: List<UiNode>) : UiNode {
    override val className: String = info.className?.toString() ?: ""
    override val role: String = className.substringAfterLast('.')
    override val text: String = info.text?.toString() ?: ""
    override val name: String = text.ifEmpty { info.contentDescription?.toString() ?: "" }
    override val rect: Rect = android.graphics.Rect().let { r ->
        info.getBoundsInScreen(r)
        Rect(r.left, r.top, r.width(), r.height())
    }

    companion object {
        /** Depth cap guards against pathological trees (some apps nest hundreds deep). */
        fun snapshot(info: AccessibilityNodeInfo, depth: Int = 0): AndroidNode {
            val kids = if (depth >= 60) emptyList() else
                (0 until info.childCount).mapNotNull { info.getChild(it) }.map { snapshot(it, depth + 1) }
            return AndroidNode(info, kids)
        }
    }
}

/** An input showing only its hint: reads as empty text, acts on the wrapped node. */
class HintlessNode(val inner: AndroidNode) : UiNode by inner {
    override val text: String = ""
}
