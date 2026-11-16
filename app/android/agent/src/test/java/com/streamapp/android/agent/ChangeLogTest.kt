package com.streamapp.android.agent

import org.junit.Assert.*
import org.junit.Test

class ChangeLogTest {
    private val row = Rect(100, 200, 50, 40)

    @Test fun nothingHappenedIsNoChange() {
        val log = ChangeLog()
        assertFalse(log.changedSince(log.version(), "1", row))
    }

    @Test fun aWindowLevelChangeStalesEverything() {
        val log = ChangeLog()
        val v = log.version()
        log.windowsChanged()
        assertTrue(log.changedSince(v, "1", row))
        assertTrue(log.changedSince(v, "9", Rect(0, 0, 1, 1)))
    }

    @Test fun aScrollStalesOnlyWhatItCovers() {
        val log = ChangeLog()
        val v = log.version()
        log.scrolled("1", Rect(0, 1000, 1080, 300)) // a carousel lower down
        assertFalse(log.changedSince(v, "1", row))
        log.scrolled("1", Rect(0, 150, 1080, 600)) // the list the row is in
        assertTrue(log.changedSince(v, "1", row))
    }

    @Test fun aScrollInAnotherWindowDoesNotCount() {
        val log = ChangeLog()
        val v = log.version()
        log.scrolled("2", Rect(0, 0, 1080, 2400))
        assertFalse(log.changedSince(v, "1", row))
    }

    @Test fun aScrollWithUnknownAreaCoversItsWholeWindow() {
        val log = ChangeLog()
        val v = log.version()
        log.scrolled("1", null)
        assertTrue(log.changedSince(v, "1", row))
    }

    @Test fun changesBeforeTheVersionDoNotCount() {
        val log = ChangeLog()
        log.windowsChanged()
        val v = log.version()
        assertFalse(log.changedSince(v, "1", row))
    }

    @Test fun aCarouselTickingForeverDoesNotOverflowTheLog() {
        val log = ChangeLog(capacity = 4)
        val v = log.version()
        repeat(1000) { log.scrolled("1", Rect(0, 1000, 1080, 300)) }
        assertFalse(log.changedSince(v, "1", row))
        log.scrolled("1", Rect(0, 1000, 1080, 300))
        assertTrue(log.changedSince(v, "1", Rect(10, 1100, 10, 10)))
    }

    @Test fun theSameWindowListTwiceIsOneChange() {
        val log = ChangeLog()
        log.windows(listOf("1/1/[0,0][1080,2400]"))
        val v = log.version()
        log.windows(listOf("1/1/[0,0][1080,2400]"))
        assertFalse(log.changedSince(v, "1", row))
        log.windows(listOf("1/1/[0,0][1080,2400]", "5/2/[0,1600][1080,2400]")) // the keyboard came up
        assertTrue(log.changedSince(v, "1", row))
    }

    @Test fun onlyAPageChangeIsAWindowStateChange() {
        assertTrue(isPageChange(contentChangeTypes = 0, className = "com.sankuai.meituan.MainActivity"))
        assertFalse(isPageChange(contentChangeTypes = 8, className = "android.widget.FrameLayout")) // a pane title
        assertFalse(isPageChange(contentChangeTypes = 0, className = "android.widget.Toast\$TN"))
    }

    @Test fun aVersionOlderThanTheLogRemembersIsTreatedAsChanged() {
        val log = ChangeLog(capacity = 4)
        val v = log.version()
        repeat(5) { log.scrolled("2", Rect(it, 0, 1, 1)) } // five different areas
        assertTrue(log.changedSince(v, "1", row))
    }
}
