package app.scout

import java.net.URI

private val SCOUT_AZURE = Regex("^sj-(event|travel|food|shop|home|appointments)-scout\\.azurewebsites\\.net$")

fun isScoutHost(host: String?): Boolean {
    if (host == null) return false
    val name = host.lowercase().removeSuffix(".")
    if (name == "localhost" || name == "127.0.0.1" || name == "10.0.2.2") return true
    if (name == "scout.shrianshjaiswal.me" || name == "sj-scout.azurewebsites.net") return true
    return SCOUT_AZURE.matches(name)
}

fun leavesScout(url: String): Boolean {
    val uri = try {
        URI(url)
    } catch (_: Exception) {
        return true
    }
    val scheme = uri.scheme?.lowercase() ?: return true
    if (scheme != "http" && scheme != "https") return true
    return !isScoutHost(uri.host)
}
