package app.scout.companion

import android.app.Activity
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.util.Base64
import android.util.Log
import java.io.File
import app.scout.companion.automation.NodeSnapshot
import app.scout.companion.automation.ScoutAutomationService
import app.scout.companion.automation.ServiceScreen

/**
 * Debug builds only. Starts the same cart run the Allow button starts, so the
 * Accessibility service does the taps. Release builds do not contain this activity.
 */
class DebugCartRun : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val debuggable = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        if (debuggable && intent.getBooleanExtra("dump", false)) {
            Thread { dumpScreen() }.start()
            finish()
            return
        }
        val action = if (debuggable) decode(intent.getStringExtra("action_b64")) else null
        if (action == null || action.name !in DEBUG_ACTIONS) {
            Log.i(TAG, "refused")
            finish()
            return
        }
        Thread {
            val result = PhoneActions(applicationContext).run(action)
            Log.i(TAG, result.toJson())
        }.start()
        finish()
    }

    /** What the Accessibility service sees in the foreground app, one labelled node per line. */
    private fun dumpScreen() {
        Thread.sleep(1_500)
        val service = ScoutAutomationService.connected
        val root = service?.let { ServiceScreen(it).root() }
        if (root == null) {
            Log.i(TAG, "dump empty")
            return
        }
        Log.i(TAG, "dump begin pkg=${root.packageName}")
        for (node in root.walk()) {
            if (node.text.isBlank() && node.desc.isBlank() && node.id.isBlank()) continue
            val b = node.bounds
            Log.i(TAG, "dump ${node.id}|${node.text.take(60)}|${node.desc.take(60)}|${if (node.clickable) "C" else "-"}|${b.left},${b.top},${b.right},${b.bottom}")
        }
        Log.i(TAG, "dump end")
        val xml = StringBuilder("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">")
        writeNode(xml, root)
        xml.append("</hierarchy>")
        val file = File(getExternalFilesDir(null), "screen.xml")
        file.writeText(xml.toString())
        Log.i(TAG, "dump file ${file.absolutePath}")
    }

    private fun writeNode(out: StringBuilder, node: NodeSnapshot) {
        val b = node.bounds
        out.append("<node text=\"").append(attr(node.text))
            .append("\" resource-id=\"").append(attr(node.id))
            .append("\" content-desc=\"").append(attr(node.desc))
            .append("\" clickable=\"").append(node.clickable)
            .append("\" scrollable=\"").append(node.scrollable)
            .append("\" package=\"").append(attr(node.packageName))
            .append("\" bounds=\"[").append(b.left).append(',').append(b.top).append("][").append(b.right).append(',').append(b.bottom).append("]\">")
        node.children.forEach { writeNode(out, it) }
        out.append("</node>")
    }

    private fun attr(value: String): String = value
        .replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;")
        .filter { it == '\t' || it == '\n' || it >= ' ' }

    private fun decode(encoded: String?): PhoneAction? {
        if (encoded.isNullOrBlank()) return null
        val json = runCatching { String(Base64.decode(encoded, Base64.DEFAULT), Charsets.UTF_8) }.getOrNull() ?: return null
        return readPhoneAction(json, System.currentTimeMillis())
    }

    private companion object {
        const val TAG = "ScoutDebug"
        val DEBUG_ACTIONS = setOf("app_cart_add", "app_event_book", "send_whatsapp", "get_capabilities")
    }
}
