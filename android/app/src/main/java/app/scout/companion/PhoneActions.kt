package app.scout.companion

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.provider.AlarmClock
import android.util.Log
import app.scout.companion.automation.AUTOMATION_PACKAGES
import app.scout.companion.automation.CartAutomation
import app.scout.companion.automation.EventBook
import app.scout.companion.automation.RunQueue
import app.scout.companion.automation.ScoutAutomationService
import app.scout.companion.automation.ServiceScreen
import app.scout.companion.automation.StepFailed
import app.scout.companion.automation.WhatsAppSend
import app.scout.companion.automation.cartMessage
import app.scout.companion.automation.cartStatus
import app.scout.companion.automation.deviceRunner
import app.scout.companion.automation.eventMessage
import app.scout.companion.automation.eventOutcome
import app.scout.companion.automation.eventStatus
import app.scout.companion.automation.readCartRequest
import app.scout.companion.automation.toJson
import org.json.JSONArray
import org.json.JSONObject

/** One Scout phone action, already validated by the server against src/shared/deviceActions.ts. */
data class PhoneAction(val id: String, val name: String, val args: JSONObject, val summary: String, val confirm: Boolean, val expiresAt: Long)

data class PhoneResult(val id: String, val status: String, val message: String, val data: Any? = null) {
    fun toJson(): String {
        val json = JSONObject().put("op", "action").put("id", id).put("status", status).put("message", message)
        if (data != null) json.put("data", data)
        return json.toString()
    }
}

val PHONE_APPS: Map<String, List<String>> = mapOf(
    "whatsapp" to listOf("com.whatsapp", "com.whatsapp.w4b"),
    "gmail" to listOf("com.google.android.gm"),
    "maps" to listOf("com.google.android.apps.maps"),
    "youtube" to listOf("com.google.android.youtube"),
    "spotify" to listOf("com.spotify.music"),
    "calendar" to listOf("com.google.android.calendar", "com.samsung.android.calendar"),
    "clock" to listOf("com.google.android.deskclock", "com.sec.android.app.clockpackage", "com.android.deskclock"),
    "camera" to listOf("com.android.camera", "com.google.android.GoogleCamera", "com.sec.android.app.camera"),
    "uber" to listOf("com.ubercab"),
    "ola" to listOf("com.olacabs.customer"),
    "zomato" to listOf("com.application.zomato"),
    "swiggy" to listOf("in.swiggy.android"),
    "blinkit" to listOf("com.grofers.customerapp"),
    "zepto" to listOf("com.zeptoconsumerapp"),
    "phonepe" to listOf("com.phonepe.app"),
    "gpay" to listOf("com.google.android.apps.nbu.paisa.user"),
    "paytm" to listOf("net.one97.paytm"),
)

private val ACTION_ID = Regex("^[a-f0-9]{24}$")

fun readPhoneAction(json: String, now: Long): PhoneAction? {
    val root = runCatching { JSONObject(json) }.getOrNull() ?: return null
    if (root.optString("op") != "action") return null
    val action = root.optJSONObject("action") ?: return null
    val id = action.optString("id")
    val name = action.optString("name")
    val expiresAt = action.optLong("expiresAt", 0L)
    if (!ACTION_ID.matches(id) || name.isBlank() || expiresAt < now) return null
    return PhoneAction(id, name, action.optJSONObject("args") ?: JSONObject(), action.optString("summary").take(200), action.optBoolean("confirm"), expiresAt)
}

class PhoneActions(private val context: Context) {
    private val reminders = ReminderStore(context)

    fun run(action: PhoneAction): PhoneResult {
        return try {
            when (action.name) {
                "set_alarm" -> setAlarm(action)
                "set_timer" -> setTimer(action)
                "create_reminder" -> createReminder(action)
                "list_reminders" -> PhoneResult(action.id, "completed", "${reminders.list().length()} reminders.", reminders.list())
                "cancel_reminder" -> cancelReminder(action)
                "open_app" -> openApp(action)
                "open_maps" -> launch(action, Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(action.args.optString("query")))), "Maps opened.")
                "share_text" -> launch(action, Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, action.args.optString("text")), "Share"), "Share sheet opened.")
                "send_whatsapp" -> sendWhatsApp(action)
                "toggle_flashlight" -> torch(action)
                "set_volume" -> volume(action)
                "get_capabilities" -> PhoneResult(action.id, "completed", "Capabilities read.", capabilities())
                "app_cart_add" -> addToCart(action)
                "app_event_book" -> bookEvent(action)
                else -> PhoneResult(action.id, "failed", "This app version cannot do ${action.name}.")
            }
        } catch (_: SecurityException) {
            PhoneResult(action.id, "needs_permission", "Android blocked that. Check Scout's permissions or Do Not Disturb.")
        } catch (_: ActivityNotFoundException) {
            PhoneResult(action.id, "failed", "No app on this phone can do that.")
        }
    }

    private fun setAlarm(action: PhoneAction): PhoneResult {
        val hour = action.args.optInt("hour", -1)
        val minute = action.args.optInt("minute", -1)
        if (hour !in 0..23 || minute !in 0..59) return PhoneResult(action.id, "failed", "That time is not valid.")
        val intent = Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, hour)
            .putExtra(AlarmClock.EXTRA_MINUTES, minute)
            .putExtra(AlarmClock.EXTRA_MESSAGE, action.args.optString("label").ifBlank { "Scout" })
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        return launch(action, intent, "Clock app asked to set %02d:%02d.".format(hour, minute))
    }

    private fun setTimer(action: PhoneAction): PhoneResult {
        val seconds = action.args.optInt("seconds", 0)
        if (seconds !in 1..86_400) return PhoneResult(action.id, "failed", "That timer length is not valid.")
        val intent = Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
            .putExtra(AlarmClock.EXTRA_MESSAGE, action.args.optString("label").ifBlank { "Scout" })
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        return launch(action, intent, "Clock app asked to start a ${seconds}s timer.")
    }

    private fun createReminder(action: PhoneAction): PhoneResult {
        val title = action.args.optString("title").trim().take(120)
        val at = action.args.optLong("at", 0L)
        if (title.isEmpty() || at <= System.currentTimeMillis()) return PhoneResult(action.id, "failed", "Reminders need a title and a future time.")
        val reminderId = action.id.take(12)
        reminders.save(reminderId, title, at)
        schedule(reminderId, title, at)
        return PhoneResult(action.id, "completed", "Reminder saved on this phone.", JSONObject().put("reminderId", reminderId))
    }

    private fun cancelReminder(action: PhoneAction): PhoneResult {
        val reminderId = action.args.optString("reminderId")
        if (!reminders.remove(reminderId)) return PhoneResult(action.id, "failed", "No reminder with that id.")
        alarms().cancel(reminderIntent(reminderId, ""))
        return PhoneResult(action.id, "completed", "Reminder cancelled.")
    }

    private fun sendWhatsApp(action: PhoneAction): PhoneResult {
        val rawPhone = action.args.optString("phone").filter { it.isDigit() }
        val phone = rawPhone.takeIf { it.matches(Regex("^[1-9][0-9]{7,14}$")) }
        val chatName = action.args.optString("name").trim().replace(Regex("\\s+"), " ").takeIf { it.length in 2..40 && !it.any { ch -> ch.isDigit() || ch == '@' } }
        val body = action.args.optString("text").trim()
        if (body.isEmpty() || (phone == null && chatName == null)) {
            return PhoneResult(action.id, "failed", "A WhatsApp message needs a number or a name, and some text.")
        }
        val pkg = listOf("com.whatsapp", "com.whatsapp.w4b").firstOrNull { installed(it) }
            ?: return PhoneResult(action.id, "failed", "WhatsApp is not installed.")
        val service = ScoutAutomationService.connected
        if (service == null) {
            if (phone == null) return PhoneResult(action.id, "failed", "Turn on Scout's accessibility service to message a chat by name.")
            val uri = Uri.parse("https://wa.me/$phone").buildUpon().appendQueryParameter("text", body).build()
            return launch(action, Intent(Intent.ACTION_VIEW, uri).setPackage(pkg), "WhatsApp opened to that chat with the message filled in.")
        }
        return RunQueue.run {
            val screen = ServiceScreen(service)
            service.beginRun(pkg)
            try {
                WhatsAppSend.deliver(screen, deviceRunner(screen, pkg), pkg, phone, chatName, body)
                PhoneResult(action.id, "completed", "WhatsApp sent that message.")
            } catch (error: StepFailed) {
                val status = if (error.reason == "unsent") "handoff_started" else "failed"
                val message = when (error.reason) {
                    "unsent" -> "WhatsApp is open with the message filled in."
                    "ambiguous" -> "More than one WhatsApp chat has that name, so nothing was sent."
                    "no_match" -> "No WhatsApp chat has that exact name."
                    "no_search" -> "WhatsApp's search box did not show up."
                    "user_stopped" -> "You stopped Scout in WhatsApp."
                    else -> "WhatsApp did not send that message."
                }
                PhoneResult(action.id, status, message)
            } finally {
                service.endRun()
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun installed(packageName: String): Boolean {
        return try {
            context.packageManager.getPackageInfo(packageName, 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
    }

    private fun openApp(action: PhoneAction): PhoneResult {
        val packages = PHONE_APPS[action.args.optString("app")] ?: return PhoneResult(action.id, "failed", "Scout cannot open that app.")
        val launchIntent = packages.firstNotNullOfOrNull { context.packageManager.getLaunchIntentForPackage(it) }
            ?: return PhoneResult(action.id, "failed", "${action.args.optString("app")} is not installed.")
        return launch(action, launchIntent, "${action.args.optString("app")} opened.")
    }

    private fun torch(action: PhoneAction): PhoneResult {
        val camera = context.getSystemService(CameraManager::class.java)
        val id = camera.cameraIdList.firstOrNull { camera.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
            ?: return PhoneResult(action.id, "failed", "This phone has no flashlight.")
        val on = action.args.optBoolean("on", true)
        camera.setTorchMode(id, on)
        return PhoneResult(action.id, "completed", if (on) "Flashlight on." else "Flashlight off.")
    }

    private fun volume(action: PhoneAction): PhoneResult {
        val audio = context.getSystemService(AudioManager::class.java)
        val stream = when (action.args.optString("stream")) {
            "ring" -> AudioManager.STREAM_RING
            "alarm" -> AudioManager.STREAM_ALARM
            else -> AudioManager.STREAM_MUSIC
        }
        val percent = action.args.optInt("percent", -1)
        if (percent !in 0..100) return PhoneResult(action.id, "failed", "Volume must be 0 to 100.")
        val max = audio.getStreamMaxVolume(stream)
        audio.setStreamVolume(stream, (max * percent + 50) / 100, AudioManager.FLAG_SHOW_UI)
        return PhoneResult(action.id, "completed", "${action.args.optString("stream", "media")} volume set to $percent%.")
    }

    private fun addToCart(action: PhoneAction): PhoneResult {
        val request = readCartRequest(action.args) ?: return PhoneResult(action.id, "failed", "That cart request is not valid.")
        val result = CartAutomation.run(context, request)
        return PhoneResult(action.id, cartStatus(result), cartMessage(result), result.toJson())
    }

    private fun bookEvent(action: PhoneAction): PhoneResult {
        val request = EventBook.readRequest(action.args) ?: return PhoneResult(action.id, "failed", "That event request is not valid.")
        val packageName = AUTOMATION_PACKAGES[request.app]
            ?: return PhoneResult(action.id, "failed", eventMessage(request.app, request.title, "app_missing"))
        if (!installed(packageName)) return PhoneResult(action.id, "failed", eventMessage(request.app, request.title, "app_missing"))
        val service = ScoutAutomationService.connected
        if (service == null || !CartAutomation.serviceOn(context)) {
            return try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(request.link)).setPackage(packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                PhoneResult(action.id, "handoff_started", "${eventAppLabel(request.app)} is open on ${request.title}. Turn on Scout's accessibility service to close a promo and stop before payment.")
            } catch (_: ActivityNotFoundException) {
                PhoneResult(action.id, "failed", eventMessage(request.app, request.title, "app_missing"))
            }
        }
        return RunQueue.run {
            val screen = ServiceScreen(service)
            service.beginRun(packageName)
            try {
                val stop = EventBook.deliver(screen, deviceRunner(screen, packageName), request)
                val outcome = eventOutcome(request, screen.root(), stop)
                PhoneResult(action.id, eventStatus(outcome.reason), eventMessage(request.app, request.title, outcome.reason, outcome.detail), outcome.toJson())
            } catch (error: StepFailed) {
                Log.i("ScoutDebug", "event stop app=${request.app} step=${error.step} reason=${error.reason}")
                PhoneResult(action.id, eventStatus(error.reason), eventMessage(request.app, request.title, error.reason))
            } finally {
                service.endRun()
            }
        }
    }

    private fun eventAppLabel(app: String): String = when (app) {
        "bookmyshow" -> "BookMyShow"
        "district" -> "District"
        "luma" -> "Luma"
        else -> app
    }

    private fun capabilities(): JSONObject {
        val pm = context.packageManager
        return JSONObject()
            .put("flashlight", pm.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH))
            .put("exactReminders", Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms().canScheduleExactAlarms())
            .put("apps", JSONArray(PHONE_APPS.filter { (_, ids) -> ids.any { pm.getLaunchIntentForPackage(it) != null } }.keys.toList()))
            .put("automation", CartAutomation.capabilities(context))
    }

    private fun launch(action: PhoneAction, intent: Intent, message: String): PhoneResult {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return PhoneResult(action.id, "handoff_started", message)
    }

    private fun schedule(reminderId: String, title: String, at: Long) {
        val pending = reminderIntent(reminderId, title)
        val manager = alarms()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms()) {
            manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
        } else {
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending)
        }
    }

    private fun reminderIntent(reminderId: String, title: String): PendingIntent {
        val intent = Intent(context, ReminderReceiver::class.java).putExtra(ReminderReceiver.EXTRA_ID, reminderId).putExtra(ReminderReceiver.EXTRA_TITLE, title)
        return PendingIntent.getBroadcast(context, reminderId.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun alarms(): AlarmManager = context.getSystemService(AlarmManager::class.java)
}

class ReminderStore(context: Context) {
    private val prefs = context.getSharedPreferences("scout-reminders", Context.MODE_PRIVATE)

    fun list(): JSONArray {
        val now = System.currentTimeMillis()
        val rows = JSONArray()
        for ((id, value) in prefs.all) {
            val row = runCatching { JSONObject(value as String) }.getOrNull() ?: continue
            if (row.optLong("at") >= now) rows.put(JSONObject().put("reminderId", id).put("title", row.optString("title")).put("at", row.optLong("at")))
        }
        return rows
    }

    fun save(id: String, title: String, at: Long) {
        prefs.edit().putString(id, JSONObject().put("title", title).put("at", at).toString()).apply()
    }

    fun remove(id: String): Boolean {
        if (!prefs.contains(id)) return false
        prefs.edit().remove(id).apply()
        return true
    }
}
