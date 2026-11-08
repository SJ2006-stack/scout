package app.scout.companion.automation

import java.io.StringReader
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element
import org.xml.sax.InputSource

object UiDump {
    fun parse(xml: String): NodeSnapshot {
        val factory = DocumentBuilderFactory.newInstance()
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true)
        val document = factory.newDocumentBuilder().parse(InputSource(StringReader(xml)))
        val hierarchy = document.documentElement
        val nodes = hierarchy.childNodes
        for (index in 0 until nodes.length) {
            val child = nodes.item(index)
            if (child is Element) return element(child)
        }
        return NodeSnapshot()
    }

    fun resource(path: String): NodeSnapshot {
        val stream = UiDump::class.java.classLoader.getResourceAsStream(path)
            ?: error("Missing fixture $path")
        return parse(stream.bufferedReader().readText())
    }

    fun text(path: String): String {
        val stream = UiDump::class.java.classLoader.getResourceAsStream(path)
            ?: error("Missing fixture $path")
        return stream.bufferedReader().readText()
    }

    private fun element(node: Element): NodeSnapshot {
        val children = ArrayList<NodeSnapshot>()
        val nodes = node.childNodes
        for (index in 0 until nodes.length) {
            val child = nodes.item(index)
            if (child is Element) children += element(child)
        }
        val id = node.getAttribute("resource-id").substringAfterLast('/')
        val bounds = BOUNDS.find(node.getAttribute("bounds"))
        return NodeSnapshot(
            id = id,
            text = node.getAttribute("text"),
            desc = node.getAttribute("content-desc"),
            clickable = node.getAttribute("clickable") == "true",
            scrollable = node.getAttribute("scrollable") == "true",
            bounds = if (bounds == null) {
                Bounds(0, 0, 0, 0)
            } else {
                Bounds(bounds.groupValues[1].toInt(), bounds.groupValues[2].toInt(), bounds.groupValues[3].toInt(), bounds.groupValues[4].toInt())
            },
            children = children,
            packageName = node.getAttribute("package"),
        )
    }

    private val BOUNDS = Regex("""\[(\d+),(\d+)\]\[(\d+),(\d+)\]""")
}
