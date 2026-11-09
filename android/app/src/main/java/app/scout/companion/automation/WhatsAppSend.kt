package app.scout.companion.automation

import java.net.URLEncoder

/**
 * Sends one WhatsApp message on the phone. A number uses the wa.me link, which opens
 * that chat with the text already filled in. A name uses WhatsApp's own search and
 * only continues when exactly one chat has that name. Either way the last step is the
 * Send button (id send). The microphone that sits in the same spot when the box is
 * empty is never tapped.
 *
 * The service adds WhatsApp to its package list for this run. Without that, the app
 * opens and the window cannot be read, so nothing after the launch runs. The search
 * box is typed again when the keyboard moves it.
 */
internal object WhatsAppSend {
    fun link(phone: String, text: String): String {
        val encoded = URLEncoder.encode(text, Charsets.UTF_8.name()).replace("+", "%20")
        return "https://wa.me/$phone?text=$encoded"
    }

    fun sendControl(root: NodeSnapshot): NodeSnapshot? {
        return root.walk().firstOrNull { it.id == "send" && it.desc.equals("Send", ignoreCase = true) }
    }

    fun namedRow(root: NodeSnapshot, name: String): NodeSnapshot? {
        val hits = root.walk().filter { it.id == "conversations_row_contact_name" && it.text.equals(name, ignoreCase = true) }.toList()
        if (hits.size != 1) return null
        return hits[0].clickableAncestor()
    }

    /** The chat-list search, including the hint this WhatsApp build puts in the field's text. */
    fun searchOpener(root: NodeSnapshot): NodeSnapshot? {
        return root.walk().firstOrNull {
            it.id == "search_bar_inner_layout" ||
                it.id == "search_input" ||
                it.label().equals("Ask Meta AI or Search", ignoreCase = true)
        }
    }

    fun deliver(screen: Screen, runner: StepRunner, packageName: String, phone: String?, name: String?, text: String) {
        when {
            !phone.isNullOrBlank() -> deliverNumber(screen, runner, packageName, phone, text)
            !name.isNullOrBlank() -> deliverName(screen, runner, packageName, name, text)
            else -> throw StepFailed("compose", "invalid", "A WhatsApp message needs a number or a name.")
        }
    }

    private fun deliverNumber(screen: Screen, runner: StepRunner, packageName: String, phone: String, text: String) {
        screen.openPackaged(link(phone, text), packageName)
        val ready = runner.waitUntil("compose", "unsent", 4_000) { sendControl(it) != null }
        runner.click("send", sendControl(ready)!!)
    }

    private fun deliverName(screen: Screen, runner: StepRunner, packageName: String, name: String, text: String) {
        screen.launch(packageName)
        var home = runner.settle("search", 12_000) { searchOpener(it) != null }
        if (searchOpener(home ?: NodeSnapshot()) == null) {
            runner.back("search")
            home = runner.waitUntil("search", "no_search", 6_000) { searchOpener(it) != null }
        }
        val opener = searchOpener(home ?: NodeSnapshot()) ?: throw StepFailed("search", "no_search", "WhatsApp's search box did not show up.")
        runner.click("search", opener)
        typeQuery(screen, runner, name)
        val results = runner.waitUntil("results", "no_match", 6_000) { root ->
            val count = root.walk().count { it.id == "conversations_row_contact_name" && it.text.equals(name, ignoreCase = true) }
            if (count > 1) throw StepFailed("results", "ambiguous", "More than one chat is named $name.")
            count == 1
        }
        val row = namedRow(results, name) ?: throw StepFailed("results", "no_match", "No chat is named $name.")
        runner.click("chat", row)
        val compose = runner.waitUntil("compose", "no_compose", 4_000) { entry(it) != null }
        runner.setText("compose", entry(compose)!!, text)
        val ready = runner.waitUntil("send", "unsent", 4_000) { sendControl(it) != null }
        runner.click("send", sendControl(ready)!!)
    }

    /** The keyboard resizes the field after it is focused, so the first type often misses. */
    private fun typeQuery(screen: Screen, runner: StepRunner, name: String) {
        repeat(4) { attempt ->
            val limit = if (attempt == 0) 8_000L else 2_000L
            val field = runner.waitUntil("search_field", "no_search", limit) { searchField(it) != null }
            val input = searchField(field)
            if (input != null && screen.setText(input, name)) {
                val shown = runner.settle("search_field", 1_500) { searchField(it)?.let { box -> holdsQuery(box, name) } == true }
                if (shown != null && searchField(shown)?.let { holdsQuery(it, name) } == true) return
            }
        }
        throw StepFailed("search_field", "no_search", "WhatsApp's search box did not take the name.")
    }

    private fun searchField(root: NodeSnapshot): NodeSnapshot? = root.walk().firstOrNull { it.id == "search_input" }

    private fun holdsQuery(node: NodeSnapshot, name: String): Boolean {
        val text = node.text.replace("\u200B", "").trim()
        if (text.equals("Ask Meta AI or Search", ignoreCase = true)) return false
        return text.contains(name, ignoreCase = true)
    }

    private fun entry(root: NodeSnapshot): NodeSnapshot? = root.walk().firstOrNull { it.id == "entry" }
}
