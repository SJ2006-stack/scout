package app.scout.companion.automation

object ZeptoCart {
    const val PACKAGE = "com.zeptoconsumerapp"
    private val OUT = Regex("(?i)(out of stock|sold out|not in stock|not available|unavailable|notify me)")
    private val PRODUCT = Regex("""https://(?:www\.)?zepto\.com/pn/([^/?#]+)/pvid/([^/?#]+)""", RegexOption.IGNORE_CASE)
    private val SIZE = Regex("(?i)\\d+\\s*(?:pack|pc|pcs|piece|pieces)\\s*(?:\\([^)]*\\))?|\\d+(?:\\.\\d+)?\\s*(?:kg|g|gm|ml|l|ltr)\\b")
    private val QTY = Regex("(?i)^(\\d+)\\s+items?$")

    fun destination(item: CartItemRequest): String {
        val link = item.link
        if (!link.isNullOrBlank()) {
            val slug = PRODUCT.find(link)?.groupValues?.getOrNull(1)
            if (!slug.isNullOrBlank() && !slug.equals("x", ignoreCase = true)) return link
        }
        return "https://www.zepto.com/search?query=" + java.net.URLEncoder.encode(query(item), "UTF-8").replace("+", "%20")
    }

    fun isHome(root: NodeSnapshot): Boolean {
        val search = root.walk().any { it.id == "homepage-search-box" }
        val query = root.walk().any { it.id == "search-query-input" && it.text.isNotBlank() }
        return search && !query
    }

    /** Zepto reopens on whatever screen it was last on: home, results, or the cart all count as loaded. */
    fun ready(root: NodeSnapshot): Boolean = root.walk().any {
        it.id == "homepage-search-box" || it.id == "cartpage-back-container" || it.id.startsWith("product-card-container")
    }

    /** Results for this item's query, not a stale page from an earlier search. */
    fun showsQuery(root: NodeSnapshot, item: CartItemRequest): Boolean {
        val destination = destination(item)
        if (!destination.contains("/search?query=")) return true
        val wanted = query(item).lowercase()
        return root.walk().any { it.id == "search-query-input" && it.text.trim().lowercase() == wanted }
    }

    private fun query(item: CartItemRequest): String =
        listOfNotNull(item.name.takeIf { it.isNotBlank() }, item.size?.takeIf { it.isNotBlank() }).joinToString(" ")

    fun cards(root: NodeSnapshot): List<OfferCard> {
        return root.walk().filter { it.id.startsWith("product-card-container") }.mapNotNull { card ->
            val parsed = parseCard(card.desc) ?: return@mapNotNull null
            val (name, size, price) = parsed
            val add = card.walk().firstOrNull { it.desc.trim().equals("Add to Cart", ignoreCase = true) }
            val increment = card.walk().firstOrNull { it.id.endsWith("-plus") }
            val quantity = card.walk().mapNotNull { QTY.find(it.desc.trim())?.groupValues?.get(1)?.toInt() }.firstOrNull()
            OfferCard(
                name = name,
                size = size,
                price = price,
                inStock = !OUT.containsMatchIn(card.desc) && (add != null || increment != null),
                add = add,
                increment = increment,
                quantity = quantity,
            )
        }.toList()
    }

    fun cartLines(root: NodeSnapshot): List<ReadLine> {
        val lines = ArrayList<ReadLine>()
        for (nameNode in root.walk()) {
            if (nameNode.id != "product-name-of-cart-item" || nameNode.label().isBlank()) continue
            val card = lineCard(nameNode) ?: continue
            val prices = card.walk().flatMap { nodeRupees(it) }.toList()
            if (prices.isEmpty()) continue
            lines += ReadLine(
                name = nameNode.label(),
                size = card.walk().firstOrNull { it.id == "order-detail-product-sku-quantity" }?.label()?.ifBlank { null },
                quantity = null,
                unitPrice = null,
                lineTotal = prices.minOrNull(),
            )
        }
        return lines.distinctBy { it.name }
    }

    fun billOf(root: NodeSnapshot): CartBillResult? {
        val items = fee(root, "Item Total")
        val grand = fee(root, "To Pay") ?: root.walk().firstOrNull { it.id == "total-amount" }?.let { lastRupee(it.label()) }
        if (items == null && grand == null) return null
        return CartBillResult(items, fee(root, "Handling Fee"), fee(root, "Delivery Fee"), null, grand)
    }

    fun run(screen: Screen, request: CartRequest, runner: StepRunner): AppCartResult {
        val store = request.items.firstOrNull()?.store ?: "zepto"
        val drafts = ArrayList<Draft>()
        var lines = emptyList<ReadLine>()
        var bill: CartBillResult? = null
        try {
            screen.launch(PACKAGE)
            val home = runner.waitUntil("home", "timeout") { ready(it) || locationOff(it) }
            blockScreen(home, false)?.let { reason ->
                return finish(store, drafts, lines, bill, "home", reason, null, null)
            }
            for (item in request.items) {
                val landed: (NodeSnapshot) -> Boolean = {
                    val found = cards(it)
                    blockScreen(it, found.isNotEmpty()) != null || (!isHome(it) && found.isNotEmpty() && showsQuery(it, item))
                }
                screen.openUrl(destination(item))
                val first = runner.settle("results", 5_000, landed)
                val results = if (first != null && landed(first)) {
                    first
                } else {
                    // A cold start can swallow the first link while Zepto is still loading.
                    screen.openUrl(destination(item))
                    runner.waitUntil("results", "screen_changed", predicate = landed)
                }
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
            val inCart: (NodeSnapshot) -> Boolean = { cartLines(it).isNotEmpty() || billOf(it)?.grandTotal != null }
            fun openCart() {
                val bar = runner.waitUntil("view_cart", "screen_changed") { it.walk().any { node -> node.id == "floating-cart-button" } }
                runner.click("view_cart", bar.walk().first { it.id == "floating-cart-button" }.clickableAncestor())
            }
            openCart()
            val opened = runner.settle("cart", 4_000, inCart)
            // A tap during the add animation can be dropped; the bar is still there, so tap it once more.
            var cart = if (opened != null && inCart(opened)) opened else {
                openCart()
                runner.waitUntil("cart", "screen_changed", predicate = inCart)
            }
            lines = cartLines(cart)
            bill = billOf(cart)
            var scrolls = 0
            while (bill?.grandTotal == null && scrolls < 4) {
                runner.scroll("bill")
                cart = runner.settle("bill", 1_500) { billOf(it)?.grandTotal != null } ?: break
                if (lines.isEmpty()) lines = cartLines(cart)
                bill = merged(bill, billOf(cart))
                scrolls += 1
            }
            return finish(store, drafts, lines, bill, null, null, null, null)
        } catch (failed: StepFailed) {
            return finish(store, drafts, lines, bill, failed.step, failed.reason, null, failed.message)
        }
    }

    internal fun parseCard(desc: String): Triple<String, String?, Double?>? {
        val cleaned = desc.replace("\u200a", " ").replace("\u00a0", " ").trim()
        if (cleaned.isBlank()) return null
        val sizeMatch = SIZE.find(cleaned)
        val head = if (sizeMatch != null) cleaned.substring(0, sizeMatch.range.first) else cleaned
        val name = head
            .replace(Regex("""(?i)(?:₹\s*)?[0-9][0-9,]*(?:\.[0-9]+)?\s*%?\s*OFF\b"""), " ")
            .replace(Regex("""₹\s*[0-9][0-9,]*(?:\.[0-9]+)?"""), " ")
            .trim { it == ' ' || it == ',' || it == '|' || it == '-' }
            .replace(Regex("\\s+"), " ")
            .trim()
        if (name.isBlank()) return null
        return Triple(name, sizeMatch?.value?.trim(), lastRupee(cleaned))
    }

    private fun merged(old: CartBillResult?, new: CartBillResult?): CartBillResult? {
        if (old == null || new == null) return new ?: old
        return CartBillResult(
            new.itemsTotal ?: old.itemsTotal,
            new.handling ?: old.handling,
            new.delivery ?: old.delivery,
            new.otherFees ?: old.otherFees,
            new.grandTotal ?: old.grandTotal,
        )
    }

    private fun fee(root: NodeSnapshot, label: String): Double? {
        val section = root.walk().firstOrNull { it.desc.equals(label, ignoreCase = true) } ?: return null
        val siblings = section.parent?.children.orEmpty()
        val next = siblings.getOrNull(siblings.indexOf(section) + 1)
        return amount(next) ?: amount(section)
    }

    private fun amount(node: NodeSnapshot?): Double? {
        if (node == null) return null
        val discounted = node.walk().firstOrNull {
            it.desc.contains("Discounted Price", ignoreCase = true) || it.text.equals("FREE", ignoreCase = true)
        }
        if (discounted != null) {
            if (discounted.text.equals("FREE", ignoreCase = true) || discounted.desc.contains("FREE", ignoreCase = true)) return 0.0
            return lastRupee("${discounted.desc} ${discounted.text}")
        }
        val price = node.walk().firstOrNull { it.desc.contains("Price is", ignoreCase = true) } ?: return null
        return lastRupee("${price.desc} ${price.text}")
    }

    private fun lineCard(nameNode: NodeSnapshot): NodeSnapshot? {
        var current = nameNode.parent
        while (current != null) {
            val names = current.walk().count { it.id == "product-name-of-cart-item" && it.label().isNotBlank() }
            if (names > 1) return null
            if (names == 1 && current.walk().any { nodeRupees(it).isNotEmpty() }) return current
            current = current.parent
        }
        return null
    }

    private fun nodeRupees(node: NodeSnapshot): List<Double> {
        val fromText = rupees(node.text)
        return if (fromText.isNotEmpty()) fromText else rupees(node.desc)
    }
}
