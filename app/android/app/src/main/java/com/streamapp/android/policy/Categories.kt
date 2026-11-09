package com.streamapp.android.policy

import org.json.JSONObject
import java.io.InputStream
import java.util.Locale

/**
 * App categories, shipped as a data file with the app (`assets/policy/apps.json`) and loaded once
 * per process; no runtime hot reload. `finance`, `passwords` and `blocked` are deny categories:
 * an app in one of them is entirely invisible to the caller (no screen, no actions). `blocked`
 * is the user's manual block list and ships empty; its only way out is removal from that list,
 * never an exemption. Entries are taken from the Pinky project (Apache-2.0), credited in NOTICE
 * and THIRD-PARTY-NOTICE.
 */
class Categories(o: JSONObject) {
    class Category(val name: String, val ids: List<String>, val names: List<String>, val deny: Boolean, val ask: List<String>)

    private val all: List<Category>

    init {
        val cs = o.getJSONObject("categories")
        all = cs.keys().asSequence().map { key ->
            val c = cs.getJSONObject(key)
            Category(key, strings(c.getJSONArray("ids")), strings(c.getJSONArray("names")),
                c.optBoolean("deny", false), strings(c.optJSONArray("ask") ?: org.json.JSONArray()))
        }.toList()
    }

    /** The category of an app by package name (a trailing `*` matches a prefix) or display name,
     *  or null when the table does not know it. */
    fun of(pkg: String, title: String? = null): Category? {
        val p = pkg.lowercase(Locale.ROOT)
        byId[p]?.let { return it }
        for (c in all) for (id in c.ids) {
            if (id.endsWith("*") && p.startsWith(id.removeSuffix("*").lowercase(Locale.ROOT))) return c
        }
        if (title != null) {
            val t = title.lowercase(Locale.ROOT)
            byName[t]?.let { return it }
        }
        return null
    }

    fun isDenied(pkg: String, title: String? = null) = of(pkg, title)?.deny == true

    /** Action kinds a category marks as ask by category, above what the word tables catch. */
    fun askOf(category: String): List<String> = all.firstOrNull { it.name == category }?.ask ?: emptyList()

    private val byId = HashMap<String, Category>()
    private val byName = HashMap<String, Category>()

    init {
        for (c in all) {
            for (id in c.ids) byId[id.lowercase(Locale.ROOT)] = c
            for (n in c.names) byName[n.lowercase(Locale.ROOT)] = c
        }
    }

    companion object {
        /** [open] maps an asset path to its stream: `assets` in the app, the source tree in tests. */
        fun load(open: (String) -> InputStream): Categories =
            Categories(JSONObject(open("policy/apps.json").bufferedReader().readText()))

        private fun strings(a: org.json.JSONArray) = (0 until a.length()).map { a.getString(it) }
    }
}
