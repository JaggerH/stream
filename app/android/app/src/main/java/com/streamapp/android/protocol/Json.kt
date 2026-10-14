package com.streamapp.android.protocol

import org.json.JSONArray
import org.json.JSONObject

/** Convert agent results (Kotlin maps, lists, primitives, null) into org.json values. */
fun toJson(v: Any?): Any = when (v) {
    null -> JSONObject.NULL
    is JSONObject, is JSONArray -> v
    is Map<*, *> -> JSONObject().also { o -> v.forEach { (k, x) -> o.put(k.toString(), toJson(x)) } }
    is List<*> -> JSONArray().also { a -> v.forEach { a.put(toJson(it)) } }
    else -> v
}
