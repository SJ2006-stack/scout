package app.scout.drop

import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DropInboxTest {
    private val root = File(Files.createTempDirectory("drop-inbox").toFile(), "scout-drop")
    private var clock = 1_000_000L
    private val ids = Ids()
    private val inbox = DropInbox(root, { clock })
    private val pkg = "app.scout"

    private fun receive(raw: RawShare, owner: String?, source: StreamSource = FakeSource(emptyMap()), into: DropInbox = inbox) =
        receiveShare(raw, pkg, owner, into, source, { clock }, ids::next)

    private fun textShare(text: String) = RawShare(ACTION_SEND, "text/plain", text, null, null, emptyList())

    private fun imageShare(vararg uris: String) =
        RawShare(ACTION_SEND_MULTIPLE, "image/*", null, null, null, uris.map { SharedStream(it, "image/*") })

    @Test
    fun onlyTheOwnerCanTakeAShare() {
        receive(textShare("hello"), owner = "alice")
        assertNull(inbox.take(null))
        assertNull(inbox.take("bob"))
        assertEquals("hello", inbox.take("alice")?.text)
    }

    @Test
    fun takeRepeatsUntilDoneThenDeletesTheFiles() {
        val receipt = receive(imageShare("content://g/1"), "alice", FakeSource(mapOf("content://g/1" to PNG))) as DropReceipt.Ready
        val file = receipt.drop.images.single().file
        assertTrue(file.isFile)
        assertNotNull(inbox.take("alice"))
        assertNotNull(inbox.take("alice"))
        assertFalse(inbox.done("bob", receipt.drop.id))
        assertFalse(inbox.done("alice", "f".repeat(24)))
        assertTrue(inbox.done("alice", receipt.drop.id))
        assertNull(inbox.take("alice"))
        assertFalse(file.exists())
        assertFalse(root.exists())
    }

    @Test
    fun servesImagesOnlyToTheOwnerAndOnlyByIdFromTheSameShare() {
        val drop = (receive(imageShare("content://g/1"), "alice", FakeSource(mapOf("content://g/1" to WEBP))) as DropReceipt.Ready).drop
        val imageId = drop.images.single().id
        assertEquals("image/webp", inbox.image("alice", drop.id, imageId)?.mime)
        assertNull(inbox.image("bob", drop.id, imageId))
        assertNull(inbox.image(null, drop.id, imageId))
        assertNull(inbox.image("alice", "0".repeat(24), imageId))
        assertNull(inbox.image("alice", drop.id, drop.id))
    }

    @Test
    fun aShareReceivedWhileSignedOutGoesToTheNextAccountThatSignsIn() {
        val receipt = receive(textShare("from signed out"), owner = null) as DropReceipt.Ready
        assertNull(receipt.drop.owner)
        assertNull(inbox.take("alice"))
        inbox.claim("alice")
        assertEquals("from signed out", inbox.take("alice")?.text)
        inbox.claim("bob")
        assertNull(inbox.take("bob"))
        assertNull(inbox.take("alice"))
    }

    @Test
    fun switchingAccountsDeletesTheOtherAccountsShare() {
        receive(imageShare("content://g/1"), "alice", FakeSource(mapOf("content://g/1" to JPEG)))
        inbox.claim("alice")
        assertNotNull(inbox.take("alice"))
        inbox.claim("bob")
        assertNull(inbox.take("bob"))
        assertNull(inbox.take("alice"))
        assertFalse(root.exists())
    }

    @Test
    fun signOutDeletesEverything() {
        receive(imageShare("content://g/1"), "alice", FakeSource(mapOf("content://g/1" to JPEG)))
        inbox.discard()
        assertNull(inbox.take("alice"))
        assertFalse(root.exists())
    }

    @Test
    fun expiresAfterThirtyMinutes() {
        receive(textShare("old"), "alice")
        clock += DropLimits.TTL_MS
        assertNotNull(inbox.take("alice"))
        clock += 1
        assertNull(inbox.take("alice"))
        assertFalse(root.exists())
    }

    @Test
    fun aNewerShareReplacesTheOlderOne() {
        val first = (receive(imageShare("content://g/1"), "alice", FakeSource(mapOf("content://g/1" to PNG))) as DropReceipt.Ready).drop
        receive(textShare("second"), "alice")
        assertEquals("second", inbox.take("alice")?.text)
        assertFalse(first.images.single().file.exists())
        assertEquals(1, root.listFiles()!!.size)
    }

    @Test
    fun survivesTheActivityOrProcessBeingRecreated() {
        val drop = (receive(imageShare("content://g/1", "content://g/2"), "alice", FakeSource(mapOf("content://g/1" to PNG, "content://g/2" to JPEG))) as DropReceipt.Ready).drop
        val again = DropInbox(root, { clock })
        val restored = again.take("alice")
        assertEquals(drop.id, restored?.id)
        assertEquals(drop.images.map { it.id to it.mime }, restored?.images?.map { it.id to it.mime })
        assertNull(again.take("bob"))
    }

    @Test
    fun aRestoredInboxCleansUpLeftoverFolders() {
        File(root, "abc").mkdirs()
        File(root, "stray.part").writeText("x")
        assertNull(DropInbox(root, { clock }).take("alice"))
        assertTrue(root.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun ignoresATamperedManifestThatPointsOutsideItsFolder() {
        val drop = (receive(imageShare("content://g/1"), "alice", FakeSource(mapOf("content://g/1" to PNG))) as DropReceipt.Ready).drop
        val folder = File(root, drop.id)
        val manifest = JSONObject(File(folder, DropInbox.MANIFEST).readText())
        manifest.getJSONArray("images").getJSONObject(0).put("file", "../../secret.png")
        assertTrue(readDropManifest(manifest, folder)!!.images.isEmpty())
        manifest.put("id", "../x")
        assertNull(readDropManifest(manifest, folder))
    }

    @Test
    fun theManifestForThePageHasNoFilePaths() {
        val drop = (receive(imageShare("content://g/1"), "alice", FakeSource(mapOf("content://g/1" to PNG))) as DropReceipt.Ready).drop
        val page = dropForPage(drop).toString()
        assertFalse(page.contains(root.path))
        assertFalse(page.contains("alice"))
        assertTrue(page.contains(drop.images.single().id))
    }

    @Test
    fun aShareWithNothingReadableIsReportedAndNotStored() {
        val receipt = receive(imageShare("content://g/no-grant"), "alice")
        assertEquals(DropReceipt.Failed("1 image skipped: the sharing app did not give Scout permission to read it."), receipt)
        assertNull(inbox.take("alice"))
        assertTrue(root.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun textSurvivesWhenItsImagesFail() {
        val raw = RawShare(ACTION_SEND, "image/jpeg", "look at this", null, null, listOf(SharedStream("content://g/gif", "image/jpeg")))
        val drop = (receive(raw, "alice", FakeSource(mapOf("content://g/gif" to "GIF89a".toByteArray()))) as DropReceipt.Ready).drop
        assertEquals("look at this", drop.text)
        assertTrue(drop.images.isEmpty())
        assertEquals(listOf("1 image not JPEG, PNG, or WebP skipped."), drop.notes)
    }

    @Test
    fun emptyAndNonShareIntentsStoreNothing() {
        assertEquals(DropReceipt.Failed("That share was empty."), receive(textShare(""), "alice"))
        assertEquals(DropReceipt.Ignored, receive(RawShare("android.intent.action.MAIN", null, null, null, null, emptyList()), "alice"))
        assertNull(inbox.take("alice"))
    }

    @Test
    fun newIdsMatchTheBridgeFormat() {
        repeat(20) { assertTrue(DROP_ID.matches(DropInbox.newId())) }
    }
}
