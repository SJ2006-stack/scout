package app.scout.companion.automation

object BlinkitCart {
    const val PACKAGE = "com.grofers.customerapp"
    private val FREE = Regex("(?i)\\bfree\\b")
    private val OUT = Regex("(?i)(out of stock|sold out|not in stock|not available|unavailable|notify me)")
    private val PRODUCT = Regex("""https://(?:www\.)?blinkit\.com/prn/([^/?#]+)/prid/([^/?#]+)""", RegexOption.IGNORE_CASE)

    fun destination(item: CartItemRequest): String {
        val link = item.link
        if (!link.isNullOrBlank()) {
            val slug = PRODUCT.find(link)?.groupValues?.getOrNull(1)
            if (!slug.isNullOrBlank() && !slug.equals("x", ignoreCase = true)) return link
        }
        val query = listOfNotNull(item.name.takeIf { it.isNotBlank() }, item.size?.takeIf { it.isNotBlank() }).joinToString(" ")
        return "https://blinkit.com/s/?q=" + java.net.URLEncoder.encode(query, "UTF-8").replace("+", "%20")
    }

    fun isHome(root: NodeSnapshot): Boolean {
        val nodes = root.walk().toList()
        val placeholder = nodes.any { it.text.trim().startsWith("Search \"") }
        val bar = nodes.any { it.id == "z_search_bar" }
        val typing = nodes.any { it.id == "edittext" && it.text.isNotBlank() }
        return bar && placeholder && !typing
    }

    fun cards(root: NodeSnapshot): List<OfferCard> {
        val found = ArrayList<OfferCard>()
        for (nameNode in root.walk()) {
            if (nameNode.id != "tv_name" || nameNode.label().isBlank()) continue
            val card = shelfCard(nameNode) ?: continue
            val blob = card.walk().joinToString(" ") { "${it.text} ${it.desc}" }
            found += OfferCard(
                name = nameNode.label(),
                size = card.walk().firstOrNull { it.id == "tv_uom_title" }?.label()?.ifBlank { null },
                price = card.walk().firstOrNull { it.id == "price" }?.let { lastRupee(it.label()) },
                inStock = !OUT.containsMatchIn(blob),
                add = card.walk().firstOrNull { it.id == "tv_title" && it.label().equals("ADD", ignoreCase = true) },
                increment = card.walk().firstOrNull { it.id == "icon_increment" },
                quantity = card.walk().mapNotNull { quantityLabel(it.label()) }.firstOrNull(),
            )
        }
        return found.distinctBy { "${it.name}|${it.size}|${it.price}" }
    }

    fun cartLines(root: NodeSnapshot): List<ReadLine> {
        val lines = ArrayList<ReadLine>()
        for (nameNode in root.walk()) {
            if (nameNode.id != "tv_name" || nameNode.label().isBlank()) continue
            val card = lineCard(nameNode) ?: continue
            val total = card.walk().firstOrNull { it.id == "total_item_price" }?.let { lastRupee(it.label()) }
            val quantity = card.walk().mapNotNull { quantityLabel(it.label()) }.firstOrNull() ?: 1
            lines += ReadLine(
                name = nameNode.label(),
                size = card.walk().firstOrNull { it.id == "tv_variant" }?.label()?.ifBlank { null },
                quantity = quantity,
                unitPrice = if (total != null && quantity > 0) roundMoney(total / quantity) else total,
                lineTotal = total,
            )
        }
        return lines.distinctBy { "${it.name}|${it.size}|${it.lineTotal}" }
    }

    fun billOf(root: NodeSnapshot): CartBillResult? {
        val rows = root.walk().filter { row ->
            row.id == "item_container" && row.walk().any { it.id == "left_header" && it.text.isNotBlank() }
        }.toList()
        if (rows.isEmpty()) return null
        fun label(row: NodeSnapshot) = row.walk().firstOrNull { it.id == "left_header" }?.text?.trim().orEmpty()
        fun amount(row: NodeSnapshot): Double? {
            val right = row.walk().firstOrNull { it.id == "right_header" } ?: return null
            val shown = right.desc.ifBlank { right.text }
            if (FREE.containsMatchIn(shown)) return 0.0
            return lastRupee(shown)
        }
        if (rows.none { label(it).startsWith("Items total", true) || label(it).startsWith("Grand total", true) }) return null
        var other = 0.0
        var sawOther = false
        for (row in rows) {
            val name = label(row)
            if (name.startsWith("Items total", true) || name.startsWith("Handling", true) || name.startsWith("Delivery", true) || name.startsWith("Grand total", true)) continue
            if (name.startsWith("Bill details", true) || name.contains("saving", true)) continue
            val value = amount(row) ?: continue
            other += value
            sawOther = true
        }
        return CartBillResult(
            itemsTotal = rows.firstOrNull { label(it).startsWith("Items total", true) }?.let { amount(it) },
            handling = rows.firstOrNull { label(it).startsWith("Handling", true) }?.let { amount(it) },
            delivery = rows.firstOrNull { label(it).startsWith("Delivery", true) }?.let { amount(it) },
            otherFees = if (sawOther) roundMoney(other) else null,
            grandTotal = rows.firstOrNull { label(it).startsWith("Grand total", true) }?.let { amount(it) },
        )
    }

    fun run(screen: Screen, request: CartRequest, runner: StepRunner): AppCartResult {
        val store = request.items.firstOrNull()?.store ?: "blinkit"
        val drafts = ArrayList<Draft>()
        var lines = emptyList<ReadLine>()
        var bill: CartBillResult? = null
        try {
            screen.launch(PACKAGE)
            val home = runner.waitUntil("home", "timeout") { isHome(it) || locationOff(it) }
            blockScreen(home, cards(home).isNotEmpty())?.let { reason ->
                return finish(store, drafts, lines, bill, "home", reason, null, null)
            }
            for (item in request.items) {
                screen.openUrl(destination(item))
                val results = runner.waitUntil("results", "screen_changed") {
                    val found = cards(it)
                    blockScreen(it, found.isNotEmpty()) != null || found.isNotEmpty()
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
            val bar = runner.waitUntil("view_cart", "screen_changed") { it.walk().any { node -> node.id == "view_cart" } }
            runner.click("view_cart", bar.walk().first { it.id == "view_cart" }.clickableAncestor())
            var cart = runner.waitUntil("cart", "screen_changed") { cartLines(it).isNotEmpty() || billOf(it) != null }
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
            return finish(store, drafts, lines, bill, null, null, null, null)
        } catch (failed: StepFailed) {
            return finish(store, drafts, lines, bill, failed.step, failed.reason, null, failed.message)
        }
    }

    private fun shelfCard(nameNode: NodeSnapshot): NodeSnapshot? {
        var current = nameNode.parent
        while (current != null) {
            val names = current.walk().count { it.id == "tv_name" && it.label().isNotBlank() }
            if (names > 1) return null
            val priced = current.walk().any { it.id == "price" && it.label().isNotBlank() }
            val stepper = current.walk().any { it.id == "stepper" || it.id == "icon_increment" || (it.id == "tv_title" && it.label().equals("ADD", true)) }
            if (names == 1 && priced && stepper && current.walk().none { it.id == "total_item_price" }) return current
            current = current.parent
        }
        return null
    }

    private fun lineCard(nameNode: NodeSnapshot): NodeSnapshot? {
        var current = nameNode.parent
        while (current != null) {
            val names = current.walk().count { it.id == "tv_name" && it.label().isNotBlank() }
            if (names > 1) return null
            if (names == 1 && current.walk().any { it.id == "total_item_price" }) return current
            current = current.parent
        }
        return null
    }

    private fun quantityLabel(text: String): Int? {
        return Regex("(?i)^quantity\\s+(\\d+)$").find(text.trim())?.groupValues?.get(1)?.toInt()
    }
}
