package app.scout.companion.automation

import org.json.JSONObject
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.ArrayDeque
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EventBookTest {
    @Test
    fun linkStaysOnThatAppsHost() {
        assertTrue(EventBook.linkFits("bookmyshow", "https://in.bookmyshow.com/events/late-show/ET1"))
        assertTrue(EventBook.linkFits("district", "https://www.district.in/events/karaoke"))
        assertTrue(EventBook.linkFits("luma", "https://lu.ma/open-mic"))
        assertEquals(false, EventBook.linkFits("bookmyshow", "https://www.bookmyshow.com/events/late-show"))
        assertEquals(false, EventBook.linkFits("district", "https://in.bookmyshow.com/events/late-show/ET1"))
        assertEquals(false, EventBook.linkFits("luma", "http://lu.ma/open-mic"))
    }

    @Test
    fun opensThePinnedLinkAndDoesNotTapCheckout() {
        val page = eventPage("com.bt.bms", "Late Show", NodeSnapshot(text = "Checkout", clickable = true, packageName = "com.bt.bms"))
        val screen = EventScreen(page)
        val request = request("bookmyshow", "https://in.bookmyshow.com/events/late-show/ET1")
        EventBook.deliver(screen, runner(screen), request)
        val outcome = eventOutcome(request, screen.root())
        assertEquals("https://in.bookmyshow.com/events/late-show/ET1" to "com.bt.bms", screen.opened.single())
        assertTrue(screen.clicked.isEmpty())
        assertEquals("before_pay", outcome.reason)
        assertEquals("Checkout", outcome.stoppedAt)
    }

    @Test
    fun closesADiningSheetThenStopsBeforePay() {
        val promo = eventPage(
            "com.application.zomato.district",
            "Flat ₹100 OFF on dining deals",
            NodeSnapshot(id = "close", desc = "Close", clickable = true, packageName = "com.application.zomato.district"),
        )
        val tickets = eventPage("com.application.zomato.district", "Karaoke Night", NodeSnapshot(text = "Pay Now", clickable = true))
        val screen = EventScreen(promo, tickets)
        val request = request("district", "https://www.district.in/events/karaoke", "Karaoke Night")
        EventBook.deliver(screen, runner(screen), request)
        assertEquals(listOf("close"), screen.clicked)
        assertEquals("before_pay", eventOutcome(request, screen.root()).reason)
    }

    @Test
    fun waitsForTheEventAppAndSaysSoWhenItLandsElsewhere() {
        val scout = NodeSnapshot(packageName = "app.scout", text = "Event Scout", children = listOf(NodeSnapshot(text = "Book", packageName = "app.scout")))
        val home = eventPage("com.bt.bms", "Recommended movies", NodeSnapshot(text = "Explore", packageName = "com.bt.bms"))
        val screen = EventScreen(scout, home)
        screen.advanceOnRead = true
        val request = request("bookmyshow", "https://in.bookmyshow.com/events/late-show/ET1")
        EventBook.deliver(screen, runner(screen), request)
        assertEquals(2, screen.opened.size)
        val outcome = eventOutcome(request, screen.root())
        assertEquals("not_on_event", outcome.reason)
        assertEquals("handoff_started", eventStatus(outcome.reason))
    }

    @Test
    fun bookTicketsIsReportedAndLeftUntapped() {
        val page = eventPage("com.luma.mobile", "Open Mic", NodeSnapshot(text = "Book tickets", clickable = true))
        assertEquals("Book tickets", EventBook.paymentControl(page))
        assertNull(EventBook.sheetDismiss(page))
    }

    @Test
    fun readsBookMyShowScreensFromTheMovieToTheSeatMap() {
        assertTrue(BookMyShowBook.bookButton(UiDump.resource("bookmyshow/01-movie.xml")) != null)
        val format = UiDump.resource("bookmyshow/02-format.xml")
        assertTrue(BookMyShowBook.formatSheet(format))
        assertEquals("2D", BookMyShowBook.formatChoice(format, null)?.label())
        assertEquals("IMAX 3D", BookMyShowBook.formatChoice(format, "imax 3d")?.label())
        val shows = BookMyShowBook.shows(UiDump.resource("bookmyshow/03-showtimes.xml"))
        assertEquals("07:10 PM", shows.first().time)
        assertTrue(shows.first().cinema, shows.first().cinema.contains("Promenade"))
        assertTrue(BookMyShowBook.pick(shows, "10:15 PM", "PVR Promenade")!!.cinema.contains("Promenade"))
        assertTrue(BookMyShowBook.pick(shows, "10:20 PM", "Cinepolis Saket")!!.cinema.contains("Cinepolis"))
        assertNull(BookMyShowBook.pick(shows, "10:15 PM", "Cinepolis Saket"))
        val saturday = ZonedDateTime.of(2026, 11, 7, 22, 15, 0, 0, ZoneId.of("Asia/Kolkata"))
        assertEquals(Bounds(181, 299, 361, 479), BookMyShowBook.dayTab(UiDump.resource("bookmyshow/03-showtimes.xml"), saturday)?.bounds)
        assertTrue(showOptions(shows).startsWith("PVR: Promenade, Vasant Kunj 07:10 PM, 10:15 PM, 11:15 PM;"))
        val count = UiDump.resource("bookmyshow/04-seat-count.xml")
        assertTrue(BookMyShowBook.seatCountSheet(count))
        assertEquals(292, BookMyShowBook.countSlot(count, 3)!!.bounds.left + 4)
        val seats = UiDump.resource("bookmyshow/05-seat-map.xml")
        assertTrue(BookMyShowBook.seatMap(seats))
        assertEquals(2, BookMyShowBook.ticketsShown(seats))
        assertTrue(BookMyShowBook.shows(seats).isEmpty())
        assertNull(SafetyGuard.refusal(seats.walk().first { it.id == "seat_quantity_container" }))
    }

    @Test
    fun drivesAMovieToTheSeatMapAndStopsThere() {
        val zone = ZoneId.systemDefault()
        val showtime = ZonedDateTime.now(zone).withHour(22).withMinute(15).withSecond(0).withNano(0).toInstant().toEpochMilli()
        val screen = EventScreen(
            UiDump.resource("bookmyshow/01-movie.xml"),
            UiDump.resource("bookmyshow/02-format.xml"),
            UiDump.resource("bookmyshow/03-showtimes.xml"),
            UiDump.resource("bookmyshow/04-seat-count.xml"),
            UiDump.resource("bookmyshow/04-seat-count.xml"),
            UiDump.resource("bookmyshow/05-seat-map.xml"),
        )
        val args = JSONObject()
            .put("tickets", 3)
            .put("showtime", showtime)
            .put("ref", JSONObject().put("app", "bookmyshow").put("link", "https://in.bookmyshow.com/movies/delhi/ramayana/ET1").put("title", "Ramayana").put("venue", "PVR Promenade"))
        val request = EventBook.readRequest(args)!!
        val stop = EventBook.deliver(screen, runner(screen), request)!!
        assertEquals("seat_map", stop.stage)
        assertEquals("10:15 PM", stop.time)
        assertEquals(5, screen.clicked.size)
        assertEquals("select_seats_button_picker", screen.clicked.last())
        val outcome = eventOutcome(request, screen.root(), stop)
        assertEquals("completed", eventStatus(outcome.reason))
        assertTrue(eventMessage(request.app, request.title, outcome.reason, outcome.detail).contains("seat map"))
    }

    @Test
    fun withoutAShowtimeStopsOnTheShowtimesAndListsThem() {
        val screen = EventScreen(
            UiDump.resource("bookmyshow/01-movie.xml"),
            UiDump.resource("bookmyshow/02-format.xml"),
            UiDump.resource("bookmyshow/03-showtimes.xml"),
        )
        val request = request("bookmyshow", "https://in.bookmyshow.com/movies/delhi/ramayana/ET1", "Ramayana")
        val stop = EventBook.deliver(screen, runner(screen), request)!!
        assertEquals("showtimes", stop.stage)
        assertEquals(2, screen.clicked.size)
        val outcome = eventOutcome(request, screen.root(), stop)
        assertEquals("handoff_started", eventStatus(outcome.reason))
        assertTrue(outcome.detail!!.contains("10:15 PM"))
    }

    @Test
    fun readsDistrictEventScreensFromTheDatesToTheTicketCount() {
        assertTrue(DistrictBook.bookButton(UiDump.resource("district/01-event.xml")) != null)
        val dates = UiDump.resource("district/02-dates.xml")
        assertTrue(DistrictBook.datesSheet(dates))
        assertEquals((6..16).map { it.toString() }, DistrictBook.openDays(dates).map { it.label() })
        val friday = ZonedDateTime.of(2026, 11, 6, 18, 0, 0, 0, ZoneId.of("Asia/Kolkata"))
        assertEquals("6", DistrictBook.dayCell(dates, friday)?.label())
        assertNull(DistrictBook.dayCell(dates, friday.plusMonths(1)))
        val slots = DistrictBook.slots(UiDump.resource("district/03-slots.xml"))
        assertEquals(listOf("6 PM - 7:30 PM", "8 PM - 9:30 PM", "9:30 PM - 11 PM", "11 PM - 11:59 PM"), slots.map { it.time })
        assertEquals("Fri, 06 Nov", slots.first().cinema)
        assertEquals("9:30 PM - 11 PM", DistrictBook.pickSlot(slots, friday.withHour(21).withMinute(30))?.time)
        assertNull(DistrictBook.pickSlot(slots, null))
        val tiers = DistrictBook.tiers(UiDump.resource("district/04-tiers.xml"))
        assertEquals(listOf("Early Bird Entry", "Ticket for One", "Ticket for Two", "Ticket for Three", "Ticket for four"), tiers.map { it.name })
        assertEquals(249.0, tiers.first().price, 0.0)
        assertTrue(tiers.all { it.add != null && it.quantity == null })
        val added = DistrictBook.tiers(UiDump.resource("district/05-added.xml")).first()
        assertEquals(1, added.quantity)
        assertEquals(964, DistrictBook.plus(added.count!!).bounds.left + 4)
        assertEquals(2 to 498.0, DistrictBook.summary(UiDump.resource("district/06-two.xml")))
        assertTrue(DistrictBook.tiers(dates).isEmpty())
    }

    @Test
    fun drivesADistrictEventToCheckoutAndStopsThere() {
        val screen = EventScreen(
            UiDump.resource("district/01-event.xml"),
            UiDump.resource("district/02-dates.xml"),
            UiDump.resource("district/03-slots.xml"),
            UiDump.resource("district/04-tiers.xml"),
            UiDump.resource("district/05-added.xml"),
            UiDump.resource("district/06-two.xml"),
        )
        val showtime = ZonedDateTime.of(2026, 11, 6, 18, 0, 0, 0, ZoneId.systemDefault()).toInstant().toEpochMilli()
        val args = JSONObject()
            .put("tickets", 2)
            .put("showtime", showtime)
            .put("ref", JSONObject().put("app", "district").put("link", "https://www.district.in/events/comedy-nights-at-foyer-buy-tickets").put("title", "Comedy Nights at Foyer"))
        val request = EventBook.readRequest(args)!!
        val stop = EventBook.deliver(screen, runner(screen), request)!!
        assertEquals("checkout_ready", stop.stage)
        assertEquals(2, stop.tickets)
        assertEquals(498.0, stop.total!!, 0.0)
        assertEquals(listOf("button", "", "", "", ""), screen.clicked)
        val outcome = eventOutcome(request, screen.root(), stop)
        assertEquals("completed", eventStatus(outcome.reason))
        assertEquals("2 × Early Bird Entry, Fri, 6 Nov, 2026, 6 PM - 7:30 PM, ₹498 in all", outcome.detail)
        assertTrue(eventMessage(request.app, request.title, outcome.reason, outcome.detail).contains("Scout does not tap Checkout"))
        assertEquals(498.0, outcome.toJson().getDouble("total"), 0.0)
    }

    @Test
    fun aDistrictEventWithoutADayStopsOnTheCalendar() {
        val screen = EventScreen(UiDump.resource("district/01-event.xml"), UiDump.resource("district/02-dates.xml"))
        val request = request("district", "https://www.district.in/events/comedy-nights-at-foyer-buy-tickets", "Comedy Nights at Foyer")
        val stop = EventBook.deliver(screen, runner(screen), request)!!
        assertEquals("dates", stop.stage)
        assertEquals("Open days: 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 Nov", stop.note)
        assertEquals("handoff_started", eventStatus(eventOutcome(request, screen.root(), stop).reason))
    }

    @Test
    fun aDistrictTicketOverTheLimitIsNotAdded() {
        val screen = EventScreen(
            UiDump.resource("district/01-event.xml"),
            UiDump.resource("district/02-dates.xml"),
            UiDump.resource("district/03-slots.xml"),
            UiDump.resource("district/04-tiers.xml"),
        )
        val showtime = ZonedDateTime.of(2026, 11, 6, 18, 0, 0, 0, ZoneId.systemDefault()).toInstant().toEpochMilli()
        val args = JSONObject()
            .put("tickets", 1)
            .put("showtime", showtime)
            .put("maxPricePerTicket", 200)
            .put("ref", JSONObject().put("app", "district").put("link", "https://www.district.in/events/comedy-nights-at-foyer-buy-tickets").put("title", "Comedy Nights at Foyer"))
        val stop = EventBook.deliver(screen, runner(screen), EventBook.readRequest(args)!!)!!
        assertEquals("over_budget", stop.stage)
        assertTrue(stop.note!!.startsWith("Early Bird Entry ₹249; Ticket for One ₹299"))
        assertEquals(3, screen.clicked.size)
    }

    @Test
    fun drivesADistrictMovieToTheSeatMap() {
        val shows = DistrictBook.showtimes(UiDump.resource("district/12-showtimes.xml"))
        assertEquals("PVR IMAX with Laser - Priya, Vasant Vihar, New Delhi", shows.first().cinema)
        assertEquals("07:10 PM", shows.first().time)
        assertTrue(BookMyShowBook.pick(shows, "05:40 PM", "PVR Promenade")!!.cinema.startsWith("PVR Promenade"))
        val saturday = ZonedDateTime.of(2026, 11, 7, 17, 40, 0, 0, ZoneId.of("Asia/Kolkata"))
        assertEquals("Sat, 7 Nov", DistrictBook.movieDay(UiDump.resource("district/12-showtimes.xml"), saturday)?.label())
        assertEquals("8 Nov", DistrictBook.movieDay(UiDump.resource("district/12-showtimes.xml"), saturday.plusDays(1))?.label())
        assertTrue(DistrictBook.seatMap(UiDump.resource("district/13-seat-map.xml")))

        val zone = ZoneId.systemDefault()
        val showtime = ZonedDateTime.now(zone).withHour(17).withMinute(40).withSecond(0).withNano(0).toInstant().toEpochMilli()
        val screen = EventScreen(
            UiDump.resource("district/11-movie.xml"),
            UiDump.resource("district/12-showtimes.xml"),
            UiDump.resource("district/13-seat-map.xml"),
        )
        val args = JSONObject()
            .put("tickets", 2)
            .put("showtime", showtime)
            .put("ref", JSONObject().put("app", "district").put("link", "https://www.district.in/movies/ramayana-movie-tickets-in-delhi-ncr-MV176276").put("title", "Ramayana").put("venue", "PVR Promenade"))
        val request = EventBook.readRequest(args)!!
        val stop = EventBook.deliver(screen, runner(screen), request)!!
        assertEquals("seat_map", stop.stage)
        assertEquals("05:40 PM", stop.time)
        assertEquals(2, screen.clicked.size)
        assertTrue(eventOutcome(request, screen.root(), stop).detail!!.endsWith("05:40 PM, 2 tickets"))
    }

    @Test
    fun opensLumaRegistrationAndLeavesRegisterForThePerson() {
        val event = UiDump.resource("luma/01-event.xml")
        assertEquals("Register", LumaBook.opener(event)?.label())
        val form = UiDump.resource("luma/02-form.xml")
        assertTrue(LumaBook.formOpen(form))
        assertNull(LumaBook.opener(form))
        assertEquals(4 to 0, LumaBook.answers(form))
        assertEquals(0 to 0, LumaBook.answers(UiDump.resource("luma/03-form-no-questions.xml")))

        val screen = EventScreen(event, form)
        val args = JSONObject()
            .put("tickets", 1)
            .put("ref", JSONObject().put("app", "luma").put("link", "https://luma.com/hbpqcuhj").put("title", "Fireside chat with Hitesh Oberoi"))
        val request = EventBook.readRequest(args)!!
        val stop = EventBook.deliver(screen, runner(screen), request)!!
        assertEquals("form", stop.stage)
        assertEquals(1, screen.clicked.size)
        val outcome = eventOutcome(request, screen.root(), stop)
        assertEquals("completed", eventStatus(outcome.reason))
        assertEquals(
            "Luma's registration form for Fireside chat with Hitesh Oberoi is open. 4 answers filled in from your Luma profile. Check it and tap Register there. Scout does not tap Register.",
            eventMessage(request.app, request.title, outcome.reason, outcome.detail),
        )
    }

    private fun request(app: String, link: String, title: String = "Late Show"): EventRequest {
        val args = JSONObject()
            .put("tickets", 2)
            .put(
                "ref",
                JSONObject().put("app", app).put("link", link).put("title", title),
            )
        return EventBook.readRequest(args) ?: error("request")
    }

    private fun eventPage(packageName: String, title: String, vararg extra: NodeSnapshot): NodeSnapshot {
        return NodeSnapshot(packageName = packageName, text = title, children = extra.toList())
    }
}

private class EventScreen(first: NodeSnapshot, vararg rest: NodeSnapshot) : Screen {
    private val frames = ArrayDeque<NodeSnapshot>().apply {
        add(first)
        rest.forEach { add(it) }
    }
    val opened = mutableListOf<Pair<String, String>>()
    val clicked = mutableListOf<String>()

    var advanceOnRead = false

    override fun root(): NodeSnapshot? {
        val top = frames.firstOrNull()
        if (advanceOnRead && frames.size > 1) frames.removeFirst()
        return top
    }
    override fun foregroundPackage(): String? = frames.firstOrNull()?.packageName
    override fun abortedReason(): String? = null
    override fun launch(packageName: String) {}
    override fun openUrl(url: String) {
        opened += url to ""
    }
    override fun openPackaged(url: String, packageName: String) {
        opened += url to packageName
    }
    override fun click(node: NodeSnapshot): Boolean {
        clicked += node.id.ifBlank { node.label() }
        if (frames.size > 1) frames.removeFirst()
        return true
    }
    override fun gestureClick(node: NodeSnapshot): Boolean = click(node)
    override fun setText(node: NodeSnapshot, value: String): Boolean = true
    override fun scroll(node: NodeSnapshot, forward: Boolean): Boolean = true
    override fun back() {}
}
