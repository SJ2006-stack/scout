package app.scout.drop

import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DropImporterTest {
    private val dir = Files.createTempDirectory("drop-import").toFile()
    private val ids = Ids()

    private fun run(source: StreamSource, vararg uris: String) =
        DropImporter(source, ids::next).import(uris.map { SharedStream(it, "image/*") }, dir)

    @Test
    fun copiesASingleImageIntoPrivateStorage() {
        val outcome = run(FakeSource(mapOf("content://g/1" to JPEG), types = mapOf("content://g/1" to "image/jpeg")), "content://g/1")
        val image = outcome.images.single()
        assertEquals("image/jpeg", image.mime)
        assertEquals(JPEG.size.toLong(), image.bytes)
        assertEquals(dir, image.file.parentFile)
        assertTrue(image.file.name.endsWith(".jpg"))
        assertArrayEquals(JPEG, image.file.readBytes())
        assertTrue(outcome.notes.isEmpty())
        assertTrue(dir.listFiles()!!.none { it.name.endsWith(".part") })
    }

    @Test
    fun copiesSeveralImagesAndUsesTheirRealType() {
        val source = FakeSource(mapOf("content://g/1" to PNG, "content://g/2" to WEBP, "content://g/3" to JPEG), types = mapOf("content://g/1" to "image/jpeg"))
        val outcome = run(source, "content://g/1", "content://g/2", "content://g/3")
        assertEquals(listOf("image/png", "image/webp", "image/jpeg"), outcome.images.map { it.mime })
        assertEquals(listOf("png", "webp", "jpg"), outcome.images.map { it.file.extension })
    }

    @Test
    fun skipsFilesThatAreNotJpegPngOrWebp() {
        val gif = "GIF89a".toByteArray() + ByteArray(100)
        val html = "<html><script>".toByteArray()
        val source = FakeSource(
            mapOf("content://g/gif" to gif, "content://g/html" to html, "content://d/pdf" to "%PDF".toByteArray()),
            types = mapOf("content://g/gif" to "image/gif", "content://g/html" to "image/png", "content://d/pdf" to "application/pdf"),
        )
        val outcome = run(source, "content://g/gif", "content://g/html", "content://d/pdf")
        assertTrue(outcome.images.isEmpty())
        assertEquals(listOf("3 images not JPEG, PNG, or WebP skipped."), outcome.notes)
        assertTrue(dir.listFiles().orEmpty().isEmpty())
        assertTrue("content://d/pdf" !in source.opened)
    }

    @Test
    fun refusesOversizedImagesFromTheDeclaredSizeWithoutReading() {
        val source = FakeSource(mapOf("content://g/big" to JPEG), sizes = mapOf("content://g/big" to DropLimits.IMAGE_BYTES + 1))
        val outcome = run(source, "content://g/big")
        assertTrue(outcome.images.isEmpty())
        assertTrue(source.opened.isEmpty())
        assertEquals(listOf("1 image over 4.5 MB skipped."), outcome.notes)
    }

    @Test
    fun stopsCopyingWhenAStreamRunsPastTheCapEvenIfItsSizeWasHidden() {
        val huge = JPEG + ByteArray(DropLimits.IMAGE_BYTES.toInt())
        val outcome = run(FakeSource(mapOf("content://g/huge" to huge)), "content://g/huge")
        assertTrue(outcome.images.isEmpty())
        assertTrue(outcome.notes.single().contains("over 4.5 MB"))
        assertTrue(dir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun acceptsAnImageExactlyAtTheCap() {
        val exact = JPEG + ByteArray(DropLimits.IMAGE_BYTES.toInt() - JPEG.size)
        assertEquals(1, run(FakeSource(mapOf("content://g/x" to exact)), "content://g/x").images.size)
    }

    @Test
    fun reportsAMissingUriPermissionPerImage() {
        val source = FakeSource(mapOf("content://g/ok" to PNG))
        val outcome = run(source, "content://g/ok", "content://g/no-grant")
        assertEquals(1, outcome.images.size)
        assertEquals(listOf("1 image skipped: the sharing app did not give Scout permission to read it."), outcome.notes)
    }

    @Test
    fun reportsMissingAndEmptyFiles() {
        val source = FakeSource(mapOf("content://g/empty" to ByteArray(0)), missing = setOf("content://g/gone"))
        val outcome = run(source, "content://g/gone", "content://g/empty")
        assertTrue(outcome.images.isEmpty())
        assertEquals(listOf("2 images could not be read."), outcome.notes)
    }
}
