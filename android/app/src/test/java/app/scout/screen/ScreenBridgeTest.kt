package app.scout.screen

import app.scout.companion.BridgeCall
import app.scout.companion.BridgeDecision
import app.scout.companion.allowBridge
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenBridgeTest {
    private val host = "scout.shrianshjaiswal.me"
    private val id = "0123456789abcdef01234567"

    @Test
    fun screenOpsAreScoutOnlyAndTakeHexIds() {
        assertEquals(BridgeCall.ScreenState, allowed("""{"op":"screen_state"}"""))
        assertEquals(BridgeCall.ScreenStart, allowed("""{"op":"screen_start"}"""))
        assertEquals(BridgeCall.ScreenStop, allowed("""{"op":"screen_stop"}"""))
        assertEquals(BridgeCall.ScreenFrame, allowed("""{"op":"screen_frame"}"""))
        assertEquals(BridgeCall.ScreenTake, allowed("""{"op":"screen_take"}"""))
        assertEquals(BridgeCall.ScreenFile(id), allowed("""{"op":"screen_file","id":"$id"}"""))
        assertEquals(BridgeCall.ScreenDone(id), allowed("""{"op":"screen_done","id":"$id"}"""))
        assertTrue(allowBridge("evil.example", """{"op":"screen_start"}""", 0L) is BridgeDecision.Deny)
        assertTrue(allowBridge(null, """{"op":"screen_state"}""", 0L) is BridgeDecision.Deny)
        assertTrue(allowBridge(host, """{"op":"screen_file","id":"../etc"}""", 0L) is BridgeDecision.Deny)
        assertTrue(allowBridge(host, """{"op":"screen_done","id":"${id.uppercase()}"}""", 0L) is BridgeDecision.Deny)
        assertTrue(allowBridge(host, """{"op":"screen_file"}""", 0L) is BridgeDecision.Deny)
    }

    @Test
    fun stateJsonHidesTheFilePath() {
        val json = screenStateJson("waiting", null, id, null)
        assertTrue(json.contains(""""state":"waiting""""))
        assertTrue(json.contains(id))
        assertTrue(json.contains(""""shot":null"""))
        assertFalse(json.contains("/cache"))
        assertFalse(json.contains(".jpg"))
        val ended = screenStateJson("idle", ScreenNotice("ended", "denied"), null, null)
        assertTrue(ended.contains(""""reason":"denied""""))
    }

    private fun allowed(json: String): BridgeCall =
        (allowBridge(host, json, 0L) as BridgeDecision.Allow).call
}
