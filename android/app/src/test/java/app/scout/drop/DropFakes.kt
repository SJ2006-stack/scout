package app.scout.drop

import java.io.ByteArrayInputStream
import java.io.FileNotFoundException
import java.io.InputStream

val JPEG = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte()) + ByteArray(200) { 7 }
val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) + ByteArray(200) { 3 }
val WEBP = "RIFF\u0000\u0000\u0000\u0000WEBPVP8 ".toByteArray(Charsets.ISO_8859_1) + ByteArray(200) { 1 }

/** A stand-in for ContentResolver. A URI missing from [files] behaves like a revoked grant. */
class FakeSource(
    private val files: Map<String, ByteArray>,
    private val types: Map<String, String?> = emptyMap(),
    private val sizes: Map<String, Long?> = emptyMap(),
    private val missing: Set<String> = emptySet(),
) : StreamSource {
    val opened = mutableListOf<String>()

    override fun type(uri: String): String? {
        guard(uri)
        return types[uri]
    }

    override fun size(uri: String): Long? {
        guard(uri)
        return sizes[uri]
    }

    override fun open(uri: String): InputStream {
        guard(uri)
        if (uri in missing) throw FileNotFoundException(uri)
        opened += uri
        return ByteArrayInputStream(files.getValue(uri))
    }

    private fun guard(uri: String) {
        if (uri !in files && uri !in missing) throw SecurityException("Permission Denial: $uri")
    }
}

/** Ids in the same shape as [DropInbox.newId], counting up so tests are repeatable. */
class Ids {
    private var next = 0
    fun next(): String = "%024x".format(++next)
}
