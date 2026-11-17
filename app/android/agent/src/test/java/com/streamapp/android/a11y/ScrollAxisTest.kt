package com.streamapp.android.a11y

import com.streamapp.android.agent.AXIS_HORIZONTAL
import com.streamapp.android.agent.AXIS_VERTICAL
import org.junit.Assert.*
import org.junit.Test

class ScrollAxisTest {
    private val forward = 4096 // ACTION_SCROLL_FORWARD
    private val down = android.R.id.accessibilityActionScrollDown
    private val right = android.R.id.accessibilityActionScrollRight
    private val pageLeft = android.R.id.accessibilityActionPageLeft

    @Test fun directionalActionsDecide() {
        assertEquals(AXIS_VERTICAL, scrollAxisOf(setOf(forward, down), "androidx.recyclerview.widget.RecyclerView", null))
        assertEquals(AXIS_HORIZONTAL, scrollAxisOf(setOf(forward, right), "android.view.View", null))
        assertEquals(AXIS_HORIZONTAL, scrollAxisOf(setOf(pageLeft), "android.view.View", null))
        // Vertical wins when both are offered (a 2-D scroller still moves down).
        assertEquals(AXIS_VERTICAL, scrollAxisOf(setOf(down, right), "android.view.View", null))
    }

    @Test fun classAndCollectionShapeDecideWithoutDirectionalActions() {
        assertEquals(AXIS_HORIZONTAL, scrollAxisOf(setOf(forward), "androidx.viewpager2.widget.ViewPager2", null))
        assertEquals(AXIS_HORIZONTAL, scrollAxisOf(setOf(forward), "android.widget.HorizontalScrollView", null))
        assertEquals(AXIS_HORIZONTAL, scrollAxisOf(setOf(forward), "androidx.recyclerview.widget.RecyclerView", 1 to 8))
        assertNull(scrollAxisOf(setOf(forward), "androidx.recyclerview.widget.RecyclerView", 20 to 1))
        assertNull(scrollAxisOf(setOf(forward), "android.widget.ScrollView", null))
    }
}
