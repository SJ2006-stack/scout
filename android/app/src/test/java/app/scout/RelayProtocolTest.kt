package app.scout

import app.scout.relay.CopyStore
import app.scout.relay.RelayKind
import app.scout.relay.SealedCopy
import app.scout.relay.VaultMessage
import app.scout.relay.decodeFrame
import app.scout.relay.decodeVault
import app.scout.relay.encodeFrame
import app.scout.relay.encodeVault
import app.scout.relay.relayTarget
import app.scout.relay.sessionFromCookies
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class RelayProtocolTest {
    @Test
    fun framesRoundTrip() {
        val frame = decodeFrame(encodeFrame(RelayKind.DATA, 70_000, byteArrayOf(1, 2, 3)))!!
        assertEquals(RelayKind.DATA, frame.kind)
        assertEquals(70_000, frame.stream)
        assertArrayEquals(byteArrayOf(1, 2, 3), frame.payload)
        assertNull(decodeFrame(byteArrayOf(9, 0, 0, 0, 1)))
    }

    @Test
    fun opensOnlyStoreHostsOn443() {
        assertEquals("blinkit.com" to 443, relayTarget("blinkit.com:443"))
        assertEquals("api.zepto.com" to 443, relayTarget("API.zepto.com:443"))
        assertEquals("in.bookmyshow.com" to 443, relayTarget("in.bookmyshow.com:443"))
        assertEquals("www.district.in" to 443, relayTarget("www.district.in:443"))
        assertNull(relayTarget("blinkit.com:80"))
        assertNull(relayTarget("blinkit.com.evil.com:443"))
        assertNull(relayTarget("169.254.169.254:443"))
    }

    @Test
    fun readsTheServersVaultFrame() {
        // Bytes as scout/src/shared/relay.ts encodes them.
        val header = "{\"op\":\"put\",\"domain\":\"blinkit.com\",\"updatedAt\":1793485380488,\"expiresAt\":1796077380488,\"lastValidatedAt\":1793485380488}"
        val head = header.toByteArray()
        val payload = byteArrayOf(0, 0, (head.size shr 8).toByte(), head.size.toByte()) + head + byteArrayOf(7, 8, 9)
        val message = decodeVault(payload) as VaultMessage.Put
        assertEquals("blinkit.com", message.copy.domain)
        assertEquals(1793485380488L, message.copy.updatedAt)
        assertArrayEquals(byteArrayOf(7, 8, 9), message.copy.blob)
        val drop = decodeVault(decodeFrame(encodeVault(VaultMessage.Drop("zepto.com", 5)))!!.payload) as VaultMessage.Drop
        assertEquals("zepto.com", drop.domain)
        assertNull(decodeVault(byteArrayOf(0, 0, 0, 2, '{'.code.toByte(), '}'.code.toByte())))
    }

    @Test
    fun keepsTheNewestCopyAndHonoursDrops() {
        val dir = Files.createTempDirectory("vault").toFile()
        val flip = { bytes: ByteArray -> bytes.map { (it.toInt() xor 0x5a).toByte() }.toByteArray() }
        val store = CopyStore(dir, flip, flip, now = { 1_000L })
        store.put(SealedCopy("blinkit.com", 10, 5_000, 10, byteArrayOf(1)))
        store.put(SealedCopy("blinkit.com", 5, 5_000, 5, byteArrayOf(2)))
        assertArrayEquals(byteArrayOf(1), store.list().single().blob)
        store.put(SealedCopy("zepto.com", 10, 500, 10, byteArrayOf(3)))
        assertEquals(listOf("blinkit.com"), store.list().map { it.domain })
        store.drop("blinkit.com", 9)
        assertEquals(1, store.list().size)
        store.drop("blinkit.com", 10)
        assertTrue(store.list().isEmpty())
        dir.deleteRecursively()
    }

    @Test
    fun findsTheSessionCookie() {
        assertEquals("a".repeat(32), sessionFromCookies("theme=dark; scout_session=${"a".repeat(32)}"))
        assertNull(sessionFromCookies("theme=dark"))
    }
}
