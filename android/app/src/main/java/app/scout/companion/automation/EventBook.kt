package app.scout.companion.automation

import org.json.JSONObject

data class EventRequest(
    val app: String,
    val link: String,
    val title: String,
    val tickets: Int,
    val showtimeMs: Long? = null,
    val venue: String? = null,
    val maxPricePerTicket: Double? = null,
)

/** Where an app run stopped, one step before money or a sign-up: seat map, Checkout, or the form. */
data class EventStop(
    val stage: String,
    val cinema: String? = null,
    val time: String? = null,
    val tickets: Int? = null,
    val options: List<Show> = emptyList(),
    val total: Double? = null,
    val note: String? = null,
)

data class EventOutcome(
    val app: String,
    val title: String,
    val stoppedAt: String,
    val reason: String,
    val detail: String? = null,
    val tickets: Int? = null,
    val showtimeMs: Long? = null,
    val total: Double? = null,
)

/**
 * Opens one event link inside its app, then goes as far as the app allows without paying or
 * signing up: BookMyShow and District movies to the seat map, District events to Checkout with
 * the tickets in, Luma to the filled registration form. Pay, Checkout, and the form's Register
 * are left for the person.
 */
object EventBook {
    private val HOST = Regex("^https://([^/?#]+)", RegexOption.IGNORE_CASE)
    private val STOP = Regex("(?i)(\\bcheckout\\b|\\bpay now\\b|\\bplace order\\b|\\bregister\\b|\\brsvp\\b|\\bbook tickets\\b|\\bpay\\b)")
    private val SHEET = Regex("(?i)(flat .{0,24}off|dining deals)")

    fun readRequest(args: JSONObject): EventRequest? {
        val ref = args.optJSONObject("ref") ?: return null
        val app = ref.optString("app")
        val link = ref.optString("link").trim()
        val title = ref.optString("title").trim()
        val tickets = args.optInt("tickets", 0)
        if (title.isEmpty() || title.length > 120 || tickets !in 1..10) return null
        if (!linkFits(app, link)) return null
        val showtime = args.opt("showtime")
        val showtimeMs = (showtime as? Number)?.toLong()
        val venue = ref.optString("venue").trim().takeIf { it.isNotEmpty() && it != "null" && it.length <= 160 }
        val max = (args.opt("maxPricePerTicket") as? Number)?.toDouble()?.takeIf { it > 0 }
        return EventRequest(app, link, title, tickets, showtimeMs, venue, max)
    }

    fun linkFits(app: String, link: String): Boolean {
        val host = hostOf(link) ?: return false
        return when (app) {
            "bookmyshow" -> host == "in.bookmyshow.com"
            "district" -> host == "www.district.in"
            "luma" -> host == "luma.com" || host == "www.luma.com" || host == "lu.ma" || host == "www.lu.ma"
            else -> false
        }
    }

    /** Opens the event and carries on as far as that app's script goes, saying where it stopped. */
    fun deliver(screen: Screen, runner: StepRunner, request: EventRequest): EventStop? {
        val packageName = AUTOMATION_PACKAGES[request.app] ?: throw StepFailed("event", "app_missing", "That event app is not in this build.")
        screen.openPackaged(request.link, packageName)
        var page = runner.waitUntil("event", "timeout", 15_000) { loaded(it, packageName) }
        if (!showsTitle(page, request.title)) {
            // A cold start can land on the app's home screen; the same link works once the app is up.
            page = runner.settle("event", 2_000) { showsTitle(it, request.title) } ?: page
            if (!showsTitle(page, request.title)) {
                screen.openPackaged(request.link, packageName)
                page = runner.settle("event", 8_000) { loaded(it, packageName) && showsTitle(it, request.title) } ?: page
            }
        }
        val dismiss = sheetDismiss(page)
        if (dismiss != null) runner.click("dismiss", dismiss)
        if (!showsTitle(page, request.title)) return null
        return when (request.app) {
            "bookmyshow" -> BookMyShowBook.toSeats(screen, runner, request)
            "district" -> DistrictBook.toStop(screen, runner, request)
            "luma" -> LumaBook.toForm(runner)
            else -> null
        }
    }

    /** The event app is in front and past its splash screen. */
    fun loaded(root: NodeSnapshot, packageName: String): Boolean {
        return root.packageName == packageName && root.walk().any { it.label().isNotBlank() }
    }

    fun showsTitle(root: NodeSnapshot, title: String): Boolean = root.walk().any { namesMatch(title, it.label(), allowSimilar = true) }

    /** A close control on a membership or dining ad. Not Checkout, and not Pay. */
    fun sheetDismiss(root: NodeSnapshot): NodeSnapshot? {
        promoDismiss(root)?.let { node ->
            if (SafetyGuard.refusal(node) == null) return node
        }
        val blob = root.walk().joinToString("\n") { "${it.text}\n${it.desc}" }
        if (!SHEET.containsMatchIn(blob)) return null
        return root.walk().firstOrNull { isDismissControl(it) && SafetyGuard.refusal(it) == null }
    }

    /** The first pay, checkout, register, or book-tickets label. Scout reports it and does not tap it. */
    fun paymentControl(root: NodeSnapshot): String? {
        for (node in root.walk()) {
            val hit = STOP.find(node.label())?.value?.trim()
            if (!hit.isNullOrEmpty()) return hit
        }
        return null
    }

    private fun hostOf(link: String): String? {
        val host = HOST.find(link)?.groupValues?.getOrNull(1)?.lowercase() ?: return null
        if (host.contains('@') || host.contains(':')) return null
        return host
    }
}

fun eventOutcome(request: EventRequest, root: NodeSnapshot?, stop: EventStop? = null): EventOutcome {
    if (stop != null) {
        val detail = when {
            stop.note != null -> stop.note
            stop.stage == "seat_map" -> listOfNotNull(stop.cinema, stop.time, stop.tickets?.let { "$it ${if (it == 1) "ticket" else "tickets"}" }).joinToString(", ")
            else -> showOptions(stop.options)
        }
        val chosen = if (stop.stage == "seat_map" || stop.stage == "checkout_ready") request.showtimeMs else null
        return EventOutcome(request.app, request.title, stop.stage, stop.stage, detail.ifBlank { null }, stop.tickets, chosen, stop.total)
    }
    val payment = root?.let { EventBook.paymentControl(it) }
    val onEvent = root != null && EventBook.showsTitle(root, request.title)
    return EventOutcome(
        app = request.app,
        title = request.title,
        stoppedAt = payment ?: "event",
        reason = when {
            !onEvent -> "not_on_event"
            payment != null -> "before_pay"
            else -> "opened"
        },
    )
}

/** Up to three cinemas (or days) with their times: "PVR: Promenade 07:10 PM, 10:15 PM; Cinepolis Saket 06:05 PM". */
fun showOptions(options: List<Show>): String {
    val byCinema = LinkedHashMap<String, MutableList<String>>()
    for (show in options) byCinema.getOrPut(show.cinema) { mutableListOf() }.add(show.time)
    return byCinema.entries.take(3).joinToString("; ") { (cinema, times) -> "$cinema ${times.take(4).joinToString(", ")}".trim() }
}

fun eventMessage(app: String, title: String, reason: String, detail: String? = null): String {
    val name = eventAppName(app)
    val more = detail?.let { " $it." } ?: ""
    return when (reason) {
        "seat_map" -> "$name is on the seat map for $title${detail?.let { ": $it" } ?: ""}. Pick your seats there, then pay. Scout does not tap Pay."
        "checkout_ready" -> "$name has the tickets in for $title${detail?.let { ": $it" } ?: ""}. Tap Checkout there to pay. Scout does not tap Checkout."
        "form" -> "$name's registration form for $title is open.$more Check it and tap Register there. Scout does not tap Register."
        "dates" -> "$name is on the dates for $title.$more Tell Scout the day and time, or pick one there."
        "over_budget" -> "Every $name ticket for $title is over your limit.$more Nothing was added."
        "showtimes" -> "$name is on the $title showtimes.$more Tap a time there, or tell Scout the cinema and time."
        "showtime_missing" -> "$name did not show that time for $title. The showtimes are open.$more"
        "opened", "before_pay" -> "$name is open on $title. Scout stopped before checkout. Pick the seats and pay there."
        "not_on_event" -> "$name is open, but not on $title. Search for it there."
        "timeout" -> "$name did not open that event."
        "user_stopped" -> "You stopped Scout on $name."
        "app_missing" -> "$name is not installed."
        "service_off" -> "Turn on Scout's accessibility service to open that event."
        else -> "Scout could not open that event on $name."
    }
}

fun eventStatus(reason: String): String = when (reason) {
    "opened", "before_pay", "seat_map", "checkout_ready", "form" -> "completed"
    "service_off" -> "needs_permission"
    "user_stopped", "not_on_event", "showtimes", "showtime_missing", "dates", "over_budget" -> "handoff_started"
    else -> "failed"
}

fun EventOutcome.toJson(): JSONObject {
    return JSONObject()
        .put("app", app)
        .put("tickets", tickets ?: JSONObject.NULL)
        .put("showtime", showtimeMs ?: JSONObject.NULL)
        .put("seats", JSONObject.NULL)
        .put("total", total ?: JSONObject.NULL)
        .put("stoppedAt", stoppedAt)
        .put("reason", reason)
}

private fun eventAppName(app: String): String = when (app) {
    "bookmyshow" -> "BookMyShow"
    "district" -> "District"
    "luma" -> "Luma"
    else -> app
}
