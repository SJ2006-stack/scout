package app.scout.companion.automation

import android.os.SystemClock
import java.util.concurrent.atomic.AtomicBoolean

/** Live-run flags. Events are ignored unless [active] is set for an approved run. */
class RunSession(private val now: () -> Long = { SystemClock.elapsedRealtime() }) {
    @Volatile var active: Boolean = false
    @Volatile var performing: Boolean = false
    /** True after Take control. Scout pauses, and taps and typing in the other app do not stop the run. */
    @Volatile var userHolding: Boolean = false
    @Volatile var abortReason: String? = null
    @Volatile var expectedPackage: String? = null
    private val seenTarget = AtomicBoolean(false)
    private var ignoreTouchUntil = 0L

    fun begin(packageName: String) {
        abortReason = null
        userHolding = false
        expectedPackage = packageName
        seenTarget.set(false)
        ignoreTouchUntil = now() + 2_000
        active = true
    }

    fun end() {
        active = false
        userHolding = false
        expectedPackage = null
        performing = false
    }

    fun stop() {
        if (active) abortReason = "user_stopped"
    }

    /** Pauses taps and typing so the person can use the other app. Stop still ends the run. */
    fun takeControl() {
        if (active && abortReason == null) userHolding = true
    }

    /** Hands the other app back to Scout. The Resume tap itself does not count as stopping. */
    fun resumeScout() {
        if (!active) return
        userHolding = false
        ignoreTouchUntil = now() + CHROME_GRACE_MS
    }

    /** A tap on the control bar, so it is not read as the person using the other app. */
    fun noteChromeTouch() {
        ignoreTouchUntil = now() + CHROME_GRACE_MS
    }

    fun onUserTouch() {
        if (userHolding) return
        if (now() < ignoreTouchUntil) return
        if (active && !performing && abortReason == null) abortReason = "user_stopped"
    }

    fun onPackage(packageName: String?) {
        if (!active || userHolding || packageName.isNullOrBlank()) return
        val expected = expectedPackage ?: return
        if (packageName == expected) {
            seenTarget.set(true)
            return
        }
        if (!seenTarget.get() || abortReason != null) return
        if (ignoredPackage(packageName)) return
        abortReason = "user_stopped"
    }

    fun aborted(): String? = if (active) abortReason else null
}

private const val CHROME_GRACE_MS = 700L

internal fun ignoredPackage(packageName: String): Boolean {
    return packageName == "android" ||
        packageName.contains("systemui") ||
        packageName == "com.milink.service" ||
        packageName == "app.scout" ||
        packageName.contains("permissioncontroller")
}
