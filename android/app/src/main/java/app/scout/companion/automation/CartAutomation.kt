package app.scout.companion.automation

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import org.json.JSONObject

val AUTOMATION_PACKAGES: Map<String, String> = linkedMapOf(
    "blinkit" to "com.grofers.customerapp",
    "zepto" to "com.zeptoconsumerapp",
    "instamart" to "in.swiggy.android",
    "bookmyshow" to "com.bt.bms",
    "district" to "com.application.zomato.district",
    "luma" to "com.luma.mobile",
)

object CartAutomation {
    fun run(context: Context, request: CartRequest): AppCartResult {
        val store = request.items.firstOrNull()?.store ?: return unsupported("blinkit")
        if (!serviceOn(context)) return AppCartResult(store, emptyList(), null, null, "service_off", null)
        val packageName = AUTOMATION_PACKAGES[store]
        if (packageName == null || !installed(context, packageName)) {
            return AppCartResult(store, emptyList(), null, null, "app_missing", null)
        }
        if (store != "blinkit" && store != "zepto" && store != "instamart") return unsupported(store)
        val service = ScoutAutomationService.connected ?: return AppCartResult(store, emptyList(), null, null, "service_off", null)
        return RunQueue.run {
            val screen = ServiceScreen(service)
            service.beginRun(packageName)
            val started = SystemClock.elapsedRealtime()
            try {
                val ran = when (store) {
                    "blinkit" -> BlinkitCart.run(screen, request, deviceRunner(screen, packageName))
                    "zepto" -> ZeptoCart.run(screen, request, deviceRunner(screen, packageName))
                    "instamart" -> InstamartCart.run(screen, request, deviceRunner(screen, packageName))
                    else -> unsupported(store)
                }
                val result = ran.copy(elapsedMs = SystemClock.elapsedRealtime() - started)
                if (result.stoppedAt != null) logStop(screen, result)
                result
            } finally {
                service.endRun()
            }
        }
    }

    fun capabilities(context: Context): JSONObject {
        val found = AUTOMATION_PACKAGES.mapValues { (_, packageName) -> installedVersion(context, packageName) }
        return automationJson(serviceOn(context), found)
    }

    fun serviceOn(context: Context): Boolean {
        val resolver = context.contentResolver
        if (Settings.Secure.getInt(resolver, Settings.Secure.ACCESSIBILITY_ENABLED, 0) != 1) return false
        val enabled = Settings.Secure.getString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val flat = ComponentName(context, ScoutAutomationService::class.java).flattenToString()
        return enabled.split(':').any { it.equals(flat, ignoreCase = true) }
    }
}

fun automationJson(serviceOn: Boolean, apps: Map<String, Pair<Boolean, String?>>): JSONObject {
    val listed = JSONObject()
    for (name in AUTOMATION_PACKAGES.keys) {
        val (installed, version) = apps[name] ?: (false to null)
        listed.put(name, JSONObject().put("installed", installed).put("version", version ?: JSONObject.NULL))
    }
    return JSONObject().put("serviceOn", serviceOn).put("apps", listed)
}

/** Ids and node count only: no product, price, or address text leaves the phone's log. */
private fun logStop(screen: Screen, result: AppCartResult) {
    val root = screen.root()
    val nodes = root?.walk()?.toList().orEmpty()
    val ids = nodes.map { it.id }.filter { it.isNotBlank() }.distinct().take(12).joinToString(",")
    Log.i("ScoutDebug", "stop store=${result.store} step=${result.stoppedAt} reason=${result.reason} pkg=${root?.packageName} nodes=${nodes.size} ids=$ids")
}

private fun unsupported(store: String): AppCartResult {
    return AppCartResult(store, emptyList(), null, "unsupported", null, null, "${storeLabel(store)} cart automation is not in this build.")
}

private fun installed(context: Context, packageName: String): Boolean = installedVersion(context, packageName).first

@Suppress("DEPRECATION")
private fun installedVersion(context: Context, packageName: String): Pair<Boolean, String?> {
    return try {
        val info = context.packageManager.getPackageInfo(packageName, 0)
        true to info.versionName
    } catch (_: PackageManager.NameNotFoundException) {
        false to null
    }
}
