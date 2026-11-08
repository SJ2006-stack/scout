package app.scout.drop

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import java.io.FileNotFoundException
import java.io.InputStream

/** Reads a share intent into plain values. Any malformed extra is treated as missing. */
fun rawShare(intent: Intent?): RawShare {
    if (intent == null) return RawShare(null, null, null, null, null, emptyList())
    val action = intent.action
    return try {
        val uris = when (action) {
            ACTION_SEND -> listOfNotNull(parcelable(intent))
            ACTION_SEND_MULTIPLE -> parcelables(intent)
            else -> emptyList()
        }
        val clipTypes = intent.clipData?.description
        RawShare(
            action = action,
            type = intent.type,
            text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT),
            subject = intent.getStringExtra(Intent.EXTRA_SUBJECT),
            title = intent.getStringExtra(Intent.EXTRA_TITLE),
            streams = uris.take(DropLimits.IMAGES * 4).map { uri ->
                SharedStream(uri.toString(), clipTypes?.takeIf { it.mimeTypeCount == 1 }?.getMimeType(0) ?: intent.type)
            },
        )
    } catch (_: RuntimeException) {
        RawShare(action, intent.type, null, null, null, emptyList())
    }
}

private fun parcelable(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else @Suppress("DEPRECATION") (intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri)

private fun parcelables(intent: Intent): List<Uri> =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
    else @Suppress("DEPRECATION") intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty().filterIsInstance<Uri>()

/** The app's ContentResolver as a [StreamSource]. */
class ResolverSource(private val resolver: ContentResolver) : StreamSource {
    override fun type(uri: String): String? = resolver.getType(Uri.parse(uri))

    override fun size(uri: String): Long? =
        resolver.query(Uri.parse(uri), arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            val column = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (column >= 0 && cursor.moveToFirst() && !cursor.isNull(column)) cursor.getLong(column) else null
        }

    override fun open(uri: String): InputStream =
        resolver.openInputStream(Uri.parse(uri)) ?: throw FileNotFoundException("no stream")
}
