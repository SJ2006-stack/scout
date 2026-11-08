package app.scout.drop

import java.io.File
import java.security.SecureRandom
import org.json.JSONArray
import org.json.JSONObject

/** A share waiting for its owner to review it. [owner] is a Firebase uid, or null until someone signs in. */
data class Drop(
    val id: String,
    val owner: String?,
    val at: Long,
    val text: String,
    val subject: String?,
    val urls: List<String>,
    val images: List<DroppedImage>,
    val notes: List<String>,
)

/**
 * Holds at most one pending share in [root] (app cache). A newer share replaces the older one.
 * Content is only handed to the account that owns it, is dropped on sign-out or when another
 * account signs in, and expires after [DropLimits.TTL_MS]. A small manifest lets a share
 * survive the Activity being recreated or the process being killed before it is reviewed.
 */
class DropInbox(private val root: File, private val now: () -> Long) {
    private var pending: Drop? = null
    private var restored = false

    /** A fresh folder for the files of the next share. */
    @Synchronized
    fun stage(id: String): File {
        restore()
        return File(root, id).also { it.mkdirs() }
    }

    /** Makes [drop] the pending share and deletes anything older. */
    @Synchronized
    fun put(drop: Drop) {
        restore()
        pending = drop
        writeManifest(drop)
        sweep(keep = drop.id)
    }

    /** Called when [uid] is signed in: an unowned share becomes theirs, another account's share is deleted. */
    @Synchronized
    fun claim(uid: String) {
        val drop = live() ?: return
        when (drop.owner) {
            null -> put(drop.copy(owner = uid))
            uid -> Unit
            else -> discard()
        }
    }

    /** The pending share if [uid] owns it. Repeats until [done], so a reload does not lose it. */
    @Synchronized
    fun take(uid: String?): Drop? {
        val drop = live() ?: return null
        return if (uid != null && drop.owner == uid) drop else null
    }

    @Synchronized
    fun image(uid: String?, dropId: String, imageId: String): DroppedImage? =
        take(uid)?.takeIf { it.id == dropId }?.images?.firstOrNull { it.id == imageId && it.file.isFile }

    /** Deletes the share once its owner sent or dismissed it. */
    @Synchronized
    fun done(uid: String?, dropId: String): Boolean {
        val drop = take(uid) ?: return false
        if (drop.id != dropId) return false
        discard()
        return true
    }

    /** Deletes every pending share and file (sign-out). */
    @Synchronized
    fun discard() {
        restored = true
        pending = null
        root.deleteRecursively()
    }

    private fun live(): Drop? {
        restore()
        val drop = pending ?: return null
        val age = now() - drop.at
        if (age > DropLimits.TTL_MS || age < 0 || drop.images.any { !it.file.isFile }) {
            discard()
            return null
        }
        return drop
    }

    private fun restore() {
        if (restored) return
        restored = true
        pending = root.listFiles()
            .orEmpty()
            .filter { it.isDirectory }
            .mapNotNull { readManifest(it) }
            .maxByOrNull { it.at }
        sweep(keep = pending?.id)
    }

    private fun sweep(keep: String?) {
        for (child in root.listFiles().orEmpty()) {
            if (child.name != keep) child.deleteRecursively()
        }
        if (keep != null) {
            File(root, keep).listFiles().orEmpty()
                .filter { it.name.endsWith(".part") }
                .forEach { it.delete() }
        }
    }

    private fun writeManifest(drop: Drop) {
        val folder = File(root, drop.id).also { it.mkdirs() }
        val temp = File(folder, "$MANIFEST.tmp")
        temp.writeText(dropManifest(drop).toString())
        temp.renameTo(File(folder, MANIFEST))
    }

    private fun readManifest(folder: File): Drop? = try {
        readDropManifest(JSONObject(File(folder, MANIFEST).readText()), folder)
    } catch (_: Exception) {
        null
    }

    companion object {
        const val MANIFEST = "drop.json"
        private val random = SecureRandom()

        fun newId(): String {
            val bytes = ByteArray(12)
            random.nextBytes(bytes)
            return bytes.joinToString("") { "%02x".format(it) }
        }
    }
}

fun dropManifest(drop: Drop): JSONObject = JSONObject()
    .put("id", drop.id)
    .put("owner", drop.owner ?: JSONObject.NULL)
    .put("at", drop.at)
    .put("text", drop.text)
    .put("subject", drop.subject ?: JSONObject.NULL)
    .put("urls", JSONArray(drop.urls))
    .put("notes", JSONArray(drop.notes))
    .put(
        "images",
        JSONArray(drop.images.map { JSONObject().put("id", it.id).put("mime", it.mime).put("bytes", it.bytes).put("file", it.file.name) }),
    )

fun readDropManifest(json: JSONObject, folder: File): Drop? {
    val id = json.optString("id")
    if (id != folder.name || !DROP_ID.matches(id)) return null
    val images = json.optJSONArray("images") ?: JSONArray()
    return Drop(
        id = id,
        owner = json.optString("owner").takeIf { !json.isNull("owner") && it.isNotEmpty() },
        at = json.optLong("at"),
        text = json.optString("text"),
        subject = json.optString("subject").takeIf { !json.isNull("subject") && it.isNotEmpty() },
        urls = strings(json.optJSONArray("urls")),
        notes = strings(json.optJSONArray("notes")),
        images = (0 until images.length()).mapNotNull { index ->
            val item = images.optJSONObject(index) ?: return@mapNotNull null
            val imageId = item.optString("id")
            val name = item.optString("file")
            val mime = item.optString("mime")
            if (!DROP_ID.matches(imageId) || mime !in DROP_IMAGE_TYPES || name != "$imageId.${extensionFor(mime)}") return@mapNotNull null
            DroppedImage(imageId, mime, item.optLong("bytes"), File(folder, name))
        },
    )
}

/** What the page gets from `drop_take`: no file paths, only ids it can ask for. */
fun dropForPage(drop: Drop): JSONObject = JSONObject()
    .put("id", drop.id)
    .put("text", drop.text)
    .put("subject", drop.subject ?: JSONObject.NULL)
    .put("urls", JSONArray(drop.urls))
    .put("notes", JSONArray(drop.notes))
    .put("images", JSONArray(drop.images.map { JSONObject().put("id", it.id).put("mime", it.mime).put("bytes", it.bytes) }))

val DROP_ID = Regex("^[a-f0-9]{24}$")

private fun strings(array: JSONArray?): List<String> =
    if (array == null) emptyList() else (0 until array.length()).mapNotNull { array.optString(it).takeIf { s -> s.isNotEmpty() } }
