package app.scout

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairCodeTest {
    @Test
    fun readsAFreshUser0CodeAndIgnoresAnythingElse() {
        val code = "c".repeat(32)
        val payload = "https://scout.example/pair?user=user0&code=$code&exp=$PAIR_WINDOW_MS"
        val fresh = readPairPayload(payload, 1_000)
        assertTrue(fresh is PairRead.Ok)
        assertEquals(
            "This code is for user0. Sign-in from another device is not connected, so this phone stays user0.",
            pairScanMessage(fresh),
        )
        val stale = readPairPayload(payload, PAIR_WINDOW_MS)
        assertEquals(
            "This code has expired. The other device shows a new one every 110 seconds.",
            pairScanMessage(stale),
        )
        val otherUser = readPairPayload(
            "https://scout.example/pair?user=user1&code=${"d".repeat(32)}&exp=110000",
            1,
        )
        assertFalse(otherUser is PairRead.Ok)
        assertFalse(readPairPayload("not a code", 1) is PairRead.Ok)
    }
}
