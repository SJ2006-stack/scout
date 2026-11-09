package app.scout.screen

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ScreenShotsTest {
    @get:Rule val folder = TemporaryFolder()
    private var clock = 5_000L

    @Test
    fun leftoverFilesAreDeletedOnCreate() {
        val root = folder.newFolder("scout-screen")
        File(root, "old.jpg").writeBytes(byteArrayOf(1, 2, 3))
        val shots = ScreenShots(root, { clock })
        assertFalse(File(root, "old.jpg").exists())
        assertNull(shots.take("u1"))
    }

    @Test
    fun theOwnerCanReadAndThenDeleteAFrame() {
        val shots = ScreenShots(folder.newFolder(), { clock })
        val id = "aaaaaaaaaaaaaaaaaaaaaaaa"
        val jpeg = ByteArray(12) { 7 }
        assertNotNull(shots.put("u1", id, jpeg, 80, 120))
        val shot = shots.take("u1")
        assertEquals(id, shot?.id)
        assertEquals("image/jpeg", shot?.mime)
        assertEquals(12, shot?.bytes)
        assertArrayEquals(jpeg, shots.bytes("u1", id))
        assertNull(shots.take("u2"))
        assertNull(shots.bytes("u2", id))
        assertTrue(shots.done("u1", id))
        assertNull(shots.take("u1"))
        assertFalse(shot!!.file.exists())
    }

    @Test
    fun emptyOversizeAndBadIdsAreRefused() {
        val shots = ScreenShots(folder.newFolder(), { clock })
        assertNull(shots.put("u1", "short", byteArrayOf(1), 10, 10))
        assertNull(shots.put("u1", "aaaaaaaaaaaaaaaaaaaaaaaa", byteArrayOf(), 10, 10))
        assertNull(shots.put("u1", "aaaaaaaaaaaaaaaaaaaaaaaa", ByteArray(ScreenShots.MAX_BYTES + 1), 10, 10))
    }

    @Test
    fun aClipKeepsFramesUntilTheCapAndExpiryDropsIt() {
        val shots = ScreenShots(folder.newFolder(), { clock })
        val first = "aaaaaaaaaaaaaaaaaaaaaaaa"
        val second = "bbbbbbbbbbbbbbbbbbbbbbbb"
        shots.put("u1", first, byteArrayOf(1), 10, 10)
        shots.put("u1", second, byteArrayOf(2, 3), 10, 10)
        assertEquals(second, shots.take("u1")?.id)
        assertEquals(2, shots.take("u1")?.frames)
        assertArrayEquals(byteArrayOf(1), shots.bytes("u1", first))
        listOf(
            "c11111111111111111111111",
            "c22222222222222222222222",
            "c33333333333333333333333",
            "c44444444444444444444444",
            "c55555555555555555555555",
        ).forEachIndexed { index, id ->
            shots.put("u1", id, byteArrayOf(index.toByte()), 10, 10)
        }
        assertEquals(ScreenShots.CLIP_FRAMES, shots.take("u1")?.frames)
        assertNull(shots.bytes("u1", first))
        clock += ScreenShots.TTL_MS + 1
        assertNull(shots.take("u1"))
    }

    @Test
    fun anotherAccountSigningInDropsTheFrameAndNewIdsMatchTheBridge() {
        val shots = ScreenShots(folder.newFolder(), { clock })
        shots.put("u1", "aaaaaaaaaaaaaaaaaaaaaaaa", byteArrayOf(1), 10, 10)
        shots.claim("u2")
        assertNull(shots.take("u1"))
        assertNull(shots.take("u2"))
        repeat(8) { assertTrue(SHOT_ID.matches(ScreenShots.newId())) }
    }
}
