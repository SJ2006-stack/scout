package app.scout.companion.automation

import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/** One showtime on BookMyShow's cinema list, with the control that opens it. */
data class Show(val cinema: String, val time: String, val node: NodeSnapshot)

/**
 * Movie pages only: Book tickets, language and format, the date, the showtime, and the
 * ticket count, then stop on the seat map. Seats and Pay are left for the person.
 */
object BookMyShowBook {
    private val TIME = Regex("^\\d{1,2}:\\d{2}\\s*[AP]M$", RegexOption.IGNORE_CASE)
    private val DISTANCE = Regex("(?i)^\\s*[\\d.]+\\s*km\\b")
    private val TICKETS = Regex("(?i)^(\\d+)\\s+tickets?$")
    private val CLOCK = DateTimeFormatter.ofPattern("hh:mm a", Locale.ENGLISH)

    fun bookButton(root: NodeSnapshot): NodeSnapshot? =
        root.walk().firstOrNull { it.label().equals("Book tickets", ignoreCase = true) }?.clickableAncestor()

    fun formatSheet(root: NodeSnapshot): Boolean = root.walk().any { it.id == "subtitle_movie_format_fragment" }

    /** The first format under the first language, unless they named one that is on the sheet. */
    fun formatChoice(root: NodeSnapshot, wanted: String?): NodeSnapshot? {
        val sheet = root.walk().firstOrNull { it.id == "recycler_lang_dimen_movie_format" } ?: root
        val chips = sheet.walk().filter { it.clickable && it.label().isNotBlank() && !it.label().equals("Select all", ignoreCase = true) }.toList()
        if (!wanted.isNullOrBlank()) chips.firstOrNull { it.label().equals(wanted.trim(), ignoreCase = true) }?.let { return it }
        return chips.firstOrNull()
    }

    fun seatCountSheet(root: NodeSnapshot): Boolean = root.walk().any { it.id == "seat_quantity_selector_seeker" }

    fun seatMap(root: NodeSnapshot): Boolean = root.walk().any { it.id == "seat_table_seat_layout" } && !seatCountSheet(root)

    fun ticketsShown(root: NodeSnapshot): Int? {
        val label = root.walk().firstOrNull { it.id == "seat_quantity_seat_layout" }?.label() ?: return null
        return TICKETS.find(label.trim())?.groupValues?.get(1)?.toIntOrNull()
    }

    /** Each time under its cinema. A cinema block is the smallest container holding the distance line. */
    fun shows(root: NodeSnapshot): List<Show> {
        if (root.walk().any { it.id == "seat_table_seat_layout" }) return emptyList()
        val found = ArrayList<Show>()
        for (node in root.walk()) {
            val time = node.label().trim()
            if (!TIME.matches(time)) continue
            val block = cinemaBlock(node) ?: continue
            val name = block.walk().map { it.label().trim() }.firstOrNull { it.isNotEmpty() && !DISTANCE.containsMatchIn(it) && !TIME.matches(it) } ?: continue
            found += Show(name, time.uppercase(Locale.ENGLISH), node.clickableAncestor())
        }
        return found
    }

    fun clockText(ms: Long, zone: ZoneId): String = CLOCK.format(Instant.ofEpochMilli(ms).atZone(zone)).uppercase(Locale.ENGLISH)

    /** A time match at the named cinema; without a cinema, the first cinema showing that time. */
    fun pick(shows: List<Show>, time: String, venue: String?): Show? {
        val atTime = shows.filter { it.time.replace(" ", "") == time.replace(" ", "").uppercase(Locale.ENGLISH) }
        if (venue.isNullOrBlank()) return atTime.firstOrNull()
        return atTime.firstOrNull { cinemaMatches(venue, it.cinema) }
    }

    /** Every word of the venue they named appears in the cinema's name ("PVR Promenade" fits "PVR: Promenade, Vasant Kunj"). */
    fun cinemaMatches(venue: String, cinema: String): Boolean {
        val have = words(cinema)
        val want = words(venue).filter { it.length > 1 }
        return want.isNotEmpty() && want.all { it in have }
    }

    /** The day in the date strip, when it is not already the selected day. */
    fun dayTab(root: NodeSnapshot, day: ZonedDateTime): NodeSnapshot? {
        val number = "%02d".format(day.dayOfMonth)
        val month = day.month.getDisplayName(TextStyle.SHORT, Locale.ENGLISH).uppercase(Locale.ENGLISH)
        return root.walk()
            .filter { it.clickable }
            .filter { tab ->
                val labels = tab.walk().map { it.label().trim().uppercase(Locale.ENGLISH) }.toSet()
                number in labels && month in labels
            }
            .minByOrNull { it.bounds.width.toLong() * it.bounds.height }
    }

    /** A tap point on the 1 to 10 seat slider, which is one node with ten equal slots. */
    fun countSlot(root: NodeSnapshot, tickets: Int): NodeSnapshot? {
        val seeker = root.walk().firstOrNull { it.id == "seat_quantity_selector_seeker" } ?: return null
        val bounds = seeker.bounds
        if (bounds.width <= 0 || tickets !in 1..10) return null
        val slot = bounds.width / 10
        val x = bounds.left + slot * (tickets - 1) + slot / 2
        val y = (bounds.top + bounds.bottom) / 2
        return NodeSnapshot(bounds = Bounds(x - 4, y - 4, x + 4, y + 4), packageName = seeker.packageName)
    }

    fun toSeats(screen: Screen, runner: StepRunner, request: EventRequest, zone: ZoneId = ZoneId.systemDefault()): EventStop? {
        val page = runner.settle("book", 3_000) { bookButton(it) != null } ?: return null
        val book = bookButton(page) ?: return null
        runner.click("book", book)
        var next = runner.waitUntil("format", "screen_changed", 10_000) { formatSheet(it) || shows(it).isNotEmpty() || seatMap(it) }
        if (formatSheet(next)) {
            val chip = formatChoice(next, null) ?: throw StepFailed("format", "screen_changed", "No format to pick")
            runner.click("format", chip)
            next = runner.waitUntil("showtimes", "screen_changed", 10_000) { !formatSheet(it) && shows(it).isNotEmpty() }
        }
        val showtime = request.showtimeMs ?: return EventStop("showtimes", null, null, null, shows(next))
        val day = Instant.ofEpochMilli(showtime).atZone(zone)
        if (day.toLocalDate() != ZonedDateTime.now(zone).toLocalDate()) {
            val tab = dayTab(next, day) ?: return EventStop("showtime_missing", request.venue, clockText(showtime, zone), null, shows(next))
            runner.click("date", tab)
            // The previous day's list stays on screen for a moment after the tap.
            runner.settle("date", 1_500) { false }
            next = runner.waitUntil("date", "screen_changed", 8_000) { shows(it).isNotEmpty() }
        }
        val time = clockText(showtime, zone)
        var choice = pick(shows(next), time, request.venue)
        var scrolls = 0
        while (choice == null && scrolls < 4) {
            runner.scroll("showtimes")
            next = runner.settle("showtimes", 1_500) { pick(shows(it), time, request.venue) != null } ?: break
            choice = pick(shows(next), time, request.venue)
            scrolls += 1
        }
        if (choice == null) return EventStop("showtime_missing", request.venue, time, null, shows(next))
        runner.click("showtime", choice.node)
        var seats = runner.waitUntil("seats", "screen_changed", 10_000) { seatCountSheet(it) || seatMap(it) }
        if (seatMap(seats) && ticketsShown(seats) != request.tickets) {
            val change = seats.walk().firstOrNull { it.id == "seat_quantity_container" }
            if (change != null) {
                runner.click("tickets", change)
                seats = runner.waitUntil("tickets", "screen_changed", 8_000) { seatCountSheet(it) }
            }
        }
        if (seatCountSheet(seats)) {
            val slot = countSlot(seats, request.tickets) ?: throw StepFailed("tickets", "screen_changed", "No ticket count to pick")
            runner.click("tickets", slot)
            val select = runner.waitUntil("tickets", "screen_changed", 4_000) { root -> root.walk().any { it.id == "select_seats_button_picker" } }
            runner.click("tickets", select.walk().first { it.id == "select_seats_button_picker" }.clickableAncestor())
            seats = runner.waitUntil("seat_map", "screen_changed", 10_000) { seatMap(it) }
        }
        return EventStop("seat_map", choice.cinema, choice.time, ticketsShown(seats) ?: request.tickets, emptyList())
    }

    private fun cinemaBlock(time: NodeSnapshot): NodeSnapshot? {
        var current = time.parent
        while (current != null) {
            if (current.walk().any { DISTANCE.containsMatchIn(it.label()) }) return current
            current = current.parent
        }
        return null
    }

    private fun words(value: String): Set<String> =
        value.lowercase(Locale.ENGLISH).split(Regex("[^a-z0-9]+")).filter { it.isNotEmpty() }.toSet()
}
