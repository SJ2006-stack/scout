package app.scout

data class TaskCode(
    val taskId: String,
    val token: String,
    val code: String,
)

private val ID = Regex("^[a-f0-9]{32}$")
private val DIGITS = Regex("^\\d{4,8}$")

fun readTaskIds(taskId: String, token: String): Boolean {
    return ID.matches(taskId.trim()) && ID.matches(token.trim())
}

fun readTaskCode(taskId: String, token: String, code: String): TaskCode? {
    val id = taskId.trim()
    val ticket = token.trim()
    val digits = code.trim()
    if (!ID.matches(id) || !ID.matches(ticket) || !DIGITS.matches(digits)) return null
    return TaskCode(id, ticket, digits)
}

fun taskCodePath(task: TaskCode): String = "/api/browser/tasks/${task.taskId}/code"

fun taskCodeBody(task: TaskCode): String = """{"token":"${task.token}","code":"${task.code}"}"""

fun taskCodeLog(task: TaskCode): String = "Sending a code for task ${task.taskId}."
