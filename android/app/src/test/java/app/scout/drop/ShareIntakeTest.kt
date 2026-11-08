package app.scout.drop

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareIntakeTest {
    private val pkg = "app.scout"

    private fun share(
        text: String? = null,
        type: String? = "text/plain",
        action: String = ACTION_SEND,
        subject: String? = null,
        streams: List<SharedStream> = emptyList(),
    ) = RawShare(action, type, text, subject, null, streams)

    private fun accept(raw: RawShare) = readShare(raw, pkg) as SharePlan.Accept

    @Test
    fun readsPlainTextAndSubject() {
        val plan = accept(share(text = "  Dinner at 8 on Friday?  ", subject = "Plans"))
        assertEquals("Dinner at 8 on Friday?", plan.text)
        assertEquals("Plans", plan.subject)
        assertTrue(plan.urls.isEmpty())
        assertTrue(plan.images.isEmpty())
    }

    @Test
    fun dropsASubjectThatRepeatsTheText() {
        assertNull(accept(share(text = "Read this https://a.example/x", subject = "Read this")).subject)
    }

    @Test
    fun keepsTheOriginalLinkAndTitleFromABrowserShare() {
        val plan = accept(share(text = "https://www.example.com/a/b?q=1&r=2#top", subject = "A page title"))
        assertEquals(listOf("https://www.example.com/a/b?q=1&r=2#top"), plan.urls)
        assertEquals("https://www.example.com/a/b?q=1&r=2#top", plan.text)
        assertEquals("A page title", plan.subject)
    }

    @Test
    fun extractsLinksAndTrimsTrailingPunctuation() {
        val urls = extractUrls("See https://a.example/x. Also (https://b.example/y), and https://en.wikipedia.org/wiki/Foo_(bar)! And https://a.example/x again")
        assertEquals(listOf("https://a.example/x", "https://b.example/y", "https://en.wikipedia.org/wiki/Foo_(bar)"), urls)
    }

    @Test
    fun ignoresNonWebSchemesAndUserInfoLinks() {
        assertTrue(extractUrls("javascript:alert(1) file:///sdcard/x content://evil/1 ftp://x").isEmpty())
        assertTrue(extractUrls("https://user:pass@evil.example/").isEmpty())
        assertTrue(extractUrls("https:///nohost").isEmpty())
    }

    @Test
    fun capsLinksAndTextLength() {
        val many = (1..9).joinToString(" ") { "https://s$it.example/" }
        assertEquals(DropLimits.URLS, extractUrls(many).size)
        val plan = accept(share(text = "x".repeat(DropLimits.TEXT_CHARS + 50)))
        assertEquals(DropLimits.TEXT_CHARS, plan.text.length)
        assertTrue(plan.notes.single().contains("cut"))
    }

    @Test
    fun stripsNullCharacters() {
        assertEquals("ab", accept(share(text = "a\u0000b")).text)
    }

    @Test
    fun rejectsEmptyAndWhitespaceShares() {
        assertEquals(SharePlan.Reject("That share was empty."), readShare(share(text = null), pkg))
        assertEquals(SharePlan.Reject("That share was empty."), readShare(share(text = "   \n  "), pkg))
    }

    @Test
    fun ignoresLaunchesThatAreNotShares() {
        assertEquals(SharePlan.NotAShare, readShare(RawShare("android.intent.action.MAIN", null, null, null, null, emptyList()), pkg))
        assertEquals(SharePlan.NotAShare, readShare(RawShare(null, null, "hi", null, null, emptyList()), pkg))
        assertEquals(SharePlan.NotAShare, readShare(share(text = "hi", action = "android.intent.action.VIEW"), pkg))
    }

    @Test
    fun takesASingleImageAsACandidate() {
        val plan = accept(share(type = "image/jpeg", streams = listOf(SharedStream("content://media/external/images/1", "image/jpeg"))))
        assertEquals(1, plan.images.size)
        assertEquals("", plan.text)
    }

    @Test
    fun takesUpToFourImagesFromAMultipleShare() {
        val streams = (1..6).map { SharedStream("content://media/external/images/$it", "image/png") }
        val plan = accept(share(action = ACTION_SEND_MULTIPLE, type = "image/*", streams = streams))
        assertEquals(4, plan.images.size)
        assertEquals("content://media/external/images/1", plan.images.first().uri)
        assertTrue(plan.notes.any { it.contains("first 4") })
    }

    @Test
    fun dropsDuplicateUris() {
        val same = SharedStream("content://media/external/images/1", "image/png")
        assertEquals(1, accept(share(action = ACTION_SEND_MULTIPLE, type = "image/*", streams = listOf(same, same))).images.size)
    }

    @Test
    fun refusesFilePathsAndOtherSchemes() {
        val plan = readShare(
            share(type = "image/jpeg", streams = listOf(SharedStream("file:///sdcard/DCIM/a.jpg", "image/jpeg"), SharedStream("http://x/a.jpg", "image/jpeg"))),
            pkg,
        )
        assertTrue(plan is SharePlan.Reject)
        assertTrue((plan as SharePlan.Reject).message.contains("JPEG, PNG, or WebP"))
    }

    @Test
    fun refusesScoutsOwnProviders() {
        assertFalse(readableUri("content://app.scout.firebaseinitprovider/x", pkg))
        assertFalse(readableUri("content://app.scout/x", pkg))
        assertFalse(readableUri("content://APP.SCOUT.androidx-startup/x", pkg))
        assertFalse(readableUri("content://1@app.scout.provider/x", pkg))
        assertFalse(readableUri("content:///x", pkg))
        assertTrue(readableUri("content://com.google.android.apps.photos.contentprovider/0/1/x", pkg))
        assertTrue(readableUri("content://app.scoutish/x", pkg))
    }

    @Test
    fun skipsNonImageFilesButKeepsTheText() {
        val plan = accept(
            share(
                text = "notes",
                type = "*/*",
                action = ACTION_SEND_MULTIPLE,
                streams = listOf(SharedStream("content://docs/1", "application/pdf"), SharedStream("content://docs/2", "video/mp4"), SharedStream("content://docs/3", "image/webp")),
            ),
        )
        assertEquals(listOf("content://docs/3"), plan.images.map { it.uri })
        assertTrue(plan.notes.any { it.contains("2 other files") })
    }

    @Test
    fun sniffsRealImageBytes() {
        assertEquals("image/jpeg", sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0)))
        assertEquals("image/png", sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)))
        assertEquals("image/webp", sniffImage("RIFF\u0000\u0000\u0000\u0000WEBP".toByteArray(Charsets.ISO_8859_1)))
        assertNull(sniffImage("GIF89a......".toByteArray()))
        assertNull(sniffImage("RIFF\u0000\u0000\u0000\u0000WAVE".toByteArray(Charsets.ISO_8859_1)))
        assertNull(sniffImage(ByteArray(0)))
        assertNull(sniffImage("<svg xmlns=".toByteArray()))
    }

    private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }
}
