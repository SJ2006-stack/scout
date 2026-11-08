package app.scout.drop

/** What MainActivity read off a share intent, as plain values so it can be checked without Android. */
data class RawShare(
    val action: String?,
    val type: String?,
    val text: CharSequence?,
    val subject: String?,
    val title: String?,
    val streams: List<SharedStream>,
)

/** One shared file: its URI string and the MIME type the sender declared, which is not trusted. */
data class SharedStream(val uri: String, val type: String?)

object DropLimits {
    const val TEXT_CHARS = 20_000
    const val SUBJECT_CHARS = 300
    const val IMAGES = 4
    /** Same cap as Scout's `/api/ocr` (`OCR_BYTES`), so every kept image can be read. */
    const val IMAGE_BYTES = 4_500_000L
    const val URLS = 5
    const val URL_CHARS = 2_048
    const val TTL_MS = 30 * 60 * 1000L
}

const val ACTION_SEND = "android.intent.action.SEND"
const val ACTION_SEND_MULTIPLE = "android.intent.action.SEND_MULTIPLE"

val DROP_IMAGE_TYPES = setOf("image/jpeg", "image/png", "image/webp")

sealed class SharePlan {
    data class Accept(
        val text: String,
        val subject: String?,
        val urls: List<String>,
        val images: List<SharedStream>,
        val notes: List<String>,
    ) : SharePlan()

    data class Reject(val message: String) : SharePlan()

    /** Not a share at all (a launcher tap, a notification). */
    data object NotAShare : SharePlan()
}

fun isShareAction(action: String?): Boolean = action == ACTION_SEND || action == ACTION_SEND_MULTIPLE

/**
 * Decides what to import from a share. Nothing here reads a file: images are only candidates,
 * and the importer checks their real type and size while copying.
 */
fun readShare(raw: RawShare, ownPackage: String): SharePlan {
    if (!isShareAction(raw.action)) return SharePlan.NotAShare
    val notes = mutableListOf<String>()
    var text = cleanText(raw.text?.toString())
    if (text.length > DropLimits.TEXT_CHARS) {
        text = text.take(DropLimits.TEXT_CHARS).trimEnd()
        notes += "The shared text was cut to ${"%,d".format(DropLimits.TEXT_CHARS)} characters."
    }
    val subject = cleanText(raw.subject ?: raw.title)
        .replace(Regex("\\s+"), " ")
        .take(DropLimits.SUBJECT_CHARS)
        .takeIf { it.isNotEmpty() && it != text && !text.startsWith(it) }
    var refused = 0
    var unsupported = 0
    val images = mutableListOf<SharedStream>()
    for (stream in raw.streams.distinctBy { it.uri }) {
        if (!readableUri(stream.uri, ownPackage)) {
            refused += 1
            continue
        }
        val declared = mimeOf(stream.type) ?: mimeOf(raw.type)
        if (declared != null && !declared.startsWith("image/") && declared != "*/*") {
            unsupported += 1
            continue
        }
        images += stream
    }
    if (images.size > DropLimits.IMAGES) {
        notes += "Only the first ${DropLimits.IMAGES} images were kept."
    }
    if (refused > 0) notes += "Scout skipped ${plural(refused, "file")} it is not allowed to open."
    if (unsupported > 0) notes += "Scout takes JPEG, PNG, and WebP images. ${plural(unsupported, "other file")} skipped."
    if (text.isEmpty() && subject == null && images.isEmpty()) {
        return SharePlan.Reject(
            if (refused + unsupported > 0) "Scout takes text, links, and JPEG, PNG, or WebP images only."
            else "That share was empty.",
        )
    }
    return SharePlan.Accept(text, subject, extractUrls(listOfNotNull(subject, text).joinToString("\n")), images.take(DropLimits.IMAGES), notes)
}

private val URL = Regex("""https?://[^\s<>"'`]+""", RegexOption.IGNORE_CASE)
private const val TRAILING = ".,;:!?'\"”’)]}>"

/** Web links in shared text, kept exactly as written apart from trailing punctuation. Never opened by Scout. */
fun extractUrls(text: String): List<String> {
    val found = LinkedHashSet<String>()
    for (match in URL.findAll(text)) {
        var url = match.value
        while (url.isNotEmpty() && url.last() in TRAILING) {
            if (url.last() == ')' && url.count { it == '(' } >= url.count { it == ')' }) break
            url = url.dropLast(1)
        }
        val host = url.substringAfter("://").substringBefore('/').substringBefore('?').substringBefore('#')
        if (host.isEmpty() || host.contains('@') || url.length > DropLimits.URL_CHARS) continue
        found += url
        if (found.size == DropLimits.URLS) break
    }
    return found.toList()
}

/**
 * Only `content://` URIs from another app. `file://` paths and Scout's own providers are refused,
 * so a share cannot make Scout read its own private files.
 */
fun readableUri(uri: String, ownPackage: String): Boolean {
    if (!uri.startsWith("content://")) return false
    val authority = uri.removePrefix("content://").substringBefore('/').substringAfterLast('@').lowercase()
    if (authority.isEmpty()) return false
    val own = ownPackage.lowercase()
    return authority != own && !authority.startsWith("$own.")
}

/** The real image type from the first bytes. Null for anything but JPEG, PNG, or WebP. */
fun sniffImage(head: ByteArray): String? {
    fun at(index: Int) = if (index < head.size) head[index].toInt() and 0xff else -1
    if (at(0) == 0xff && at(1) == 0xd8 && at(2) == 0xff) return "image/jpeg"
    val png = intArrayOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    if (png.indices.all { at(it) == png[it] }) return "image/png"
    val riff = "RIFF".map { it.code }
    val webp = "WEBP".map { it.code }
    if (riff.indices.all { at(it) == riff[it] } && webp.indices.all { at(8 + it) == webp[it] }) return "image/webp"
    return null
}

fun extensionFor(mime: String): String = when (mime) {
    "image/png" -> "png"
    "image/webp" -> "webp"
    else -> "jpg"
}

private fun mimeOf(type: String?): String? = type?.substringBefore(';')?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }

private fun cleanText(value: String?): String = value.orEmpty().replace("\u0000", "").trim()

private fun plural(count: Int, noun: String): String = if (count == 1) "1 $noun" else "$count ${noun}s"
