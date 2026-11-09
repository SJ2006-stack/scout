package app.scout.companion.automation

/** One node from an accessibility tree. Tests build these from saved dumps; the service builds them from the live window. */
class NodeSnapshot(
    val id: String = "",
    val text: String = "",
    val desc: String = "",
    val clickable: Boolean = false,
    val scrollable: Boolean = false,
    val bounds: Bounds = Bounds(0, 0, 0, 0),
    val children: List<NodeSnapshot> = emptyList(),
    val packageName: String = "",
    val editable: Boolean = false,
    val hint: String = "",
) {
    var parent: NodeSnapshot? = null

    init {
        children.forEach { child -> child.parent = this }
    }

    fun label(): String = text.trim().ifBlank { desc.trim() }

    fun walk(): Sequence<NodeSnapshot> = sequence {
        yield(this@NodeSnapshot)
        children.forEach { child -> yieldAll(child.walk()) }
    }

    /** The node itself when it is clickable, otherwise the nearest clickable ancestor. */
    fun clickableAncestor(): NodeSnapshot {
        var current: NodeSnapshot? = this
        while (current != null) {
            if (current.clickable) return current
            current = current.parent
        }
        return this
    }
}

/** A small box at the node's centre that matches no live node, so the tap goes out as a gesture. */
fun tapPoint(node: NodeSnapshot): NodeSnapshot {
    val x = (node.bounds.left + node.bounds.right) / 2
    val y = (node.bounds.top + node.bounds.bottom) / 2
    return NodeSnapshot(bounds = Bounds(x - 4, y - 4, x + 4, y + 4), packageName = node.packageName)
}

data class Bounds(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
}
