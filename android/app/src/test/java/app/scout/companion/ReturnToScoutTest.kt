package app.scout.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReturnToScoutTest {
    @Test
    fun aFinishedTaskComesBackAndAHandoffStays() {
        assertTrue(shouldReturnToScout("completed"))
        assertTrue(shouldReturnToScout("failed"))
        assertTrue(shouldReturnToScout("needs_approval"))
        assertFalse(shouldReturnToScout("handoff_started"))
    }
}
