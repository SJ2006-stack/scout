package app.scout.companion

private val SECRET_FIELD = Regex(
    "\"(otp|password|cookie|cvv|pan|cardNumber)\"\\s*:\\s*\"[^\"\\\\]*\"",
    RegexOption.IGNORE_CASE,
)

fun redactSecrets(json: String): String {
    return SECRET_FIELD.replace(json) { match ->
        "\"${match.groupValues[1]}\":\"\""
    }
}

fun pageMessages(messages: List<CachedMessage>, before: Long?, limit: Int): List<CachedMessage> {
    val cap = limit.coerceIn(1, 50)
    return messages
        .filter { before == null || it.at < before }
        .sortedByDescending { it.at }
        .take(cap)
}

fun needsFetch(fetchedAt: Long, now: Long, ttlMs: Long = 60_000): Boolean {
    if (fetchedAt <= 0L) return true
    return now - fetchedAt >= ttlMs
}
