package app.scout.companion.automation

import android.util.Log
import java.net.URLEncoder

object InstamartCart {
    const val PACKAGE = "in.swiggy.android"
    private val OUT = Regex("(?i)(out of stock|sold out|not in stock|not available|unavailable|notify me)")
    private val PRODUCT = Regex(
        """https://(?:www\.)?(?:instamart\.in|swiggy\.com/instamart)/item/([^/?#]+)""",
        RegexOption.IGNORE_CASE,
    )
    private val SIZE = Regex("(?i)^\\d+(?:\\.\\d+)?\\s*(?:kg|g|gm|grams|ml|l|ltr|pc|pcs|pack|piece|pieces|bunch)$")
    private val LINE = Regex("""^(.*),\s+(.*?),\s+quantity\s+(\d+),\s+price\s+(\d+(?:\.\d+)?)\s+rupees?$""", RegexOption.IGNORE_CASE)
    private val ADDRESS = Regex("(?i)add address to proceed")

    fun destination(item: CartItemRequest): String {
        val link = item.link
        if (!link.isNullOrBlank()) {
            val id = PRODUCT.find(link)?.groupValues?.getOrNull(1)
            if (!id.isNullOrBlank()) return "https://instamart.in/item/$id"
        }
        val query = listOfNotNull(item.name.takeIf { it.isNotBlank() }, item.size?.takeIf { it.isNotBlank() }).joinToString(" ")
        return "https://instamart.in/search?query=" + URLEncoder.encode(query, "UTF-8").replace("+", "%20")
    }

    fun isHome(root: NodeSnapshot): Boolean {
        val nodes = root.walk().toList()
        val hint = nodes.any {
            it.id == "search_query_hint_layout" || it.id == "pre_search_query_hint" || it.desc.equals("Search for products", ignoreCase = true)
        }
        val typing = nodes.any { it.id == "et_search_query_v2" }
        return hint && !typing
    }

    fun cards(root: NodeSnapshot): List<OfferCard> {
        val found = ArrayList<OfferCard>()
        for (nameNode in root.walk()) {
            if (nameNode.id != "item_description" || nameNode.label().isBlank()) continue
            val card = shelfCard(nameNode) ?: continue
            val blob = card.walk().joinToString(" ") { "${it.text} ${it.desc}" }
            val quantity = card.walk().firstOrNull { it.id.startsWith("quantity_text") && it.text.trim().toIntOrNull() != null }
            found += OfferCard(
                name = nameNode.label(),
                size = card.walk().firstOrNull { it.id.isEmpty() && SIZE.matches(it.text.trim()) }?.text?.trim(),
                price = card.walk().firstOrNull { it.id == "selling_price" }?.let { lastRupee(it.label()) },
                inStock = !OUT.containsMatchIn(blob) && (
                    card.walk().any { it.id == "add_to_cart" } || card.walk().any { it.id == "increment_button_touch_target" }
                    ),
                add = card.walk().firstOrNull { it.id == "add_to_cart" },
                increment = card.walk().firstOrNull { it.id == "increment_button_touch_target" },
                quantity = quantity?.text?.trim()?.toIntOrNull(),
            )
        }
        for (nameNode in root.walk()) {
            if (nameNode.id != "tvItemName" || nameNode.label().isBlank()) continue
            val card = widgetCard(nameNode) ?: continue
            val blob = card.walk().joinToString(" ") { "${it.text} ${it.desc}" }
            val qtyText = card.walk().firstOrNull { it.id.startsWith("quantity_text") }?.text?.trim()
            val quantity = qtyText?.toIntOrNull()
            found += OfferCard(
                name = nameNode.label(),
                size = card.walk().firstOrNull { it.id == "tvItemWeight" }?.text?.trim(),
                price = card.walk().firstOrNull { it.id == "tvItemPrice" }?.let { lastRupee(it.label()) },
                inStock = !OUT.containsMatchIn(blob) && card.walk().any { it.id == "add_button" || it.id == "increment_button_touch_target" },
                add = if (quantity == null) card.walk().firstOrNull { it.id == "add_button" } else null,
                increment = card.walk().firstOrNull { it.id == "increment_button_touch_target" },
                quantity = quantity,
            )
        }
        return found.distinctBy { "${it.name}|${it.size}|${it.price}" }
    }

    fun cartLines(root: NodeSnapshot): List<ReadLine> {
        val lines = ArrayList<ReadLine>()
        for (node in root.walk()) {
            val parsed = LINE.find(node.text.trim()) ?: continue
            val quantity = parsed.groupValues[3].toInt()
            val total = parsed.groupValues[4].toDouble()
            lines += ReadLine(
                name = parsed.groupValues[1].trim(),
                size = parsed.groupValues[2].trim().ifBlank { null },
                quantity = quantity,
                unitPrice = if (quantity > 0) roundMoney(total / quantity) else total,
                lineTotal = total,
            )
        }
        return lines.distinctBy { "${it.name}|${it.size}|${it.lineTotal}" }
    }

    fun billOf(root: NodeSnapshot): CartBillResult? {
        val texts = root.walk().map { it.text.trim() }.filter { it.isNotEmpty() }.toList()
        fun after(label: String): Double? {
            val index = texts.indexOfFirst { it.equals(label, ignoreCase = true) }
            if (index < 0) return null
            return texts.getOrNull(index + 1)?.let { lastRupee(it) }
        }
        val items = after("Item Total")
        val grand = after("To Pay")
        if (items == null && grand == null) return null
        return CartBillResult(items, after("Handling Fee"), after("Delivery Partner Fee"), after("Delivery Partner Tip"), grand)
    }

    fun needsAddress(root: NodeSnapshot): Boolean = root.walk().any { ADDRESS.containsMatchIn(it.desc) || ADDRESS.containsMatchIn(it.text) }

    fun run(screen: Screen, request: CartRequest, runner: StepRunner): AppCartResult {
        val store = request.items.firstOrNull()?.store ?: "instamart"
        val drafts = ArrayList<Draft>()
        var lines = emptyList<ReadLine>()
        var bill: CartBillResult? = null
        try {
            screen.launch(PACKAGE)
            for (item in request.items) {
                val results = openShelf(screen, runner, destination(item))
                val found = cards(results)
                blockScreen(results, found.isNotEmpty())?.let { reason ->
                    return finish(store, drafts, lines, bill, "results", reason, null, null)
                }
                if (found.isEmpty()) return finish(store, drafts, lines, bill, "results", "no_match", null, null)
                when (val pick = choose(found, item, request.allowSimilar)) {
                    is Pick.Stop -> return finish(store, drafts, lines, bill, "results", pick.reason, pick.seen, null)
                    is Pick.Add -> {
                        val quantity = raiseQuantity(runner, item.quantity, pick.card) { root ->
                            cards(root).firstOrNull { namesMatch(pick.card.name, it.name, false) && sizesMatch(pick.card.size, it.size) }
                        }
                        drafts += Draft(pick.card.name, pick.card.size, quantity, pick.card.price)
                    }
                }
            }
            val bar = runner.waitUntil("view_cart", "screen_changed") { cartBar(it) != null }
            runner.click("view_cart", cartBar(bar)!!.clickableAncestor())
            dismissPromos(runner)
            var cart = runner.waitUntil("cart", "screen_changed") { cartLines(it).isNotEmpty() || billOf(it)?.grandTotal != null }
            lines = cartLines(cart)
            bill = billOf(cart)
            var scrolls = 0
            while (bill?.grandTotal == null && scrolls < 4) {
                runner.scroll("bill")
                cart = runner.settle("bill", 1_500) { billOf(it)?.grandTotal != null } ?: break
                if (lines.isEmpty()) lines = cartLines(cart)
                bill = billOf(cart)
                scrolls += 1
            }
            if (needsAddress(cart)) {
                return finish(store, drafts, lines, bill, "cart", "no_address", null, null)
            }
            return finishOrder(store, drafts, lines, bill, request, runner)
        } catch (failed: StepFailed) {
            if (failed.step == "results") {
                val seen = screen.root()
                val ids = seen?.walk()?.map { it.id }?.filter { it.isNotBlank() }?.distinct()?.take(8)?.joinToString(",")
                Log.i("ScoutDebug", "home miss pkg=${seen?.packageName} fg=${screen.foregroundPackage()} home=${seen?.let { isHome(it) }} ids=$ids")
            }
            return finish(store, drafts, lines, bill, failed.step, failed.reason, null, failed.message)
        }
    }

    /**
     * Sends the search or item link right after launch instead of waiting for the Swiggy home first. The launch
     * still comes first: on a cold start the link's trampoline activity closes onto the launcher otherwise, which
     * reads as the user leaving. A cold Swiggy can also swallow the link and land on its home, so it is sent again.
     */
    private fun openShelf(screen: Screen, runner: StepRunner, url: String): NodeSnapshot {
        var sent = 0
        var closed = 0
        screen.openUrl(url)
        while (true) {
            val seen = runner.waitUntil("results", "screen_changed", 25_000) {
                onShelf(it) || blockScreen(it, cards(it).isNotEmpty()) != null || promoDismiss(it) != null || isHome(it)
            }
            if (onShelf(seen) || blockScreen(seen, cards(seen).isNotEmpty()) != null) return seen
            val close = promoDismiss(seen)
            if (close != null && closed < 3) {
                runner.click("dismiss", close.clickableAncestor())
                closed += 1
                continue
            }
            val landed = runner.settle("results", 3_000) { onShelf(it) }
            if (landed != null && onShelf(landed)) return landed
            if (sent >= 2) throw StepFailed("results", "screen_changed", "Swiggy stayed on its home after the link was sent three times")
            screen.openUrl(url)
            sent += 1
        }
    }

    /** The Swiggy home shows product widgets too, so only a non-home screen with cards is the shelf. */
    private fun onShelf(root: NodeSnapshot): Boolean = !isHome(root) && cards(root).isNotEmpty()

    private fun cartBar(root: NodeSnapshot): NodeSnapshot? {
        return root.walk().firstOrNull { it.id == "cart_button" || it.id == "floating_crouton" || it.text.equals("CART", ignoreCase = true) }
    }

    private fun dismissPromos(runner: StepRunner) {
        repeat(3) {
            val root = runner.waitUntil("popup", "timeout") { true }
            val close = promoDismiss(root) ?: return
            runner.click("dismiss", close.clickableAncestor())
        }
    }

    private fun widgetCard(nameNode: NodeSnapshot): NodeSnapshot? {
        var current = nameNode.parent
        while (current != null) {
            val names = current.walk().count { it.id == "tvItemName" && it.label().isNotBlank() }
            if (names > 1) return null
            if (names == 1 && current.walk().any { it.id == "tvItemPrice" && it.label().isNotBlank() }) return current
            current = current.parent
        }
        return null
    }

    private fun shelfCard(nameNode: NodeSnapshot): NodeSnapshot? {
        var current = nameNode.parent
        while (current != null) {
            val names = current.walk().count { it.id == "item_description" && it.label().isNotBlank() }
            if (names > 1) return null
            if (names == 1 && current.walk().any { it.id == "selling_price" && it.label().isNotBlank() }) return current
            current = current.parent
        }
        return null
    }
}
