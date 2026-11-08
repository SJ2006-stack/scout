package app.scout.companion.automation

fun interface Clock {
    fun now(): Long
}

interface Screen {
    fun root(): NodeSnapshot?
    fun foregroundPackage(): String?
    fun abortedReason(): String?
    fun launch(packageName: String)
    fun openUrl(url: String)

    /** Opens a link inside one package so it does not fall through to Chrome. */
    fun openPackaged(url: String, packageName: String) {
        openUrl(url)
    }

    fun click(node: NodeSnapshot): Boolean
    fun gestureClick(node: NodeSnapshot): Boolean
    fun setText(node: NodeSnapshot, value: String): Boolean
    fun scroll(node: NodeSnapshot, forward: Boolean): Boolean
    fun back()
}

class StepFailed(val step: String, val reason: String, message: String) : Exception(message)

/**
 * Waits for a screen condition, then acts. The clock and pause are injected so tests
 * advance time without sleeping. A missing condition fails with the step name and a reason.
 */
class StepRunner(
    private val screen: Screen,
    private val clock: Clock,
    private val pause: (Long) -> Unit,
    private val expectedPackage: String? = null,
    private val timeoutMs: Long = 8_000,
    private val pollMs: Long = 50,
) {
    private var seenExpected = false

    fun waitUntil(step: String, reason: String, limitMs: Long = timeoutMs, predicate: (NodeSnapshot) -> Boolean): NodeSnapshot {
        val start = clock.now()
        while (true) {
            val root = screen.root()
            notePackage(root)
            val aborted = screen.abortedReason()
            if (aborted != null) throw StepFailed(step, aborted, "Stopped during $step")
            if (leftApp(root)) throw StepFailed(step, "user_stopped", "Left the app during $step")
            if (root != null && predicate(root)) return root
            if (clock.now() - start >= limitMs) throw StepFailed(step, reason, "Timed out waiting for $step")
            pause(pollMs)
        }
    }

    /** Like [waitUntil], but returns the last screen instead of failing when time runs out. */
    fun settle(step: String, limitMs: Long, predicate: (NodeSnapshot) -> Boolean): NodeSnapshot? {
        val start = clock.now()
        var last: NodeSnapshot? = null
        while (true) {
            val root = screen.root()
            notePackage(root)
            screen.abortedReason()?.let { throw StepFailed(step, it, "Stopped during $step") }
            if (leftApp(root)) throw StepFailed(step, "user_stopped", "Left the app during $step")
            if (root != null) last = root
            if (root != null && predicate(root)) return root
            if (clock.now() - start >= limitMs) return last
            pause(pollMs)
        }
    }

    fun click(step: String, node: NodeSnapshot) {
        val blocked = SafetyGuard.refusal(node)
        if (blocked != null) throw StepFailed(step, "refused", "Refused to tap $blocked")
        screen.abortedReason()?.let { throw StepFailed(step, it, "Stopped during $step") }
        if (screen.click(node)) return
        if (screen.gestureClick(node)) return
        throw StepFailed(step, "screen_changed", "Could not tap $step")
    }

    fun setText(step: String, node: NodeSnapshot, value: String) {
        val blocked = SafetyGuard.refusal(node)
        if (blocked != null) throw StepFailed(step, "refused", "Refused to type into $blocked")
        if (!screen.setText(node, value)) throw StepFailed(step, "screen_changed", "Could not type at $step")
    }

    fun scroll(step: String) {
        val root = screen.root() ?: throw StepFailed(step, "screen_changed", "No screen at $step")
        screen.abortedReason()?.let { throw StepFailed(step, it, "Stopped during $step") }
        if (!screen.scroll(scrollTarget(root), true)) throw StepFailed(step, "screen_changed", "Could not scroll at $step")
    }

    fun back(step: String) {
        screen.abortedReason()?.let { throw StepFailed(step, it, "Stopped during $step") }
        screen.back()
    }

    private fun notePackage(root: NodeSnapshot?) {
        val pkg = root?.packageName?.takeIf { it.isNotBlank() } ?: screen.foregroundPackage()?.takeIf { it.isNotBlank() }
        if (expectedPackage != null && pkg == expectedPackage) seenExpected = true
    }

    private fun leftApp(root: NodeSnapshot?): Boolean {
        if (expectedPackage == null || !seenExpected) return false
        val pkg = root?.packageName?.takeIf { it.isNotBlank() } ?: screen.foregroundPackage()?.takeIf { it.isNotBlank() } ?: return false
        return pkg != expectedPackage && !ignoredPackage(pkg)
    }
}
