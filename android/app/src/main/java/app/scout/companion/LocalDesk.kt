package app.scout.companion

interface LocalDesk {
    suspend fun conversations(userId: String): List<CachedConversation>
    suspend fun saveConversation(row: CachedConversation)
    suspend fun messages(userId: String, conversationId: String): List<CachedMessage>
    suspend fun saveMessage(row: CachedMessage)
    suspend fun events(userId: String): List<CachedEvent>
    suspend fun saveEvent(row: CachedEvent)
    suspend fun groceries(userId: String): List<CachedGrocery>
    suspend fun saveGrocery(row: CachedGrocery)
    suspend fun carts(userId: String): List<CachedCart>
    suspend fun saveCart(row: CachedCart)
    suspend fun tasks(userId: String): List<CachedTask>
    suspend fun saveTask(row: CachedTask)
    suspend fun browserTasks(userId: String): List<CachedBrowserTask>
    suspend fun saveBrowserTask(row: CachedBrowserTask)
    suspend fun outbox(userId: String): List<OutboxItem>
    suspend fun saveOutbox(row: OutboxItem)
    suspend fun removeOutbox(id: String)
    suspend fun cursor(userId: String, resource: String): Long
    suspend fun setCursor(userId: String, resource: String, at: Long)
    suspend fun devices(userId: String): List<DeviceRecord>
    suspend fun saveDevice(row: DeviceRecord)
    suspend fun clearUser(userId: String)
}

interface PreferenceStore {
    suspend fun read(userId: String): ScoutPreferences
    suspend fun write(userId: String, prefs: ScoutPreferences)
    suspend fun clear(userId: String)
}

interface WorkScheduler {
    fun enqueue(job: SyncJob)
    fun names(): Set<String>
}
