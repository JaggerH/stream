package com.streamapp.android.a11y

import android.view.accessibility.AccessibilityNodeInfo
import com.streamapp.android.agent.RANGE_FLOAT
import com.streamapp.android.agent.RANGE_INDETERMINATE
import com.streamapp.android.agent.RANGE_INT
import com.streamapp.android.agent.RANGE_PERCENT
import com.streamapp.android.agent.RangeValue
import com.streamapp.android.agent.Rect
import com.streamapp.android.agent.UiNode

/**
 * A snapshot of one `AccessibilityNodeInfo` subtree. Children are read once, when the snapshot
 * is built, so a query walks plain objects instead of making a binder call per child per query.
 * `info` stays attached for actions.
 */
internal class AndroidNode(val info: AccessibilityNodeInfo, override val children: List<UiNode>) : UiNode {
    override val className: String = info.className?.toString() ?: ""
    override val role: String = className.substringAfterLast('.')
    override val text: String = info.text?.toString() ?: ""
    override val name: String = text.ifEmpty { info.contentDescription?.toString() ?: "" }
    override val rect: Rect = android.graphics.Rect().let { r ->
        info.getBoundsInScreen(r)
        Rect(r.left, r.top, r.width(), r.height())
    }
    override val isPassword: Boolean = info.isPassword
    override val isEditable: Boolean = info.isEditable
    override val isClickable: Boolean = info.isClickable
    override val isScrollable: Boolean = info.isScrollable
    override val isVisible: Boolean = info.isVisibleToUser
    private val actionIds: Set<Int> = if (isScrollable) info.actionList.map { it.id }.toSet() else emptySet()
    override val scrollAxis: String? = if (!isScrollable) null else scrollAxisOf(
        actionIds,
        className,
        info.collectionInfo?.let { it.rowCount to it.columnCount },
    )
    override val scrollsForward: Boolean = actionIds.any { it in FORWARD_ACTIONS }
    override val scrollsBackward: Boolean = actionIds.any { it in BACKWARD_ACTIONS }
    override val viewId: String = info.viewIdResourceName ?: ""
    override val hintText: String = info.hintText?.toString() ?: ""
    override val isShowingHint: Boolean = info.isShowingHintText || (hintText.isNotEmpty() && text == hintText)
    override val checked: Boolean? = if (info.isCheckable) info.isChecked else null
    override val range: RangeValue? = info.rangeInfo?.let { RangeValue(rangeTypeName(it.type), it.current, it.min, it.max) }
    override val stateDescription: String = info.stateDescription?.toString() ?: ""

    companion object {
        /** Depth cap guards against pathological trees (some apps nest hundreds deep). */
        fun snapshot(info: AccessibilityNodeInfo, depth: Int = 0): AndroidNode {
            val kids = if (depth >= 60) emptyList() else
                (0 until info.childCount).mapNotNull { info.getChild(it) }.map { snapshot(it, depth + 1) }
            return AndroidNode(info, kids)
        }
    }
}

/** `RangeInfo.RANGE_TYPE_*` as the protocol names it. 3 is `RANGE_TYPE_INDETERMINATE` (API 36). */
internal fun rangeTypeName(type: Int): String = when (type) {
    AccessibilityNodeInfo.RangeInfo.RANGE_TYPE_INT -> RANGE_INT
    AccessibilityNodeInfo.RangeInfo.RANGE_TYPE_PERCENT -> RANGE_PERCENT
    3 -> RANGE_INDETERMINATE
    else -> RANGE_FLOAT
}

/** An input showing only its hint: reads as empty text, acts on the wrapped node. */
internal class HintlessNode(val inner: AndroidNode) : UiNode by inner {
    override val text: String = ""
}

private val FORWARD_ACTIONS = setOf(
    android.R.id.accessibilityActionScrollDown,
    android.R.id.accessibilityActionPageDown,
    AccessibilityNodeInfo.ACTION_SCROLL_FORWARD,
)
private val BACKWARD_ACTIONS = setOf(
    android.R.id.accessibilityActionScrollUp,
    android.R.id.accessibilityActionPageUp,
    AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD,
)
private val VERTICAL_ACTIONS = setOf(
    android.R.id.accessibilityActionScrollUp,
    android.R.id.accessibilityActionScrollDown,
    android.R.id.accessibilityActionPageUp,
    android.R.id.accessibilityActionPageDown,
)
private val HORIZONTAL_ACTIONS = setOf(
    android.R.id.accessibilityActionScrollLeft,
    android.R.id.accessibilityActionScrollRight,
    android.R.id.accessibilityActionPageLeft,
    android.R.id.accessibilityActionPageRight,
)

/** The axis of a scrollable node: directional actions first, then the class (pagers and horizontal
 *  scroll views), then a one-row collection. Null when nothing tells. */
internal fun scrollAxisOf(actions: Set<Int>, className: String, collection: Pair<Int, Int>?): String? {
    if (actions.any { it in VERTICAL_ACTIONS }) return com.streamapp.android.agent.AXIS_VERTICAL
    if (actions.any { it in HORIZONTAL_ACTIONS }) return com.streamapp.android.agent.AXIS_HORIZONTAL
    val simple = className.substringAfterLast('.')
    if (simple.contains("ViewPager") || simple == "HorizontalScrollView") return com.streamapp.android.agent.AXIS_HORIZONTAL
    if (collection != null && collection.first == 1 && collection.second > 1) return com.streamapp.android.agent.AXIS_HORIZONTAL
    return null
}
