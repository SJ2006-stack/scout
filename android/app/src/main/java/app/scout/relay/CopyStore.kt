package app.scout.relay

import java.io.File

/**
 * The phone's copies of Scout's sealed site sign-ins, one file per site. The
 * server's seal already makes them unreadable here; seal and unseal add the
 * phone's own key (Android Keystore) so the files are also bound to this device.
 */
class CopyStore(
    private val dir: File,
    private val seal: (ByteArray) -> ByteArray,
    private val unseal: (ByteArray) -> ByteArray?,
    private val now: () -> Long = System::currentTimeMillis,
) {
    @Synchronized
    fun list(): List<SealedCopy> {
        val files = dir.listFiles { file -> file.name.endsWith(".seal") } ?: return emptyList()
        return files.mapNotNull { read(it) }.filter { it.expiresAt > now() }
    }

    /** Keeps the copy unless the one already held is as new or newer. */
    @Synchronized
    fun put(copy: SealedCopy) {
        if (!validDomain(copy.domain)) return
        val held = read(file(copy.domain))
        if (held != null && held.updatedAt >= copy.updatedAt) return
        dir.mkdirs()
        val tmp = File(dir, "${copy.domain}.tmp")
        tmp.writeBytes(seal(encodeVault(VaultMessage.Put(copy))))
        if (!tmp.renameTo(file(copy.domain))) tmp.delete()
    }

    /** Removes the copy if it is not newer than the revoke. */
    @Synchronized
    fun drop(domain: String, at: Long) {
        if (!validDomain(domain)) return
        val held = read(file(domain)) ?: return
        if (held.updatedAt <= at) file(domain).delete()
    }

    private fun file(domain: String) = File(dir, "$domain.seal")

    private fun read(file: File): SealedCopy? {
        if (!file.exists()) return null
        val bytes = try {
            unseal(file.readBytes())
        } catch (_: Exception) {
            null
        } ?: return null
        val frame = decodeFrame(bytes) ?: return null
        if (frame.kind != RelayKind.VAULT) return null
        return when (val message = decodeVault(frame.payload)) {
            is VaultMessage.Put -> message.copy
            is VaultMessage.Offer -> message.copy
            is VaultMessage.Drop, null -> null
        }
    }
}
