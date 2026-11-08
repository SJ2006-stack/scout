package app.scout.companion.automation

import android.accessibilityservice.AccessibilityService
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.view.accessibility.AccessibilityEvent
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import app.scout.R

/**
 * Reads only the six shop and event apps, and only while an approved run is active.
 * It does not place orders. Pay controls are refused by [SafetyGuard] before every tap.
 */
class ScoutAutomationService : AccessibilityService() {
    val session = RunSession()
    private var receiverRegistered = false
    private val stopReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == ACTION_STOP) session.stop()
        }
    }

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(NotificationManager::class.java)
            val channel = NotificationChannel(CHANNEL, "Cart automation", NotificationManager.IMPORTANCE_DEFAULT)
            manager.createNotificationChannel(channel)
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        connected = this
        if (!receiverRegistered) {
            ContextCompat.registerReceiver(this, stopReceiver, IntentFilter(ACTION_STOP), ContextCompat.RECEIVER_NOT_EXPORTED)
            receiverRegistered = true
        }
    }

    override fun onUnbind(intent: Intent?): Boolean {
        if (connected === this) connected = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        if (receiverRegistered) {
            unregisterReceiver(stopReceiver)
            receiverRegistered = false
        }
        if (connected === this) connected = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (!session.active || event == null) return
        // Leaving the app is judged from the topmost window in ServiceScreen.root(). Events also
        // arrive late from an app that is going to the background, which read as the user leaving.
        if (event.eventType == AccessibilityEvent.TYPE_TOUCH_INTERACTION_START) session.onUserTouch()
    }

    override fun onInterrupt() {
        session.stop()
    }

    fun beginRun(packageName: String) {
        session.begin(packageName)
        showNotice()
    }

    fun endRun() {
        session.end()
        hideNotice()
    }

    private fun showNotice() {
        val stop = PendingIntent.getBroadcast(
            this,
            NOTICE,
            Intent(ACTION_STOP).setPackage(packageName),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_mic_notice)
            .setContentTitle("Scout")
            .setContentText(getString(R.string.automation_notice))
            .setOngoing(true)
            .setContentIntent(stop)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTICE, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTICE, notification)
            }
        } catch (_: RuntimeException) {
            getSystemService(NotificationManager::class.java)?.notify(NOTICE, notification)
        }
    }

    private fun hideNotice() {
        stopForeground(Service.STOP_FOREGROUND_REMOVE)
        getSystemService(NotificationManager::class.java)?.cancel(NOTICE)
    }

    companion object {
        const val ACTION_STOP = "app.scout.automation.STOP"
        private const val CHANNEL = "scout-automation"
        private const val NOTICE = 41

        @Volatile
        var connected: ScoutAutomationService? = null
            private set
    }
}
