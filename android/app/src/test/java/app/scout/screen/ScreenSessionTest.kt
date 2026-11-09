package app.scout.screen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenSessionTest {
    private val ids = ArrayDeque(listOf("aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccccc"))
    private var clock = 1_000L
    private val session = ScreenSession(now = { clock }, newId = { ids.removeFirst() })

    @Test
    fun beginAsksThenConsentStartsTheProjection() {
        val shutter = FakeShutter()
        val notices = mutableListOf<String>()
        session.listen { notices.add(it.state) }
        val id = session.begin("u1")
        assertEquals("aaaaaaaaaaaaaaaaaaaaaaaa", id)
        assertEquals("asking", session.state())
        assertTrue(session.answer(id!!, true))
        assertEquals("starting", session.state())
        assertTrue(session.started(id, shutter))
        assertEquals("waiting", session.state())
        assertEquals(listOf("asking", "starting", "waiting"), notices)
    }

    @Test
    fun denialEndsTheSessionAndASecondAnswerIsIgnored() {
        val id = session.begin("u1")!!
        assertFalse(session.answer(id, false))
        assertEquals("idle", session.state())
        assertEquals("denied", session.lastNotice()?.reason)
        assertFalse(session.answer(id, true))
        assertEquals("idle", session.state())
    }

    @Test
    fun aSecondStartWhileOneRunsIsRefused() {
        session.begin("u1")
        assertNull(session.begin("u1"))
        assertEquals("asking", session.state())
    }

    @Test
    fun consentForAnotherSessionIsRefused() {
        val id = session.begin("u1")!!
        assertFalse(session.answer("bbbbbbbbbbbbbbbbbbbbbbbb", true))
        assertEquals(id, session.asking())
    }

    @Test
    fun captureSavesOneFrameThenReleasesAndARepeatNeedsNewConsent() {
        val shutter = FakeShutter(CaptureResult.Saved("shot-1"))
        val id = live(shutter)
        val done = mutableListOf<Boolean>()
        assertTrue(session.shoot(id, FrameSize(100, 200, 320)) { ok, _ -> done.add(ok) })
        assertEquals("idle", session.state())
        assertEquals(listOf(true), done)
        assertEquals(1, shutter.captures)
        assertEquals(1, shutter.releases)
        assertEquals("captured", session.lastNotice()?.state)
        val next = session.begin("u1")
        assertEquals("bbbbbbbbbbbbbbbbbbbbbbbb", next)
        assertEquals("asking", session.state())
        assertNotEquals(id, session.currentId())
    }

    @Test
    fun aFailedFrameEndsTheSessionAndReleases() {
        val shutter = FakeShutter(CaptureResult.Failed("black"))
        val id = live(shutter)
        val messages = mutableListOf<String?>()
        assertTrue(session.shoot(id, FrameSize(10, 10, 160)) { ok, message ->
            assertFalse(ok)
            messages.add(message)
        })
        assertEquals("idle", session.state())
        assertEquals("failed", session.lastNotice()?.reason)
        assertEquals("black", session.lastNotice()?.message)
        assertEquals(listOf("black"), messages)
        assertEquals(1, shutter.releases)
    }

    @Test
    fun stopWhileWaitingReleasesAndStopWhileCapturingCallsDone() {
        val waiting = FakeShutter()
        val waitingId = live(waiting)
        assertTrue(session.stop(waitingId, ScreenEnd.STOPPED))
        assertEquals(1, waiting.releases)
        assertEquals("stopped", session.lastNotice()?.reason)

        val capturing = FakeShutter(hold = true)
        val capturingId = live(capturing)
        var finished = true
        assertTrue(session.shoot(capturingId, FrameSize(10, 10, 160)) { ok, _ -> finished = ok })
        assertEquals("capturing", session.state())
        assertTrue(session.stop(capturingId, ScreenEnd.STOPPED))
        assertFalse(finished)
        assertEquals(1, capturing.releases)
        assertEquals("idle", session.state())
    }

    @Test
    fun systemStopAndSignOutMatchTheCurrentSessionOnly() {
        val shutter = FakeShutter()
        val id = live(shutter)
        assertFalse(session.stop("bbbbbbbbbbbbbbbbbbbbbbbb", ScreenEnd.SYSTEM))
        assertEquals("waiting", session.state())
        assertTrue(session.stop(null, ScreenEnd.SIGNED_OUT))
        assertEquals("signed_out", session.lastNotice()?.reason)
        assertEquals(1, shutter.releases)
        assertEquals(id, id)
    }

    @Test
    fun aRecordingKeepsSamplingUntilStopThenHandsBackTheClip() {
        val shutter = FakeShutter()
        val id = live(shutter)
        assertTrue(session.kept(id))
        assertTrue(session.kept(id))
        assertEquals(2, session.frameCount(id))
        assertEquals("waiting", session.state())
        assertEquals(0, shutter.releases)
        assertTrue(session.stop(id, ScreenEnd.STOPPED))
        assertEquals("captured", session.lastNotice()?.state)
        assertEquals(1, shutter.releases)
        assertEquals("idle", session.state())
    }

    @Test
    fun theSixthSavedFrameIsTheLastOneTheClipWillKeep() {
        val shutter = FakeShutter()
        val id = live(shutter)
        repeat(ScreenSession.CLIP_FRAMES - 1) { assertTrue(session.kept(id)) }
        assertFalse(session.kept(id))
        assertEquals(ScreenSession.CLIP_FRAMES, session.frameCount(id))
        assertTrue(session.stop(id, ScreenEnd.STOPPED))
        assertEquals("captured", session.lastNotice()?.state)
    }

    @Test
    fun aStaleStartAfterStopCannotAttachAProjection() {
        val id = session.begin("u1")!!
        session.stop(id, ScreenEnd.STOPPED)
        assertFalse(session.started(id, FakeShutter()))
        assertEquals("idle", session.state())
    }

    @Test
    fun captureForAStoppedSessionIsRefused() {
        val shutter = FakeShutter()
        val id = live(shutter)
        session.stop(id, ScreenEnd.STOPPED)
        assertFalse(session.shoot(id, FrameSize(10, 10, 160)) { _, _ -> })
        assertEquals(0, shutter.captures)
    }

    @Test
    fun idleProjectionExpiresAfterThreeMinutesNotWhileCapturing() {
        val shutter = FakeShutter(hold = true)
        live(shutter)
        clock += ScreenSession.LIVE_MS - 1
        assertFalse(session.expire())
        clock += 2
        assertTrue(session.expire())
        assertEquals("expired", session.lastNotice()?.reason)
        assertEquals(1, shutter.releases)

        val held = FakeShutter(hold = true)
        val id = live(held)
        session.shoot(id, FrameSize(10, 10, 160)) { _, _ -> }
        clock += ScreenSession.LIVE_MS + 10
        assertFalse(session.expire())
        assertEquals("capturing", session.state())
    }

    private fun live(shutter: FakeShutter): String {
        val id = session.begin("u1")!!
        assertTrue(session.answer(id, true))
        assertTrue(session.started(id, shutter))
        return id
    }
}

class FakeShutter(private val result: CaptureResult = CaptureResult.Saved("ok"), private val hold: Boolean = false) : Shutter {
    var captures = 0
    var releases = 0

    override fun capture(size: FrameSize, done: (CaptureResult) -> Unit) {
        captures += 1
        if (!hold) done(result)
    }

    override fun release() {
        releases += 1
    }
}
