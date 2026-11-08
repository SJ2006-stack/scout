package app.scout.companion.automation

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BlinkitCartTest {
    @Test
    fun readsSearchCardsBillAndCartFromTheDumps() {
        assertTrue(BlinkitCart.isHome(UiDump.resource("blinkit/01-home.xml")))
        assertFalse(BlinkitCart.isHome(UiDump.resource("blinkit/02-search.xml")))
        val cards = BlinkitCart.cards(UiDump.resource("blinkit/02-search.xml"))
        val butter = cards.first { it.name == "Nutralite DoodhShakti Probiotic Salted Butter" && it.size == "100 g" }
        assertEquals(62.0, butter.price!!, 0.001)
        assertTrue(butter.inStock)
        assertEquals("ADD", butter.add!!.desc)
        val item = butterItem()
        val chosen = choose(cards, item, allowSimilar = false)
        assertEquals(62.0, (chosen as Pick.Add).card.price!!, 0.001)
        val tooDear = choose(cards, item.copy(maxPrice = 50.0), allowSimilar = false) as Pick.Stop
        assertEquals("price_above_limit", tooDear.reason)
        assertEquals(62.0, tooDear.seen!!.price!!, 0.001)
        val wrongSize = choose(cards, item.copy(size = "500 g"), allowSimilar = false) as Pick.Stop
        assertEquals("size_mismatch", wrongSize.reason)
        val cheapest = choose(cards, item.copy(name = "Salted Butter", size = "100 g", maxPrice = 200.0), allowSimilar = true) as Pick.Add
        assertEquals(62.0, cheapest.card.price!!, 0.001)

        val lines = BlinkitCart.cartLines(UiDump.resource("blinkit/05-cart.xml"))
        assertEquals(1, lines.size)
        assertEquals(2, lines.single().quantity)
        assertEquals(124.0, lines.single().lineTotal!!, 0.001)
        assertEquals(62.0, lines.single().unitPrice!!, 0.001)
        assertTrue(BlinkitCart.cartLines(UiDump.resource("blinkit/09-removed.xml")).isEmpty())

        val bill = BlinkitCart.billOf(UiDump.resource("blinkit/06-bill.xml"))!!
        assertEquals(124.0, bill.itemsTotal!!, 0.001)
        assertEquals(6.0, bill.handling!!, 0.001)
        assertEquals(35.0, bill.delivery!!, 0.001)
        assertNull(bill.otherFees)
        assertEquals(165.0, bill.grandTotal!!, 0.001)

        val place = UiDump.resource("blinkit/09-removed.xml").walk().first { it.id == "tv_action_text" && it.text == "Place Order" }
        assertEquals("Place Order", SafetyGuard.refusal(place))
    }

    @Test
    fun stopsOnTheLocationOffDialogWithAPermissionStatus() {
        val dialog = UiDump.resource("blinkit/11-location-off.xml")
        assertTrue(locationOff(dialog))
        assertEquals("location_off", blockScreen(dialog, hasProducts = false))
        assertFalse(locationOff(UiDump.resource("blinkit/01-home.xml")))
        val result = AppCartResult("blinkit", emptyList(), null, "home", "location_off", null)
        assertEquals("needs_permission", cartStatus(result))
        assertTrue(cartMessage(result).startsWith("Turn on Location"))
    }

    @Test
    fun readsFreeDeliveryAsZeroAndLeavesSavingsOutOfFees() {
        val bill = BlinkitCart.billOf(UiDump.resource("blinkit/10-bill-free-delivery.xml"))!!
        assertEquals(260.0, bill.itemsTotal!!, 0.001)
        assertEquals(0.0, bill.delivery!!, 0.001)
        assertEquals(6.0, bill.handling!!, 0.001)
        assertNull(bill.otherFees)
        assertEquals(266.0, bill.grandTotal!!, 0.001)
    }

    @Test
    fun redactsTheSavedAddress() {
        val cart = UiDump.text("blinkit/05-cart.xml")
        assertFalse(cart.contains("Nilgiri"))
        assertTrue(cart.contains("REDACTED"))
        assertFalse(UiDump.text("blinkit/01-home.xml").contains("Nilgiri"))
    }

    @Test
    fun opensARealProductLinkOnlyAfterHomeAndNeverChecksOut() {
        val screen = BlinkitFixture()
        val result = BlinkitCart.run(screen, CartRequest(listOf(butterItem()), allowSimilar = false), fastRunner(screen, BlinkitCart.PACKAGE))
        assertNull(result.reason)
        assertNull(result.stoppedAt)
        assertEquals("Nutralite DoodhShakti Probiotic Salted Butter", result.added.single().name)
        assertEquals("100 g", result.added.single().size)
        assertEquals(2, result.added.single().quantity)
        assertEquals(62.0, result.added.single().unitPrice!!, 0.001)
        assertEquals(124.0, result.added.single().lineTotal!!, 0.001)
        assertEquals(165.0, result.cart!!.grandTotal!!, 0.001)
        assertEquals("completed", cartStatus(result))
        assertEquals("launch", screen.events.first())
        assertTrue(screen.events[1].contains("/prn/nutralite-doodhshakti-probiotic-salted-butter/prid/1391202"))
        assertFalse(screen.clicked.any { it.contains("Place Order") || it.contains("cv_checkout") })
    }

    @Test
    fun usesSearchWhenTheSlugIsAPlaceholder() {
        val link = BlinkitCart.destination(butterItem().copy(link = "https://blinkit.com/prn/x/prid/1391202"))
        assertTrue(link.startsWith("https://blinkit.com/s/?q="))
        assertFalse(link.contains("/prn/"))
    }

    @Test
    fun timesOutOnABlankHomeAndStopsWhenTheUserAborts() {
        val blank = object : Screen by BlinkitFixture() {
            override fun launch(packageName: String) {}
            override fun root(): NodeSnapshot = NodeSnapshot()
        }
        val timed = BlinkitCart.run(blank, CartRequest(listOf(butterItem()), false), fastRunner(blank, null))
        assertEquals("timeout", timed.reason)
        assertEquals("home", timed.stoppedAt)

        val screen = BlinkitFixture()
        screen.abortOnOpen = true
        val stopped = BlinkitCart.run(screen, CartRequest(listOf(butterItem()), false), fastRunner(screen, BlinkitCart.PACKAGE))
        assertEquals("user_stopped", stopped.reason)
        assertEquals("handoff_started", cartStatus(stopped))
    }

    private fun butterItem() = CartItemRequest(
        store = "blinkit",
        productId = "1391202",
        link = "https://blinkit.com/prn/nutralite-doodhshakti-probiotic-salted-butter/prid/1391202",
        name = "Nutralite DoodhShakti Probiotic Salted Butter",
        size = "100 g",
        price = 62.0,
        quantity = 2,
        maxPrice = 80.0,
    )
}

class ZeptoCartTest {
    @Test
    fun readsCardsPlusButtonsAndTheBill() {
        assertTrue(ZeptoCart.isHome(UiDump.resource("zepto/01-home.xml")))
        assertFalse(ZeptoCart.isHome(UiDump.resource("zepto/04-search-results.xml")))
        val cards = ZeptoCart.cards(UiDump.resource("zepto/04-search-results.xml"))
        val salt = cards.first { it.name.contains("Free Flowing") && sizesMatch("1 kg", it.size) }
        assertEquals(29.0, salt.price!!, 0.001)
        assertTrue(salt.add!!.desc.trim().equals("Add to Cart", true))
        val added = ZeptoCart.cards(UiDump.resource("zepto/05-added.xml")).first { it.name.contains("Free Flowing") }
        assertTrue(added.increment!!.id.endsWith("-plus"))
        var stepper: NodeSnapshot? = added.increment
        var foundMinus = false
        while (stepper != null) {
            if (stepper.walk().any { it.id.endsWith("-minus") }) foundMinus = true
            stepper = stepper.parent
        }
        assertTrue(foundMinus)
        assertEquals(1, added.quantity)
        assertEquals(2, ZeptoCart.cards(UiDump.resource("zepto/06-plus.xml")).first { it.name.contains("Free Flowing") }.quantity)
        val line = ZeptoCart.cartLines(UiDump.resource("zepto/07-cart.xml")).single()
        assertTrue(line.name.contains("Free Flowing"))
        assertEquals(58.0, line.lineTotal!!, 0.001)
        val bill = ZeptoCart.billOf(UiDump.resource("zepto/08-bill.xml"))!!
        assertEquals(58.0, bill.itemsTotal!!, 0.001)
        assertEquals(0.0, bill.handling!!, 0.001)
        assertEquals(30.0, bill.delivery!!, 0.001)
        assertEquals(88.0, bill.grandTotal!!, 0.001)
        val pay = UiDump.resource("zepto/08-bill.xml").walk().first { it.id == "cart-pay-button" }
        assertEquals("cart-pay-button", SafetyGuard.refusal(pay))
        assertFalse(UiDump.text("zepto/01-home.xml").contains("Nilgiri"))
    }

    @Test
    fun readsTheFooterTotalAndDropsDiscountTextFromNames() {
        val cart = UiDump.resource("zepto/09-cart-footer.xml")
        assertFalse(UiDump.text("zepto/09-cart-footer.xml").contains("Nilgiri"))
        assertEquals(2, ZeptoCart.cartLines(cart).size)
        assertEquals(78.0, ZeptoCart.billOf(cart)!!.grandTotal!!, 0.001)
        val salt = ZeptoCart.cards(UiDump.resource("zepto/10-reopened-results.xml")).first { it.name.contains("Free Flowing") }
        assertTrue(salt.name, salt.name.startsWith("Tata Salt"))
        assertEquals(29.0, salt.price!!, 0.001)
    }

    @Test
    fun treatsAReopenedSearchAsReadyButNotAsNewResults() {
        val reopened = UiDump.resource("zepto/10-reopened-results.xml")
        assertTrue(ZeptoCart.ready(reopened))
        assertTrue(ZeptoCart.ready(UiDump.resource("zepto/09-cart-footer.xml")))
        assertFalse(ZeptoCart.isHome(reopened))
        fun item(name: String, size: String) = CartItemRequest("zepto", null, null, name, size, 28.0, 1, 40.0)
        assertTrue(ZeptoCart.showsQuery(reopened, item("Tata Salt", "1 kg")))
        assertFalse(ZeptoCart.showsQuery(reopened, item("Amul Butter", "100 g")))
    }

    @Test
    fun addsTheMatchingSaltAndStopsBeforePay() {
        val salt = ZeptoCart.cards(UiDump.resource("zepto/04-search-results.xml")).first { it.name.contains("Free Flowing") }
        val item = CartItemRequest(
            store = "zepto",
            productId = "208bdb3c",
            link = "https://www.zepto.com/pn/tata-salt/pvid/208bdb3c-da54-493a",
            name = salt.name,
            size = "1 kg",
            price = 29.0,
            quantity = 2,
            maxPrice = 40.0,
        )
        assertEquals(item.link, ZeptoCart.destination(item))
        assertTrue(ZeptoCart.destination(item.copy(link = "https://www.zepto.com/pn/x/pvid/1")).contains("search?query="))
        val screen = ZeptoFixture()
        val result = ZeptoCart.run(screen, CartRequest(listOf(item), false), fastRunner(screen, ZeptoCart.PACKAGE))
        assertNull(result.reason)
        assertEquals(2, result.added.single().quantity)
        assertEquals(29.0, result.added.single().unitPrice!!, 0.001)
        assertEquals(58.0, result.added.single().lineTotal!!, 0.001)
        assertEquals(88.0, result.cart!!.grandTotal!!, 0.001)
        assertEquals("launch", screen.events.first())
        assertTrue(screen.events[1].contains("/pn/tata-salt/pvid/"))
        assertFalse(screen.clicked.any { it.contains("cart-pay-button") || it.contains("Pay") })
    }
}

class CartWireTest {
    @Test
    fun readsTheCartRequestAndWritesTheResultShape() {
        val request = readCartRequest(sample())
        assertEquals("blinkit", request!!.items.single().store)
        assertEquals(2, request.items.single().quantity)
        assertFalse(request.allowSimilar)
        val missing = JSONObject(sample().toString())
        missing.remove("allowSimilar")
        assertNull(readCartRequest(missing))
        val badQty = sample()
        badQty.getJSONArray("items").getJSONObject(0).put("quantity", 0)
        assertNull(readCartRequest(badQty))

        val result = AppCartResult(
            store = "blinkit",
            added = listOf(CartLineResult("Butter", "100 g", 2, 62.0, 124.0)),
            cart = CartBillResult(124.0, 6.0, 35.0, null, 165.0),
            stoppedAt = null,
            reason = null,
            seen = null,
        )
        val json = result.toJson()
        assertEquals("blinkit", json.getString("store"))
        assertTrue(json.isNull("reason"))
        assertTrue(json.isNull("stoppedAt"))
        assertTrue(json.isNull("seen"))
        assertEquals(2, json.getJSONArray("added").getJSONObject(0).getInt("quantity"))
        assertEquals(124.0, json.getJSONObject("cart").getDouble("itemsTotal"), 0.001)
        assertTrue(json.getJSONObject("cart").isNull("otherFees"))
        assertTrue(json.isNull("elapsedMs"))
        assertEquals(17_250L, result.copy(elapsedMs = 17_250).toJson().getLong("elapsedMs"))
        assertEquals("completed", cartStatus(result))
        assertEquals("needs_approval", cartStatus(result.copy(reason = "price_above_limit")))
        assertEquals("needs_permission", cartStatus(result.copy(reason = "service_off", added = emptyList())))
        assertEquals("handoff_started", cartStatus(result.copy(reason = "user_stopped")))
        assertEquals("failed", cartStatus(result.copy(added = emptyList(), reason = "no_match")))
    }

    @Test
    fun capabilitiesListEveryAutomationApp() {
        val json = automationJson(true, mapOf("blinkit" to (true to "18.41.0")))
        assertTrue(json.getBoolean("serviceOn"))
        val apps = json.getJSONObject("apps")
        for (name in listOf("blinkit", "zepto", "instamart", "bookmyshow", "district", "luma")) {
            assertTrue(name, apps.has(name))
            assertTrue(apps.getJSONObject(name).has("installed"))
            assertTrue(apps.getJSONObject(name).has("version"))
        }
        assertTrue(apps.getJSONObject("blinkit").getBoolean("installed"))
        assertEquals("18.41.0", apps.getJSONObject("blinkit").getString("version"))
        assertFalse(apps.getJSONObject("zepto").getBoolean("installed"))
        assertTrue(apps.getJSONObject("zepto").isNull("version"))
    }

    private fun sample(): JSONObject {
        return JSONObject()
            .put("allowSimilar", false)
            .put(
                "items",
                JSONArray().put(
                    JSONObject()
                        .put("quantity", 2)
                        .put("maxPrice", 80)
                        .put(
                            "ref",
                            JSONObject()
                                .put("store", "blinkit")
                                .put("productId", "1391202")
                                .put("link", "https://blinkit.com/prn/butter/prid/1391202")
                                .put("name", "Butter")
                                .put("size", "100 g")
                                .put("price", 62)
                                .put("seenAt", 1),
                        ),
                ),
            )
    }
}

class InstamartCartTest {
    @Test
    fun readsSearchCardsCartAndBillFromTheDumps() {
        assertTrue(InstamartCart.isHome(UiDump.resource("instamart/01-home.xml")))
        assertFalse(InstamartCart.isHome(UiDump.resource("instamart/02-search.xml")))
        val cards = InstamartCart.cards(UiDump.resource("instamart/02-search.xml"))
        val salt = cards.first { it.name == "Tata Salt, Iodised Namak, Vacuum Evaporated Salt" && it.size == "1 kg" }
        assertEquals(29.0, salt.price!!, 0.001)
        assertTrue(salt.inStock)
        assertEquals("add button", salt.add!!.desc)
        val plus = InstamartCart.cards(UiDump.resource("instamart/03-plus.xml"))
            .first { it.name == salt.name && it.size == "1 kg" }
        assertEquals(2, plus.quantity)

        val lines = InstamartCart.cartLines(UiDump.resource("instamart/04-cart.xml"))
        val line = lines.first { it.name.contains("Tata Salt") }
        assertEquals("1 kg", line.size)
        assertEquals(2, line.quantity)
        assertEquals(58.0, line.lineTotal!!, 0.001)
        assertEquals(29.0, line.unitPrice!!, 0.001)
        val bill = InstamartCart.billOf(UiDump.resource("instamart/04-cart.xml"))!!
        assertEquals(58.0, bill.itemsTotal!!, 0.001)
        assertEquals(3.01, bill.handling!!, 0.001)
        assertEquals(35.70, bill.delivery!!, 0.001)
        assertEquals(97.0, bill.grandTotal!!, 0.001)
        assertTrue(InstamartCart.needsAddress(UiDump.resource("instamart/04-cart.xml")))
    }

    @Test
    fun redactsTheSavedAddress() {
        val home = UiDump.text("instamart/01-home.xml")
        assertFalse(home.contains("Nilgiri"))
        assertTrue(home.contains("REDACTED"))
    }

    @Test
    fun searchesByNameAndStopsWhenTheAddressIsIncomplete() {
        val screen = InstamartFixture()
        val result = InstamartCart.run(screen, CartRequest(listOf(saltItem()), allowSimilar = false), fastRunner(screen, InstamartCart.PACKAGE))
        assertEquals("no_address", result.reason)
        assertEquals("cart", result.stoppedAt)
        assertEquals("Tata Salt, Iodised Namak, Vacuum Evaporated Salt", result.added.single().name)
        assertEquals(2, result.added.single().quantity)
        assertEquals(97.0, result.cart!!.grandTotal!!, 0.001)
        assertEquals("needs_approval", cartStatus(result))
        assertEquals("launch", screen.events[0])
        assertTrue(screen.events[1].startsWith("https://instamart.in/search?query="))
        assertFalse(screen.events.any { it.contains("swiggy.com/instamart/search") })
        assertFalse(screen.clicked.any { it.contains("Add address") || it.contains("To Pay") || it.contains("Place Order") })
    }

    @Test
    fun sendsTheLinkAgainWhenAColdSwiggyLandsOnItsHome() {
        val screen = InstamartFixture().apply { homeOnFirstLink = true }
        val result = InstamartCart.run(screen, CartRequest(listOf(saltItem()), allowSimilar = false), fastRunner(screen, InstamartCart.PACKAGE))
        assertEquals(2, screen.events.count { it.startsWith("https://instamart.in/search?query=") })
        assertEquals("Tata Salt, Iodised Namak, Vacuum Evaporated Salt", result.added.single().name)
        assertEquals(97.0, result.cart!!.grandTotal!!, 0.001)
    }

    @Test
    fun closesAMembershipSheetAndLeavesANormalCartAlone() {
        val promo = NodeSnapshot(
            text = "Join Swiggy One at just ₹1 for 3 months!",
            children = listOf(NodeSnapshot(desc = "Close", clickable = true)),
        )
        assertEquals("Close", promoDismiss(promo)!!.desc)
        assertNull(promoDismiss(UiDump.resource("instamart/02-search.xml")))
        assertNull(SafetyGuard.refusal(NodeSnapshot(desc = "Close")))
    }

    @Test
    fun usesTheItemLinkWhenTheIdIsReal() {
        val link = InstamartCart.destination(saltItem().copy(link = "https://www.swiggy.com/instamart/item/5DMEFBCGC6"))
        assertEquals("https://instamart.in/item/5DMEFBCGC6", link)
        val search = InstamartCart.destination(saltItem().copy(link = null))
        assertTrue(search.startsWith("https://instamart.in/search?query="))
        assertFalse(search.contains("swiggy.com"))
    }

    private fun saltItem() = CartItemRequest(
        store = "instamart",
        productId = null,
        link = null,
        name = "Tata Salt, Iodised Namak, Vacuum Evaporated Salt",
        size = "1 kg",
        price = 29.0,
        quantity = 2,
        maxPrice = 40.0,
    )
}

private class InstamartFixture : Screen {
    var tree: NodeSnapshot = NodeSnapshot()
    val events = ArrayList<String>()
    val clicked = ArrayList<String>()
    override fun root(): NodeSnapshot = tree
    override fun foregroundPackage(): String? = tree.packageName.ifBlank { null }
    override fun abortedReason(): String? = null
    override fun launch(packageName: String) {
        events += "launch"
        tree = UiDump.resource("instamart/01-home.xml")
    }
    var homeOnFirstLink = false
    override fun openUrl(url: String) {
        events += url
        val home = homeOnFirstLink && events.count { it.startsWith("https://") } == 1
        tree = UiDump.resource(if (home) "instamart/01-home.xml" else "instamart/02-search.xml")
    }
    override fun click(node: NodeSnapshot): Boolean {
        clicked += "${node.id} ${node.desc} ${node.text}"
        when {
            node.walk().any { it.id == "cart_button" } || node.id == "cart_button" -> tree = UiDump.resource("instamart/04-cart.xml")
            node.id == "add_to_cart" || node.walk().any { it.id == "add_to_cart" } -> tree = UiDump.resource("instamart/03-plus.xml")
        }
        return true
    }
    override fun gestureClick(node: NodeSnapshot): Boolean = click(node)
    override fun setText(node: NodeSnapshot, value: String): Boolean = true
    override fun scroll(node: NodeSnapshot, forward: Boolean): Boolean = true
    override fun back() {}
}

private class BlinkitFixture : Screen {
    var tree: NodeSnapshot = NodeSnapshot()
    val events = ArrayList<String>()
    val clicked = ArrayList<String>()
    var abortOnOpen = false
    private var abort: String? = null
    override fun root(): NodeSnapshot = tree
    override fun foregroundPackage(): String? = tree.packageName.ifBlank { null }
    override fun abortedReason(): String? = abort
    override fun launch(packageName: String) {
        events += "launch"
        tree = UiDump.resource("blinkit/01-home.xml")
    }
    override fun openUrl(url: String) {
        events += "open $url"
        if (abortOnOpen) abort = "user_stopped"
        tree = UiDump.resource("blinkit/02-search.xml")
    }
    override fun click(node: NodeSnapshot): Boolean {
        clicked += "${node.id} ${node.desc} ${node.text}"
        val card = shelfLabel(node)
        when {
            node.walk().any { it.id == "view_cart" } -> tree = UiDump.resource("blinkit/05-cart.xml")
            card.contains("Nutralite DoodhShakti Probiotic Salted Butter") && !card.contains("(Tub)") && node.desc.equals("ADD", true) ->
                tree = UiDump.resource("blinkit/03-added.xml")
            card.contains("Nutralite DoodhShakti Probiotic Salted Butter") && !card.contains("(Tub)") && node.id == "icon_increment" ->
                tree = UiDump.resource("blinkit/04-plus.xml")
        }
        return true
    }
    override fun gestureClick(node: NodeSnapshot): Boolean = click(node)
    override fun setText(node: NodeSnapshot, value: String): Boolean = true
    override fun scroll(node: NodeSnapshot, forward: Boolean): Boolean {
        tree = UiDump.resource("blinkit/06-bill.xml")
        return true
    }
    override fun back() {}
}

private class ZeptoFixture : Screen {
    var tree: NodeSnapshot = NodeSnapshot()
    val events = ArrayList<String>()
    val clicked = ArrayList<String>()
    override fun root(): NodeSnapshot = tree
    override fun foregroundPackage(): String? = tree.packageName.ifBlank { null }
    override fun abortedReason(): String? = null
    override fun launch(packageName: String) {
        events += "launch"
        tree = UiDump.resource("zepto/01-home.xml")
    }
    override fun openUrl(url: String) {
        events += "open $url"
        tree = UiDump.resource("zepto/04-search-results.xml")
    }
    override fun click(node: NodeSnapshot): Boolean {
        clicked += "${node.id} ${node.desc}"
        val desc = cardDesc(node)
        when {
            node.id == "floating-cart-button" || node.walk().any { it.id == "floating-cart-button" } ->
                tree = UiDump.resource("zepto/07-cart.xml")
            desc.contains("Free Flowing") && node.desc.trim().equals("Add to Cart", true) ->
                tree = UiDump.resource("zepto/05-added.xml")
            desc.contains("Free Flowing") && node.id.endsWith("-plus") ->
                tree = UiDump.resource("zepto/06-plus.xml")
        }
        return true
    }
    override fun gestureClick(node: NodeSnapshot): Boolean = click(node)
    override fun setText(node: NodeSnapshot, value: String): Boolean = true
    override fun scroll(node: NodeSnapshot, forward: Boolean): Boolean {
        tree = UiDump.resource("zepto/08-bill.xml")
        return true
    }
    override fun back() {}
}

private fun fastRunner(screen: Screen, packageName: String?): StepRunner {
    val clock = ManualClock()
    return StepRunner(screen, clock, pause = { clock.time += it }, expectedPackage = packageName, timeoutMs = 400, pollMs = 100)
}

private fun shelfLabel(node: NodeSnapshot): String {
    var current: NodeSnapshot? = node
    while (current != null) {
        val names = current.walk().filter { it.id == "tv_name" && it.desc.isNotBlank() }.toList()
        if (names.size == 1) {
            val size = current.walk().filter { it.id == "tv_uom_title" }.joinToString(" ") { it.desc }
            return "${names.single().desc} $size"
        }
        if (names.size > 1) return ""
        current = current.parent
    }
    return ""
}

private fun cardDesc(node: NodeSnapshot): String {
    var current: NodeSnapshot? = node
    while (current != null) {
        if (current.id.startsWith("product-card-container")) return current.desc
        current = current.parent
    }
    return ""
}
