package app.scout

import java.net.URI
import java.net.URLDecoder

const val SCOUT_USER = "user0"
const val PAIR_WINDOW_MS = 110_000L

private val CODE = Regex("^[a-f0-9]{32}$")
private val INTEGER = Regex("^-?\\d+$")

data class PairTicket(
    val userId: String,
    val code: String,
    val issuedAt: Long,
    val expiresAt: Long,
)

sealed class PairRead {
    data class Ok(
        val userId: String,
        val code: String,
        val expiresAt: Long,
        val fresh: Boolean,
    ) : PairRead()

    data class Bad(val message: String) : PairRead()
}

fun readPairPayload(text: String, now: Long): PairRead {
    val uri = try {
        URI(text.trim())
    } catch (_: Exception) {
        return PairRead.Bad("That code is not a Scout device code.")
    }
    val path = uri.path ?: ""
    if (!path.endsWith("/pair")) {
        return PairRead.Bad("That code is not a Scout device code.")
    }
    val params = try {
        queryParams(uri.rawQuery)
    } catch (_: Exception) {
        return PairRead.Bad("That code is not a Scout device code.")
    }
    if (params["user"] != SCOUT_USER) {
        return PairRead.Bad("Scout is using user0 on every device.")
    }
    val code = params["code"] ?: ""
    val exp = params["exp"] ?: ""
    if (!CODE.matches(code) || !INTEGER.matches(exp)) {
        return PairRead.Bad("That code is not a Scout device code.")
    }
    val expiresAt = exp.toLong()
    return PairRead.Ok(
        userId = SCOUT_USER,
        code = code,
        expiresAt = expiresAt,
        fresh = expiresAt > now,
    )
}

fun pairScanMessage(read: PairRead): String {
    return when (read) {
        is PairRead.Bad -> read.message
        is PairRead.Ok -> if (read.fresh) {
            "This code is for user0. Sign-in from another device is not connected, so this phone stays user0."
        } else {
            "This code has expired. The other device shows a new one every 110 seconds."
        }
    }
}

private fun queryParams(raw: String?): Map<String, String> {
    if (raw.isNullOrEmpty()) return emptyMap()
    val out = LinkedHashMap<String, String>()
    for (part in raw.split("&")) {
        if (part.isEmpty()) continue
        val eq = part.indexOf("=")
        val key = decode(if (eq < 0) part else part.substring(0, eq))
        val value = decode(if (eq < 0) "" else part.substring(eq + 1))
        if (!out.containsKey(key)) out[key] = value
    }
    return out
}

private fun decode(value: String): String {
    return URLDecoder.decode(value, "UTF-8")
}
