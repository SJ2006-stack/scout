package app.scout.screen

import java.io.File
import java.security.SecureRandom
import org.json.JSONObject

data class ScreenShot(val id: String, val owner: String, val at: Long, val width: Int, val height: Int, val bytes: Int, val file: File) {
    val mime: String get() = "image/jpeg"
}

/**
 * Holds at most one captured frame in [root] (app cache) until its owner sends or discards it.
 * Nothing here survives the process: whatever is on disk when this is created is a leftover and
 * is deleted. A frame is only handed to the account that captured it and expires after [TTL_MS].
 */
class ScreenShots(private val root: File, private val now: () -> Long) {
    private var pending: ScreenShot? = null

    init {
        root.deleteRecursively()
    }

    /** Saves [jpeg] as the pending frame, replacing any older one. Null when it is empty or too large. */
    @Synchronized
    fun put(owner: String, id: String, jpeg: ByteArray, width: Int, height: Int): ScreenShot? {
        if (!SHOT_ID.matches(id) || jpeg.isEmpty() || jpeg.size > MAX_BYTES) return null
        discard()
        root.mkdirs()
        val part = File(root, "$id.part")
        part.writeBytes(jpeg)
        val file = File(root, "$id.jpg")
        if (!part.renameTo(file)) {
            part.delete()
            return null
        }
        return ScreenShot(id, owner, now(), width, height, jpeg.size, file).also { pending = it }
    }

    @Synchronized
    fun take(uid: String?): ScreenShot? {
        val shot = pending ?: return null
        val age = now() - shot.at
        if (age > TTL_MS || age < 0 || !shot.file.isFile) {
            discard()
            return null
        }
        return if (uid != null && shot.owner == uid) shot else null
    }

    @Synchronized
    fun bytes(uid: String?, id: String): ByteArray? = take(uid)?.takeIf { it.id == id }?.file?.readBytes()

    /** Deletes the frame once its owner sent or discarded it. */
    @Synchronized
    fun done(uid: String?, id: String): Boolean {
        val shot = take(uid) ?: return false
        if (shot.id != id) return false
        discard()
        return true
    }

    /** Another account signed in: their frame is not shown to this one. */
    @Synchronized
    fun claim(uid: String) {
        val shot = pending ?: return
        if (shot.owner != uid) discard()
    }

    @Synchronized
    fun discard() {
        pending = null
        root.deleteRecursively()
    }

    companion object {
        const val TTL_MS = 10 * 60_000L
        const val MAX_BYTES = 4_500_000
        private val random = SecureRandom()

        fun newId(): String {
            val bytes = ByteArray(12)
            random.nextBytes(bytes)
            return bytes.joinToString("") { "%02x".format(it) }
        }
    }
}

/** What the page gets for a pending frame: no path, only the id it can ask for. */
fun shotForPage(shot: ScreenShot): JSONObject = JSONObject()
    .put("id", shot.id)
    .put("mime", shot.mime)
    .put("bytes", shot.bytes)
    .put("width", shot.width)
    .put("height", shot.height)

fun screenStateJson(state: String, last: ScreenNotice?, session: String?, shot: JSONObject?): String {
    val payload = JSONObject().put("accepted", true).put("state", state)
    if (session != null) payload.put("session", session)
    if (last != null) {
        payload.put("last", last.state)
        if (last.reason != null) payload.put("reason", last.reason)
        if (last.message != null) payload.put("message", last.message)
    }
    payload.put("shot", shot ?: JSONObject.NULL)
    return payload.toString()
}

val SCREEN_REFUSED = """{"accepted":false}"""

val SHOT_ID = Regex("^[a-f0-9]{24}$")
