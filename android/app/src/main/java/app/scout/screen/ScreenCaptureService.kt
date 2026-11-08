package app.scout.screen

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import app.scout.MainActivity
import app.scout.R
import app.scout.ScoutApp
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Holds one MediaProjection for one screen session, under a foreground service of type
 * mediaProjection with a notice the user cannot miss. It creates no display and reads no
 * pixels until the user taps Capture; then it reads one frame, saves it privately, and
 * stops the projection. Stop, Android's own stop, Scout being swiped away, or three idle
 * minutes all end it.
 */
class ScreenCaptureService : Service(), Shutter {
    private val app get() = application as ScoutApp
    private val main = Handler(Looper.getMainLooper())
    private var worker: HandlerThread? = null
    private var handler: Handler? = null
    @Volatile private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    @Volatile private var sessionId: String? = null
    @Volatile private var owner: String? = null
    @Volatile private var contentVisible = true
    private val released = AtomicBoolean(false)
    private val expiry = Runnable { app.screen.expire() }

    private val callback = object : MediaProjection.Callback() {
        override fun onStop() {
            sessionId?.let { app.screen.stop(it, ScreenEnd.SYSTEM) }
            release()
        }

        override fun onCapturedContentVisibilityChanged(isVisible: Boolean) {
            contentVisible = isVisible
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> start(intent)
            ACTION_CAPTURE -> captureNow(intent.getStringExtra(EXTRA_SESSION))
            ACTION_STOP -> {
                val id = intent.getStringExtra(EXTRA_SESSION)
                if (id == null || !app.screen.stop(id, ScreenEnd.STOPPED)) release()
            }
            else -> release()
        }
        return START_NOT_STICKY
    }

    private fun start(intent: Intent) {
        val id = intent.getStringExtra(EXTRA_SESSION)
        val code = intent.getIntExtra(EXTRA_CODE, 0)
        val consent = consentData(intent)
        intent.removeExtra(EXTRA_DATA)
        try {
            ServiceCompat.startForeground(this, NOTICE_ID, liveNotice(id.orEmpty()), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } catch (_: RuntimeException) {
            if (id != null) app.screen.stop(id, ScreenEnd.FAILED, "Android did not let Scout start screen capture.")
            release()
            return
        }
        if (id == null || consent == null || projection != null || released.get() || app.screen.state() != "starting") {
            if (id != null && projection == null) app.screen.stop(id, ScreenEnd.FAILED, "Screen capture could not start. Try again.")
            if (projection == null) release()
            return
        }
        val manager = getSystemService(MediaProjectionManager::class.java)
        val granted = try {
            manager?.getMediaProjection(code, consent)
        } catch (_: RuntimeException) {
            null
        }
        if (granted == null) {
            app.screen.stop(id, ScreenEnd.FAILED, "Android did not hand Scout the screen. Try again.")
            release()
            return
        }
        val thread = HandlerThread("scout-screen").also { it.start() }
        worker = thread
        handler = Handler(thread.looper)
        projection = granted
        sessionId = id
        owner = app.screen.owner()
        granted.registerCallback(callback, handler)
        if (!app.screen.started(id, this)) {
            release()
            return
        }
        main.postDelayed(expiry, ScreenSession.LIVE_MS + 1_000)
    }

    private fun captureNow(id: String?) {
        val size = displaySize()
        if (id == null || size.width <= 0 || size.height <= 0) return
        app.screen.shoot(id, size) { _, _ -> }
    }

    override fun capture(size: FrameSize, done: (CaptureResult) -> Unit) {
        val work = handler
        val live = projection
        val user = owner
        if (work == null || live == null || user == null) {
            done(CaptureResult.Failed("Screen capture already stopped."))
            return
        }
        val finished = AtomicBoolean(false)
        val timeout = Runnable { finishOnce(finished, work, done, CaptureResult.Failed("No picture came from the screen. Try again.")) }
        work.post {
            val frames = ImageReader.newInstance(size.width, size.height, PixelFormat.RGBA_8888, 2)
            reader = frames
            val armed = AtomicBoolean(false)
            frames.setOnImageAvailableListener({ source ->
                if (armed.compareAndSet(false, true)) {
                    work.postDelayed(
                        { finishOnce(finished, work, done, save(source, size, user)) },
                        SETTLE_MS,
                    )
                }
            }, work)
            display = try {
                live.createVirtualDisplay(
                    "scout-screen",
                    size.width,
                    size.height,
                    size.dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    frames.surface,
                    null,
                    work,
                )
            } catch (_: RuntimeException) {
                finishOnce(finished, work, done, CaptureResult.Failed("Android stopped the screen capture. Try again."))
                null
            }
            work.postDelayed(timeout, FRAME_WAIT_MS)
        }
    }

    private fun finishOnce(finished: AtomicBoolean, work: Handler, done: (CaptureResult) -> Unit, result: CaptureResult) {
        if (!finished.compareAndSet(false, true)) return
        work.removeCallbacksAndMessages(null)
        done(result)
    }

    private fun save(source: ImageReader, size: FrameSize, user: String): CaptureResult {
        if (released.get()) return CaptureResult.Failed("Screen capture already stopped.")
        if (!contentVisible) return CaptureResult.Failed("The app you shared was not on screen. Start again from Scout.")
        val image = try {
            source.acquireLatestImage()
        } catch (_: IllegalStateException) {
            null
        } ?: return CaptureResult.Failed("No picture came from the screen. Try again.")
        val frame = try {
            val plane = image.planes[0]
            val rowPixels = plane.rowStride / plane.pixelStride
            val padded = Bitmap.createBitmap(rowPixels, size.height, Bitmap.Config.ARGB_8888)
            padded.copyPixelsFromBuffer(plane.buffer)
            if (rowPixels == size.width) padded else Bitmap.createBitmap(padded, 0, 0, size.width, size.height).also { padded.recycle() }
        } catch (_: RuntimeException) {
            null
        } finally {
            image.close()
        }
        if (frame == null) return CaptureResult.Failed("The screen picture could not be read.")
        try {
            if (looksBlank(sample(frame))) {
                return CaptureResult.Failed("That screen came out black. Apps that protect payments, passwords, or private content block screenshots.")
            }
            val (width, height) = fitWithin(frame.width, frame.height)
            val scaled = if (width == frame.width && height == frame.height) frame else Bitmap.createScaledBitmap(frame, width, height, true)
            val jpeg = encode(scaled)
            if (scaled !== frame) scaled.recycle()
            val shot = jpeg?.let { app.shots.put(user, ScreenShots.newId(), it, width, height) }
                ?: return CaptureResult.Failed("That screen picture was too large to keep.")
            return CaptureResult.Saved(shot.id)
        } finally {
            frame.recycle()
        }
    }

    private fun sample(frame: Bitmap): IntArray {
        val steps = 24
        return IntArray(steps * steps) { index ->
            val x = ((index % steps) + 0.5) * frame.width / steps
            val y = ((index / steps) + 0.5) * frame.height / steps
            frame.getPixel(x.toInt().coerceIn(0, frame.width - 1), y.toInt().coerceIn(0, frame.height - 1))
        }
    }

    private fun encode(frame: Bitmap): ByteArray? {
        for (quality in FRAME_QUALITIES) {
            val out = ByteArrayOutputStream()
            if (!frame.compress(Bitmap.CompressFormat.JPEG, quality, out)) return null
            if (out.size() <= ScreenShots.MAX_BYTES) return out.toByteArray()
        }
        return null
    }

    override fun release() {
        if (!released.compareAndSet(false, true)) return
        main.removeCallbacks(expiry)
        val work = handler
        val teardown = Runnable {
            display?.release()
            display = null
            reader?.close()
            reader = null
            val live = projection
            projection = null
            live?.unregisterCallback(callback)
            live?.stop()
            main.post {
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
                worker?.quitSafely()
            }
        }
        if (work == null) teardown.run() else work.post(teardown)
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        val id = sessionId
        if (id == null || !app.screen.stop(id, ScreenEnd.STOPPED)) release()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        sessionId?.let { app.screen.stop(it, ScreenEnd.STOPPED) }
        release()
        super.onDestroy()
    }

    private fun liveNotice(id: String): android.app.Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL, getString(R.string.screen_channel), NotificationManager.IMPORTANCE_HIGH)
            channel.setSound(null, null)
            manager?.createNotificationChannel(channel)
        }
        val immutable = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val capture = PendingIntent.getService(this, CAPTURE_REQUEST, captureIntent(this, id), immutable)
        val stop = PendingIntent.getService(this, STOP_REQUEST, stopIntent(this, id), immutable)
        val open = PendingIntent.getActivity(this, OPEN_REQUEST, Intent(this, MainActivity::class.java), immutable)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_screen_notice)
            .setContentTitle(getString(R.string.screen_live_title))
            .setContentText(getString(R.string.screen_live_body))
            .setStyle(NotificationCompat.BigTextStyle().bigText(getString(R.string.screen_live_body)))
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, getString(R.string.screen_capture), capture)
            .addAction(0, getString(R.string.screen_stop), stop)
            .build()
    }

    @Suppress("DEPRECATION")
    private fun displaySize(): FrameSize {
        val window = getSystemService(WindowManager::class.java)
        return if (Build.VERSION.SDK_INT >= 30) {
            val bounds = window.maximumWindowMetrics.bounds
            frameSizeFor(bounds.width(), bounds.height(), resources.displayMetrics.densityDpi)
        } else {
            val metrics = DisplayMetrics()
            window.defaultDisplay.getRealMetrics(metrics)
            frameSizeFor(metrics.widthPixels, metrics.heightPixels, metrics.densityDpi)
        }
    }

    @Suppress("DEPRECATION")
    private fun consentData(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(EXTRA_DATA, Intent::class.java) else intent.getParcelableExtra(EXTRA_DATA)

    companion object {
        private const val ACTION_START = "app.scout.screen.START"
        private const val ACTION_CAPTURE = "app.scout.screen.CAPTURE"
        private const val ACTION_STOP = "app.scout.screen.STOP"
        private const val EXTRA_SESSION = "session"
        private const val EXTRA_CODE = "code"
        private const val EXTRA_DATA = "consent"
        private const val CHANNEL = "scout-screen"
        private const val NOTICE_ID = 41
        private const val CAPTURE_REQUEST = 41
        private const val STOP_REQUEST = 42
        private const val OPEN_REQUEST = 43
        private const val SETTLE_MS = 250L
        private const val FRAME_WAIT_MS = 3_000L

        /** The consent result goes straight to the service and is used once there; nothing else keeps it. */
        fun start(context: Context, session: String, code: Int, consent: Intent): Intent =
            Intent(context, ScreenCaptureService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_SESSION, session)
                .putExtra(EXTRA_CODE, code)
                .putExtra(EXTRA_DATA, consent)

        fun captureIntent(context: Context, session: String?): Intent =
            Intent(context, ScreenCaptureService::class.java)
                .setAction(ACTION_CAPTURE)
                .putExtra(EXTRA_SESSION, session)

        fun stopIntent(context: Context, session: String?): Intent =
            Intent(context, ScreenCaptureService::class.java)
                .setAction(ACTION_STOP)
                .putExtra(EXTRA_SESSION, session)
    }
}
