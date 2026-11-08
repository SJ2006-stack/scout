package app.scout.drop

import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream

/** Reads shared URIs. Android's ContentResolver in the app, a fake in tests. */
interface StreamSource {
    fun type(uri: String): String?
    fun size(uri: String): Long?
    fun open(uri: String): InputStream
}

data class DroppedImage(val id: String, val mime: String, val bytes: Long, val file: File)

data class ImportOutcome(val images: List<DroppedImage>, val notes: List<String>)

/**
 * Copies shared images into Scout's private cache while the sender's read grant is still valid.
 * The declared type is not trusted: each copy is capped at [DropLimits.IMAGE_BYTES] and kept only
 * if its first bytes are a JPEG, PNG, or WebP.
 */
class DropImporter(private val source: StreamSource, private val newId: () -> String) {
    fun import(images: List<SharedStream>, into: File): ImportOutcome {
        val kept = mutableListOf<DroppedImage>()
        val notes = mutableListOf<String>()
        var tooBig = 0
        var unsupported = 0
        var denied = 0
        var unreadable = 0
        for (stream in images) {
            when (val result = copy(stream, into)) {
                is Copy.Kept -> kept += result.image
                Copy.TooBig -> tooBig += 1
                Copy.Unsupported -> unsupported += 1
                Copy.Denied -> denied += 1
                Copy.Unreadable -> unreadable += 1
            }
        }
        if (tooBig > 0) notes += "${count(tooBig)} over ${DropLimits.IMAGE_BYTES / 1_000_000.0} MB skipped."
        if (unsupported > 0) notes += "${count(unsupported)} not JPEG, PNG, or WebP skipped."
        if (denied > 0) notes += "${count(denied)} skipped: the sharing app did not give Scout permission to read it."
        if (unreadable > 0) notes += "${count(unreadable)} could not be read."
        return ImportOutcome(kept, notes)
    }

    private fun copy(stream: SharedStream, into: File): Copy {
        val id = newId()
        val part = File(into, "$id.part")
        try {
            val resolved = source.type(stream.uri)?.substringBefore(';')?.trim()?.lowercase()
            if (resolved != null && !resolved.startsWith("image/")) return Copy.Unsupported
            val declaredSize = source.size(stream.uri)
            if (declaredSize != null && declaredSize > DropLimits.IMAGE_BYTES) return Copy.TooBig
            into.mkdirs()
            var total = 0L
            val head = ByteArray(12)
            var headLength = 0
            source.open(stream.uri).use { input ->
                part.outputStream().use { output ->
                    val buffer = ByteArray(16 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        if (headLength < head.size) {
                            val take = minOf(head.size - headLength, read)
                            System.arraycopy(buffer, 0, head, headLength, take)
                            headLength += take
                        }
                        total += read
                        if (total > DropLimits.IMAGE_BYTES) return Copy.TooBig
                        output.write(buffer, 0, read)
                    }
                }
            }
            if (total == 0L) return Copy.Unreadable
            val mime = sniffImage(head.copyOf(headLength)) ?: return Copy.Unsupported
            val file = File(into, "$id.${extensionFor(mime)}")
            if (!part.renameTo(file)) return Copy.Unreadable
            return Copy.Kept(DroppedImage(id, mime, total, file))
        } catch (_: SecurityException) {
            return Copy.Denied
        } catch (_: FileNotFoundException) {
            return Copy.Unreadable
        } catch (_: IOException) {
            return Copy.Unreadable
        } catch (_: RuntimeException) {
            return Copy.Unreadable
        } finally {
            part.delete()
        }
    }

    private sealed class Copy {
        data class Kept(val image: DroppedImage) : Copy()
        data object TooBig : Copy()
        data object Unsupported : Copy()
        data object Denied : Copy()
        data object Unreadable : Copy()
    }

    private fun count(n: Int): String = if (n == 1) "1 image" else "$n images"
}
