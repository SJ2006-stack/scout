package app.scout.companion

data class LiveEvent(val id: String, val type: String)

sealed class LiveEffect {
    data object Notify : LiveEffect()
}

private val LIVE_TYPES = setOf(
    "browser-progress",
    "search-done",
    "auth-request",
    "session-expired",
    "checkout-review",
    "payment-handoff",
    "booking-status",
)

class RealtimeFeed {
    private val seen = LinkedHashSet<String>()
    private var lastId: String? = null

    fun accept(id: String, type: String): LiveEvent? {
        if (id.isBlank() || type !in LIVE_TYPES) return null
        if (!seen.add(id)) return null
        if (seen.size > 200) seen.remove(seen.first())
        lastId = id
        return LiveEvent(id, type)
    }

    fun effect(event: LiveEvent): LiveEffect = LiveEffect.Notify

    fun runsLocally(event: LiveEvent): Boolean = false

    fun reconnectHeaders(): Map<String, String> {
        val id = lastId ?: return emptyMap()
        return mapOf("Last-Event-ID" to id)
    }
}

fun readPush(data: Map<String, String>): LiveEvent? {
    val id = data["id"] ?: return null
    val type = data["type"] ?: return null
    if (type !in LIVE_TYPES && type != "browser-completed") return null
    if (type == "browser-completed") return LiveEvent(id, "browser-progress")
    return LiveEvent(id, type)
}
