package com.streamapp.android.agent

class StaleRefException(msg: String) : Exception(msg)

/**
 * Refs handed to the backend for one tree snapshot. A new snapshot invalidates every older ref,
 * so a ref used after the screen changed fails loudly instead of acting on whatever node the
 * system recycled into that slot.
 */
class RefTable<N> {
    var generation = 0
        private set
    private var nodes: List<N> = emptyList()

    fun snapshot(list: List<N>): List<String> {
        generation++
        nodes = list
        return list.indices.map { "g$generation-$it" }
    }

    fun resolve(ref: String): N {
        val m = Regex("^g(\\d+)-(\\d+)$").matchEntire(ref)
            ?: throw StaleRefException("stale-ref: $ref is not a ref this agent issued")
        val (gen, idx) = m.destructured
        if (gen.toIntOrNull() != generation) throw StaleRefException("stale-ref: $ref belongs to an older tree (now g$generation); find it again")
        return idx.toIntOrNull()?.let { nodes.getOrNull(it) } ?: throw StaleRefException("stale-ref: $ref is out of range")
    }
}
