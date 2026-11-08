package app.scout.companion

import app.scout.isScoutHost
import java.net.URI

const val SPEECH_PATH = "/api/voice/stt"

sealed class SpeechResult {
    data class Heard(val text: String) : SpeechResult()
    data class Failed(val message: String) : SpeechResult()
}

fun speechUrl(origin: String): String? {
    val trimmed = origin.trim().trimEnd('/')
    val uri = try {
        URI(trimmed)
    } catch (_: Exception) {
        return null
    }
    val scheme = uri.scheme?.lowercase() ?: return null
    val host = uri.host ?: return null
    if (!isScoutHost(host)) return null
    if (scheme == "https") return "$trimmed$SPEECH_PATH"
    if (scheme == "http" && (host == "127.0.0.1" || host == "localhost" || host == "10.0.2.2")) {
        return "$trimmed$SPEECH_PATH"
    }
    return null
}

fun speechMessage(status: Int, body: String): SpeechResult {
    val text = jsonField(body, "text")?.trim().orEmpty()
    if (status in 200..299 && text.isNotEmpty()) return SpeechResult.Heard(text)
    val error = jsonField(body, "error")?.trim().orEmpty()
    if (error.isNotEmpty()) return SpeechResult.Failed(error)
    return SpeechResult.Failed("Speech could not be read.")
}
