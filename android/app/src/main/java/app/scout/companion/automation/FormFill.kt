package app.scout.companion.automation

data class FormValue(val label: String, val value: String)

data class FormPlan(val writes: List<Pair<NodeSnapshot, String>>, val button: NodeSnapshot?)

private val GENERIC = Regex("(?i)^(your answer|short answer|long answer|enter|type here|text|input|answer)$")
private val SECRET = Regex("(?i)(password|passcode|\\botp\\b|one[- ]time|\\bcvv\\b|\\bpin\\b|card number|aadhaar|aadhar)")
private val PAY = Regex("(?i)(\\bpay\\b|place\\s+order|buy now|purchase|checkout|\\bupi\\b)")
private val GO = Regex("(?i)^(submit|send|next|continue|done|save)$")
private val PAIR = Regex("""([A-Za-z][A-Za-z ]{0,30}?)\s*(?:is|:)\s*([^,;\n]{1,80})""")

/** Name, email, and phone from the account, plus "city is Delhi" style pairs from what they asked. */
fun formValues(name: String, email: String, phone: String, note: String): List<FormValue> {
    val values = ArrayList<FormValue>()
    if (name.isNotBlank()) values += FormValue("name", name.trim().take(80))
    if (email.isNotBlank()) values += FormValue("email", email.trim().take(80))
    if (phone.isNotBlank()) values += FormValue("phone", phone.trim().take(20))
    PAIR.findAll(note).forEach { match ->
        val label = match.groupValues[1].trim()
        val value = match.groupValues[2].trim().trim('.')
        if (label.length >= 2 && value.isNotEmpty() && !SECRET.containsMatchIn(label)) values += FormValue(label, value.take(80))
    }
    return values
}

fun formShouldSubmit(note: String): Boolean = Regex("(?i)\\b(submit|send|finish|complete)\\b").containsMatchIn(note)

/**
 * Which empty fields on [root] to type, and which button to tap.
 * Payment, password, and code fields are left alone. A button is only chosen when [submit] is true.
 */
fun planFormFill(root: NodeSnapshot, values: List<FormValue>, submit: Boolean): FormPlan {
    if (root.packageName == "app.scout") return FormPlan(emptyList(), null)
    val order = root.walk().toList()
    val used = HashSet<NodeSnapshot>()
    val writes = ArrayList<Pair<NodeSnapshot, String>>()
    for (node in order) {
        if (!node.editable || node in used) continue
        val question = fieldQuestion(node, order)
        if (question.isBlank() || SECRET.containsMatchIn(question)) continue
        val value = values.firstOrNull { wants(question, it.label) }?.value ?: continue
        if (value.isBlank() || node.text.trim().equals(value, ignoreCase = true)) continue
        used += node
        writes += node to value
    }
    val button = if (submit) submitButton(order) else null
    return FormPlan(writes, button)
}

private fun fieldQuestion(field: NodeSnapshot, order: List<NodeSnapshot>): String {
    val hint = field.hint.trim()
    if (hint.isNotEmpty() && !GENERIC.matches(hint)) return hint
    val desc = field.desc.trim()
    if (desc.isNotEmpty() && !GENERIC.matches(desc)) return desc
    val index = order.indexOf(field)
    for (cursor in index - 1 downTo 0) {
        val other = order[cursor]
        if (other.editable) continue
        val label = other.label()
        if (label.length !in 2..80 || GENERIC.matches(label)) continue
        if (other.bounds.bottom <= field.bounds.top + 12) return label
    }
    return ""
}

private fun wants(question: String, label: String): Boolean {
    val asked = question.lowercase()
    val given = label.lowercase().trim()
    if (given.length < 2 || asked.length < 2) return false
    if (asked.contains(given) || given.contains(asked)) return true
    val aliases = listOf(
        "name" to listOf("name", "naam"),
        "email" to listOf("email", "e-mail", "mail"),
        "phone" to listOf("phone", "mobile", "whatsapp", "contact"),
    )
    val group = aliases.firstOrNull { (key, words) -> given == key || words.any { given.contains(it) } } ?: return false
    return asked.contains(group.first) || group.second.any { asked.contains(it) }
}

private fun submitButton(order: List<NodeSnapshot>): NodeSnapshot? {
    return order
        .filter { it.clickable }
        .map { it.clickableAncestor() }
        .distinct()
        .filter { button ->
            val label = button.label()
            label.length in 2..32 && GO.matches(label.trim()) && !PAY.containsMatchIn(label) && SafetyGuard.refusal(button) == null
        }
        .maxByOrNull { it.bounds.top }
}
