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
    fun sendsTheTokenAsJson() {
        assertEquals("""{"idToken":"abc\"def"}""", googleSignInBody("abc\"def"))
    }
}
