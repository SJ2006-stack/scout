package app.scout

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ScoutSessionTest {
    @Test
    fun keepsOnlyThatPersonsSessionCookie() {
        val id = "a".repeat(32)
        assertEquals(
            "scout_session=$id; Max-Age=34560000; Path=/",
            webViewSessionCookie("scout_session=$id; HttpOnly; SameSite=Lax; Path=/; Max-Age=34560000"),
        )
        assertNull(webViewSessionCookie("theme=dark"))
        assertNull(webViewSessionCookie("scout_session=shared"))
    }

    @Test
    fun findsTheSessionAmongAzureAffinityCookies() {
        val id = "b".repeat(32)
        val headers = listOf(
            "ARRAffinity=abc123; Path=/; HttpOnly; Secure; Domain=scout.shrianshjaiswal.me",
            "ARRAffinitySameSite=abc123; Path=/; HttpOnly; SameSite=None; Secure; Domain=scout.shrianshjaiswal.me",
            "scout_session=$id; HttpOnly; SameSite=Lax; Path=/; Max-Age=34560000",
        )
        assertEquals("scout_session=$id; Max-Age=34560000; Path=/", sessionFromSetCookies(headers))
        assertNull(sessionFromSetCookies(headers.take(2)))
        assertNull(sessionFromSetCookies(emptyList()))
    }

    @Test
    fun opensTheChatRatherThanTheLandingPage() {
        assertEquals("https://scout.shrianshjaiswal.me/chat", deskStartUrl("https://scout.shrianshjaiswal.me"))
        assertEquals("http://127.0.0.1:8787/chat", deskStartUrl("http://127.0.0.1:8787/"))
    }

    @Test
    fun sendsTheTokenAsJson() {
        assertEquals("""{"idToken":"abc\"def"}""", googleSignInBody("abc\"def"))
    }
}
