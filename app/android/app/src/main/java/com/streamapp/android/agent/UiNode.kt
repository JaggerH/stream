package com.streamapp.android.agent

data class Rect(val x: Int, val y: Int, val w: Int, val h: Int) {
    fun toMap(): Map<String, Int> = mapOf("x" to x, "y" to y, "w" to w, "h" to h)
    val centerX get() = x + w / 2
    val centerY get() = y + h / 2
}

/** One node of an accessibility tree, as the query engine sees it. The Android adapter builds
 *  these from `AccessibilityNodeInfo`; tests build them by hand. */
interface UiNode {
    /** Class simple name, e.g. `Button`. */
    val role: String
    /** Text if non-empty, else contentDescription, else "". */
    val name: String
    /** Full class name, e.g. `android.widget.Button`. */
    val className: String
    /** The node's text alone (an input's current value). */
    val text: String
    val rect: Rect
    val children: List<UiNode>
}
