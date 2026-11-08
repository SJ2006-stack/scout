package app.scout.companion

import app.scout.drop.DROP_ID
import app.scout.isScoutHost
import app.scout.leavesScout
import app.scout.readPairPayload

sealed class QrRead {
    data class Page(val url: String) : QrRead()
    data class PairCode(val code: String) : QrRead()
    data class Reject(val message: String) : QrRead()
}

sealed class BridgeCall {
    data object DropTake : BridgeCall()
    data class DropImage(val dropId: String, val imageId: String) : BridgeCall()
    data class DropDone(val dropId: String) : BridgeCall()
    data object Location : BridgeCall()
    data object Microphone : BridgeCall()
    data object Camera : BridgeCall()
    data class Qr(val read: QrRead) : BridgeCall()
    data object Notification : BridgeCall()
    data class Share(val text: String) : BridgeCall()
    data object Biometric : BridgeCall()
    data object Permissions : BridgeCall()
    data class Checkout(val app: String) : BridgeCall()
}

sealed class BridgeDecision {
    data class Allow(val call: BridgeCall) : BridgeDecision()
    data object Deny : BridgeDecision()
}

private val BLOCKED = setOf("filesystem", "credentials", "payment", "browser", "eval", "sms", "cookie")

fun readDeviceQr(text: String, now: Long): QrRead {
    val trimmed = text.trim()
    if (trimmed.startsWith("https://") && !leavesScout(trimmed)) return QrRead.Page(trimmed)
    val pair = readPairPayload(trimmed, now)
    if (pair is app.scout.PairRead.Ok && pair.fresh) return QrRead.PairCode(pair.code)
    return QrRead.Reject("That code is not a Scout page.")
}

fun allowBridge(host: String?, json: String, now: Long): BridgeDecision {
    if (!isScoutHost(host)) return BridgeDecision.Deny
    val op = jsonField(json, "op") ?: return BridgeDecision.Deny
    if (op in BLOCKED) return BridgeDecision.Deny
    return when (op) {
        "drop_take" -> BridgeDecision.Allow(BridgeCall.DropTake)
        "drop_file" -> dropImageCall(json)
        "drop_done" -> dropDoneCall(json)
        "location" -> BridgeDecision.Allow(BridgeCall.Location)
        "microphone" -> BridgeDecision.Allow(BridgeCall.Microphone)
        "camera" -> BridgeDecision.Allow(BridgeCall.Camera)
        "notification" -> BridgeDecision.Allow(BridgeCall.Notification)
        "biometric" -> BridgeDecision.Allow(BridgeCall.Biometric)
        "permissions" -> BridgeDecision.Allow(BridgeCall.Permissions)
        "share" -> shareCall(json)
        "qr" -> qrCall(json, now)
        "open_checkout" -> checkoutCall(json)
        else -> BridgeDecision.Deny
    }
}

fun bridgeResponse(decision: BridgeDecision): String {
    return when (decision) {
        is BridgeDecision.Allow -> """{"accepted":true}"""
        BridgeDecision.Deny -> """{"accepted":false}"""
    }
}

private fun shareCall(json: String): BridgeDecision {
    val text = jsonField(json, "text") ?: return BridgeDecision.Deny
    if (text.isBlank() || text.length > 500) return BridgeDecision.Deny
    if (text.contains("file://") || text.contains("content://")) return BridgeDecision.Deny
    return BridgeDecision.Allow(BridgeCall.Share(text))
}

private fun qrCall(json: String, now: Long): BridgeDecision {
    val payload = jsonField(json, "payload") ?: return BridgeDecision.Deny
    val read = readDeviceQr(payload, now)
    if (read is QrRead.Reject) return BridgeDecision.Deny
    return BridgeDecision.Allow(BridgeCall.Qr(read))
}

private fun checkoutCall(json: String): BridgeDecision {
    val app = jsonField(json, "app") ?: return BridgeDecision.Deny
    if (checkoutTarget(app) == null) return BridgeDecision.Deny
    return BridgeDecision.Allow(BridgeCall.Checkout(app))
}

private fun dropImageCall(json: String): BridgeDecision {
    val dropId = jsonField(json, "id")?.takeIf { DROP_ID.matches(it) } ?: return BridgeDecision.Deny
    val imageId = jsonField(json, "image")?.takeIf { DROP_ID.matches(it) } ?: return BridgeDecision.Deny
    return BridgeDecision.Allow(BridgeCall.DropImage(dropId, imageId))
}

private fun dropDoneCall(json: String): BridgeDecision {
    val dropId = jsonField(json, "id")?.takeIf { DROP_ID.matches(it) } ?: return BridgeDecision.Deny
    return BridgeDecision.Allow(BridgeCall.DropDone(dropId))
}

fun jsonField(json: String, key: String): String? {
    val match = Regex(""""$key"\s*:\s*"((?:\\.|[^"\\])*)"""").find(json) ?: return null
    return match.groupValues[1].replace("\\\"", "\"").replace("\\\\", "\\")
}
