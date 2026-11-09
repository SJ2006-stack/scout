package app.scout.companion.automation

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.net.Uri
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal fun deviceRunner(screen: Screen, packageName: String): StepRunner {
    return StepRunner(
        screen,
        clock = Clock { android.os.SystemClock.elapsedRealtime() },
        pause = { ms -> if (ms > 0) Thread.sleep(ms) },
        expectedPackage = packageName,
    )
}

/** Live screen behind [Screen]. Unit tests use a fake [Screen] instead of this. */
internal class ServiceScreen(private val service: ScoutAutomationService) : Screen {
    override fun root(): NodeSnapshot? {
        val top = foreground()
        top?.let { service.session.onPackage(it.packageName) }
        return top
    }

    override fun foregroundPackage(): String? = foreground()?.packageName

    override fun abortedReason(): String? = service.session.aborted()

    override fun holding(): Boolean = service.session.userHolding

    override fun launch(packageName: String) {
        val intent = service.packageManager.getLaunchIntentForPackage(packageName) ?: return
        // Zepto hangs on a blank home when its task is cleared. WhatsApp's search is the screen
        // we need, and clearing its task only delays that screen past the wait.
        val flags = if (packageName == ZeptoCart.PACKAGE || packageName == "com.whatsapp" || packageName == "com.whatsapp.w4b") {
            Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
        } else {
            Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        }
        service.startActivity(intent.addFlags(flags))
    }

    override fun openUrl(url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        storePackage(url)?.let { intent.setPackage(it) }
        service.startActivity(intent)
    }

    override fun openPackaged(url: String, packageName: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .setPackage(packageName)
        service.startActivity(intent)
    }

    override fun click(node: NodeSnapshot): Boolean = performing {
        withNode(node) { live -> live.performAction(AccessibilityNodeInfo.ACTION_CLICK) }
    }

    override fun gestureClick(node: NodeSnapshot): Boolean = performing {
        val bounds = node.bounds
        if (bounds.width <= 0 || bounds.height <= 0) {
            false
        } else {
            val x = (bounds.left + bounds.right) / 2f
            val y = (bounds.top + bounds.bottom) / 2f
            val path = Path().apply {
                moveTo(x, y)
                lineTo(x + 1f, y + 1f)
            }
            val stroke = GestureDescription.StrokeDescription(path, 0, 60)
            val gesture = GestureDescription.Builder().addStroke(stroke).build()
            val done = CountDownLatch(1)
            val ok = AtomicBoolean(false)
            val dispatched = service.dispatchGesture(
                gesture,
                object : AccessibilityService.GestureResultCallback() {
                    override fun onCompleted(gestureDescription: GestureDescription?) {
                        ok.set(true)
                        done.countDown()
                    }

                    override fun onCancelled(gestureDescription: GestureDescription?) {
                        done.countDown()
                    }
                },
                null,
            )
            if (!dispatched) {
                false
            } else {
                done.await(2, TimeUnit.SECONDS)
                ok.get()
            }
        }
    }

    override fun setText(node: NodeSnapshot, value: String): Boolean = performing {
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
        }
        withNode(node) { live -> live.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args) }
    }

    override fun scroll(node: NodeSnapshot, forward: Boolean): Boolean {
        val action = if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        if (performing { withNode(node) { live -> live.performAction(action) } }) return true
        return performing { swipe(node, forward) }
    }

    override fun back() {
        service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
    }

    private fun <T> performing(block: () -> T): T {
        service.session.performing = true
        try {
            return block()
        } finally {
            service.session.performing = false
        }
    }

    private fun swipe(node: NodeSnapshot, forward: Boolean): Boolean {
        val bounds = node.bounds
        if (bounds.height <= 0) return false
        val x = (bounds.left + bounds.right) / 2f
        val top = bounds.top + bounds.height * 0.3f
        val bottom = bounds.top + bounds.height * 0.75f
        val path = Path().apply {
            if (forward) {
                moveTo(x, bottom)
                lineTo(x, top)
            } else {
                moveTo(x, top)
                lineTo(x, bottom)
            }
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, 250)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return service.dispatchGesture(gesture, null, null)
    }

    private fun withNode(target: NodeSnapshot, block: (AccessibilityNodeInfo) -> Boolean): Boolean {
        val roots = liveRoots()
        try {
            for (root in roots) {
                val found = find(root, target)
                if (found == null) continue
                val ok = block(found)
                if (found !== root) found.recycle()
                return ok
            }
        } finally {
            roots.forEach { it.recycle() }
        }
        if (target.id.isBlank()) return false
        // The keyboard moves WhatsApp's search box between the snapshot and the type, so the
        // bounds no longer match. One node with that id is still the field.
        val again = liveRoots()
        try {
            for (root in again) {
                val found = findUniqueId(root, target.id) ?: continue
                val ok = block(found)
                found.recycle()
                return ok
            }
        } finally {
            again.forEach { it.recycle() }
        }
        return false
    }

    private fun findUniqueId(node: AccessibilityNodeInfo, id: String): AccessibilityNodeInfo? {
        val matches = ArrayList<AccessibilityNodeInfo>()
        collectId(node, id, matches)
        if (matches.size == 1) return matches[0]
        matches.forEach { it.recycle() }
        return null
    }

    private fun collectId(node: AccessibilityNodeInfo, id: String, out: MutableList<AccessibilityNodeInfo>) {
        val viewId = node.viewIdResourceName?.substringAfterLast('/').orEmpty()
        if (viewId == id) out += AccessibilityNodeInfo.obtain(node)
        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            try {
                collectId(child, id, out)
            } finally {
                child.recycle()
            }
        }
    }

    /**
     * The topmost app's windows, topmost first, under one root. Status bar, HyperOS island,
     * keyboard and other system windows are skipped: they are not the app, and counting them
     * made a near-empty splash screen look like the user had left the app.
     */
    private fun foreground(): NodeSnapshot? {
        val snaps = ArrayList<NodeSnapshot>()
        val windows = service.windows.orEmpty()
            .filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
            .sortedByDescending { it.layer }
        for (window in windows) {
            val info = window.root ?: continue
            try {
                val snap = info.snapshot()
                if (snap.packageName.isNotBlank() && snap.packageName != service.packageName) snaps += snap
            } finally {
                info.recycle()
            }
        }
        if (snaps.isEmpty()) {
            val active = service.rootInActiveWindow ?: return null
            return try {
                val snap = active.snapshot()
                if (snap.packageName == service.packageName) null else snap
            } finally {
                active.recycle()
            }
        }
        val top = snaps.first().packageName
        val same = snaps.filter { it.packageName == top }
        if (same.size == 1) return same.first()
        val bounds = Bounds(
            same.minOf { it.bounds.left },
            same.minOf { it.bounds.top },
            same.maxOf { it.bounds.right },
            same.maxOf { it.bounds.bottom },
        )
        return NodeSnapshot(bounds = bounds, children = same, packageName = top)
    }

    private fun liveRoots(): List<AccessibilityNodeInfo> {
        val roots = ArrayList<AccessibilityNodeInfo>()
        service.rootInActiveWindow?.let { roots += it }
        for (window in service.windows.orEmpty()) {
            window.root?.let { roots += it }
        }
        return roots
    }

    private fun find(node: AccessibilityNodeInfo, target: NodeSnapshot): AccessibilityNodeInfo? {
        if (same(node, target)) return node
        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            val found = find(child, target)
            if (found != null) {
                if (found !== child) child.recycle()
                return found
            }
            child.recycle()
        }
        return null
    }

    private fun same(node: AccessibilityNodeInfo, target: NodeSnapshot): Boolean {
        val rect = Rect()
        node.getBoundsInScreen(rect)
        val id = node.viewIdResourceName?.substringAfterLast('/').orEmpty()
        return id == target.id &&
            rect.left == target.bounds.left &&
            rect.top == target.bounds.top &&
            rect.right == target.bounds.right &&
            rect.bottom == target.bounds.bottom &&
            node.text?.toString().orEmpty() == target.text &&
            node.contentDescription?.toString().orEmpty() == target.desc
    }
}

private fun storePackage(url: String): String? {
    val host = Uri.parse(url).host?.lowercase() ?: return null
    return when {
        host == "blinkit.com" || host.endsWith(".blinkit.com") -> "com.grofers.customerapp"
        host == "zepto.com" || host.endsWith(".zepto.com") -> "com.zeptoconsumerapp"
        host == "instamart.in" || host.endsWith(".instamart.in") -> "in.swiggy.android"
        host == "swiggy.com" || host.endsWith(".swiggy.com") -> "in.swiggy.android"
        host == "in.bookmyshow.com" -> "com.bt.bms"
        host == "www.district.in" -> "com.application.zomato.district"
        host == "luma.com" || host == "www.luma.com" || host == "lu.ma" || host == "www.lu.ma" -> "com.luma.mobile"
        else -> null
    }
}

internal fun AccessibilityNodeInfo.snapshot(): NodeSnapshot {
    val kids = ArrayList<NodeSnapshot>(childCount)
    for (index in 0 until childCount) {
        val child = getChild(index) ?: continue
        try {
            kids += child.snapshot()
        } finally {
            child.recycle()
        }
    }
    val rect = Rect()
    getBoundsInScreen(rect)
    val kind = className?.toString().orEmpty()
    val hint = hintText?.toString().orEmpty()
    return NodeSnapshot(
        id = viewIdResourceName?.substringAfterLast('/').orEmpty(),
        text = text?.toString().orEmpty(),
        desc = contentDescription?.toString().orEmpty(),
        clickable = isClickable,
        scrollable = isScrollable,
        bounds = Bounds(rect.left, rect.top, rect.right, rect.bottom),
        children = kids,
        packageName = packageName?.toString().orEmpty(),
        editable = isEditable || kind.contains("EditText") || hint.isNotBlank(),
        hint = hint,
    )
}
