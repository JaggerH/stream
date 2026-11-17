package com.streamapp.android.agent

import java.util.IdentityHashMap

/**
 * Control values in `find` output. A slider, seek bar or progress bar reports its value through
 * `rangeInfo`, a switch or checkbox through its checked state, and many controls add a
 * `stateDescription`; none of these shows up as text, so without them a caller could only read
 * such a control from a screenshot.
 */

/** How far up from a found label `find` looks for the row it sits in (see [rowValues]). */
internal const val ROW_CLIMB = 3
/** At most this many value-bearing controls are reported for one row; more means a group, not a row. */
internal const val MAX_ROW_VALUES = 3

/** The value fields of [n] as an element carries them: `checked`, `range` (`{type, now, min, max}`)
 *  and `state`, each only when the node has it. Empty for a node without a value. */
internal fun valueFields(n: UiNode): Map<String, Any> {
    val m = LinkedHashMap<String, Any>()
    n.checked?.let { m["checked"] = it }
    n.range?.let { r ->
        val range = LinkedHashMap<String, Any>()
        range["type"] = r.type
        jsonNumber(r.current)?.let { range["now"] = it }
        jsonNumber(r.min)?.let { range["min"] = it }
        jsonNumber(r.max)?.let { range["max"] = it }
        m["range"] = range
    }
    if (n.stateDescription.isNotEmpty()) m["state"] = n.stateDescription
    return m
}

/** A float as a compact JSON number: whole values as integers, others to three decimals. Null for
 *  NaN and infinities, which JSON cannot carry. */
internal fun jsonNumber(f: Float): Number? {
    if (f.isNaN() || f.isInfinite()) return null
    // Through the float's shortest decimal form: 0.1f stays 0.1, not 0.10000000149011612.
    val d = f.toString().toDouble()
    if (d == Math.rint(d) && kotlin.math.abs(d) < 1e15) return d.toLong()
    return Math.round(d * 1000) / 1000.0
}

/** Each node under [root] mapped to its parent (by identity). */
internal fun parentsOf(root: UiNode): Map<UiNode, UiNode> {
    val out = IdentityHashMap<UiNode, UiNode>()
    fun walk(n: UiNode) {
        for (c in n.children) {
            out[c] = n
            walk(c)
        }
    }
    walk(root)
    return out
}

/**
 * The value-bearing controls in the row [label] belongs to, nearest first. A settings row puts its
 * title in one view and its slider or switch in another; a caller that found the title by name
 * wants the value next to it. Looks at [label]'s own subtree, then up to [ROW_CLIMB] ancestors,
 * stopping at the first that holds any value-bearing node. It never climbs to [root] or to
 * a scrollable container (that is the list, not the row), and an ancestor holding more than
 * [MAX_ROW_VALUES] such nodes is a group of rows, which yields nothing.
 */
internal fun rowValues(label: UiNode, root: UiNode, parents: Map<UiNode, UiNode>): List<UiNode> {
    var item = label
    for (level in 0..ROW_CLIMB) {
        val found = mutableListOf<Pair<UiNode, List<UiNode>>>()
        // Visibility is not asked: some sliders (Material's on Android 16 Settings) report
        // `isVisibleToUser` false while on screen. A node with no area is not shown, though.
        fun walk(n: UiNode, ancestors: List<UiNode>) {
            if (n !== label && hasValue(n) && n.rect.w > 0 && n.rect.h > 0) found += n to ancestors
            n.children.forEach { walk(it, ancestors + n) }
        }
        walk(item, emptyList())
        // A control and the virtual node inside it often say the same thing (the slider's state,
        // then its thumb's range and the same state): keep the inner one when it says it all.
        val kept = found.filter { (n, _) ->
            val own = valueFields(n).entries
            found.none { (m, up) -> m !== n && up.any { it === n } && valueFields(m).entries.containsAll(own) }
        }.map { it.first }
        if (kept.size > MAX_ROW_VALUES) return emptyList()
        if (kept.isNotEmpty()) return kept.sortedBy { distance(it.rect, label.rect) }
        val p = parents[item] ?: return emptyList()
        if (p === root || p.isScrollable) return emptyList()
        item = p
    }
    return emptyList()
}

/** Distance between two rects' centres, squared (only compared). */
private fun distance(a: Rect, b: Rect): Long {
    val dx = (a.centerX - b.centerX).toLong()
    val dy = (a.centerY - b.centerY).toLong()
    return dx * dx + dy * dy
}
