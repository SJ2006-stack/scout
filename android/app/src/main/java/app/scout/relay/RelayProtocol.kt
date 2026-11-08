package app.scout.relay

import java.nio.ByteBuffer

/**
 * Scout's phone relay wire format, mirrored from scout/src/shared/relay.ts.
 * Frame: [kind: 1 byte][stream id: 4 bytes, big-endian][payload].
 */
object RelayKind {
    const val OPEN = 1
    const val OPENED = 2
    const val DATA = 3
    const val CLOSE = 4
    const val FAIL = 5
    const val VAULT = 6
}

class RelayFrame(val kind: Int, val stream: Int, val payload: ByteArray)

const val RELAY_PATH = "/api/relay"
const val MAX_VAULT_BLOB = 1_100_000

private val RELAY_SUFFIXES = listOf(
    "blinkit.com",
    "grofers.com",
    "zepto.com",
    "zeptonow.com",
    "zepto.co.in",
    "swiggy.com",
    "swiggy.in",
    "swiggystatic.com",
    "bookmyshow.com",
    "bmscdn.com",
    "district.in",
    "luma.com",
    "lu.ma",
    "challenges.cloudflare.com",
)

fun relayHost(host: String): Boolean {
    val name = host.lowercase().trimEnd('.')
    return RELAY_SUFFIXES.any { name == it || name.endsWith(".$it") }
}

/** The phone opens only store hosts on 443, so it passes TLS bytes it cannot read. */
fun relayTarget(value: String): Pair<String, Int>? {
    val match = Regex("^([a-z0-9.-]{1,253}):(\\d{1,5})$", RegexOption.IGNORE_CASE).matchEntire(value.trim()) ?: return null
    val host = match.groupValues[1].lowercase()
    val port = match.groupValues[2].toIntOrNull() ?: return null
    if (port != 443 || !relayHost(host)) return null
    return host to port
}

fun encodeFrame(kind: Int, stream: Int, payload: ByteArray = ByteArray(0)): ByteArray {
    val buffer = ByteBuffer.allocate(5 + payload.size)
    buffer.put(kind.toByte())
    buffer.putInt(stream)
    buffer.put(payload)
    return buffer.array()
}

fun decodeFrame(bytes: ByteArray): RelayFrame? {
    if (bytes.size < 5) return null
    val kind = bytes[0].toInt() and 0xff
    if (kind !in RelayKind.OPEN..RelayKind.VAULT) return null
    val stream = ByteBuffer.wrap(bytes, 1, 4).int
    return RelayFrame(kind, stream, bytes.copyOfRange(5, bytes.size))
}

/** A site sign-in sealed by the server. The phone keeps it but cannot open it. */
class SealedCopy(
    val domain: String,
    val updatedAt: Long,
    val expiresAt: Long,
    val lastValidatedAt: Long,
    val blob: ByteArray,
)

sealed class VaultMessage {
    class Put(val copy: SealedCopy) : VaultMessage()
    class Offer(val copy: SealedCopy) : VaultMessage()
    class Drop(val domain: String, val at: Long) : VaultMessage()
}

private val DOMAIN = Regex("^[a-z0-9-]+(?:\\.[a-z0-9-]+)+$")

fun validDomain(domain: String): Boolean = DOMAIN.matches(domain)

/** Payload: [header length: 4 bytes, big-endian][header JSON][blob]. */
fun encodeVault(message: VaultMessage): ByteArray {
    val (header, blob) = when (message) {
        is VaultMessage.Put -> copyHeader("put", message.copy) to message.copy.blob
        is VaultMessage.Offer -> copyHeader("offer", message.copy) to message.copy.blob
        is VaultMessage.Drop -> "{\"op\":\"drop\",\"domain\":\"${message.domain}\",\"at\":${message.at}}" to ByteArray(0)
    }
    val head = header.toByteArray(Charsets.UTF_8)
    val payload = ByteBuffer.allocate(4 + head.size + blob.size)
    payload.putInt(head.size)
    payload.put(head)
    payload.put(blob)
    return encodeFrame(RelayKind.VAULT, 0, payload.array())
}

fun decodeVault(payload: ByteArray): VaultMessage? {
    if (payload.size < 4) return null
    val size = ByteBuffer.wrap(payload, 0, 4).int
    if (size < 0 || size > 4_096 || 4 + size > payload.size) return null
    val fields = flatJson(String(payload, 4, size, Charsets.UTF_8)) ?: return null
    val domain = fields["domain"] ?: return null
    if (!validDomain(domain)) return null
    val blob = payload.copyOfRange(4 + size, payload.size)
    return when (fields["op"]) {
        "drop" -> fields["at"]?.toLongOrNull()?.let { VaultMessage.Drop(domain, it) }
        "put", "offer" -> {
            val updatedAt = fields["updatedAt"]?.toLongOrNull() ?: return null
            val expiresAt = fields["expiresAt"]?.toLongOrNull() ?: return null
            val validatedAt = fields["lastValidatedAt"]?.toLongOrNull() ?: return null
            if (blob.isEmpty() || blob.size > MAX_VAULT_BLOB) return null
            val copy = SealedCopy(domain, updatedAt, expiresAt, validatedAt, blob)
            if (fields["op"] == "put") VaultMessage.Put(copy) else VaultMessage.Offer(copy)
        }
        else -> null
    }
}

private fun copyHeader(op: String, copy: SealedCopy): String =
    "{\"op\":\"$op\",\"domain\":\"${copy.domain}\",\"updatedAt\":${copy.updatedAt},\"expiresAt\":${copy.expiresAt},\"lastValidatedAt\":${copy.lastValidatedAt}}"

/** Reads a flat object of string and integer fields, which is all the vault header holds. */
private fun flatJson(text: String): Map<String, String>? {
    val body = text.trim()
    if (!body.startsWith("{") || !body.endsWith("}")) return null
    val fields = mutableMapOf<String, String>()
    for (match in Regex("\"([A-Za-z]+)\"\\s*:\\s*(?:\"([^\"\\\\]*)\"|(-?\\d+))").findAll(body)) {
        fields[match.groupValues[1]] = match.groupValues[2].ifEmpty { match.groupValues[3] }
    }
    return fields
}
