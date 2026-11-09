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
import android.util.Log
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
 * mediaProjection with a notice the user cannot miss. Once Android grants the projection,
 * Scout samples frames into a short clip until Stop, a run of failures, or [ScreenSession.CLIP_FRAMES].
 * Stop with at least one frame keeps the clip. An explicit Capture tap still saves one frame and stops.
 * On Android 14 and later, a shared app window reports its size through
 * onCapturedContentResize, including after rotation; the virtual display and its ImageReader
 * are rebuilt to that size before the frame is saved, and the previous reader is closed only
 * after the display has stopped drawing to it.
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
    @Volatile private var contentWidth = 0
    @Volatile private var contentHeight = 0
    private val released = AtomicBoolean(false)
    private val recording = AtomicBoolean(false)
    private val frameFinished = AtomicBoolean(false)
    private val expiry = Runnable { app.screen.expire() }
    private var requested = FrameSize(0, 0, 0)
    private var generation = 0
    private var settleToken = 0
    private var timeout: Runnable? = null
    private var settle: Runnable? = null
    private var pendingDone: ((CaptureResult) -> Unit)? = null

    private val callback = object : MediaProjection.Callback() {
        override fun onStop() {
            sessionId?.let { app.screen.stop(it, ScreenEnd.SYSTEM) }
            release()
        }

        override fun onCapturedContentVisibilityChanged(isVisible: Boolean) {
            contentVisible = isVisible
        }

        override fun onCapturedContentResize(width: Int, height: Int) {
            if (width <= 0 || height <= 0) return
            val changed = width != contentWidth || height != contentHeight
            contentWidth = width
            contentHeight = height
            if (!changed || pendingDone == null || frameFinished.get() || released.get()) return
            val size = currentSize() ?: return
            val frames = reader
            if (frames != null && frames.width == size.width && frames.height == size.height) {
                Log.i(TAG, "screen content resized to ${width}x${height}, capture already ${size.width}x${size.height}")
                return
            }
            Log.i(TAG, "screen content resized to ${width}x${height}, capture ${size.width}x${size.height}")
            if (mount(size)) armTimeout()
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
        recording.set(true)
        handler?.post { watchNext(0) }
    }

    /** Samples the shared screen until the clip is full, the user stops, or several grabs fail. */
    private fun watchNext(misses: Int) {
        if (released.get() || !recording.get()) return
        val id = sessionId ?: return
        val size = displaySize()
        if (size.width <= 0 || size.height <= 0) {
            handler?.postDelayed({ watchNext(misses + 1) }, SAMPLE_MS)
            return
        }
        sample(size) { result ->
            if (released.get() || !recording.get()) return@sample
            when (result) {
                is CaptureResult.Saved -> {
                    if (app.screen.kept(id)) handler?.postDelayed({ watchNext(0) }, SAMPLE_MS)
                    else {
                        recording.set(false)
                        app.screen.stop(id, ScreenEnd.STOPPED)
                    }
                }
                is CaptureResult.Failed -> {
                    val have = app.screen.frameCount(id)
                    val next = misses + 1
                    if (have > 0 && next >= 3) {
                        recording.set(false)
                        app.screen.stop(id, ScreenEnd.STOPPED)
                    } else if (have == 0 && next >= 6) {
                        recording.set(false)
                        app.screen.stop(id, ScreenEnd.FAILED, result.message)
                    } else {
                        handler?.postDelayed({ watchNext(next) }, SAMPLE_MS)
                    }
                }
            }
        }
    }

    /** Grabs one frame and leaves the virtual display up so the next sample can reuse it. */
    private fun sample(size: FrameSize, done: (CaptureResult) -> Unit) {
        val work = handler
        if (work == null || projection == null || owner == null) {
            done(CaptureResult.Failed("Screen capture already stopped."))
            return
        }
        work.post {
            if (released.get() || projection == null || owner == null) {
                done(CaptureResult.Failed("Screen capture already stopped."))
                return@post
            }
            requested = size
            frameFinished.set(false)
            pendingDone = done
            val sizeNow = currentSize()
            if (sizeNow == null || sizeNow.width <= 0 || sizeNow.height <= 0) {
                finishFrame(CaptureResult.Failed("No picture came from the screen. Try again."))
                return@post
            }
            if (display == null || reader == null) {
                if (mount(sizeNow)) armTimeout()
                return@post
            }
            val run = Runnable {
                if (frameFinished.get() || released.get()) return@Runnable
                val source = reader
                val user = owner
                if (source == null || user == null) {
                    finishFrame(CaptureResult.Failed("Screen capture already stopped."))
                    return@Runnable
                }
                finishFrame(save(source, sizeNow, user))
            }
            settle = run
            work.postDelayed(run, SETTLE_MS)
            armTimeout()
        }
    }

    private fun captureNow(id: String?) {
        val size = displaySize()
        if (id == null || size.width <= 0 || size.height <= 0) return
        app.screen.shoot(id, size) { _, _ -> }
    }

    override fun capture(size: FrameSize, done: (CaptureResult) -> Unit) {
        val work = handler
        if (work == null || projection == null || owner == null) {
            done(CaptureResult.Failed("Screen capture already stopped."))
            return
        }
        requested = size
        work.post { openCapture(done) }
    }

    private fun openCapture(done: (CaptureResult) -> Unit) {
        if (released.get() || projection == null || owner == null) {
            done(CaptureResult.Failed("Screen capture already stopped."))
            return
        }
        frameFinished.set(false)
        pendingDone = done
        val size = currentSize()
        if (size == null || size.width <= 0 || size.height <= 0) {
            finishFrame(CaptureResult.Failed("No picture came from the screen. Try again."))
            return
        }
        Log.i(TAG, "screen capture ${size.width}x${size.height} content ${contentWidth}x${contentHeight}")
        if (mount(size)) armTimeout()
    }

    /** Latest shared-window size when Android has reported one, otherwise the full display. */
    private fun currentSize(): FrameSize? {
        if (requested.width <= 0 || requested.height <= 0 || requested.dpi <= 0) return null
        return captureSize(requested, contentWidth, contentHeight)
    }

    /**
     * Points the virtual display at a new [ImageReader] of [size]. The reader is created first,
     * then the display is created or resized onto its surface, and only then is the previous
     * reader closed. A failed create closes the new reader and ends the capture.
     */
    private fun mount(size: FrameSize): Boolean {
        val live = projection ?: return false
        val work = handler ?: return false
        generation += 1
        val generationAtListen = generation
        settle?.let { work.removeCallbacks(it) }
        settle = null
        val oldReader = reader
        oldReader?.setOnImageAvailableListener(null, null)
        val frames = try {
            ImageReader.newInstance(size.width, size.height, PixelFormat.RGBA_8888, 2)
        } catch (_: RuntimeException) {
            finishFrame(CaptureResult.Failed("Android stopped the screen capture. Try again."))
            return false
        }
        frames.setOnImageAvailableListener({ source ->
            if (generation != generationAtListen || frameFinished.get() || released.get()) return@setOnImageAvailableListener
            val token = settleToken + 1
            settleToken = token
            val run = Runnable {
                if (settleToken != token || generation != generationAtListen || frameFinished.get()) return@Runnable
                val user = owner
                if (user == null) {
                    finishFrame(CaptureResult.Failed("Screen capture already stopped."))
                    return@Runnable
                }
                finishFrame(save(source, size, user))
            }
            settle = run
            val wait = if (contentWidth > 0 && contentHeight > 0) SETTLE_MS else FIRST_SIZE_MS
            work.postDelayed(run, wait)
        }, work)
        val existing = display
        try {
            if (existing == null) {
                display = live.createVirtualDisplay(
                    "scout-screen",
                    size.width,
                    size.height,
                    size.dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    frames.surface,
                    null,
                    work,
                )
            } else {
                existing.resize(size.width, size.height, size.dpi)
                existing.setSurface(frames.surface)
            }
        } catch (_: RuntimeException) {
            frames.setOnImageAvailableListener(null, null)
            frames.close()
            finishFrame(CaptureResult.Failed("Android stopped the screen capture. Try again."))
            return false
        }
        if (display == null) {
            frames.close()
            finishFrame(CaptureResult.Failed("Android stopped the screen capture. Try again."))
            return false
        }
        reader = frames
        oldReader?.close()
        return true
    }

    private fun armTimeout() {
        val work = handler ?: return
        timeout?.let { work.removeCallbacks(it) }
        val run = Runnable { finishFrame(CaptureResult.Failed("No picture came from the screen. Try again.")) }
        timeout = run
        work.postDelayed(run, FRAME_WAIT_MS)
    }

    private fun finishFrame(result: CaptureResult) {
        if (!frameFinished.compareAndSet(false, true)) return
        val work = handler
        timeout?.let { work?.removeCallbacks(it) }
        settle?.let { work?.removeCallbacks(it) }
        timeout = null
        settle = null
        val done = pendingDone
        pendingDone = null
        if (!recording.get() || released.get()) closeSurfaces()
        done?.invoke(result)
    }

    /** Stop drawing, release the display, then close the reader. Safe when nothing is open. */
    private fun closeSurfaces() {
        val live = display
        display = null
        if (live != null) {
            try {
                live.setSurface(null)
            } catch (_: RuntimeException) {
                // The display may already have been stopped.
            }
            live.release()
        }
        val frames = reader
        reader = null
        frames?.setOnImageAvailableListener(null, null)
        frames?.close()
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
        recording.set(false)
        main.removeCallbacks(expiry)
        frameFinished.set(true)
        pendingDone = null
        val work = handler
        val teardown = Runnable {
            timeout?.let { handler?.removeCallbacks(it) }
            settle?.let { handler?.removeCallbacks(it) }
            timeout = null
            settle = null
            closeSurfaces()
            val live = projection
            projection = null
            if (live != null) {
                try {
                    live.unregisterCallback(callback)
                } catch (_: RuntimeException) {
                    // Already unregistered.
                }
                try {
                    live.stop()
                } catch (_: RuntimeException) {
                    // Already stopped.
                }
            }
            main.post {
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
                worker?.quitSafely()
            }
        }
        if (work == null || Looper.myLooper() == work.looper) teardown.run() else work.post(teardown)
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
        private const val TAG = "ScoutDebug"
        /** Not the automation notice id (41), so the two foreground services do not replace each other. */
        private const val NOTICE_ID = 48
        private const val STOP_REQUEST = 42
        private const val OPEN_REQUEST = 43
        private const val SETTLE_MS = 250L
        /** Android reports the shared window shortly after the display is created. Wait for that before saving the first frame. */
        private const val FIRST_SIZE_MS = 800L
        private const val FRAME_WAIT_MS = 3_000L
        private const val SAMPLE_MS = 1_500L

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
