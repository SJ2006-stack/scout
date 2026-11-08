package app.scout.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CheckoutHandoffTest {
    @Test
    fun parsesOpenCheckoutForAKnownApp() {
        val decision = allowBridge("127.0.0.1", """{"op":"open_checkout","app":"zepto"}""", 0L)
        assertTrue(decision is BridgeDecision.Allow)
        val call = (decision as BridgeDecision.Allow).call
        assertTrue(call is BridgeCall.Checkout)
        assertEquals("zepto", (call as BridgeCall.Checkout).app)
    }

    @Test
    fun signOutIsOnlyForScoutPages() {
        val decision = allowBridge("scout.shrianshjaiswal.me", """{"op":"sign_out"}""", 0L)
        assertEquals(BridgeCall.SignOut, (decision as BridgeDecision.Allow).call)
        assertTrue(allowBridge("evil.example", """{"op":"sign_out"}""", 0L) is BridgeDecision.Deny)
    }

    @Test
    fun rejectsCheckoutFromOutsideAndUnknownApps() {
        assertTrue(allowBridge("evil.example", """{"op":"open_checkout","app":"zepto"}""", 0L) is BridgeDecision.Deny)
        assertTrue(allowBridge("127.0.0.1", """{"op":"open_checkout","app":"chrome"}""", 0L) is BridgeDecision.Deny)
        assertTrue(allowBridge("127.0.0.1", """{"op":"open_checkout"}""", 0L) is BridgeDecision.Deny)
        assertTrue(allowBridge("127.0.0.1", """{"op":"payment","url":"https://blinkit.com/cart"}""", 0L) is BridgeDecision.Deny)
    }

    @Test
    fun choosesACartLinkOrTheRunningTask() {
        assertEquals("https://blinkit.com/cart", checkoutTarget("blinkit")?.cartUrl)
        assertEquals(CheckoutIdle.Launch, checkoutTarget("blinkit")?.idle)
        assertEquals(CheckoutMove.Launch, checkoutMove("blinkit", installed = true, taskRunning = false))
        assertEquals(CheckoutMove.Resume, checkoutMove("blinkit", installed = true, taskRunning = true))

        assertEquals("https://www.zepto.com/cart", checkoutTarget("zepto")?.cartUrl)
        assertEquals(CheckoutMove.Cart, checkoutMove("zepto", installed = true, taskRunning = false))
        assertEquals(CheckoutMove.Resume, checkoutMove("zepto", installed = true, taskRunning = true))

        assertNull(checkoutTarget("instamart")?.cartUrl)
        assertEquals("in.swiggy.android", checkoutTarget("instamart")?.packageName)
        assertEquals(CheckoutMove.Launch, checkoutMove("instamart", installed = true, taskRunning = false))
        assertEquals(CheckoutMove.Resume, checkoutMove("instamart", installed = true, taskRunning = true))

        assertEquals("https://www.flipkart.com/viewcart", checkoutTarget("flipkart")?.cartUrl)
        assertEquals(CheckoutMove.Cart, checkoutMove("flipkart", installed = true, taskRunning = false))
        assertEquals("https://www.amazon.in/gp/cart/view.html", checkoutTarget("amazon")?.cartUrl)
        assertEquals(CheckoutMove.Cart, checkoutMove("amazon", installed = true, taskRunning = false))

        assertNull(checkoutTarget("bookmyshow")?.cartUrl)
        assertEquals("com.bt.bms", checkoutTarget("bookmyshow")?.packageName)
        assertEquals(CheckoutMove.Resume, checkoutMove("bookmyshow", installed = true, taskRunning = true))
        assertEquals("com.application.zomato.district", checkoutTarget("district")?.packageName)
        assertEquals(CheckoutMove.Launch, checkoutMove("district", installed = true, taskRunning = false))
        assertEquals("com.luma.mobile", checkoutTarget("luma")?.packageName)
        assertEquals(CheckoutMove.Launch, checkoutMove("luma", installed = true, taskRunning = false))

        assertEquals(CheckoutMove.Missing, checkoutMove("zepto", installed = false, taskRunning = false))
        assertEquals(CheckoutMove.Unknown, checkoutMove("chrome", installed = true, taskRunning = true))
    }
}
