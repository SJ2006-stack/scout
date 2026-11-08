package app.scout.companion.automation

import java.net.URLEncoder

/**
 * Sends one WhatsApp message on the phone. A number uses the wa.me link, which opens
 * that chat with the text already filled in. A name uses WhatsApp's own search and
 * only continues when exactly one chat has that name. Either way the last step is the
 * Send button (id send). The microphone that sits in the same spot when the box is
 * empty is never tapped.
 *
 * WhatsApp stays off the service's event list. Its notifications must not cancel a
 * store run. The front window is still readable while this run is active.
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
        val home = runner.waitUntil("search", "no_search", 4_000) { searchOpener(it) != null }
        runner.click("search", searchOpener(home)!!)
        val field = runner.waitUntil("search_field", "no_search", 3_000) { it.walk().any { node -> node.id == "search_input" } }
        runner.setText("search_field", field.walk().first { it.id == "search_input" }, name)
        val results = runner.waitUntil("results", "no_match", 3_000) { root ->
            val count = root.walk().count { it.id == "conversations_row_contact_name" && it.text.equals(name, ignoreCase = true) }
            if (count > 1) throw StepFailed("results", "ambiguous", "More than one chat is named $name.")
            count == 1
        }
        val row = namedRow(results, name) ?: throw StepFailed("results", "no_match", "No chat is named $name.")
        runner.click("chat", row)
        val compose = runner.waitUntil("compose", "no_compose", 3_000) { entry(it) != null }
        runner.setText("compose", entry(compose)!!, text)
        val ready = runner.waitUntil("send", "unsent", 3_000) { sendControl(it) != null }
        runner.click("send", sendControl(ready)!!)
    }

    private fun searchOpener(root: NodeSnapshot): NodeSnapshot? {
        return root.walk().firstOrNull {
            it.id == "search_bar_inner_layout" || it.id == "search_input" || it.desc == "Ask Meta AI or Search"
        }
    }

    private fun entry(root: NodeSnapshot): NodeSnapshot? = root.walk().firstOrNull { it.id == "entry" }
}
