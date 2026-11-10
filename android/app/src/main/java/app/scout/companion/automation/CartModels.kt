package app.scout.companion.automation

import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

data class CartItemRequest(
    val store: String,
    val productId: String?,
    val link: String?,
    val name: String,
    val size: String?,
    val price: Double,
    val quantity: Int,
    val maxPrice: Double,
)

data class CartRequest(val items: List<CartItemRequest>, val allowSimilar: Boolean, val placeOrder: Boolean = false)

data class Draft(val name: String, val size: String?, val quantity: Int, val unitPrice: Double?)

data class ReadLine(
    val name: String,
    val size: String?,
    val quantity: Int?,
    val unitPrice: Double?,
    val lineTotal: Double?,
)

data class CartLineResult(
    val name: String,
    val size: String?,
    val quantity: Int,
    val unitPrice: Double?,
    val lineTotal: Double?,
)

data class CartBillResult(
    val itemsTotal: Double?,
    val handling: Double?,
    val delivery: Double?,
    val otherFees: Double?,
    val grandTotal: Double?,
)

data class SeenProduct(val name: String, val size: String?, val price: Double?, val inStock: Boolean?)

data class AppCartResult(
    val store: String,
    val added: List<CartLineResult>,
    val cart: CartBillResult?,
    val stoppedAt: String?,
    val reason: String?,
    val seen: SeenProduct?,
    val detail: String? = null,
    val elapsedMs: Long? = null,
)

val CART_REASONS = setOf(
    "no_match",
    "price_above_limit",
    "out_of_stock",
    "size_mismatch",
    "not_signed_in",
    "no_address",
    "app_missing",
    "service_off",
    "screen_changed",
    "timeout",
    "captcha",
    "location_off",
    "user_stopped",
    "payment_pin",
)

fun publicReason(reason: String?): String? = reason?.takeIf { it in CART_REASONS }

fun readCartRequest(args: JSONObject): CartRequest? {
    if (!args.has("allowSimilar")) return null
    val array = args.optJSONArray("items") ?: return null
    if (array.length() !in 1..10) return null
    val items = ArrayList<CartItemRequest>()
    for (index in 0 until array.length()) {
        val item = array.optJSONObject(index) ?: return null
        val ref = item.optJSONObject("ref") ?: return null
        val store = ref.optString("store")
        if (store != "blinkit" && store != "zepto" && store != "instamart") return null
        val name = ref.optString("name").trim()
        if (name.isEmpty() || name.length > 120) return null
        val quantity = item.optInt("quantity", 0)
        if (quantity !in 1..20) return null
        val maxPrice = item.optDouble("maxPrice", Double.NaN)
        if (!maxPrice.isFinite() || maxPrice <= 0 || maxPrice > 100_000) return null
        val size = ref.optString("size").trim().ifEmpty { null }
        val link = ref.optString("link").trim().ifEmpty { null }
        val productId = ref.optString("productId").trim().ifEmpty { null }
        val price = ref.optDouble("price", 0.0)
        items += CartItemRequest(store, productId, link, name, size, price, quantity, maxPrice)
    }
    if (items.map { it.store }.distinct().size != 1) return null
    return CartRequest(items, args.optBoolean("allowSimilar"), args.optBoolean("placeOrder", false))
}

/** Places the order only when this run was a confirmed order. Otherwise the cart is the stop. */
fun finishOrder(
    store: String,
    drafts: List<Draft>,
    lines: List<ReadLine>,
    bill: CartBillResult?,
    request: CartRequest,
    runner: StepRunner,
): AppCartResult {
    if (!request.placeOrder) return finish(store, drafts, lines, bill, null, null, null, null)
    return try {
        when (val outcome = submitOrder(runner)) {
            null -> finish(store, drafts, lines, bill, "ordered", null, null, null)
            "payment_pin" -> finish(store, drafts, lines, bill, "place_order", "payment_pin", null, null)
            else -> finish(store, drafts, lines, bill, "place_order", outcome, null, "The items are in the cart. The order button was not on screen.")
        }
    } catch (failed: StepFailed) {
        finish(store, drafts, lines, bill, failed.step, failed.reason, null, failed.message)
    }
}

fun finish(
    store: String,
    drafts: List<Draft>,
    lines: List<ReadLine>,
    bill: CartBillResult?,
    stoppedAt: String?,
    reason: String?,
    seen: SeenProduct?,
    detail: String?,
): AppCartResult {
    val added = drafts.map { draft ->
        val line = lines.firstOrNull { namesMatch(draft.name, it.name, allowSimilar = false) }
        val quantity = line?.quantity ?: draft.quantity
        val lineTotal = line?.lineTotal ?: draft.unitPrice?.let { roundMoney(it * quantity) }
        val unit = line?.unitPrice ?: when {
            lineTotal != null && quantity > 0 -> roundMoney(lineTotal / quantity)
            else -> draft.unitPrice
        }
        CartLineResult(line?.name ?: draft.name, line?.size ?: draft.size, quantity, unit, lineTotal)
    }
    return AppCartResult(store, added, bill, stoppedAt, publicReason(reason), seen, detail)
}

fun cartStatus(result: AppCartResult): String = when (result.reason) {
    null -> if (result.added.isNotEmpty()) "completed" else "failed"
    "price_above_limit", "out_of_stock", "size_mismatch", "not_signed_in", "no_address" -> "needs_approval"
    "service_off", "location_off" -> "needs_permission"
    "user_stopped", "payment_pin" -> "handoff_started"
    else -> "failed"
}

private fun addedMessage(store: String, result: AppCartResult): String {
    val total = result.cart?.grandTotal?.let { " Cart total ${money(it)}." } ?: ""
    val line = result.added.singleOrNull()
    return if (line != null) "Added ${line.quantity} × ${line.name} to $store.$total" else "Added ${result.added.sumOf { it.quantity }} items to $store.$total"
}

fun cartMessage(result: AppCartResult): String {
    val store = storeLabel(result.store)
    return when (result.reason) {
        null -> when {
            result.stoppedAt == "ordered" && result.added.isNotEmpty() -> "Placed the order on $store.${result.cart?.grandTotal?.let { " Cart total ${money(it)}." } ?: ""} Scout does not enter a UPI PIN."
            result.added.isNotEmpty() -> addedMessage(store, result)
            else -> result.detail ?: "Scout stopped at ${result.stoppedAt ?: "the cart"}."
        }
        "price_above_limit" -> {
            val name = result.seen?.name ?: "That item"
            val price = result.seen?.price?.let { money(it) }
            if (price == null) "$name is above your limit." else "$name is $price, above your limit."
        }
        "out_of_stock" -> "${result.seen?.name ?: "That item"} is out of stock on $store."
        "size_mismatch" -> "${result.seen?.name ?: "That item"} is ${result.seen?.size ?: "a different size"}."
        "not_signed_in" -> "$store needs a sign-in before Scout can add items."
        "no_address" -> "$store has no delivery address. Scout will not change it."
        "app_missing" -> "$store is not installed."
        "service_off" -> "Turn on Scout's Accessibility service to add items."
        "screen_changed" -> "$store changed at ${result.stoppedAt ?: "a step"}."
        "timeout" -> "$store timed out at ${result.stoppedAt ?: "a step"}."
        "captcha" -> "$store is showing a captcha."
        "location_off" -> "Turn on Location on your phone. $store will not continue without it."
        "user_stopped" -> "You stopped Scout on $store."
        "payment_pin" -> "The order is waiting on a UPI PIN or code on $store. Enter that yourself. Scout does not type it."
        "no_match" -> if (result.seen != null) "No match on $store. Saw ${result.seen.name}." else "No match on $store."
        else -> result.detail ?: "Scout could not finish the $store cart."
    }
}

fun AppCartResult.toJson(): JSONObject {
    val rows = JSONArray()
    for (line in added) {
        rows.put(
            JSONObject()
                .put("name", line.name)
                .put("size", line.size ?: JSONObject.NULL)
                .put("quantity", line.quantity)
                .put("unitPrice", line.unitPrice ?: JSONObject.NULL)
                .put("lineTotal", line.lineTotal ?: JSONObject.NULL),
        )
    }
    val bill = if (cart == null) {
        JSONObject.NULL
    } else {
        JSONObject()
            .put("itemsTotal", cart.itemsTotal ?: JSONObject.NULL)
            .put("handling", cart.handling ?: JSONObject.NULL)
            .put("delivery", cart.delivery ?: JSONObject.NULL)
            .put("otherFees", cart.otherFees ?: JSONObject.NULL)
            .put("grandTotal", cart.grandTotal ?: JSONObject.NULL)
    }
    val seenJson = if (seen == null) {
        JSONObject.NULL
    } else {
        JSONObject()
            .put("name", seen.name)
            .put("size", seen.size ?: JSONObject.NULL)
            .put("price", seen.price ?: JSONObject.NULL)
            .put("inStock", seen.inStock ?: JSONObject.NULL)
    }
    return JSONObject()
        .put("store", store)
        .put("added", rows)
        .put("cart", bill)
        .put("stoppedAt", stoppedAt ?: JSONObject.NULL)
        .put("reason", reason ?: JSONObject.NULL)
        .put("seen", seenJson)
        .put("elapsedMs", elapsedMs ?: JSONObject.NULL)
}

fun storeLabel(store: String): String = when (store) {
    "blinkit" -> "Blinkit"
    "zepto" -> "Zepto"
    "instamart" -> "Instamart"
    else -> store.replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.US) else it.toString() }
}

fun money(value: Double): String {
    val text = String.format(Locale.US, "%.2f", value).trimEnd('0').trimEnd('.')
    return "₹$text"
}

fun roundMoney(value: Double): Double = kotlin.math.round(value * 100.0) / 100.0

fun rupees(raw: String): List<Double> {
    val cleaned = raw.replace("\u200a", "").replace("\u00a0", " ")
    return Regex("""₹\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)""").findAll(cleaned).map { match ->
        match.groupValues[1].replace(",", "").toDouble()
    }.toList()
}

fun lastRupee(raw: String): Double? = rupees(raw).lastOrNull()
