package com.streamapp.android.agent

data class Rect(val x: Int, val y: Int, val w: Int, val h: Int) {
    fun toMap(): Map<String, Int> = mapOf("x" to x, "y" to y, "w" to w, "h" to h)
    val centerX get() = x + w / 2
    val centerY get() = y + h / 2
    fun intersects(o: Rect) = x < o.x + o.w && o.x < x + w && y < o.y + o.h && o.y < y + h
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
    /** Structure signals the sensitive-action gate reads; the adapter fills them from the node,
     *  hand-built test nodes default to false. */
    val isPassword: Boolean get() = false
    val isEditable: Boolean get() = false
    val isClickable: Boolean get() = false
    val isScrollable: Boolean get() = false
    /** The node's resource id, e.g. `com.app:id/password`; "" when the app gave none. */
    val viewId: String get() = ""
}
