package app.scout

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import app.scout.companion.CompanionRepository
import app.scout.companion.OtpHandoff
import app.scout.companion.RealtimeFeed
import app.scout.data.AndroidScheduler
import app.scout.data.DataPreferences
import app.scout.data.RoomDesk
import app.scout.data.ScoutMessaging
import app.scout.data.ScoutRoom

class ScoutApp : Application() {
    lateinit var runtime: CompanionRepository
        private set
    val feed = RealtimeFeed()
    val otp = OtpHandoff(now = { System.currentTimeMillis() })

    override fun onCreate() {
        super.onCreate()
        runtime = CompanionRepository(
            RoomDesk(ScoutRoom.get(this).dao()),
            DataPreferences(this),
            AndroidScheduler(this),
            System::currentTimeMillis,
        )
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(NotificationManager::class.java)
            val channel = NotificationChannel(ScoutMessaging.CHANNEL, "Scout", NotificationManager.IMPORTANCE_DEFAULT)
            manager.createNotificationChannel(channel)
        }
    }
}
