package com.streamapp.android.agent

internal data class Rect(val x: Int, val y: Int, val w: Int, val h: Int) {
    fun toMap(): Map<String, Int> = mapOf("x" to x, "y" to y, "w" to w, "h" to h)
    val centerX get() = x + w / 2
    val centerY get() = y + h / 2
    fun intersects(o: Rect) = x < o.x + o.w && o.x < x + w && y < o.y + o.h && o.y < y + h
}

/** One node of an accessibility tree, as the query engine sees it. The Android adapter builds
 *  these from `AccessibilityNodeInfo`; tests build them by hand. */
internal interface UiNode {
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
    /** Whether the node is on screen for the user (`isVisibleToUser`). */
    val isVisible: Boolean get() = true
    /** The axis a scrollable node scrolls along, as far as its actions or class tell: [AXIS_VERTICAL],
     *  [AXIS_HORIZONTAL], or null when unknown (only forward / backward offered). */
    val scrollAxis: String? get() = null
    /** Whether a scrollable node declares an action towards content further down (`SCROLL_DOWN`,
     *  `PAGE_DOWN` or `SCROLL_FORWARD`) / back up (`SCROLL_UP`, `PAGE_UP` or `SCROLL_BACKWARD`). A
     *  list at its end drops that direction's action and keeps the other one. */
    val scrollsForward: Boolean get() = isScrollable
    val scrollsBackward: Boolean get() = isScrollable
    /** The node's resource id, e.g. `com.app:id/password`; "" when the app gave none. */
    val viewId: String get() = ""
    /** A checkable control's state (switch, checkbox, radio button, toggle); null when not checkable. */
    val checked: Boolean? get() = null
    /** A ranged control's value (slider, seek bar, progress bar, rating bar) from `rangeInfo`; null when it has none. */
    val range: RangeValue? get() = null
    /** The control's `stateDescription` (e.g. a slider's "Default", a switch's "On"); "" when none. */
    val stateDescription: String get() = ""
}

/** `AccessibilityNodeInfo.RangeInfo`: [type] is [RANGE_INT], [RANGE_FLOAT], [RANGE_PERCENT] or
 *  [RANGE_INDETERMINATE] (a progress bar without a known value). */
internal data class RangeValue(val type: String, val current: Float, val min: Float, val max: Float)

internal const val RANGE_INT = "int"
internal const val RANGE_FLOAT = "float"
internal const val RANGE_PERCENT = "percent"
internal const val RANGE_INDETERMINATE = "indeterminate"

/** Whether [n] carries a value of its own: checked state, a range or a state description. */
internal fun hasValue(n: UiNode): Boolean = n.checked != null || n.range != null || n.stateDescription.isNotEmpty()

internal const val AXIS_VERTICAL = "vertical"
internal const val AXIS_HORIZONTAL = "horizontal"
