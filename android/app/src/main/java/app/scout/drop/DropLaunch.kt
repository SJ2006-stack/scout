package app.scout.drop

import java.security.MessageDigest

/** A stable fingerprint of a share, saved with the Activity so a recreated Activity does not import it twice. */
fun shareKey(raw: RawShare): String {
    val parts = listOf(raw.action.orEmpty(), raw.type.orEmpty(), raw.text?.toString().orEmpty(), raw.subject.orEmpty(), raw.title.orEmpty()) +
        raw.streams.map { "${it.uri}|${it.type.orEmpty()}" }
    val digest = MessageDigest.getInstance("SHA-256").digest(parts.joinToString("\u0001").toByteArray())
    return digest.take(16).joinToString("") { "%02x".format(it) }
}

/**
 * Whether to import the intent. `onNewIntent` passes no saved key and always imports a share.
 * `onCreate` passes the key saved before recreation, so rotating or returning to a killed
 * Activity, which redelivers the same intent, does not import it again.
 */
fun shouldImport(raw: RawShare, savedKey: String?): Boolean = isShareAction(raw.action) && shareKey(raw) != savedKey
