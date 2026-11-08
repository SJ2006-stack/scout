package app.scout.companion.automation

import java.util.Locale

data class OfferCard(
    val name: String,
    val size: String?,
    val price: Double?,
    val inStock: Boolean,
    val add: NodeSnapshot?,
    val increment: NodeSnapshot?,
    val quantity: Int?,
)

fun OfferCard.seen(): SeenProduct = SeenProduct(name, size, price, inStock)

sealed class Pick {
    data class Add(val card: OfferCard) : Pick()
    data class Stop(val reason: String, val seen: SeenProduct?) : Pick()
}

fun normName(value: String): String = value.lowercase(Locale.US).replace(Regex("[^a-z0-9]+"), " ").trim()

fun namesMatch(requested: String, card: String, allowSimilar: Boolean): Boolean {
    val left = normName(requested)
    val right = normName(card)
    if (left.isEmpty() || right.isEmpty()) return false
    if (left == right) return true
    if (!allowSimilar) return false
    val words = left.split(" ").filter { it.length > 2 && !it.all { char -> char.isDigit() } }
    return words.isNotEmpty() && words.all { word -> right.contains(word) }
}

fun sizesMatch(requested: String?, card: String?): Boolean {
    if (requested.isNullOrBlank()) return true
    if (card.isNullOrBlank()) return false
    val left = parseQuantity(requested)
    val right = parseQuantity(card)
    if (left != null && right != null) return quantitiesMatch(left, right)
    return normName(requested) == normName(card)
}

/** Cheapest in-stock card that matches the name and size and stays within maxPrice. */
fun choose(cards: List<OfferCard>, item: CartItemRequest, allowSimilar: Boolean): Pick {
    val named = cards.filter { namesMatch(item.name, it.name, allowSimilar) }
    if (named.isEmpty()) return Pick.Stop("no_match", cards.minByOrNull { it.price ?: Double.MAX_VALUE }?.seen())
    val sized = named.filter { sizesMatch(item.size, it.size) }
    if (sized.isEmpty()) return Pick.Stop("size_mismatch", named.first().seen())
    val stocked = sized.filter { it.inStock }
    if (stocked.isEmpty()) return Pick.Stop("out_of_stock", sized.first().seen())
    val affordable = stocked.filter { (it.price ?: Double.MAX_VALUE) <= item.maxPrice }
    if (affordable.isEmpty()) return Pick.Stop("price_above_limit", stocked.minBy { it.price ?: Double.MAX_VALUE }.seen())
    return Pick.Add(affordable.minBy { it.price ?: Double.MAX_VALUE })
}

fun raiseQuantity(runner: StepRunner, target: Int, card: OfferCard, findCard: (NodeSnapshot) -> OfferCard?): Int {
    var current = card
    var qty = current.quantity ?: 0
    if (qty < 1) {
        val add = current.add ?: throw StepFailed("add", "screen_changed", "No add button for ${current.name}")
        runner.click("add", add.clickableAncestor())
        val root = runner.waitUntil("quantity", "screen_changed") { findCard(it)?.let { found -> (found.quantity ?: 0) >= 1 } == true }
        current = findCard(root) ?: throw StepFailed("quantity", "screen_changed", "Lost ${card.name} after add")
        qty = current.quantity ?: 1
    }
    var guard = 0
    while (qty < target) {
        if (guard++ > 20) throw StepFailed("quantity", "screen_changed", "Quantity stopped at $qty")
        val increment = current.increment ?: throw StepFailed("quantity", "screen_changed", "No increment for ${current.name}")
        runner.click("quantity", increment.clickableAncestor())
        val next = qty + 1
        val root = runner.waitUntil("quantity", "screen_changed") { findCard(it)?.let { found -> (found.quantity ?: 0) >= next } == true }
        current = findCard(root) ?: throw StepFailed("quantity", "screen_changed", "Lost ${card.name}")
        qty = current.quantity ?: next
    }
    return qty
}

private val CAPTCHA = Regex("(?i)captcha")
private val SIGN_IN = Regex("(?i)\\b(sign in|log in|login)\\b")
private val ADDRESS = Regex("(?i)(select location|add address|enter your delivery address|set delivery location)")

private val LOCATION_OFF = Regex("(?i)(location permission not enabled|enable device location)")

/** The store's modal asking for the phone's Location switch. Back does not close it. */
fun locationOff(root: NodeSnapshot): Boolean = root.walk().any { LOCATION_OFF.containsMatchIn(it.text) || LOCATION_OFF.containsMatchIn(it.desc) }

fun blockScreen(root: NodeSnapshot, hasProducts: Boolean): String? {
    val blob = root.walk().joinToString("\n") { "${it.text}\n${it.desc}" }
    if (CAPTCHA.containsMatchIn(blob)) return "captcha"
    if (LOCATION_OFF.containsMatchIn(blob)) return "location_off"
    if (hasProducts) return null
    if (SIGN_IN.containsMatchIn(blob)) return "not_signed_in"
    if (ADDRESS.containsMatchIn(blob)) return "no_address"
    return null
}

fun scrollTarget(root: NodeSnapshot): NodeSnapshot {
    return root.walk()
        .filter { it.scrollable && it.bounds.height > 200 && it.bounds.height >= it.bounds.width / 2 }
        .maxByOrNull { it.bounds.height }
        ?: root.walk().firstOrNull { it.scrollable }
        ?: root
}
