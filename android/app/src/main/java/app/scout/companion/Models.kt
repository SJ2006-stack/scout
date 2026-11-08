package app.scout.companion

data class CachedConversation(
    val userId: String,
    val id: String,
    val title: String,
    val agent: String,
    val updatedAt: Long,
    val payload: String,
)

data class CachedMessage(
    val userId: String,
    val conversationId: String,
    val at: Long,
    val text: String,
)

data class CachedEvent(
    val userId: String,
    val id: String,
    val title: String,
    val updatedAt: Long,
)

data class CachedGrocery(
    val userId: String,
    val id: String,
    val query: String,
    val updatedAt: Long,
)

data class CachedCart(
    val userId: String,
    val id: String,
    val payload: String,
    val updatedAt: Long,
)

data class CachedTask(
    val userId: String,
    val id: String,
    val title: String,
    val status: String,
    val updatedAt: Long,
)

data class CachedBrowserTask(
    val userId: String,
    val id: String,
    val status: String,
    val updatedAt: Long,
)

data class OutboxItem(
    val id: String,
    val userId: String,
    val kind: SyncKind,
    val payload: String,
    val attempts: Int,
)

data class DeviceRecord(
    val userId: String,
    val deviceId: String,
    val pushToken: String,
    val revoked: Boolean,
)

data class ScoutPreferences(
    val city: String = "",
    val language: String = "",
    val groceryPlatforms: List<String> = emptyList(),
    val notifications: Boolean = false,
    val lastScout: String = "",
)

enum class SyncKind {
    Analytics,
    History,
    Preferences,
    Media,
}

fun syncKind(wire: String?): SyncKind? {
    return when (wire) {
        "analytics" -> SyncKind.Analytics
        "history" -> SyncKind.History
        "preferences" -> SyncKind.Preferences
        "media" -> SyncKind.Media
        else -> null
    }
}

fun syncWire(kind: SyncKind): String {
    return when (kind) {
        SyncKind.Analytics -> "analytics"
        SyncKind.History -> "history"
        SyncKind.Preferences -> "preferences"
        SyncKind.Media -> "media"
    }
}

fun syncWorkName(userId: String, kind: SyncKind): String = "scout-sync-$userId-${syncWire(kind)}"

fun syncPath(kind: SyncKind): String {
    return when (kind) {
        SyncKind.History -> "/api/desk"
        SyncKind.Media -> "/api/desk"
        SyncKind.Preferences -> "/api/devices"
        SyncKind.Analytics -> "/api/devices"
    }
}

data class SyncJob(
    val userId: String,
    val name: String,
    val kind: SyncKind,
    val requiresNetwork: Boolean,
    val backoffSeconds: Long,
)

fun planSync(userId: String, wire: String, attempt: Int): SyncJob? {
    val kind = syncKind(wire) ?: return null
    val shift = (attempt - 1).coerceIn(0, 6)
    val backoff = (30L shl shift).coerceAtMost(3_600L)
    return SyncJob(userId, syncWorkName(userId, kind), kind, requiresNetwork = true, backoffSeconds = backoff)
}

fun jpegQuality(byteSize: Int): Int {
    if (byteSize <= 1_500_000) return 90
    return 60
}

data class CompanionMetrics(
    var requests: Int = 0,
    var latencyMs: Long = 0,
    var hits: Int = 0,
    var misses: Int = 0,
) {
    val hitRatio: Double
        get() {
            val total = hits + misses
            if (total == 0) return 0.0
            return hits.toDouble() / total.toDouble()
        }
}
