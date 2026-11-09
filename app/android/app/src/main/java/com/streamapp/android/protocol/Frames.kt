package com.streamapp.android.protocol

import org.json.JSONArray
import org.json.JSONObject

/** [abortEpoch]: how many aborts the backend had counted when it sent this; null from a backend
 *  that does not count them. */
data class Request(val id: Long, val op: String, val args: JSONObject, val abortEpoch: Long? = null)

/** An out-of-band control frame (`{type:"control"}`, symmetric with `abort`): sets busy or
 *  replaces the exemption set. Optional `id` gets a reply; an `exemption-invalid` grant is
 *  refused as a whole. */
data class Control(
    val id: Long?,
    val control: String,
    val busy: Boolean?,
    val reason: String?,
    val ask: List<Pair<String, String>>,
    val financeVisible: List<String>,
)

data class DeviceState(
    val a11yEnabled: Boolean,
    val screenOn: Boolean,
    val keyguardLocked: Boolean,
    val battery: Int,
    val charging: Boolean,
)

/** The `host-relay.v2` frames this app sends and receives. */
object Frames {
    const val PROTOCOL = "host-relay.v2"

    /** A backend request, or null for anything else. A frame with a non-numeric id is not ours. */
    fun request(raw: String): Request? {
        val o = try { JSONObject(raw) } catch (_: Exception) { return null }
        val id = o.opt("id")
        if (id !is Number) return null
        val op = o.optString("op", "")
        if (op.isEmpty()) return null
        return Request(id.toLong(), op, o.optJSONObject("args") ?: JSONObject(), if (o.has("abortEpoch")) o.optLong("abortEpoch") else null)
    }

    /** A backend control frame, or null for anything else. */
    fun control(raw: String): Control? {
        val o = try { JSONObject(raw) } catch (_: Exception) { return null }
        if (o.optString("type") != "control") return null
        val control = o.optString("control", "")
        if (control.isEmpty()) return null
        return Control(
            id = (o.opt("id") as? Number)?.toLong(),
            control = control,
            busy = if (o.has("busy")) o.optBoolean("busy") else null,
            reason = if (o.has("reason")) o.optString("reason") else null,
            ask = o.optJSONArray("ask")?.let { a ->
                (0 until a.length()).mapNotNull { e ->
                    val x = a.optJSONObject(e) ?: return@mapNotNull null
                    (x.optString("app") ?: return@mapNotNull null) to x.optString("action")
                }
            } ?: emptyList(),
            financeVisible = o.optJSONArray("financeVisible")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList(),
        )
    }

    fun reply(id: Long, result: Any?): String = JSONObject().put("id", id).put("result", toJson(result)).toString()    /** An error reply. [code] is the machine-readable family (`approval-required`, `device-busy`…)
     *  for callers that know it; the message keeps the `code: 人话` shape every caller reads.
     *  [semantics] carries the structured receipt of an `approval-required`. */
    fun error(id: Long, message: String, code: String? = null, semantics: JSONObject? = null): String {
        val o = JSONObject().put("id", id).put("error", message)
        if (!code.isNullOrEmpty()) o.put("code", code)
        if (semantics != null) o.put("semantics", semantics)
        return o.toString()
    }

    fun hello(deviceId: String, name: String, agentVersion: String, ops: List<String>): String =
        JSONObject()
            .put("type", "hello")
            .put("deviceId", deviceId)
            .put("platform", "android")
            .put("name", name)
            .put("agentVersion", agentVersion)
            .put("ops", JSONArray(ops))
            .toString()

    fun state(s: DeviceState): String =
        JSONObject()
            .put("type", "state")
            .put("a11yEnabled", s.a11yEnabled)
            .put("screenOn", s.screenOn)
            .put("keyguardLocked", s.keyguardLocked)
            .put("battery", s.battery)
            .put("charging", s.charging)
            .toString()

    /** `phone-stop`: the backend tells this apart from the desktop hotkey when it words the abort. */
    fun abort(): String = JSONObject().put("type", "abort").put("reason", "phone-stop").toString()

}
