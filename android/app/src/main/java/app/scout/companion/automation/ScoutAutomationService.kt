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
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import app.scout.R

/**
 * Reads the six shop and event apps, and only while an approved run is active.
 * A WhatsApp send adds WhatsApp for that run, then the list goes back.
 * It does not place orders. Pay controls are refused by [SafetyGuard] before every tap.
 */
class ScoutAutomationService : AccessibilityService() {
    val session = RunSession()
    private val main = Handler(Looper.getMainLooper())
    private val overlay by lazy { ControlOverlay(this) }
    private var receiverRegistered = false
    private var basePackages: Array<String>? = null
    private var watchingWhatsApp = false
    private var runNotice: String? = null
    private val stopReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                ACTION_STOP -> session.stop()
                ACTION_TOGGLE -> {
                    if (session.userHolding) session.resumeScout() else session.takeControl()
                    main.post { if (session.active) present() }
                }
            }
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
        basePackages = serviceInfo?.packageNames?.clone()
        if (!receiverRegistered) {
            val filter = IntentFilter().apply {
                addAction(ACTION_STOP)
                addAction(ACTION_TOGGLE)
            }
            ContextCompat.registerReceiver(this, stopReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
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
        if (event.eventType == AccessibilityEvent.TYPE_TOUCH_INTERACTION_START) {
            if (event.packageName?.toString() == packageName) return
            session.onUserTouch()
        }
    }

    override fun onInterrupt() {
        session.stop()
    }

    fun beginRun(packageName: String, notice: String? = null) {
        if (packageName == "com.whatsapp" || packageName == "com.whatsapp.w4b") watchWhatsApp(packageName)
        runNotice = notice
        session.begin(packageName)
        main.post { if (session.active) present() }
    }

    fun endRun() {
        session.end()
        runNotice = null
        restorePackages()
        main.post {
            overlay.hide()
            hideNotice()
        }
    }

    private fun present() {
        overlay.show(
            session.userHolding,
            onDown = { session.noteChromeTouch() },
            onToggle = {
                if (session.userHolding) session.resumeScout() else session.takeControl()
                if (session.active) present()
            },
            onStop = { session.stop() },
        )
        showNotice()
    }

    /**
     * The service's package list is the shop and event apps. WhatsApp stays off that list so a
     * WhatsApp window cannot look like the user left a shop. A send adds WhatsApp for the run,
     * because a window outside the list cannot be read or typed into.
     */
    private fun watchWhatsApp(packageName: String) {
        val info = serviceInfo ?: return
        val base = basePackages ?: info.packageNames ?: return
        if (packageName in base) return
        info.packageNames = base + packageName
        serviceInfo = info
        watchingWhatsApp = true
    }

    private fun restorePackages() {
        if (!watchingWhatsApp) return
        val info = serviceInfo ?: return
        val base = basePackages ?: return
        info.packageNames = base.clone()
        serviceInfo = info
        watchingWhatsApp = false
    }

    private fun showNotice() {
        val holding = session.userHolding
        val toggle = getString(if (holding) R.string.automation_resume else R.string.automation_take)
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_mic_notice)
            .setContentTitle("Scout")
            .setContentText(if (holding) getString(R.string.automation_holding) else runNotice ?: getString(R.string.automation_notice))
            .setOngoing(true)
            .setContentIntent(broadcast(ACTION_STOP, NOTICE))
            .addAction(0, toggle, broadcast(ACTION_TOGGLE, TOGGLE_REQUEST))
            .addAction(0, getString(R.string.automation_stop), broadcast(ACTION_STOP, STOP_REQUEST))
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

    private fun broadcast(action: String, request: Int): PendingIntent {
        return PendingIntent.getBroadcast(
            this,
            request,
            Intent(action).setPackage(packageName),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    companion object {
        const val ACTION_STOP = "app.scout.automation.STOP"
        const val ACTION_TOGGLE = "app.scout.automation.TOGGLE"
        private const val CHANNEL = "scout-automation"
        private const val NOTICE = 41
        private const val TOGGLE_REQUEST = 42
        private const val STOP_REQUEST = 43

        @Volatile
        var connected: ScoutAutomationService? = null
            private set
    }
}
