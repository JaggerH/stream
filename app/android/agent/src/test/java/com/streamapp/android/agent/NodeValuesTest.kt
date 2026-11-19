package com.streamapp.android.agent

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Control values in `find`: a node's own `checked` / `range` / `state`, and a found label's row values. */
class NodeValuesTest {
    private lateinit var dev: FakeDevice
    private lateinit var d: Dispatcher

    private fun call(op: String, args: String = "{}") = d.dispatch(op, JSONObject(args))
    @Suppress("UNCHECKED_CAST") private fun els(r: Any?) = (r as Map<String, Any?>)["elements"] as List<Map<String, Any?>>
    private fun find(q: String) = els(call("find", """{"query":$q}"""))

    private fun page(vararg kids: UiNode) = FakeNode("FrameLayout", rect = Rect(0, 0, 1080, 2400), children = kids.toList())
    private fun list(vararg rows: UiNode) = FakeNode("RecyclerView", rect = Rect(0, 200, 1080, 2000), isScrollable = true, children = rows.toList())

    // A settings row as Android 16 builds "Font size": title and summary, then the slider in a frame.
    private val fontTitle = FakeNode("TextView", "Font size", rect = Rect(68, 1087, 143, 49))
    private val fontSlider = FakeNode("SeekBar", "", className = "android.widget.SeekBar", rect = Rect(169, 1177, 382, 101),
        range = RangeValue(RANGE_FLOAT, 1.0f, 0.85f, 2.0f), stateDescription = "Default")
    private val fontRow = FakeNode("LinearLayout", "Font size", rect = Rect(0, 1053, 720, 259), children = listOf(
        FakeNode("RelativeLayout", rect = Rect(68, 1053, 584, 259), children = listOf(
            fontTitle,
            FakeNode("TextView", "Make text bigger or smaller", rect = Rect(68, 1136, 377, 41)),
            FakeNode("LinearLayout", rect = Rect(68, 1177, 584, 101), children = listOf(
                FakeNode("FrameLayout", "Decrease font size", rect = Rect(68, 1177, 101, 101)),
                fontSlider,
                FakeNode("FrameLayout", "Increase font size", rect = Rect(551, 1177, 101, 101)),
            )),
        )),
    ))
    private val wifiTitle = FakeNode("TextView", "Wi-Fi", rect = Rect(68, 1400, 300, 49))
    private val wifiSwitch = FakeNode("Switch", "", rect = Rect(900, 1400, 100, 60), checked = true, stateDescription = "On")
    private val wifiRow = FakeNode("LinearLayout", rect = Rect(0, 1380, 1080, 120), isClickable = true, children = listOf(wifiTitle, wifiSwitch))
    private val plainRow = FakeNode("LinearLayout", rect = Rect(0, 1500, 1080, 120), children = listOf(FakeNode("TextView", "About phone", rect = Rect(68, 1520, 300, 49))))

    @Before fun setUp() {
        dev = FakeDevice()
        dev.wins = mutableListOf(WindowInfo("1", "com.android.settings", "Settings", true))
        dev.fg = "com.android.settings"
        dev.roots["1"] = page(list(fontRow, wifiRow, plainRow))
        d = Dispatcher(dev, settleTiming = FAST_SETTLE)
        call("scopeWindow", """{"match":{"process":"com.android.settings"}}""")
    }

    @Test fun aControlCarriesItsOwnValue() {
        val s = find("""{"role":"SeekBar"}""").single()
        assertEquals(mapOf("type" to "float", "now" to 1L, "min" to 0.85, "max" to 2L), s["range"])
        assertEquals("Default", s["state"])
        assertFalse(s.containsKey("checked"))
        assertFalse(s.containsKey("values"))
        val w = find("""{"role":"Switch"}""").single()
        assertEquals(true, w["checked"])
        assertEquals("On", w["state"])
        assertFalse(w.containsKey("range"))
    }

    @Test fun aNodeWithoutAValueCarriesNoValueKeys() {
        val e = find("""{"name":"About phone"}""").single()
        assertEquals(setOf("ref", "role", "name", "className", "rect", "editable"), e.keys)
    }

    @Test fun aFoundLabelBringsItsRowsSliderAlong() {
        val title = find("""{"role":"TextView","name":"Font size"}""").single()
        @Suppress("UNCHECKED_CAST") val values = title["values"] as List<Map<String, Any?>>
        assertEquals(1, values.size)
        val v = values.single()
        assertEquals("SeekBar", v["role"])
        assertEquals(mapOf("type" to "float", "now" to 1L, "min" to 0.85, "max" to 2L), v["range"])
        assertEquals("Default", v["state"])
        assertEquals(mapOf("x" to 169, "y" to 1177, "w" to 382, "h" to 101), v["rect"])
        assertFalse(v.containsKey("name")) // unnamed: left out
        // The value's ref is a ref like any other: it acts on the slider.
        call("invoke", """{"ref":"${v["ref"]}"}""")
        assertTrue("click " in dev.log)
    }

    @Test fun aRowContainerHitReportsTheValueInsideIt() {
        val row = find("""{"role":"LinearLayout","name":"Font size"}""").single()
        @Suppress("UNCHECKED_CAST") val values = row["values"] as List<Map<String, Any?>>
        assertEquals("SeekBar", values.single()["role"])
    }

    @Test fun aSwitchRowLabelGetsTheSwitch() {
        val t = find("""{"name":"Wi-Fi"}""").single()
        @Suppress("UNCHECKED_CAST") val v = (t["values"] as List<Map<String, Any?>>).single()
        assertEquals(true, v["checked"])
        assertEquals("On", v["state"])
    }

    @Test fun theSearchStopsAtTheListAndNeverReportsAnotherRow() {
        val e = find("""{"name":"About phone"}""").single()
        assertNull(e["values"])
    }

    @Test fun aValueAlsoFoundAsAHitSharesItsRef() {
        val hits = find("{}") // every node, the label and its switch among them
        @Suppress("UNCHECKED_CAST")
        val v = (hits.first { it["name"] == "Wi-Fi" && it["role"] == "TextView" }["values"] as List<Map<String, Any?>>).single()
        assertEquals(hits.single { it["role"] == "Switch" }["ref"], v["ref"])
    }

    @Test fun aGroupOfManyControlsIsNotARow() {
        val title = FakeNode("TextView", "Options", rect = Rect(0, 0, 100, 40))
        val boxes = (1..4).map { FakeNode("CheckBox", "opt $it", rect = Rect(0, 50 * it, 100, 40), checked = it % 2 == 0) }
        dev.roots["1"] = page(FakeNode("LinearLayout", rect = Rect(0, 0, 1080, 400), children = listOf(title) + boxes))
        assertNull(find("""{"name":"Options"}""").single()["values"])
    }

    @Test fun nearestValueFirst() {
        val title = FakeNode("TextView", "Volume", rect = Rect(0, 100, 200, 40))
        val near = FakeNode("SeekBar", rect = Rect(0, 150, 800, 40), range = RangeValue(RANGE_INT, 7f, 0f, 15f))
        val far = FakeNode("Switch", rect = Rect(900, 400, 100, 40), checked = false)
        dev.roots["1"] = page(list(FakeNode("LinearLayout", rect = Rect(0, 100, 1080, 400), children = listOf(title, far, near))))
        @Suppress("UNCHECKED_CAST") val v = find("""{"name":"Volume"}""").single()["values"] as List<Map<String, Any?>>
        assertEquals(listOf("SeekBar", "Switch"), v.map { it["role"] })
        assertEquals(mapOf("type" to "int", "now" to 7L, "min" to 0L, "max" to 15L, "stepCount" to 16), v[0]["range"])
        assertEquals(false, v[1]["checked"])
    }

    @Test fun aSliderAndItsThumbSayingTheSameAreReportedOnce() {
        // Android 16 Settings: a Material slider (state only, reported not visible to the user)
        // with a virtual thumb node carrying the range and the same state.
        val title = FakeNode("TextView", "Font size", rect = Rect(68, 1087, 143, 49))
        val thumb = FakeNode("SeekBar", rect = Rect(213, 1177, 100, 100), isVisible = false,
            range = RangeValue(RANGE_FLOAT, 1f, 0f, 6f), stateDescription = "100 %")
        val slider = FakeNode("SeekBar", rect = Rect(169, 1177, 382, 101), isVisible = false, stateDescription = "100 %", children = listOf(thumb))
        dev.roots["1"] = page(list(FakeNode("LinearLayout", rect = Rect(0, 1053, 720, 259), children = listOf(
            FakeNode("RelativeLayout", rect = Rect(68, 1053, 584, 259), children = listOf(title, FakeNode("LinearLayout", rect = Rect(68, 1177, 584, 101), children = listOf(slider)))),
        ))))
        @Suppress("UNCHECKED_CAST") val v = find("""{"role":"TextView","name":"Font size"}""").single()["values"] as List<Map<String, Any?>>
        assertEquals(1, v.size)
        assertEquals(mapOf("type" to "float", "now" to 1L, "min" to 0L, "max" to 6L), v[0]["range"])
        assertEquals("100 %", v[0]["state"])
        assertEquals(213, (v[0]["rect"] as Map<*, *>)["x"])
    }

    @Test fun aValueNodeWithoutAreaIsNotReported() {
        val title = FakeNode("TextView", "Sync", rect = Rect(0, 100, 200, 40))
        val gone = FakeNode("Switch", rect = Rect(0, 0, 0, 0), checked = true)
        dev.roots["1"] = page(list(FakeNode("LinearLayout", rect = Rect(0, 100, 1080, 100), children = listOf(title, gone))))
        assertNull(find("""{"name":"Sync"}""").single()["values"])
    }

    @Test fun numbersAreCompact() {
        assertEquals(3L, jsonNumber(3f))
        assertEquals(0.1, jsonNumber(0.1f))
        assertEquals(0.333, jsonNumber(1f / 3))
        assertEquals(-2L, jsonNumber(-2f))
        assertNull(jsonNumber(Float.NaN))
        assertNull(jsonNumber(Float.POSITIVE_INFINITY))
    }

    @Test fun anIndeterminateRangeStillSaysSo() {
        dev.roots["1"] = page(FakeNode("ProgressBar", rect = Rect(0, 0, 100, 10), range = RangeValue(RANGE_INDETERMINATE, 0f, 0f, 0f)))
        assertEquals("indeterminate", (find("""{"role":"ProgressBar"}""").single()["range"] as Map<*, *>)["type"])
    }

    // ---- slider values: stepCount and valueText ----------------------------------------

    @Test fun anIntSliderCarriesItsStepCountAndValueText() {
        dev.roots["1"] = page(FakeNode("SeekBar", "", className = "android.widget.SeekBar",
            rect = Rect(0, 100, 800, 40), range = RangeValue(RANGE_INT, 0f, 0f, 3f), stateDescription = "Default"))
        val s = find("""{"role":"SeekBar"}""").single()
        assertEquals(mapOf("type" to "int", "now" to 0L, "min" to 0L, "max" to 3L, "stepCount" to 4), s["range"])
        assertEquals("Default", s["valueText"])
    }

    @Test fun aFloatSliderHasNoStepCount() {
        dev.roots["1"] = page(FakeNode("SeekBar", "", className = "android.widget.SeekBar",
            rect = Rect(0, 100, 800, 40), range = RangeValue(RANGE_FLOAT, 1.3f, 0.85f, 2.0f)))
        val s = find("""{"role":"SeekBar"}""").single()
        val r = s["range"] as Map<*, *>
        assertEquals("float", r["type"])
        assertEquals(1.3, r["now"])
        assertFalse(r.containsKey("stepCount"))
        assertFalse(s.containsKey("valueText")) // neither a state description nor text
    }

    @Test fun aPercentSliderRoundTripsVerbatim() {
        dev.roots["1"] = page(FakeNode("SeekBar", "", className = "android.widget.SeekBar",
            rect = Rect(0, 100, 800, 40), range = RangeValue(RANGE_PERCENT, 40f, 0f, 100f), stateDescription = "40 %"))
        val s = find("""{"role":"SeekBar"}""").single()
        assertEquals(mapOf("type" to "percent", "now" to 40L, "min" to 0L, "max" to 100L), s["range"])
        assertEquals("40 %", s["valueText"])
    }

    @Test fun aRowValueCarriesItsValueText() {
        val title = FakeNode("TextView", "Font size", rect = Rect(68, 1087, 143, 49))
        val slider = FakeNode("SeekBar", "", className = "android.widget.SeekBar",
            rect = Rect(169, 1177, 382, 101), range = RangeValue(RANGE_INT, 3f, 0f, 3f), stateDescription = "Largest")
        dev.roots["1"] = page(list(FakeNode("LinearLayout", rect = Rect(0, 1053, 720, 259), children = listOf(title, slider))))
        @Suppress("UNCHECKED_CAST")
        val v = find("""{"role":"TextView","name":"Font size"}""").single()["values"] as List<Map<String, Any?>>
        assertEquals("Largest", v.single()["valueText"])
        assertEquals(4, (v.single()["range"] as Map<*, *>)["stepCount"])
    }
}
