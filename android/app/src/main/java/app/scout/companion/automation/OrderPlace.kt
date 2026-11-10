package app.scout.companion.automation

private val PIN = Regex("(?i)(upi\\s*pin|enter\\s+(?:your\\s+)?pin|\\bcvv\\b|\\botp\\b|one[- ]time|passcode|password)")
private val ORDER_LABEL = Regex("(?i)^place\\s+order$")

/** The store's order button. A PIN, code, or password control is never returned. */
fun orderButton(root: NodeSnapshot): NodeSnapshot? {
    val match = root.walk().firstOrNull { node ->
        val label = "${node.text} ${node.desc}"
        if (PIN.containsMatchIn(label)) return@firstOrNull false
        node.id == "cart-pay-button" ||
            node.id == "cv_checkout_container" ||
            (node.id == "tv_action_text" && node.text.contains("place order", ignoreCase = true)) ||
            ORDER_LABEL.matches(node.label())
    } ?: return null
    return match.clickableAncestor()
}

fun asksForPin(root: NodeSnapshot): Boolean = root.walk().any { PIN.containsMatchIn("${it.text} ${it.desc}") }

/**
 * Taps the order button after the cart is filled. Null means the tap went through.
 * "payment_pin" means the app then asked for a PIN or code. "screen_changed" means the button was not there.
 */
fun submitOrder(runner: StepRunner): String? {
    var seen = runner.settle("place_order", 2_000) { orderButton(it) != null }
    if (seen == null || orderButton(seen) == null) {
        runner.scroll("place_order")
        seen = runner.settle("place_order", 1_500) { orderButton(it) != null }
    }
    val button = seen?.let { orderButton(it) } ?: return "screen_changed"
    runner.confirmOrder("place_order", button)
    val after = runner.settle("placed", 3_000) { asksForPin(it) }
    return if (after != null && asksForPin(after)) "payment_pin" else null
}
