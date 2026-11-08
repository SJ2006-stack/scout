package app.scout

private val SIX_DIGITS = Regex("(?<!\\d)(\\d{6})(?!\\d)")
private val CODE_DIGITS = Regex("(?<!\\d)(\\d{4,8})(?!\\d)")

fun readConsentOtp(message: String): String? {
    val six = SIX_DIGITS.find(message)
    if (six != null) return six.groupValues[1]
    return CODE_DIGITS.find(message)?.groupValues?.get(1)
}

fun otpFillScript(code: String): String {
    val quoted = jsonString(code)
    return """
        (function() {
          var code = $quoted;
          window.dispatchEvent(new CustomEvent("scout-otp", { detail: code }));
          var input = document.getElementById("auth-code");
          if (!input) input = document.querySelector("input[autocomplete='one-time-code']");
          if (!input) return;
          var proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
          if (proto && proto.set) proto.set.call(input, code);
          else input.value = code;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        })();
    """.trimIndent()
}

private fun jsonString(value: String): String {
    val escaped = value.replace("\\", "\\\\").replace("\"", "\\\"")
    return "\"$escaped\""
}
