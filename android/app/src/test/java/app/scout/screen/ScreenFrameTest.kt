package app.scout.screen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenFrameTest {
    @Test
    fun fitWithinDoesNotScaleUpAndKeepsTheLongSideAtTheCap() {
        assertEquals(100 to 50, fitWithin(100, 50, 1600))
        assertEquals(0 to 0, fitWithin(0, 10))
        val (width, height) = fitWithin(3200, 1800, 1600)
        assertEquals(1600, width)
        assertEquals(900, height)
        val portrait = fitWithin(1080, 2400, 1600)
        assertEquals(720, portrait.first)
        assertEquals(1600, portrait.second)
    }

    @Test
    fun frameSizeForUsesTheFittedSides() {
        val size = frameSizeFor(4000, 2000, 420)
        assertEquals(1600, size.width)
        assertEquals(800, size.height)
        assertEquals(420, size.dpi)
    }

    @Test
    fun captureSizeFollowsTheSharedWindowIncludingOrientation() {
        val display = frameSizeFor(1080, 2400, 440)
        assertEquals(display, captureSize(display, 0, 0))
        assertEquals(display, captureSize(display, 1080, 0))
        val window = captureSize(display, 1080, 1920)
        assertEquals(900, window.width)
        assertEquals(1600, window.height)
        assertEquals(440, window.dpi)
        val turned = captureSize(display, 1920, 1080)
        assertEquals(1600, turned.width)
        assertEquals(900, turned.height)
        val small = captureSize(display, 400, 800)
        assertEquals(400, small.width)
        assertEquals(800, small.height)
    }

    @Test
    fun looksBlankRejectsABlackFrameAndKeepsALitOne() {
        assertTrue(looksBlank(intArrayOf()))
        assertTrue(looksBlank(intArrayOf(0xFF000000.toInt(), 0xFF050505.toInt())))
        assertFalse(looksBlank(intArrayOf(0xFF000000.toInt(), 0xFF112233.toInt())))
    }
}
