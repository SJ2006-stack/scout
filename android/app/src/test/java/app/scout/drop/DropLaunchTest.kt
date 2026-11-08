package app.scout.drop

import app.scout.companion.BridgeCall
import app.scout.companion.BridgeDecision
import app.scout.companion.allowBridge
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DropLaunchTest {
    private val text = RawShare(ACTION_SEND, "text/plain", "hello", null, null, emptyList())
    private val image = RawShare(ACTION_SEND, "image/png", null, null, null, listOf(SharedStream("content://g/1", "image/png")))
    private val launcher = RawShare("android.intent.action.MAIN", null, null, null, null, emptyList())

    @Test
    fun coldStartImportsAShare() {
        assertTrue(shouldImport(text, savedKey = null))
        assertTrue(shouldImport(image, savedKey = null))
    }

    @Test
    fun warmStartImportsEveryNewShareEvenIfTheSameAsBefore() {
        assertTrue(shouldImport(text, savedKey = null))
        assertTrue(shouldImport(text, savedKey = null))
    }

    @Test
    fun recreationDoesNotImportTheSameShareTwice() {
        assertFalse(shouldImport(text, savedKey = shareKey(text)))
        assertTrue(shouldImport(image, savedKey = shareKey(text)))
    }

    @Test
    fun launcherAndEmptyIntentsAreNotImported() {
        assertFalse(shouldImport(launcher, null))
        assertFalse(shouldImport(RawShare(null, null, null, null, null, emptyList()), null))
    }

    @Test
    fun keysDifferWhenAnyPartDiffers() {
        assertEquals(shareKey(text), shareKey(text.copy()))
        assertNotEquals(shareKey(text), shareKey(text.copy(text = "hello!")))
        assertNotEquals(shareKey(image), shareKey(image.copy(streams = listOf(SharedStream("content://g/2", "image/png")))))
    }

    @Test
    fun dropBridgeOpsAreScoutOnlyAndTakeHexIds() {
        val id = "0123456789abcdef01234567"
        assertEquals(BridgeCall.DropTake, (allowBridge("scout.shrianshjaiswal.me", """{"op":"drop_take"}""", 0L) as BridgeDecision.Allow).call)
        assertEquals(BridgeCall.DropImage(id, id), (allowBridge("127.0.0.1", """{"op":"drop_file","id":"$id","image":"$id"}""", 0L) as BridgeDecision.Allow).call)
        assertEquals(BridgeCall.DropDone(id), (allowBridge("127.0.0.1", """{"op":"drop_done","id":"$id"}""", 0L) as BridgeDecision.Allow).call)
        assertTrue(allowBridge("evil.example", """{"op":"drop_take"}""", 0L) is BridgeDecision.Deny)
        assertTrue(allowBridge(null, """{"op":"drop_take"}""", 0L) is BridgeDecision.Deny)
        assertTrue(allowBridge("127.0.0.1", """{"op":"drop_file","id":"../../etc","image":"$id"}""", 0L) is BridgeDecision.Deny)
        assertTrue(allowBridge("127.0.0.1", """{"op":"drop_file","id":"$id"}""", 0L) is BridgeDecision.Deny)
        assertTrue(allowBridge("127.0.0.1", """{"op":"drop_done","id":"${id.uppercase()}"}""", 0L) is BridgeDecision.Deny)
        assertTrue(allowBridge("127.0.0.1", """{"op":"drop_done"}""", 0L) is BridgeDecision.Deny)
    }
}
