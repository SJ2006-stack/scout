package app.scout

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeskHostsTest {
    @Test
    fun keepsScoutPagesInTheApp() {
        assertFalse(leavesScout("http://127.0.0.1:8787/"))
        assertFalse(leavesScout("https://scout.shrianshjaiswal.me/event-scout"))
        assertFalse(leavesScout("https://sj-food-scout.azurewebsites.net/"))
        assertTrue(isScoutHost("10.0.2.2"))
    }

    @Test
    fun sendsListingLinksOut() {
        assertTrue(leavesScout("https://www.district.in/events/"))
        assertTrue(leavesScout("https://in.bookmyshow.com/movies"))
        assertFalse(isScoutHost("luma.com"))
    }
}
