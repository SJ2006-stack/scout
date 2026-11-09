package app.scout.companion.automation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IgnoredPackageTest {
    @Test
    fun hyperOsOverlaysDoNotCountAsLeavingTheApp() {
        assertTrue(ignoredPackage("miui.systemui.plugin"))
        assertTrue(ignoredPackage("com.android.systemui"))
        assertTrue(ignoredPackage("com.milink.service"))
        assertFalse(ignoredPackage("com.miui.home"))
        assertFalse(ignoredPackage("com.android.chrome"))
    }
}

class QuantityTest {
    @Test
    fun matchesWeightSpellings() {
        assertMatch("500g", "500 g")
        assertMatch("500 g", "500 gm")
        assertMatch("500 gm", "0.5 kg")
        assertEquals(500.0, parseQuantity("500g")!!.amount, 0.001)
        assertEquals("g", parseQuantity("0.5 kg")!!.unit)
    }

    @Test
    fun matchesVolume() {
        assertMatch("1 l", "1000 ml")
        assertMatch("1 ltr", "1000 ml")
        assertEquals("ml", parseQuantity("1 l")!!.unit)
        assertEquals(1000.0, parseQuantity("1 l")!!.amount, 0.001)
    }

    @Test
    fun matchesPackCounts() {
        assertMatch("5 pcs", "5 pc")
        assertMatch("1 piece", "1 pieces")
        assertMatch("50 x 1 pcs", "50 pcs")
        assertEquals("pcs", parseQuantity("5 pcs")!!.unit)
    }

    @Test
    fun multipliesPacks() {
        assertMatch("2 x 500 g", "1 kg")
        assertMatch("500 ml x 2", "1 l")
    }

    @Test
    fun rejectsADifferentSize() {
        assertFalse(quantitiesMatch(parseQuantity("500 g"), parseQuantity("100 g")))
        assertFalse(quantitiesMatch(parseQuantity("1 l"), parseQuantity("500 g")))
        assertFalse(quantitiesMatch(parseQuantity("1 pc"), null))
    }

    private fun assertMatch(left: String, right: String) {
        assertTrue("$left vs $right", quantitiesMatch(parseQuantity(left), parseQuantity(right)))
    }
}

class SafetyGuardTest {
    @Test
    fun refusesPaymentControls() {
        val phrases = listOf(
            "Pay",
            "Place Order",
            "Proceed to pay",
            "Pay now",
            "Make payment",
            "Confirm booking",
            "Autopay",
            "auto-pay",
            "Mandate",
            "Subscribe",
            "Save card",
            "UPI PIN",
            "CVV",
            "Pay ₹88",
        )
        for (phrase in phrases) {
            assertTrue(phrase, SafetyGuard.refusal(NodeSnapshot(text = phrase)) != null)
        }
    }

    @Test
    fun refusesBlinkitCheckoutByIdAndByLabel() {
        val place = NodeSnapshot(id = "tv_action_text", text = "Place Order")
        val inner = NodeSnapshot(id = "inner")
        val checkout = NodeSnapshot(id = "cv_checkout_container", clickable = true, children = listOf(inner))
        val pay = NodeSnapshot(id = "cart-pay-button", desc = "Pay ₹88", clickable = true)
        assertEquals("Place Order", SafetyGuard.refusal(place))
        assertEquals("cv_checkout_container", SafetyGuard.refusal(checkout))
        assertEquals("cv_checkout_container", SafetyGuard.refusal(inner))
        assertEquals("cart-pay-button", SafetyGuard.refusal(pay))
    }

    @Test
    fun allowsAddQuantityAndTheCartTitle() {
        assertNull(SafetyGuard.refusal(NodeSnapshot(id = "tv_title", desc = "ADD", clickable = true)))
        assertNull(SafetyGuard.refusal(NodeSnapshot(id = "icon_increment", desc = "Increase quantity", clickable = true)))
        assertNull(SafetyGuard.refusal(NodeSnapshot(text = "View cart")))
        assertNull(SafetyGuard.refusal(NodeSnapshot(desc = "Checkout")))
        assertNull(SafetyGuard.refusal(NodeSnapshot(text = "Papaya")))
        assertNull(SafetyGuard.refusal(NodeSnapshot(text = "PAYING VIA")))
        assertNull(SafetyGuard.refusal(NodeSnapshot(text = "payment offers")))
    }

    @Test
    fun doesNotTapARefusedControl() {
        val screen = RecordingScreen(NodeSnapshot(text = "Place Order", clickable = true))
        val runner = runner(screen)
        try {
            runner.click("pay", screen.root()!!)
            error("tap should have been refused")
        } catch (failed: StepFailed) {
            assertEquals("pay", failed.step)
            assertEquals("refused", failed.reason)
        }
        assertEquals(0, screen.clicks)
        assertEquals(0, screen.gestures)
    }
}

class StepRunnerTest {
    @Test
    fun doesNotSleepWhenTheScreenIsAlreadyReady() {
        val screen = RecordingScreen(NodeSnapshot(text = "home", packageName = "com.grofers.customerapp"))
        var slept = 0
        val clock = ManualClock()
        val runner = StepRunner(screen, clock, pause = { slept += 1; clock.time += it }, expectedPackage = "com.grofers.customerapp")
        runner.waitUntil("home", "timeout") { it.text == "home" }
        assertEquals(0, slept)
    }

    @Test
    fun namesTheStepWhenTheScreenNeverArrives() {
        val clock = ManualClock()
        val runner = StepRunner(
            RecordingScreen(NodeSnapshot(packageName = "com.grofers.customerapp")),
            clock,
            pause = { clock.time += it },
            timeoutMs = 200,
            pollMs = 100,
        )
        try {
            runner.waitUntil("results", "screen_changed") { false }
            error("wait should time out")
        } catch (failed: StepFailed) {
            assertEquals("results", failed.step)
            assertEquals("screen_changed", failed.reason)
        }
    }

    @Test
    fun fallsBackToAGestureWhenClickDoesNothing() {
        val screen = RecordingScreen(NodeSnapshot(desc = "ADD", clickable = true), clickSucceeds = false)
        runner(screen).click("add", screen.root()!!)
        assertEquals(1, screen.clicks)
        assertEquals(1, screen.gestures)
    }

    @Test
    fun waitsWhileTheUserHasControl() {
        val screen = RecordingScreen(NodeSnapshot(text = "home", packageName = "com.grofers.customerapp"))
        screen.holding = true
        val clock = ManualClock()
        var polls = 0
        val runner = StepRunner(
            screen,
            clock,
            pause = {
                polls += 1
                clock.time += it
                if (polls == 4) {
                    screen.holding = false
                    screen.root = NodeSnapshot(text = "ready", packageName = "com.grofers.customerapp")
                }
            },
            expectedPackage = "com.grofers.customerapp",
            timeoutMs = 120,
            pollMs = 50,
        )
        val found = runner.waitUntil("results", "screen_changed") { it.text == "ready" }
        assertEquals("ready", found.text)
        assertTrue(clock.time >= 200)
    }

    @Test
    fun leavingWhileInControlDoesNotStopUntilScoutResumes() {
        val screen = RecordingScreen(NodeSnapshot(text = "home", packageName = "com.grofers.customerapp"))
        val clock = ManualClock()
        var polls = 0
        val runner = StepRunner(
            screen,
            clock,
            pause = {
                polls += 1
                clock.time += it
                if (polls == 1) {
                    screen.holding = true
                    screen.root = NodeSnapshot(text = "elsewhere", packageName = "com.whatsapp")
                }
                if (polls == 3) screen.holding = false
            },
            expectedPackage = "com.grofers.customerapp",
            timeoutMs = 5_000,
            pollMs = 50,
        )
        runner.waitUntil("home", "timeout") { it.text == "home" }
        try {
            runner.waitUntil("results", "timeout") { false }
            error("leaving after Resume should stop the run")
        } catch (failed: StepFailed) {
            assertEquals("user_stopped", failed.reason)
        }
        assertTrue(polls >= 3)
    }

    @Test
    fun stopsWhenTheUserLeavesTheApp() {
        val screen = RecordingScreen(NodeSnapshot(text = "home", packageName = "com.grofers.customerapp"))
        val clock = ManualClock()
        val runner = StepRunner(
            screen,
            clock,
            pause = { clock.time += it },
            expectedPackage = "com.grofers.customerapp",
            timeoutMs = 500,
        )
        runner.waitUntil("home", "timeout") { it.text == "home" }
        screen.root = NodeSnapshot(text = "elsewhere", packageName = "com.whatsapp")
        try {
            runner.waitUntil("results", "timeout") { false }
            error("leaving the app should stop the run")
        } catch (failed: StepFailed) {
            assertEquals("user_stopped", failed.reason)
            assertEquals("results", failed.step)
        }
    }
}

class RunSessionControlTest {
    @Test
    fun takeControlLetsTheUserTouchWithoutStopping() {
        var time = 0L
        val session = RunSession { time }
        session.begin("com.grofers.customerapp")
        assertFalse(session.userHolding)
        session.takeControl()
        session.onUserTouch()
        assertTrue(session.userHolding)
        assertNull(session.aborted())
        session.resumeScout()
        assertFalse(session.userHolding)
        session.onUserTouch()
        assertNull(session.aborted())
        time = 800
        session.onUserTouch()
        assertEquals("user_stopped", session.aborted())
    }

    @Test
    fun stopStillEndsARunTheUserIsControlling() {
        val session = RunSession { 0L }
        session.begin("com.whatsapp")
        session.takeControl()
        session.stop()
        assertEquals("user_stopped", session.aborted())
    }
}

class RunQueueTest {
    @Test
    fun runsOneCartAtATime() {
        val running = java.util.concurrent.atomic.AtomicInteger(0)
        val peak = java.util.concurrent.atomic.AtomicInteger(0)
        val start = java.util.concurrent.CountDownLatch(1)
        val done = java.util.concurrent.CountDownLatch(2)
        repeat(2) {
            Thread {
                start.await()
                RunQueue.run {
                    val now = running.incrementAndGet()
                    peak.updateAndGet { current -> maxOf(current, now) }
                    Thread.sleep(40)
                    running.decrementAndGet()
                }
                done.countDown()
            }.start()
        }
        start.countDown()
        assertTrue(done.await(5, java.util.concurrent.TimeUnit.SECONDS))
        assertEquals(1, peak.get())
    }
}

internal class ManualClock(var time: Long = 0) : Clock {
    override fun now(): Long = time
}

internal class RecordingScreen(
    var root: NodeSnapshot,
    private val clickSucceeds: Boolean = true,
    var abort: String? = null,
) : Screen {
    var clicks = 0
    var gestures = 0
    var holding = false
    override fun holding(): Boolean = holding
    override fun root(): NodeSnapshot = root
    override fun foregroundPackage(): String = root.packageName
    override fun abortedReason(): String? = abort
    override fun launch(packageName: String) {}
    override fun openUrl(url: String) {}
    override fun click(node: NodeSnapshot): Boolean {
        clicks += 1
        return clickSucceeds
    }
    override fun gestureClick(node: NodeSnapshot): Boolean {
        gestures += 1
        return true
    }
    override fun setText(node: NodeSnapshot, value: String): Boolean = true
    override fun scroll(node: NodeSnapshot, forward: Boolean): Boolean = true
    override fun back() {}
}

internal fun runner(screen: Screen): StepRunner {
    val clock = ManualClock()
    return StepRunner(screen, clock, pause = { clock.time += it })
}
