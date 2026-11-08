package app.scout.screen

import org.json.JSONObject

/** Why a screen session ended. [word] is what the page sees. */
enum class ScreenEnd(val word: String) {
    DENIED("denied"),
    NOTICES("notifications"),
    STOPPED("stopped"),
    SYSTEM("system"),
    EXPIRED("expired"),
    FAILED("failed"),
    SIGNED_OUT("signed_out"),
}

data class FrameSize(val width: Int, val height: Int, val dpi: Int)

sealed class CaptureResult {
    data class Saved(val shotId: String) : CaptureResult()
    data class Failed(val message: String) : CaptureResult()
}

/** The live MediaProjection, held by the foreground service. */
interface Shutter {
    /** Grabs one frame and saves it. Calls [done] exactly once, on any thread. */
    fun capture(size: FrameSize, done: (CaptureResult) -> Unit)

    /** Stops the projection and frees the display. Safe to call more than once. */
    fun release()
}

data class ScreenNotice(val state: String, val reason: String? = null, val message: String? = null) {
    fun json(): String {
        val payload = JSONObject().put("op", "screen").put("state", state)
        if (reason != null) payload.put("reason", reason)
        if (message != null) payload.put("message", message)
        return payload.toString()
    }
}

/**
 * One screen capture at a time, from the user's tap to one saved frame:
 * idle -> asking (Android's consent screen) -> starting (service is taking the projection)
 * -> waiting (projection held, nothing captured) -> capturing (one frame) -> idle.
 *
 * Every session has its own id and needs its own consent. A consent answer, a service start,
 * or a capture tap that does not match the current session is refused, so an old result or an
 * old notification can never reuse a projection. The projection is released as soon as one
 * frame is saved, the user stops, Android stops it, or [LIVE_MS] passes without a capture.
 */
class ScreenSession(private val now: () -> Long, private val newId: () -> String) {
    private sealed class Phase(val id: String, val owner: String) {
        class Asking(id: String, owner: String) : Phase(id, owner)
        class Starting(id: String, owner: String) : Phase(id, owner)
        class Live(id: String, owner: String, val shutter: Shutter, val since: Long) : Phase(id, owner)
        class Capturing(id: String, owner: String, val shutter: Shutter, val done: (Boolean, String?) -> Unit) : Phase(id, owner)
    }

    private var phase: Phase? = null
    private var last: ScreenNotice? = null
    private var listener: ((ScreenNotice) -> Unit)? = null

    @Synchronized
    fun listen(next: ((ScreenNotice) -> Unit)?) {
        listener = next
    }

    @Synchronized
    fun state(): String = when (phase) {
        null -> "idle"
        is Phase.Asking -> "asking"
        is Phase.Starting -> "starting"
        is Phase.Live -> "waiting"
        is Phase.Capturing -> "capturing"
    }

    /** How the last session ended, until a new one begins. */
    @Synchronized
    fun lastNotice(): ScreenNotice? = last

    @Synchronized
    fun owner(): String? = phase?.owner

    @Synchronized
    fun currentId(): String? = phase?.id

    /** The session waiting on Android's consent screen, if any. */
    @Synchronized
    fun asking(): String? = (phase as? Phase.Asking)?.id

    /** Starts a session for [owner] when nothing else is running. A second tap while one runs is refused. */
    fun begin(owner: String): String? {
        val id: String
        synchronized(this) {
            if (phase != null) return null
            id = newId()
            phase = Phase.Asking(id, owner)
            last = null
        }
        tell(ScreenNotice("asking"))
        return id
    }

    /** Android's consent answer. Counts once: a second answer for the same session is refused. */
    fun answer(id: String, granted: Boolean): Boolean {
        synchronized(this) {
            val current = phase as? Phase.Asking ?: return false
            if (current.id != id) return false
            if (granted) phase = Phase.Starting(id, current.owner)
        }
        if (!granted) {
            stop(id, ScreenEnd.DENIED)
            return false
        }
        tell(ScreenNotice("starting"))
        return true
    }

    /** The service holds the projection. False means the session moved on and [shutter] must be released. */
    fun started(id: String, shutter: Shutter): Boolean {
        synchronized(this) {
            val current = phase as? Phase.Starting ?: return false
            if (current.id != id) return false
            phase = Phase.Live(id, current.owner, shutter, now())
        }
        tell(ScreenNotice("waiting"))
        return true
    }

    /** The user tapped Capture. Grabs one frame, then releases the projection whatever happens. */
    fun shoot(id: String, size: FrameSize, done: (Boolean, String?) -> Unit): Boolean {
        val shutter: Shutter
        synchronized(this) {
            val current = phase as? Phase.Live ?: return false
            if (current.id != id) return false
            shutter = current.shutter
            phase = Phase.Capturing(id, current.owner, shutter, done)
        }
        tell(ScreenNotice("capturing"))
        shutter.capture(size) { result ->
            when (result) {
                is CaptureResult.Saved -> finishShot(id)
                is CaptureResult.Failed -> stop(id, ScreenEnd.FAILED, result.message)
            }
        }
        return true
    }

    /** Ends the session [id], or whichever is running when [id] is null. */
    fun stop(id: String?, end: ScreenEnd, message: String? = null): Boolean {
        val ended: Phase
        val notice = ScreenNotice("ended", end.word, message)
        synchronized(this) {
            val current = phase ?: return false
            if (id != null && current.id != id) return false
            ended = current
            phase = null
            last = notice
        }
        when (ended) {
            is Phase.Live -> ended.shutter.release()
            is Phase.Capturing -> {
                ended.shutter.release()
                ended.done(false, message)
            }
            is Phase.Asking, is Phase.Starting -> Unit
        }
        tell(notice)
        return true
    }

    /** Ends a session that has waited [LIVE_MS] for a capture. */
    fun expire(): Boolean {
        val id = synchronized(this) {
            val current = phase as? Phase.Live ?: return false
            if (now() - current.since < LIVE_MS) return false
            current.id
        }
        return stop(id, ScreenEnd.EXPIRED)
    }

    private fun finishShot(id: String) {
        val ended: Phase.Capturing
        val notice = ScreenNotice("captured")
        synchronized(this) {
            val current = phase as? Phase.Capturing ?: return
            if (current.id != id) return
            ended = current
            phase = null
            last = notice
        }
        ended.shutter.release()
        ended.done(true, null)
        tell(notice)
    }

    private fun tell(notice: ScreenNotice) {
        val target = synchronized(this) { listener }
        target?.invoke(notice)
    }

    companion object {
        /** A session that captured nothing for this long is stopped. */
        const val LIVE_MS = 3 * 60_000L
    }
}
