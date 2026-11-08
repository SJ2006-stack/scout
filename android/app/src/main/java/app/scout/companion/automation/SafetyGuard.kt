package app.scout.companion.automation

/**
 * Checked before every tap. A hit is the phrase or id Scout must not activate.
 * "Checkout" as a cart title is allowed. Pay, place order, and the Blinkit pay button are not.
 */
object SafetyGuard {
    private val FORBIDDEN = Regex(
        "(?i)(\\bplace\\s+order\\b|proceed\\s+to\\s+pay|\\bpay\\s+now\\b|make\\s+payment|\\bconfirm\\s+booking\\b|auto[\\s-]?pay|\\bmandate\\b|\\bsubscribe\\b|save\\s+card|\\bupi\\s+pin\\b|\\bcvv\\b|\\bpay\\b|instant\\s+order|cash\\s+on\\s+delivery|\\bbuy\\s+now\\b)",
    )

    fun refusal(node: NodeSnapshot): String? {
        if (isDismissControl(node)) return null
        val considered = ArrayList<NodeSnapshot>()
        node.walk().forEach { considered += it }
        var ancestor = node.parent
        while (ancestor != null) {
            considered += ancestor
            ancestor = ancestor.parent
        }
        for (candidate in considered) {
            if (candidate.id == "cv_checkout_container" || candidate.id == "cart-pay-button") return candidate.id
            if (candidate.id == "tv_action_text" && candidate.text.contains("place order", ignoreCase = true)) return "Place Order"
            val hit = FORBIDDEN.find("${candidate.text} ${candidate.desc}")?.value?.trim()
            if (!hit.isNullOrEmpty()) return hit
        }
        return null
    }
}

private val DISMISS = Regex("(?i)^(close|cancel|skip for now|not now|maybe later|no thanks|skip)$")
private val PROMO = Regex("(?i)(swiggy one|join .{0,40}at just|nectr|grab on instamart|unlimited free deliver)")

/** A close or skip control on an ad or membership sheet. Not the search-clear button, and not Pay. */
fun isDismissControl(node: NodeSnapshot): Boolean {
    if (node.id == "close") return true
    return DISMISS.matches(node.text.trim()) || DISMISS.matches(node.desc.trim())
}

fun promoDismiss(root: NodeSnapshot): NodeSnapshot? {
    val nodes = root.walk().toList()
    // Swiggy's full-screen offers are one picture and a close button, with no text to match.
    val pictureOnly = nodes.any { it.id == "widget_image" } && nodes.none { it.label().isNotBlank() }
    if (!pictureOnly) {
        val blob = nodes.joinToString("\n") { "${it.text}\n${it.desc}" }
        if (!PROMO.containsMatchIn(blob)) return null
    }
    return nodes.firstOrNull { isDismissControl(it) }
}
