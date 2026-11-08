package app.scout.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import app.scout.companion.ApiPlan
import app.scout.companion.OutboxItem
import app.scout.companion.PreferenceStore
import app.scout.companion.ScoutPreferences
import app.scout.companion.SyncJob
import app.scout.companion.WorkScheduler
import app.scout.companion.SpeechResult
import app.scout.companion.planRequest
import app.scout.companion.speechMessage
import app.scout.companion.syncKind
import app.scout.companion.syncPath
import app.scout.companion.syncWire
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.suspendCancellableCoroutine
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

private val Context.companionPreferences by preferencesDataStore(name = "scout-companion")

class DataPreferences(private val context: Context) : PreferenceStore {
    override suspend fun read(userId: String): ScoutPreferences {
        val prefs = context.companionPreferences.data.first()
        val grocery = prefs[stringPreferencesKey(name(userId, "grocery"))] ?: ""
        return ScoutPreferences(
            city = prefs[stringPreferencesKey(name(userId, "city"))] ?: "",
            language = prefs[stringPreferencesKey(name(userId, "language"))] ?: "",
            groceryPlatforms = grocery.split("|").filter { it.isNotBlank() },
            notifications = prefs[booleanPreferencesKey(name(userId, "notifications"))] ?: false,
            lastScout = prefs[stringPreferencesKey(name(userId, "last"))] ?: "",
        )
    }

    override suspend fun write(userId: String, prefs: ScoutPreferences) {
        context.companionPreferences.edit { store ->
            store[stringPreferencesKey(name(userId, "city"))] = prefs.city
            store[stringPreferencesKey(name(userId, "language"))] = prefs.language
            store[stringPreferencesKey(name(userId, "grocery"))] = prefs.groceryPlatforms.joinToString("|")
            store[booleanPreferencesKey(name(userId, "notifications"))] = prefs.notifications
            store[stringPreferencesKey(name(userId, "last"))] = prefs.lastScout
        }
    }

    override suspend fun clear(userId: String) {
        context.companionPreferences.edit { store ->
            val prefix = "$userId|"
            store.asMap().keys.filter { it.name.startsWith(prefix) }.forEach { store.remove(it) }
        }
    }
}

private fun name(userId: String, field: String): String = "$userId|$field"

class AndroidScheduler(private val context: Context) : WorkScheduler {
    private val known = HashSet<String>()

    override fun enqueue(job: SyncJob) {
        if (!known.add(job.name)) return
        val request = OneTimeWorkRequestBuilder<CompanionSyncWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, job.backoffSeconds, TimeUnit.SECONDS)
            .setInputData(workDataOf("userId" to job.userId, "kind" to syncWire(job.kind)))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(job.name, ExistingWorkPolicy.KEEP, request)
    }

    override fun names(): Set<String> = known.toSet()
}

class CompanionSyncWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val kind = syncKind(inputData.getString("kind")) ?: return Result.failure()
        val userId = inputData.getString("userId") ?: return Result.failure()
        val path = syncPath(kind)
        if (path.startsWith("/api/browser") || path == "/api/pay") return Result.failure()
        if (runAttemptCount >= 5) return Result.failure()
        val user = FirebaseAuth.getInstance().currentUser ?: return Result.failure()
        if (user.uid != userId) return Result.failure()
        val token = idToken(user) ?: return Result.retry()
        val desk = RoomDesk(ScoutRoom.get(applicationContext).dao())
        val deviceId = androidDeviceId(applicationContext)
        val device = desk.devices(userId).firstOrNull { it.deviceId == deviceId }
        val pending = desk.outbox(userId).filter { it.kind == kind }
        if (pending.isEmpty()) return Result.success()
        var sent = 0
        for (item in pending) {
            val plan = planRequest(user.uid, token, device, "POST", path, item.payload, background = true)
            val ready = plan as? ApiPlan.Ready ?: return Result.failure()
            val code = postScout(ready.method, ready.path, ready.authorization, ready.body)
            if (code !in 200..299) return Result.retry()
            desk.removeOutbox(item.id)
            sent += 1
        }
        return if (sent == pending.size) Result.success() else Result.retry()
    }
}

internal fun deliverable(item: OutboxItem): Boolean {
    val path = syncPath(item.kind)
    return !path.startsWith("/api/browser") && path != "/api/pay"
}

private suspend fun idToken(user: FirebaseUser): String? = suspendCancellableCoroutine { cont ->
    user.getIdToken(false)
        .addOnSuccessListener { cont.resume(it.token) }
        .addOnFailureListener { cont.resume(null) }
}

fun postScout(method: String, path: String, authorization: String, body: String): Int {
    val origin = "https://scout.shrianshjaiswal.me"
    val connection = (URL(origin + path).openConnection() as HttpURLConnection).apply {
        requestMethod = method
        connectTimeout = 8_000
        readTimeout = 8_000
        doOutput = true
        setRequestProperty("content-type", "application/json")
        setRequestProperty("authorization", authorization)
    }
    return try {
        connection.outputStream.use { it.write(body.toByteArray()) }
        connection.responseCode
    } catch (_: Exception) {
        0
    } finally {
        connection.disconnect()
    }
}

fun postSpeech(url: String, cookie: String, mime: String, bytes: ByteArray): SpeechResult {
    if (cookie.isBlank() || bytes.isEmpty() || bytes.size > 4_000_000) {
        return SpeechResult.Failed("Speech could not be read.")
    }
    val connection = (URL(url).openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = 8_000
        readTimeout = 20_000
        doOutput = true
        setRequestProperty("content-type", mime)
        setRequestProperty("cookie", cookie)
    }
    return try {
        connection.outputStream.use { it.write(bytes) }
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
        speechMessage(status, body)
    } catch (_: Exception) {
        SpeechResult.Failed("Speech could not be read.")
    } finally {
        connection.disconnect()
    }
}
