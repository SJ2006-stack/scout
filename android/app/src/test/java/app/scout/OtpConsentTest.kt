package app.scout

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class OtpConsentTest {
    @Test
    fun readsTheSixDigitCodeAndIgnoresLongerNumbers() {
        val message = "Scout code 918273. Helpline 1800123456."
        assertEquals("918273", readConsentOtp(message))
    }

    @Test
    fun readsAShorterCodeWhenNoSixDigitCodeIsPresent() {
        assertEquals("1234", readConsentOtp("Your OTP is 1234."))
        assertNull(readConsentOtp("No code in this message."))
    }

    @Test
    fun fillScriptQuotesTheCode() {
        val script = otpFillScript("918273")
        assert(script.contains("\"918273\""))
        assertFalse(script.contains("918273."))
    }
}
