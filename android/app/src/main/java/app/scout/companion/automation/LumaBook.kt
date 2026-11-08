package app.scout.companion.automation

/**
 * Opens the registration screen from the event page and stops on it. Luma fills the answers it
 * knows from the profile; the Register button on that screen is the person's to tap.
 */
object LumaBook {
    private val OPENERS = setOf("register", "request to join", "get tickets", "get ticket")

    /** The Register control in the event page's action row, beside Contact. Never the one on the form. */
    fun opener(root: NodeSnapshot): NodeSnapshot? {
        if (formOpen(root)) return null
        val labels = root.walk().map { it.label().trim() }.toList()
        if (labels.none { it.equals("Contact", ignoreCase = true) }) return null
        return root.walk().firstOrNull { it.label().trim().lowercase() in OPENERS }
    }

    fun formOpen(root: NodeSnapshot): Boolean = root.walk().any { it.label().trim().equals("Registration", ignoreCase = true) }

    /** Required questions as answered and unanswered. A field holds its answer as text and its question as a hint. */
    fun answers(root: NodeSnapshot): Pair<Int, Int> {
        var filled = 0
        var empty = 0
        val nodes = root.walk().toList()
        for (question in nodes) {
            val asked = question.text.trim()
            if (!asked.endsWith("*")) continue
            val field = nodes.firstOrNull { it !== question && it.desc.trim() == asked }?.let { hint -> hint.parent?.takeIf { it.clickable } ?: hint }
            val answer = field?.text?.trim().orEmpty()
            if (answer.isNotEmpty() && answer != asked) filled += 1 else empty += 1
        }
        return filled to empty
    }

    fun toForm(runner: StepRunner): EventStop? {
        var page = runner.settle("register", 3_000) { opener(it) != null } ?: return null
        // The first tap on a page that is still loading does nothing, so it gets one more.
        repeat(2) {
            val button = opener(page) ?: return@repeat
            runner.click("register", tapPoint(button))
            val form = runner.settle("register", 5_000) { formOpen(it) }
            if (form != null && formOpen(form)) {
                val (filled, empty) = answers(form)
                return EventStop("form", note = formNote(filled, empty))
            }
            page = form ?: page
        }
        return null
    }

    private fun formNote(filled: Int, empty: Int): String? = when {
        filled == 0 && empty == 0 -> null
        empty == 0 -> "${answerCount(filled)} filled in from your Luma profile"
        else -> "${answerCount(filled)} filled in, ${answerCount(empty, "question")} still empty"
    }

    private fun answerCount(count: Int, noun: String = "answer"): String = "$count ${if (count == 1) noun else "${noun}s"}"
}
