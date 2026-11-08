package app.scout.companion.automation

import java.time.Instant
import java.time.YearMonth
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/** One ticket type on District's ticket page, with its Add button or its count once added. */
data class Tier(val name: String, val price: Double, val add: NodeSnapshot?, val count: NodeSnapshot?) {
    val quantity: Int? get() = count?.label()?.trim()?.toIntOrNull()
}

/**
 * Events: Book tickets, the day, the time slot, and the cheapest ticket type at the count asked
 * for, then stop with Checkout on screen. Movies: the day and showtime, then stop on the seat map.
 * Checkout, seats, and Pay are left for the person.
 */
object DistrictBook {
    private val TIME = Regex("^\\d{1,2}:\\d{2}\\s*[AP]M$", RegexOption.IGNORE_CASE)
    private val SLOT = Regex("^(\\d{1,2})(?::(\\d{2}))?\\s*([AP]M)\\s*[-–]", RegexOption.IGNORE_CASE)
    private val DAY = Regex("^[A-Z][a-z]{2}, \\d{1,2} [A-Z][a-z]{2}(?:, \\d{4})?$")
    private val COUNT = Regex("(?i)^(\\d+)\\s+tickets?$")
    private val RUPEE = Regex("^₹\\s*([0-9][0-9,]*(?:\\.\\d+)?)$")
    private val PAY_STEP = Regex("(?i)(\\bpay now\\b|proceed to pay|\\bpay\\s*₹)")
    private val MONTH = DateTimeFormatter.ofPattern("MMMM yyyy", Locale.ENGLISH)

    fun isMovie(link: String): Boolean = link.contains("/movies/")

    /** The wide button at the foot of an event or movie page. It has no text of its own. */
    fun bookButton(root: NodeSnapshot): NodeSnapshot? {
        if (root.walk().none { it.id == "dstatic_view_title" }) return null
        return root.walk().lastOrNull { it.id == "button" && it.clickable }
    }

    fun datesSheet(root: NodeSnapshot): Boolean = root.walk().any { it.id == "dates_recycler_view" }

    fun payStep(root: NodeSnapshot): Boolean = root.walk().any { PAY_STEP.containsMatchIn(it.label()) }

    /** Days on the calendar that show a price under them, which is how District marks a day with shows. */
    fun openDays(root: NodeSnapshot): List<NodeSnapshot> {
        val grid = root.walk().firstOrNull { it.id == "dates_recycler_view" } ?: return emptyList()
        val cells = grid.walk().filter { it.label().trim().toIntOrNull() != null }.toList()
        val prices = grid.walk().filter { it.label().trim().startsWith("₹") }.toList()
        return cells.filter { cell ->
            prices.any { price -> price.bounds.top in cell.bounds.bottom..(cell.bounds.bottom + 24) && price.bounds.left < cell.bounds.right && price.bounds.right > cell.bounds.left }
        }
    }

    fun shownMonth(root: NodeSnapshot): YearMonth? {
        val label = root.walk().firstOrNull { it.id == "month_name" }?.label()?.trim() ?: return null
        return try {
            YearMonth.parse(label, MONTH)
        } catch (_: RuntimeException) {
            null
        }
    }

    fun dayCell(root: NodeSnapshot, day: ZonedDateTime): NodeSnapshot? {
        if (shownMonth(root) != YearMonth.from(day)) return null
        return openDays(root).firstOrNull { it.label().trim().toInt() == day.dayOfMonth }
    }

    /** Time slots for the chosen day: "6 PM - 7:30 PM", under the day they belong to. */
    fun slots(root: NodeSnapshot): List<Show> {
        val day = root.walk().firstOrNull { it.id == "title" && DAY.matches(it.label().trim()) }?.label()?.trim() ?: ""
        return root.walk()
            .filter { it.id == "title" && SLOT.containsMatchIn(it.label().trim()) }
            .map { Show(day, it.label().trim(), it) }
            .toList()
    }

    /** The slot starting at that time of day, or the only slot when there is one. */
    fun pickSlot(slots: List<Show>, wanted: ZonedDateTime?): Show? {
        if (wanted == null) return slots.singleOrNull()
        return slots.firstOrNull { slotStart(it.time) == wanted.hour * 60 + wanted.minute } ?: slots.singleOrNull()
    }

    fun slotStart(slot: String): Int? {
        val match = SLOT.find(slot.trim()) ?: return null
        val hour = match.groupValues[1].toInt() % 12
        val minute = match.groupValues[2].ifEmpty { "0" }.toInt()
        val pm = match.groupValues[3].equals("PM", ignoreCase = true)
        return (if (pm) hour + 12 else hour) * 60 + minute
    }

    /** Each ticket type: a name line, a price line under it, and the control on the right of that row. */
    fun tiers(root: NodeSnapshot): List<Tier> {
        if (datesSheet(root)) return emptyList()
        val labelled = root.walk().filter { it.label().isNotBlank() }.toList()
        val found = ArrayList<Tier>()
        for (index in 0 until labelled.size - 1) {
            val name = labelled[index]
            val priceNode = labelled[index + 1]
            val price = RUPEE.find(priceNode.label().trim())?.groupValues?.get(1)?.replace(",", "")?.toDoubleOrNull() ?: continue
            val title = name.label().trim()
            if (title.none { it.isLetter() } || COUNT.matches(title) || title.startsWith("₹")) continue
            val middle = (name.bounds.left + name.bounds.right) / 2
            val top = name.bounds.top - 24
            val bottom = priceNode.bounds.bottom + 24
            val row = labelled.filter { it.bounds.left > middle && (it.bounds.top + it.bounds.bottom) / 2 in top..bottom }
            found += Tier(
                name = title,
                price = price,
                add = row.firstOrNull { it.clickable && it.label().trim().equals("Add", ignoreCase = true) },
                count = row.firstOrNull { it.label().trim().toIntOrNull() != null },
            )
        }
        return found
    }

    /** A tap point on the plus sign, drawn without a label just right of the count. */
    fun plus(count: NodeSnapshot): NodeSnapshot {
        val bounds = count.bounds
        val x = bounds.right + bounds.width * 3 / 4
        val y = (bounds.top + bounds.bottom) / 2
        return NodeSnapshot(bounds = Bounds(x - 4, y - 4, x + 4, y + 4), packageName = count.packageName)
    }

    fun minus(count: NodeSnapshot): NodeSnapshot {
        val bounds = count.bounds
        val x = bounds.left - bounds.width * 3 / 4
        val y = (bounds.top + bounds.bottom) / 2
        return NodeSnapshot(bounds = Bounds(x - 4, y - 4, x + 4, y + 4), packageName = count.packageName)
    }

    /** The footer above Checkout: "2 tickets" and "₹498". */
    fun summary(root: NodeSnapshot): Pair<Int, Double?>? {
        val labelled = root.walk().filter { it.label().isNotBlank() }.toList()
        val index = labelled.indexOfFirst { COUNT.matches(it.label().trim()) }
        if (index < 0) return null
        val tickets = COUNT.find(labelled[index].label().trim())!!.groupValues[1].toInt()
        val total = labelled.getOrNull(index + 1)?.label()?.trim()?.let { RUPEE.find(it) }?.groupValues?.get(1)?.replace(",", "")?.toDoubleOrNull()
        return tickets to total
    }

    /** The day and slot printed at the top of the ticket page. */
    fun chosenWhen(root: NodeSnapshot): String? {
        val labels = root.walk().map { it.label().trim() }.filter { it.isNotEmpty() }.toList()
        val day = labels.firstOrNull { DAY.matches(it) }
        val slot = labels.firstOrNull { SLOT.containsMatchIn(it) }
        return listOfNotNull(day, slot).joinToString(", ").ifEmpty { null }
    }

    fun seatMap(root: NodeSnapshot): Boolean = root.walk().any { it.id == "seat-layout-id" || it.id == "available-seat" }

    /** Each showtime under its cinema. A cinema's name sits just before its distance and rating line. */
    fun showtimes(root: NodeSnapshot): List<Show> {
        if (seatMap(root)) return emptyList()
        val found = ArrayList<Show>()
        var cinema: String? = null
        for (node in root.walk()) {
            if (node.id == "titles_array_container") {
                cinema = nameBefore(node) ?: cinema
                continue
            }
            val time = node.label().trim()
            if (node.id != "top_container_title" || !TIME.matches(time)) continue
            val name = cinema ?: continue
            found += Show(name, time.uppercase(Locale.ENGLISH), node.clickableAncestor())
        }
        return found
    }

    /** "Today" carries "Fri, 6 Nov" under it; later days read "8 Nov". */
    fun movieDay(root: NodeSnapshot, day: ZonedDateTime): NodeSnapshot? {
        val month = day.month.getDisplayName(TextStyle.SHORT, Locale.ENGLISH)
        val pattern = Regex("(^|\\D)${day.dayOfMonth} $month$")
        return root.walk().firstOrNull { (it.id == "title" || it.id == "subtitle") && pattern.containsMatchIn(it.label().trim()) }
    }

    fun toStop(screen: Screen, runner: StepRunner, request: EventRequest, zone: ZoneId = ZoneId.systemDefault()): EventStop? {
        val page = runner.settle("book", 3_000) { bookButton(it) != null } ?: return null
        val book = bookButton(page) ?: return null
        runner.click("book", book)
        return if (isMovie(request.link)) toSeats(runner, request, zone) else toTickets(runner, request, zone)
    }

    private fun toTickets(runner: StepRunner, request: EventRequest, zone: ZoneId): EventStop? {
        val wanted = request.showtimeMs?.let { Instant.ofEpochMilli(it).atZone(zone) }
        var next = runner.waitUntil("dates", "screen_changed", 10_000) { datesSheet(it) || slots(it).isNotEmpty() || tiers(it).isNotEmpty() || payStep(it) }
        if (datesSheet(next)) {
            if (wanted != null) {
                var turns = 0
                while (shownMonth(next)?.let { it < YearMonth.from(wanted) } == true && turns < 3) {
                    val forward = next.walk().firstOrNull { it.id == "chevron_right" } ?: break
                    val before = shownMonth(next)
                    runner.click("dates", forward)
                    next = runner.settle("dates", 3_000) { shownMonth(it) != before } ?: break
                    turns += 1
                }
            }
            val open = openDays(next)
            val cell = if (wanted != null) dayCell(next, wanted) else open.singleOrNull()
            if (cell == null) {
                val stage = if (wanted == null) "dates" else "showtime_missing"
                return EventStop(stage, note = openDayNote(next, open))
            }
            runner.click("date", tapPoint(cell))
            next = runner.waitUntil("slots", "screen_changed", 8_000) { !datesSheet(it) && (slots(it).isNotEmpty() || tiers(it).isNotEmpty() || payStep(it)) }
        }
        val shown = slots(next)
        if (shown.isNotEmpty()) {
            val slot = pickSlot(shown, wanted) ?: return EventStop(if (wanted == null) "showtimes" else "showtime_missing", options = shown)
            runner.click("slot", tapPoint(slot.node))
            next = runner.waitUntil("tickets", "screen_changed", 10_000) { tiers(it).isNotEmpty() || payStep(it) }
        }
        if (payStep(next)) return null
        val open = tiers(next).filter { it.add != null || it.count != null }
        if (open.isEmpty()) return null
        val max = request.maxPricePerTicket
        val tier = open.filter { max == null || it.price <= max }.minByOrNull { it.price }
            ?: return EventStop("over_budget", note = open.take(5).joinToString("; ") { "${it.name} ${rupees(it.price)}" })
        next = setCount(runner, next, tier, request.tickets)
        val count = tiers(next).firstOrNull { it.name == tier.name }?.quantity ?: 0
        val summary = summary(next)
        val tickets = summary?.first ?: count
        val note = listOfNotNull(
            "$tickets × ${tier.name}",
            chosenWhen(next),
            summary?.second?.let { "${rupees(it)} in all" },
            if (tickets < request.tickets) "the app allowed $tickets of ${request.tickets}" else null,
        ).joinToString(", ")
        return EventStop("checkout_ready", tickets = tickets, total = summary?.second, note = note)
    }

    private fun setCount(runner: StepRunner, start: NodeSnapshot, tier: Tier, tickets: Int): NodeSnapshot {
        fun current(root: NodeSnapshot): Tier? = tiers(root).firstOrNull { it.name == tier.name }
        var page = start
        // The ticket page is a web view: an accessibility click on Add is accepted and ignored, so it is a tap.
        var tries = 0
        while (current(page)?.quantity == null && tries < 2) {
            val add = current(page)?.add ?: throw StepFailed("tickets", "screen_changed", "No Add button for ${tier.name}")
            runner.click("tickets", tapPoint(add))
            page = runner.settle("tickets", 4_000) { current(it)?.quantity != null } ?: page
            tries += 1
        }
        if (current(page)?.quantity == null) throw StepFailed("tickets", "screen_changed", "Add did not take for ${tier.name}")
        var taps = 0
        while (taps < 12) {
            val row = current(page) ?: break
            val count = row.quantity ?: break
            if (count == tickets) break
            runner.click("tickets", if (count < tickets) plus(row.count!!) else minus(row.count!!))
            val moved = runner.settle("tickets", 3_000) { current(it)?.quantity != count } ?: break
            if (current(moved)?.quantity == count) break
            page = moved
            taps += 1
        }
        return page
    }

    private fun toSeats(runner: StepRunner, request: EventRequest, zone: ZoneId): EventStop {
        var next = runner.waitUntil("showtimes", "screen_changed", 10_000) { showtimes(it).isNotEmpty() || seatMap(it) }
        val showtime = request.showtimeMs ?: return EventStop("showtimes", options = showtimes(next))
        val day = Instant.ofEpochMilli(showtime).atZone(zone)
        val time = BookMyShowBook.clockText(showtime, zone)
        if (day.toLocalDate() != ZonedDateTime.now(zone).toLocalDate()) {
            val tab = movieDay(next, day) ?: return EventStop("showtime_missing", request.venue, time, options = showtimes(next))
            runner.click("date", tapPoint(tab))
            runner.settle("date", 1_500) { false }
            next = runner.waitUntil("date", "screen_changed", 8_000) { showtimes(it).isNotEmpty() }
        }
        var choice = BookMyShowBook.pick(showtimes(next), time, request.venue)
        var scrolls = 0
        while (choice == null && scrolls < 4) {
            runner.scroll("showtimes")
            next = runner.settle("showtimes", 1_500) { BookMyShowBook.pick(showtimes(it), time, request.venue) != null } ?: break
            choice = BookMyShowBook.pick(showtimes(next), time, request.venue)
            scrolls += 1
        }
        if (choice == null) return EventStop("showtime_missing", request.venue, time, options = showtimes(next))
        runner.click("showtime", choice.node)
        runner.waitUntil("seat_map", "screen_changed", 12_000) { seatMap(it) }
        return EventStop("seat_map", choice.cinema, choice.time, request.tickets)
    }

    private fun openDayNote(root: NodeSnapshot, open: List<NodeSnapshot>): String? {
        if (open.isEmpty()) return null
        val month = shownMonth(root)?.month?.getDisplayName(TextStyle.SHORT, Locale.ENGLISH) ?: ""
        return "Open days: ${open.take(10).joinToString(", ") { it.label().trim() }} $month".trim()
    }

    private fun nameBefore(node: NodeSnapshot): String? {
        val siblings = node.parent?.children ?: return null
        val index = siblings.indexOf(node)
        return siblings.take(index).flatMap { it.walk().toList() }.lastOrNull { it.label().isNotBlank() }?.label()?.trim()
    }

    private fun rupees(value: Double): String = if (value % 1.0 == 0.0) "₹${value.toLong()}" else "₹$value"
}
