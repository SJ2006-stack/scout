package app.scout.companion.automation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.ArrayDeque

class WhatsAppSendTest {
    @Test
    fun linkPinsTheNumberAndTheText() {
        assertEquals("https://wa.me/919876543210?text=On%20my%20way", WhatsAppSend.link("919876543210", "On my way"))
    }

    @Test
    fun sendButtonIsThePaperPlaneNotTheMicrophone() {
        val mic = NodeSnapshot(id = "voice_note_btn", desc = "Voice message, Button", clickable = true)
        val send = NodeSnapshot(id = "send", desc = "Send", clickable = true, bounds = Bounds(919, 1340, 1054, 1475))
        assertNull(WhatsAppSend.sendControl(NodeSnapshot(children = listOf(mic), packageName = "com.whatsapp")))
        assertEquals("send", WhatsAppSend.sendControl(NodeSnapshot(children = listOf(mic, send), packageName = "com.whatsapp"))?.id)
    }

    @Test
    fun oneExactNameIsTappableAndTwoAreNot() {
        val only = chatList("Soham Bhanja")
        assertEquals("row", WhatsAppSend.namedRow(only, "soham bhanja")?.id)
        val two = NodeSnapshot(
            packageName = "com.whatsapp",
            children = listOf(
                NodeSnapshot(id = "row", clickable = true, children = listOf(NodeSnapshot(id = "conversations_row_contact_name", text = "Soham Bhanja"))),
                NodeSnapshot(id = "row", clickable = true, children = listOf(NodeSnapshot(id = "conversations_row_contact_name", text = "Soham Bhanja"))),
            ),
        )
        assertNull(WhatsAppSend.namedRow(two, "Soham Bhanja"))
    }

    @Test
    fun numberPathOpensTheLinkAndTapsSend() {
        val screen = FrameScreen(
            compose("On my way", send = true),
            compose("", send = false),
        )
        WhatsAppSend.deliver(screen, runner(screen), "com.whatsapp", "919876543210", null, "On my way")
        assertEquals("https://wa.me/919876543210?text=On%20my%20way" to "com.whatsapp", screen.opened.single())
        assertEquals(listOf("send"), screen.clicked)
    }

    @Test
    fun searchHintInTheFieldTextIsTheOpener() {
        val home = NodeSnapshot(children = listOf(NodeSnapshot(text = "Ask Meta AI or Search", clickable = true)))
        assertEquals("Ask Meta AI or Search", WhatsAppSend.searchOpener(home)?.text)
    }

    @Test
    fun namePathRetriesTypingWhenTheKeyboardMovesTheField() {
        val screen = NameScreen()
        WhatsAppSend.deliver(screen, runner(screen), "com.whatsapp", null, "Soham Bhanja", "hi, why so serious")
        assertEquals(2, screen.searchAttempts)
        assertEquals(listOf("Ask Meta AI or Search", "contact_row_container", "send"), screen.clicked)
    }

    @Test
    fun microphoneAloneIsLeftUntapped() {
        val screen = FrameScreen(compose("", send = false))
        val error = runCatching { WhatsAppSend.deliver(screen, runner(screen), "com.whatsapp", "919876543210", null, "On my way") }.exceptionOrNull()
        assertTrue(error is StepFailed)
        assertEquals("unsent", (error as StepFailed).reason)
        assertTrue(screen.clicked.isEmpty())
    }

    private fun compose(entry: String, send: Boolean): NodeSnapshot {
        val kids = mutableListOf(NodeSnapshot(id = "entry", text = entry, packageName = "com.whatsapp"))
        if (send) kids += NodeSnapshot(id = "send", desc = "Send", clickable = true, bounds = Bounds(919, 1340, 1054, 1475), packageName = "com.whatsapp")
        else kids += NodeSnapshot(id = "voice_note_btn", desc = "Voice message, Button", clickable = true, packageName = "com.whatsapp")
        return NodeSnapshot(packageName = "com.whatsapp", children = kids)
    }

    private fun chatList(name: String): NodeSnapshot {
        return NodeSnapshot(
            packageName = "com.whatsapp",
            children = listOf(
                NodeSnapshot(
                    id = "row",
                    clickable = true,
                    children = listOf(NodeSnapshot(id = "conversations_row_contact_name", text = name)),
                ),
            ),
        )
    }
}

private class NameScreen : Screen {
    var phase = "home"
    var query = ""
    var searchAttempts = 0
    val clicked = mutableListOf<String>()

    override fun root(): NodeSnapshot {
        val kids = when (phase) {
            "chat" -> listOf(
                NodeSnapshot(id = "entry", text = "hi, why so serious", packageName = "com.whatsapp"),
                NodeSnapshot(id = "send", desc = "Send", clickable = true, bounds = Bounds(919, 1340, 1054, 1475), packageName = "com.whatsapp"),
            )
            "search" -> {
                val field = NodeSnapshot(id = "search_input", text = query.ifBlank { "Ask Meta AI or Search" }, clickable = true, packageName = "com.whatsapp")
                if (query.equals("Soham Bhanja", ignoreCase = true)) {
                    listOf(field, NodeSnapshot(id = "contact_row_container", clickable = true, packageName = "com.whatsapp", children = listOf(NodeSnapshot(id = "conversations_row_contact_name", text = "Soham Bhanja", packageName = "com.whatsapp"))))
                } else {
                    listOf(field)
                }
            }
            else -> listOf(NodeSnapshot(text = "Ask Meta AI or Search", clickable = true, packageName = "com.whatsapp"))
        }
        return NodeSnapshot(packageName = "com.whatsapp", children = kids)
    }

    override fun foregroundPackage(): String = "com.whatsapp"
    override fun abortedReason(): String? = null
    override fun launch(packageName: String) {}
    override fun openUrl(url: String) {}
    override fun click(node: NodeSnapshot): Boolean {
        clicked += node.id.ifBlank { node.text }
        if (node.text == "Ask Meta AI or Search") phase = "search"
        if (node.id == "contact_row_container") phase = "chat"
        return true
    }
    override fun gestureClick(node: NodeSnapshot): Boolean = click(node)
    override fun setText(node: NodeSnapshot, value: String): Boolean {
        if (node.id != "search_input") return true
        searchAttempts += 1
        if (searchAttempts == 1) return false
        query = value
        return true
    }
    override fun scroll(node: NodeSnapshot, forward: Boolean): Boolean = true
    override fun back() {}
}

private class FrameScreen(first: NodeSnapshot, vararg rest: NodeSnapshot) : Screen {
    private val frames = ArrayDeque<NodeSnapshot>().apply {
        add(first)
        rest.forEach { add(it) }
    }
    val opened = mutableListOf<Pair<String, String>>()
    val clicked = mutableListOf<String>()

    override fun root(): NodeSnapshot? = frames.firstOrNull()
    override fun foregroundPackage(): String = "com.whatsapp"
    override fun abortedReason(): String? = null
    override fun launch(packageName: String) {}
    override fun openUrl(url: String) {
        opened += url to ""
    }
    override fun openPackaged(url: String, packageName: String) {
        opened += url to packageName
    }
    override fun click(node: NodeSnapshot): Boolean {
        clicked += node.id
        if (frames.size > 1) frames.removeFirst()
        return true
    }
    override fun gestureClick(node: NodeSnapshot): Boolean = click(node)
    override fun setText(node: NodeSnapshot, value: String): Boolean = true
    override fun scroll(node: NodeSnapshot, forward: Boolean): Boolean = true
    override fun back() {}
}
