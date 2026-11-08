package app.scout.companion

sealed class ApiPlan {
    data class Ready(
        val method: String,
        val path: String,
        val authorization: String,
        val body: String,
        val log: String,
    ) : ApiPlan()

    data class Blocked(val reason: String) : ApiPlan()
}

private val BODY_USER = Regex("\"(?:userId|uid)\"\\s*:\\s*\"([^\"]*)\"")

fun planRequest(
    firebaseUid: String,
    firebaseToken: String,
    device: DeviceRecord?,
    method: String,
    path: String,
    body: String,
    background: Boolean,
): ApiPlan {
    if (firebaseUid.isBlank() || firebaseToken.isBlank()) {
        return ApiPlan.Blocked("Sign in before calling Scout.")
    }
    if (device == null || device.userId != firebaseUid || device.revoked) {
        return ApiPlan.Blocked("This device is not allowed.")
    }
    val claimed = BODY_USER.find(body)?.groupValues?.get(1)
    if (claimed != null && claimed != firebaseUid) {
        return ApiPlan.Blocked("That user does not match the signed-in account.")
    }
    if (background && (path.startsWith("/api/browser") || path == "/api/pay")) {
        return ApiPlan.Blocked("That stays on the server.")
    }
    val log = if (path.contains("/code")) "Sending a code for a bound task." else "$method $path"
    return ApiPlan.Ready(method, path, "Bearer $firebaseToken", body, log)
}
