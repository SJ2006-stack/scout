package app.scout

import android.net.Uri

private val PAY_SCHEMES = setOf("upi", "tez", "gpay", "phonepe", "paytmmp", "bhim")

fun payTarget(raw: String): Uri? {
    val uri = try {
        Uri.parse(raw.trim())
    } catch (_: Exception) {
        return null
    }
    val scheme = uri.scheme?.lowercase() ?: return null
    if (scheme in PAY_SCHEMES) return uri
    if (scheme == "https" && !uri.host.isNullOrBlank()) return uri
    return null
}
