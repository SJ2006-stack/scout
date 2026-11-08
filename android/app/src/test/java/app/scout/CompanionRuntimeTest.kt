package app.scout

import app.scout.companion.CachedBrowserTask
import app.scout.companion.CachedConversation
import app.scout.companion.CachedEvent
import app.scout.companion.CachedMessage
import app.scout.companion.CompanionMetrics
import app.scout.companion.CompanionRepository
import app.scout.companion.DeviceRecord
import app.scout.companion.LiveEffect
import app.scout.companion.LocalDesk
import app.scout.companion.OtpHandoff
import app.scout.companion.OutboxItem
import app.scout.companion.PreferenceStore
import app.scout.companion.RealtimeFeed
import app.scout.companion.ScoutPreferences
import app.scout.companion.SyncJob
import app.scout.companion.SyncKind
import app.scout.companion.WorkScheduler
import app.scout.companion.allowBridge
import app.scout.companion.BridgeDecision
import app.scout.companion.jpegQuality
import app.scout.companion.needsFetch
import app.scout.companion.pageMessages
import app.scout.companion.planRequest
import app.scout.companion.planSync
import app.scout.companion.readPush
import app.scout.companion.SpeechResult
import app.scout.companion.redactSecrets
import app.scout.companion.speechMessage
import app.scout.companion.speechUrl
import app.scout.data.ScoutMigrations
import app.scout.data.deliverable
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanionRuntimeTest {
    @Test
    fun opensConversationsFromTheLocalDeskWithoutARequest() = runBlocking {
        val desk = MemoryDesk()
        val repo = repo(desk)
        desk.saveConversation(chat("user-a", "c1", "Evening plans"))
        val rows = repo.openConversations("user-a")
        assertEquals("Evening plans", rows.single().title)
        assertEquals(0, repo.metrics.requests)
        assertEquals(1, repo.metrics.hits)
    }

    @Test
    fun readsEventResultsFromCache() = runBlocking {
        val desk = MemoryDesk()
        val repo = repo(desk)
        desk.saveEvent(CachedEvent("user-a", "e1", "Concert", 10))
        assertEquals("Concert", repo.openEvents("user-a").single().title)
        assertEquals(0, repo.metrics.requests)
    }

    @Test
    fun skipsASecondFetchWhileTheCacheIsFresh() = runBlocking {
        val desk = MemoryDesk()
        val repo = repo(desk)
        val remote = listOf(chat("user-a", "c1", "One"))
        assertTrue(repo.refreshConversations("user-a", remote))
        assertFalse(repo.refreshConversations("user-a", remote))
        assertEquals(1, repo.metrics.requests)
        assertFalse(needsFetch(60_000, 60_000))
    }

    @Test
    fun keepsAnOfflineMessageOnTheDevice() = runBlocking {
        val desk = MemoryDesk()
        val repo = repo(desk)
        repo.rememberMessage("user-a", "c1", "hold this", online = false)
        assertEquals("hold this", desk.messages("user-a", "c1").single().text)
        assertEquals(1, desk.outbox("user-a").size)
    }

    @Test
    fun sendsQueuedHistoryOnceTheNetworkReturns() = runBlocking {
        val desk = MemoryDesk()
        val jobs = MemoryJobs()
        val repo = repo(desk, jobs)
        repo.rememberMessage("user-a", "c1", "send later", online = false)
        val sent = repo.flush("user-a", online = true) { true }
        assertEquals(1, sent)
        assertTrue(desk.outbox("user-a").isEmpty())
        assertEquals(1, jobs.names().size)
        assertEquals(0, repo.flush("user-a", online = false) { true })
    }

    @Test
    fun handsABoundCodeOnceAndLeavesItOutOfTheLog() {
        var clock = 1_000L
        val otp = OtpHandoff({ clock })
        val user = "firebase-user"
        val task = "a".repeat(32)
        val token = "b".repeat(32)
        assertTrue(otp.begin(user, task, token))
        val submit = otp.offerMessage(user, "Scout code 918273")
        assertEquals("/api/browser/tasks/$task/code", submit?.path)
        assertTrue(submit?.body?.contains("918273") == true)
        assertFalse(submit?.log?.contains("918273") == true)
        assertFalse(otp.toString().contains("918273"))
        assertNull(otp.offerCode("other-user", "918273"))
        assertTrue(otp.consume(user, task))
        assertFalse(otp.holdingCode())
        assertNull(otp.offerMessage(user, "Scout code 918273"))
        assertTrue(otp.begin(user, task, token))
        clock += 130_000
        assertNull(otp.offerCode(user, "918273"))
    }

    @Test
    fun keepsBrowserWorkOnTheServer() = runBlocking {
        val desk = MemoryDesk()
        val repo = repo(desk)
        repo.saveBrowserStatus(CachedBrowserTask("user-a", "t1", "open", 5))
        val stored = desk.browserTasks("user-a").single()
        assertEquals("open", stored.status)
        val device = DeviceRecord("user-a", "phone", "push", revoked = false)
        val blocked = planRequest("user-a", "token", device, "POST", "/api/browser/sessions", "{}", background = true)
        assertTrue(blocked is app.scout.companion.ApiPlan.Blocked)
        val pay = planRequest("user-a", "token", device, "POST", "/api/pay", "{}", background = true)
        assertTrue(pay is app.scout.companion.ApiPlan.Blocked)
        assertTrue(deliverable(OutboxItem("1", "user-a", SyncKind.History, "{}", 0)))
    }

    @Test
    fun reportsAFinishedBrowserTaskWithoutRunningIt() {
        val feed = RealtimeFeed()
        val event = readPush(mapOf("id" to "job-1", "type" to "browser-completed"))
        assertEquals("browser-progress", event?.type)
        val accepted = feed.accept(event!!.id, event.type)
        assertEquals(LiveEffect.Notify, accepted?.let { feed.effect(it) })
        assertFalse(feed.runsLocally(accepted!!))
        assertNull(feed.accept("job-1", "browser-progress"))
        assertEquals("job-1", feed.reconnectHeaders()["Last-Event-ID"])
    }

    @Test
    fun logoutClearsOnlyThatUsersLocalRows() = runBlocking {
        val desk = MemoryDesk()
        val prefs = MemoryPrefs()
        val repo = CompanionRepository(desk, prefs, MemoryJobs(), { 10L }, CompanionMetrics())
        desk.saveConversation(chat("user-a", "c1", "mine"))
        desk.saveConversation(chat("user-b", "c2", "theirs"))
        prefs.write("user-a", ScoutPreferences(city = "Delhi"))
        repo.logout("user-a")
        assertTrue(desk.conversations("user-a").isEmpty())
        assertEquals("theirs", desk.conversations("user-b").single().title)
        assertEquals("", prefs.read("user-a").city)
    }

    @Test
    fun aRevokedDeviceCannotCallTheApi() {
        val device = DeviceRecord("user-a", "phone", "push", revoked = true)
        val plan = planRequest("user-a", "token", device, "GET", "/api/desk", """{"uid":"user-b"}""", background = false)
        assertTrue(plan is app.scout.companion.ApiPlan.Blocked)
        val mismatch = planRequest(
            "user-a",
            "token",
            device.copy(revoked = false),
            "POST",
            "/api/chat",
            """{"uid":"user-b"}""",
            background = false,
        )
        assertTrue(mismatch is app.scout.companion.ApiPlan.Blocked)
        val ready = planRequest(
            "user-a",
            "token",
            device.copy(revoked = false),
            "GET",
            "/api/desk",
            "{}",
            background = false,
        )
        assertTrue(ready is app.scout.companion.ApiPlan.Ready)
        assertFalse((ready as app.scout.companion.ApiPlan.Ready).log.contains("token"))
    }

    @Test
    fun sendsSpeechToTheScoutTranscriber() {
        assertEquals("https://scout.shrianshjaiswal.me/api/voice/stt", speechUrl("https://scout.shrianshjaiswal.me"))
        assertEquals("http://127.0.0.1:8787/api/voice/stt", speechUrl("http://127.0.0.1:8787/"))
        assertEquals(null, speechUrl("https://evil.example"))
        assertEquals(null, speechUrl("http://evil.example"))
        val heard = speechMessage(200, """{"text":"films tonight"}""")
        assertTrue(heard is SpeechResult.Heard)
        assertEquals("films tonight", (heard as SpeechResult.Heard).text)
        val refused = speechMessage(401, """{"error":"Sign in with the code from your email."}""")
        assertTrue(refused is SpeechResult.Failed)
        assertEquals("Sign in with the code from your email.", (refused as SpeechResult.Failed).message)
        assertTrue(allowBridge("scout.shrianshjaiswal.me", """{"op":"microphone"}""", 1_000L) is BridgeDecision.Allow)
        assertTrue(allowBridge("scout.shrianshjaiswal.me", """{"op":"permissions"}""", 1_000L) is BridgeDecision.Allow)
    }

    @Test
    fun restrictsTheWebViewBridgeToScout() {
        val now = 1_000L
        assertTrue(allowBridge("evil.example", """{"op":"share","text":"hi"}""", now) is BridgeDecision.Deny)
        assertTrue(allowBridge("sj-scout.azurewebsites.net", """{"op":"filesystem"}""", now) is BridgeDecision.Deny)
        assertTrue(allowBridge("sj-scout.azurewebsites.net", """{"op":"share","text":"file:///secret"}""", now) is BridgeDecision.Deny)
        val share = allowBridge("127.0.0.1", """{"op":"share","text":"Tonight in Delhi"}""", now)
        assertTrue(share is BridgeDecision.Allow)
        val page = "https://scout.shrianshjaiswal.me/pair"
        val qr = allowBridge("scout.shrianshjaiswal.me", """{"op":"qr","payload":"$page"}""", now)
        assertTrue(qr is BridgeDecision.Allow)
    }

    @Test
    fun redactsSecretsAndPagesMessages() {
        val clean = redactSecrets("""{"otp":"918273","text":"hello"}""")
        assertFalse(clean.contains("918273"))
        assertTrue(clean.contains("hello"))
        val messages = listOf(
            CachedMessage("u", "c", 3, "three"),
            CachedMessage("u", "c", 2, "two"),
            CachedMessage("u", "c", 1, "one"),
        )
        assertEquals(listOf("two", "one"), pageMessages(messages, before = 3, limit = 2).map { it.text })
        assertEquals(60, jpegQuality(2_000_000))
        assertNull(planSync("user-a", "payment", 1))
        assertNull(planSync("user-a", "browser", 1))
        assertTrue(ScoutMigrations.ADD_DEVICE_REVOKED.contains("revoked"))
    }

    private fun repo(desk: MemoryDesk, jobs: WorkScheduler = MemoryJobs()): CompanionRepository {
        return CompanionRepository(desk, MemoryPrefs(), jobs, { 10_000L }, CompanionMetrics())
    }

    private fun chat(userId: String, id: String, title: String): CachedConversation {
        return CachedConversation(userId, id, title, "event", 10, """{"text":"$title"}""")
    }
}

private class MemoryJobs : WorkScheduler {
    private val rows = LinkedHashSet<String>()
    override fun enqueue(job: SyncJob) {
        rows.add(job.name)
    }
    override fun names(): Set<String> = rows
}

private class MemoryPrefs : PreferenceStore {
    private val rows = HashMap<String, ScoutPreferences>()
    override suspend fun read(userId: String): ScoutPreferences = rows[userId] ?: ScoutPreferences()
    override suspend fun write(userId: String, prefs: ScoutPreferences) {
        rows[userId] = prefs
    }
    override suspend fun clear(userId: String) {
        rows.remove(userId)
    }
}

private class MemoryDesk : LocalDesk {
    private val conversations = mutableListOf<CachedConversation>()
    private val messages = mutableListOf<CachedMessage>()
    private val events = mutableListOf<CachedEvent>()
    private val groceries = mutableListOf<app.scout.companion.CachedGrocery>()
    private val carts = mutableListOf<app.scout.companion.CachedCart>()
    private val tasks = mutableListOf<app.scout.companion.CachedTask>()
    private val browserTasks = mutableListOf<CachedBrowserTask>()
    private val outbox = mutableListOf<OutboxItem>()
    private val cursors = HashMap<String, Long>()
    private val devices = mutableListOf<DeviceRecord>()

    override suspend fun conversations(userId: String) = conversations.filter { it.userId == userId }
    override suspend fun saveConversation(row: CachedConversation) {
        conversations.removeAll { it.userId == row.userId && it.id == row.id }
        conversations.add(row)
    }
    override suspend fun messages(userId: String, conversationId: String) =
        messages.filter { it.userId == userId && it.conversationId == conversationId }
    override suspend fun saveMessage(row: CachedMessage) {
        messages.add(row)
    }
    override suspend fun events(userId: String) = events.filter { it.userId == userId }
    override suspend fun saveEvent(row: CachedEvent) {
        events.add(row)
    }
    override suspend fun groceries(userId: String) = groceries.filter { it.userId == userId }
    override suspend fun saveGrocery(row: app.scout.companion.CachedGrocery) {
        groceries.add(row)
    }
    override suspend fun carts(userId: String) = carts.filter { it.userId == userId }
    override suspend fun saveCart(row: app.scout.companion.CachedCart) {
        carts.add(row)
    }
    override suspend fun tasks(userId: String) = tasks.filter { it.userId == userId }
    override suspend fun saveTask(row: app.scout.companion.CachedTask) {
        tasks.add(row)
    }
    override suspend fun browserTasks(userId: String) = browserTasks.filter { it.userId == userId }
    override suspend fun saveBrowserTask(row: CachedBrowserTask) {
        browserTasks.add(row)
    }
    override suspend fun outbox(userId: String) = outbox.filter { it.userId == userId }
    override suspend fun saveOutbox(row: OutboxItem) {
        outbox.add(row)
    }
    override suspend fun removeOutbox(id: String) {
        outbox.removeAll { it.id == id }
    }
    override suspend fun cursor(userId: String, resource: String) = cursors["$userId/$resource"] ?: 0L
    override suspend fun setCursor(userId: String, resource: String, at: Long) {
        cursors["$userId/$resource"] = at
    }
    override suspend fun devices(userId: String) = devices.filter { it.userId == userId }
    override suspend fun saveDevice(row: DeviceRecord) {
        devices.removeAll { it.userId == row.userId && it.deviceId == row.deviceId }
        devices.add(row)
    }
    override suspend fun clearUser(userId: String) {
        conversations.removeAll { it.userId == userId }
        messages.removeAll { it.userId == userId }
        events.removeAll { it.userId == userId }
        groceries.removeAll { it.userId == userId }
        carts.removeAll { it.userId == userId }
        tasks.removeAll { it.userId == userId }
        browserTasks.removeAll { it.userId == userId }
        outbox.removeAll { it.userId == userId }
        devices.removeAll { it.userId == userId }
        cursors.keys.filter { it.startsWith("$userId/") }.forEach { cursors.remove(it) }
    }
}
