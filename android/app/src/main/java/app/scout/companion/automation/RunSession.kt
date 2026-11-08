package app.scout.companion.automation

import android.os.SystemClock
import java.util.concurrent.atomic.AtomicBoolean

/** Live-run flags. Events are ignored unless [active] is set for an approved run. */
class RunSession {
    @Volatile var active: Boolean = false
    @Volatile var performing: Boolean = false
    @Volatile var abortReason: String? = null
    @Volatile var expectedPackage: String? = null
    private val seenTarget = AtomicBoolean(false)
    private var ignoreTouchUntil = 0L

    fun begin(packageName: String) {
        abortReason = null
        expectedPackage = packageName
        seenTarget.set(false)
        ignoreTouchUntil = SystemClock.elapsedRealtime() + 2_000
        active = true
    }

    fun end() {
        active = false
        expectedPackage = null
        performing = false
    }

    fun stop() {
        if (active) abortReason = "user_stopped"
    }

    fun onUserTouch() {
        if (SystemClock.elapsedRealtime() < ignoreTouchUntil) return
        if (active && !performing && abortReason == null) abortReason = "user_stopped"
    }

    fun onPackage(packageName: String?) {
        if (!active || packageName.isNullOrBlank()) return
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

internal fun ignoredPackage(packageName: String): Boolean {
    return packageName == "android" ||
        packageName.contains("systemui") ||
        packageName == "com.milink.service" ||
        packageName == "app.scout" ||
        packageName.contains("permissioncontroller")
}
