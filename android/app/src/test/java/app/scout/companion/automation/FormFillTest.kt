package app.scout.companion.automation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FormFillTest {
    @Test
    fun fillsNamedFieldsAndSubmitsWithoutTouchingPay() {
        val root = form()
        val plan = planFormFill(root, formValues("Ada Lovelace", "ada@gmail.com", "+919800000000", "city is Delhi"), true)
        assertEquals(listOf("Ada Lovelace", "ada@gmail.com", "Delhi"), plan.writes.map { it.second })
        assertEquals("Submit", plan.button?.text)
    }

    @Test
    fun leavesAFormAloneWhenNothingWasAskedToSend() {
        val plan = planFormFill(form(), formValues("Ada", "ada@gmail.com", "", ""), false)
        assertEquals(2, plan.writes.size)
        assertNull(plan.button)
    }

    @Test
    fun skipsPasswordsAndTheScoutAppItself() {
        val secret = NodeSnapshot(text = "Password", bounds = Bounds(0, 0, 100, 40))
        val box = NodeSnapshot(editable = true, bounds = Bounds(0, 50, 100, 100))
        val chrome = NodeSnapshot(packageName = "com.android.chrome", children = listOf(secret, box))
        assertTrue(planFormFill(chrome, formValues("", "", "", "password is hunter2"), true).writes.isEmpty())
        val scout = NodeSnapshot(packageName = "app.scout", children = listOf(secret, box))
        assertTrue(planFormFill(scout, formValues("Ada", "", "", ""), true).writes.isEmpty())
    }

    @Test
    fun doesNotRetypeAValueThatIsAlreadyThere() {
        val label = NodeSnapshot(text = "Email", bounds = Bounds(0, 0, 100, 30))
        val filled = NodeSnapshot(text = "ada@gmail.com", editable = true, bounds = Bounds(0, 40, 100, 90))
        val root = NodeSnapshot(packageName = "com.android.chrome", children = listOf(label, filled))
        assertTrue(planFormFill(root, formValues("", "ada@gmail.com", "", ""), false).writes.isEmpty())
    }

    private fun form(): NodeSnapshot {
        return NodeSnapshot(
            packageName = "com.android.chrome",
            children = listOf(
                NodeSnapshot(text = "Full name", bounds = Bounds(0, 0, 400, 40)),
                NodeSnapshot(editable = true, hint = "Your answer", bounds = Bounds(0, 50, 400, 120)),
                NodeSnapshot(text = "Email", bounds = Bounds(0, 140, 400, 180)),
                NodeSnapshot(editable = true, bounds = Bounds(0, 190, 400, 260)),
                NodeSnapshot(text = "City", bounds = Bounds(0, 280, 400, 320)),
                NodeSnapshot(editable = true, bounds = Bounds(0, 330, 400, 400)),
                NodeSnapshot(text = "Pay now", clickable = true, bounds = Bounds(0, 420, 200, 480)),
                NodeSnapshot(text = "Submit", clickable = true, bounds = Bounds(0, 500, 200, 560)),
            ),
        )
    }
}
