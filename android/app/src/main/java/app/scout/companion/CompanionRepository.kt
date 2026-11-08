package app.scout.companion

class CompanionRepository(
    private val desk: LocalDesk,
    private val prefs: PreferenceStore,
    private val scheduler: WorkScheduler,
    private val now: () -> Long,
    val metrics: CompanionMetrics = CompanionMetrics(),
) {
    suspend fun openConversations(userId: String): List<CachedConversation> {
        val local = desk.conversations(userId)
        if (local.isEmpty()) metrics.misses += 1 else metrics.hits += 1
        return local
    }

    suspend fun openEvents(userId: String): List<CachedEvent> {
        val local = desk.events(userId)
        if (local.isEmpty()) metrics.misses += 1 else metrics.hits += 1
        return local
    }

    suspend fun refreshConversations(userId: String, remote: List<CachedConversation>): Boolean {
        val fetchedAt = desk.cursor(userId, "conversations")
        if (!needsFetch(fetchedAt, now())) {
            metrics.hits += 1
            return false
        }
        metrics.requests += 1
        val started = now()
        for (row in remote) {
            if (row.userId != userId) continue
            desk.saveConversation(row.copy(payload = redactSecrets(row.payload)))
        }
        desk.setCursor(userId, "conversations", now())
        metrics.latencyMs += now() - started
        metrics.misses += 1
        return true
    }

    suspend fun rememberMessage(userId: String, conversationId: String, text: String, online: Boolean): CachedMessage {
        val row = CachedMessage(userId, conversationId, now(), redactSecrets(text))
        desk.saveMessage(row)
        if (!online) {
            val item = OutboxItem(
                id = "$userId-$conversationId-${row.at}",
                userId = userId,
                kind = SyncKind.History,
                payload = redactSecrets(text),
                attempts = 0,
            )
            desk.saveOutbox(item)
            queue(userId, SyncKind.History)
        }
        return row
    }

    suspend fun flush(userId: String, online: Boolean, deliver: suspend (OutboxItem) -> Boolean): Int {
        if (!online) return 0
        var sent = 0
        for (item in desk.outbox(userId)) {
            val path = syncPath(item.kind)
            if (path.startsWith("/api/browser") || path == "/api/pay") continue
            if (!deliver(item)) continue
            desk.removeOutbox(item.id)
            sent += 1
        }
        if (sent > 0) queue(userId, SyncKind.History)
        return sent
    }

    suspend fun saveBrowserStatus(row: CachedBrowserTask) {
        desk.saveBrowserTask(row)
    }

    suspend fun registerDevice(userId: String, deviceId: String, pushToken: String): DeviceRecord {
        val row = DeviceRecord(userId, deviceId, pushToken, revoked = false)
        val existing = desk.devices(userId).firstOrNull { it.deviceId == deviceId }
        val stored = if (existing?.revoked == true) existing else row
        desk.saveDevice(stored)
        return stored
    }

    suspend fun revokeDevice(userId: String, deviceId: String) {
        val existing = desk.devices(userId).firstOrNull { it.deviceId == deviceId } ?: return
        desk.saveDevice(existing.copy(revoked = true))
    }

    suspend fun device(userId: String, deviceId: String): DeviceRecord? {
        return desk.devices(userId).firstOrNull { it.deviceId == deviceId }
    }

    suspend fun logout(userId: String) {
        desk.clearUser(userId)
        prefs.clear(userId)
    }

    fun queue(userId: String, kind: SyncKind) {
        val job = planSync(userId, syncWire(kind), attempt = 1) ?: return
        if (scheduler.names().contains(job.name)) return
        scheduler.enqueue(job)
    }
}
