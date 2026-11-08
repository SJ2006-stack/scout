package app.scout.companion.automation

/**
 * Size matching shared with scout/src/shared/quantity.ts.
 * pcs / piece is included here because Blinkit and Zepto label counts that way (1 pc, 5 pcs).
 */
data class Quantity(val amount: Double, val unit: String, val raw: String)

private const val UNIT =
    "millilitres?|milliliters?|litres?|liters?|kilograms?|grams?|ltr|kgs?|gms?|ml|l|g|pieces?|pcs?"

private val UNIT_PATTERN = Regex("(?<amount>\\d+(?:\\.\\d+)?)\\s*(?<unit>$UNIT)\\b", RegexOption.IGNORE_CASE)

fun parseQuantity(text: String): Quantity? {
    val prefix = Regex("(\\d+(?:\\.\\d+)?)\\s*(?:x|×)\\s*(\\d+(?:\\.\\d+)?)\\s*($UNIT)\\b", RegexOption.IGNORE_CASE).find(text)
    if (prefix != null) {
        return toBase(prefix.groupValues[1].toDouble() * prefix.groupValues[2].toDouble(), prefix.groupValues[3], prefix.value)
    }
    val suffix = Regex("(\\d+(?:\\.\\d+)?)\\s*($UNIT)\\b\\s*(?:x|×)\\s*(\\d+)\\b", RegexOption.IGNORE_CASE).find(text)
    if (suffix != null) {
        return toBase(suffix.groupValues[1].toDouble() * suffix.groupValues[3].toDouble(), suffix.groupValues[2], suffix.value)
    }
    val matches = UNIT_PATTERN.findAll(text).toList()
    for (index in matches.indices.reversed()) {
        val match = matches[index]
        val amount = match.groups["amount"]?.value ?: continue
        val unit = match.groups["unit"]?.value ?: continue
        val quantity = toBase(amount.toDouble(), unit, match.value)
        if (quantity != null) return quantity
    }
    return null
}

fun quantitiesMatch(left: Quantity?, right: Quantity?): Boolean {
    if (left == null || right == null) return false
    return left.unit == right.unit && kotlin.math.abs(left.amount - right.amount) < 0.001
}

private fun toBase(amount: Double, unitRaw: String, raw: String): Quantity? {
    val unit = unitRaw.lowercase()
    if (Regex("^(l|ltr|litres?|liters?)$").matches(unit)) return Quantity(amount * 1000, "ml", raw)
    if (Regex("^(ml|millilitres?|milliliters?)$").matches(unit)) return Quantity(amount, "ml", raw)
    if (Regex("^(kg|kgs|kilograms?)$").matches(unit)) return Quantity(amount * 1000, "g", raw)
    if (Regex("^(g|gm|gms|grams?)$").matches(unit)) return Quantity(amount, "g", raw)
    if (Regex("^(pc|pcs|piece|pieces)$").matches(unit)) return Quantity(amount, "pcs", raw)
    return null
}
