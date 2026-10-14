package com.streamapp.android.agent

import org.json.JSONObject

data class A11yQuery(
    val role: String? = null,
    val name: String? = null,
    val nameContains: String? = null,
    val className: String? = null,
    val path: List<A11yQuery>? = null,
) {
    companion object {
        fun from(o: JSONObject): A11yQuery {
            fun s(k: String) = if (o.has(k) && !o.isNull(k)) o.getString(k) else null
            val q = A11yQuery(
                role = s("role"),
                name = s("name"),
                nameContains = s("nameContains"),
                className = s("className"),
                path = o.optJSONArray("path")?.let { a -> (0 until a.length()).map { from(a.getJSONObject(it)) } },
            )
            require(q.name == null || q.nameContains == null) { "a11y query: name 与 nameContains 只能给一个（前者全等、后者包含）" }
            return q
        }
    }
}

private fun selfMatches(n: UiNode, q: A11yQuery): Boolean {
    if (q.role != null && n.role != q.role) return false
    if (q.name != null && n.name != q.name) return false
    if (q.nameContains != null && (n.name.isEmpty() || !n.name.contains(q.nameContains, ignoreCase = true))) return false
    if (q.className != null && n.className != q.className) return false
    return true
}

private fun pathMatches(ancestors: List<UiNode>, path: List<A11yQuery>?): Boolean {
    if (path.isNullOrEmpty()) return true
    var i = 0
    for (a in ancestors) {
        if (selfMatches(a, path[i])) {
            i++
            if (i == path.size) return true
        }
    }
    return false
}

/** Every descendant of [root] (root excluded) matching [q], in document order. */
fun findAll(root: UiNode, q: A11yQuery): List<UiNode> {
    val out = mutableListOf<UiNode>()
    fun walk(n: UiNode, ancestors: List<UiNode>) {
        for (c in n.children) {
            if (selfMatches(c, q) && pathMatches(ancestors, q.path)) out.add(c)
            walk(c, ancestors + c)
        }
    }
    walk(root, listOf(root))
    return out
}

/** Read items into rows. See the plan's Task 3 rules; `dedupeBy` is the backend's job. */
fun readSubtree(root: UiNode, spec: JSONObject): List<Map<String, String>> {
    val items = findAll(root, A11yQuery.from(spec.getJSONObject("itemQuery")))
    val fields = spec.getJSONObject("fields")
    // A misspelt `read` would otherwise silently read the name.
    for (field in fields.keys()) {
        val read = fields.getJSONObject(field).optString("read")
        require(read == "name" || read == "value") { "readSubtree: 字段 $field 的 read 必须是 name 或 value，收到「$read」" }
    }
    return items.map { item ->
        fields.keys().asSequence().associateWith { field ->
            val f = fields.getJSONObject(field)
            val node = f.optJSONObject("from")?.let { findAll(item, A11yQuery.from(it)).firstOrNull() } ?: if (f.has("from")) null else item
            when {
                node == null -> ""
                f.getString("read") == "value" -> node.text
                else -> node.name
            }
        }
    }
}
