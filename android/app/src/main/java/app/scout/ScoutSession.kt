package app.scout

import java.net.HttpURLConnection
import java.net.URL

/** The Set-Cookie from a person's own Google sign-in, shaped for the WebView. */
fun webViewSessionCookie(setCookie: String?): String? {
    if (setCookie.isNullOrBlank()) return null
    val parts = setCookie.split(";").map { it.trim() }.filter { it.isNotEmpty() }
    val pair = parts.firstOrNull() ?: return null
    val id = pair.removePrefix("scout_session=")
    if (!pair.startsWith("scout_session=") || !Regex("^[a-f0-9]{32}$").matches(id)) return null
    val maxAge = parts.firstOrNull { it.startsWith("Max-Age=") } ?: "Max-Age=34560000"
    return "$pair; $maxAge; Path=/"
}

/** The main host serves the public landing page at `/`, so the app opens the chat on its own path. */
fun deskStartUrl(origin: String): String = origin.trimEnd('/') + "/chat"

/** Azure's front end adds its own ARRAffinity cookies, so the session is picked out of every Set-Cookie header. */
fun sessionFromSetCookies(headers: List<String>): String? = headers.firstNotNullOfOrNull { webViewSessionCookie(it) }

fun googleSignInBody(idToken: String): String {
    val escaped = buildString(idToken.length) {
        for (char in idToken) {
            when (char) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                else -> append(char)
            }
        }
    }
    return """{"idToken":"$escaped"}"""
}

/** Trades this person's Firebase ID token for their Scout session cookie. Null when Scout refuses it. */
fun exchangeGoogleSession(origin: String, idToken: String): String? {
    if (idToken.isBlank()) return null
    val connection = (URL(origin.trimEnd('/') + "/api/auth/google").openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = 8_000
        readTimeout = 8_000
        doOutput = true
        setRequestProperty("content-type", "application/json")
    }
    return try {
        connection.outputStream.use { it.write(googleSignInBody(idToken).toByteArray()) }
        if (connection.responseCode !in 200..299) return null
        sessionFromSetCookies(connection.headerFields.entries.filter { it.key.equals("Set-Cookie", ignoreCase = true) }.flatMap { it.value })
    } catch (_: Exception) {
        null
    } finally {
        connection.disconnect()
    }
}
