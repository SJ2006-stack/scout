package app.scout.companion

import android.app.Activity
import android.app.ActivityManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Looper

enum class CheckoutIdle { Cart, Launch }

enum class CheckoutMove { Resume, Cart, Launch, Missing, Unknown }

data class CheckoutTarget(
    val app: String,
    val packageName: String,
    val cartUrl: String?,
    val idle: CheckoutIdle,
)

/**
 * Cart and event handoff. Hosts were read with dumpsys package on the attached phone, Nov 4, 2026.
 * Blinkit claims https://blinkit.com/cart, but a cold start drops that link, so an idle task is launched.
 * Zepto claims https://www.zepto.com/cart. Instamart does not claim /checkout or /instamart/cart
 * (both open Chrome), so only in.swiggy.android is brought forward. Event apps are brought forward
 * so a seat hold stays on screen.
 */
val CHECKOUT_TARGETS: List<CheckoutTarget> = listOf(
    CheckoutTarget("blinkit", "com.grofers.customerapp", "https://blinkit.com/cart", CheckoutIdle.Launch),
    CheckoutTarget("zepto", "com.zeptoconsumerapp", "https://www.zepto.com/cart", CheckoutIdle.Cart),
    CheckoutTarget("instamart", "in.swiggy.android", null, CheckoutIdle.Launch),
    CheckoutTarget("flipkart", "com.flipkart.android", "https://www.flipkart.com/viewcart", CheckoutIdle.Cart),
    CheckoutTarget("amazon", "in.amazon.mShop.android.shopping", "https://www.amazon.in/gp/cart/view.html", CheckoutIdle.Cart),
    CheckoutTarget("bookmyshow", "com.bt.bms", null, CheckoutIdle.Launch),
    CheckoutTarget("district", "com.application.zomato.district", null, CheckoutIdle.Launch),
    CheckoutTarget("luma", "com.luma.mobile", null, CheckoutIdle.Launch),
)

fun checkoutTarget(app: String): CheckoutTarget? = CHECKOUT_TARGETS.find { it.app == app }

/** A running task is resumed. Otherwise the cart link is opened with the app pinned, or the app is launched. */
fun checkoutMove(app: String, installed: Boolean, taskRunning: Boolean): CheckoutMove {
    val target = checkoutTarget(app) ?: return CheckoutMove.Unknown
    if (!installed) return CheckoutMove.Missing
    if (taskRunning) return CheckoutMove.Resume
    if (target.idle == CheckoutIdle.Cart && target.cartUrl != null) return CheckoutMove.Cart
    return CheckoutMove.Launch
}

/** Opens the app and returns at once. app_missing when that package is not installed. */
fun beginCheckout(context: Context, app: String): String {
    val target = checkoutTarget(app) ?: return checkoutJson(false, "failed")
    val launch = context.packageManager.getLaunchIntentForPackage(target.packageName)
        ?: return checkoutJson(false, "app_missing")
    val running = taskRunning(context, target.packageName)
    val intent = when (checkoutMove(app, installed = true, taskRunning = running)) {
        CheckoutMove.Cart -> target.cartUrl?.let { cartIntent(target.packageName, it) } ?: launch
        CheckoutMove.Resume, CheckoutMove.Launch -> launch.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        }
        CheckoutMove.Missing, CheckoutMove.Unknown -> null
    } ?: return checkoutJson(false, "app_missing")
    startCheckout(context, intent)
    return checkoutJson(true, "opened")
}

@Suppress("DEPRECATION")
internal fun taskRunning(context: Context, packageName: String): Boolean {
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
    val alive = manager.runningAppProcesses?.any { info ->
        info.processName == packageName || info.pkgList?.contains(packageName) == true
    } == true
    if (alive) return true
    return manager.getRunningTasks(30).any { task ->
        task.baseActivity?.packageName == packageName || task.topActivity?.packageName == packageName
    }
}

private fun cartIntent(packageName: String, url: String): Intent {
    return Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
        setPackage(packageName)
        addCategory(Intent.CATEGORY_DEFAULT)
        addCategory(Intent.CATEGORY_BROWSABLE)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}

private fun startCheckout(context: Context, intent: Intent) {
    val start = Runnable {
        try {
            context.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
        }
    }
    if (context is Activity && Looper.myLooper() != Looper.getMainLooper()) context.runOnUiThread(start) else start.run()
}

private fun checkoutJson(accepted: Boolean, status: String): String {
    return """{"accepted":$accepted,"op":"open_checkout","status":"$status"}"""
}
