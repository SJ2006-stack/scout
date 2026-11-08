package app.scout.data

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.provider.Settings
import androidx.core.app.NotificationCompat
import app.scout.MainActivity
import app.scout.R
import app.scout.ScoutApp
import app.scout.companion.readPush
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

fun androidDeviceId(context: android.content.Context): String {
    return Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: "device"
}

class ScoutMessaging : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val parsed = readPush(message.data) ?: return
        val app = application as? ScoutApp ?: return
        val event = app.feed.accept(parsed.id, parsed.type) ?: return
        if (app.feed.runsLocally(event)) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (!manager.areNotificationsEnabled()) return
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(label(event.type))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        manager.notify(event.id.hashCode(), notification)
    }

    private fun label(type: String): String {
        return when (type) {
            "browser-progress" -> "A browser task updated."
            "search-done" -> "A search finished."
            "auth-request" -> "A site is waiting for a code."
            "session-expired" -> "A browser session expired."
            "checkout-review" -> "A checkout is ready to review."
            "payment-handoff" -> "A payment is ready for you to approve."
            "booking-status" -> "A booking status changed."
            else -> "Scout has an update."
        }
    }

    companion object {
        const val CHANNEL = "scout"
    }
}
