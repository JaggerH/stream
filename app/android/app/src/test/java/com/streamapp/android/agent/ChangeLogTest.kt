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

    @Test fun aVersionOlderThanTheLogRemembersIsTreatedAsChanged() {
        val log = ChangeLog(capacity = 4)
        val v = log.version()
        repeat(5) { log.scrolled("2", Rect(0, 0, 1, 1)) }
        assertTrue(log.changedSince(v, "1", row))
    }
}
