package app.scout.companion

import app.scout.readConsentOtp
import app.scout.readTaskCode
import app.scout.readTaskIds
import app.scout.taskCodeBody
import app.scout.taskCodeLog
import app.scout.taskCodePath

data class OtpSubmit(
    val path: String,
    val body: String,
    val log: String,
)

class OtpHandoff(
    private val now: () -> Long,
    private val ttlMs: Long = 120_000,
) {
    private var owner: String? = null
    private var taskId: String? = null
    private var token: String? = null
    private var code: String? = null
    private var expiresAt: Long = 0
    private var prepared = false

    fun begin(userId: String, taskId: String, token: String): Boolean {
        if (userId.isBlank() || !readTaskIds(taskId, token)) return false
        owner = userId
        this.taskId = taskId.trim()
        this.token = token.trim()
        code = null
        prepared = false
        expiresAt = now() + ttlMs
        return true
    }

    fun offerMessage(userId: String, message: String): OtpSubmit? {
        val digits = readConsentOtp(message) ?: return null
        return offerCode(userId, digits)
    }

    fun offerCode(userId: String, digits: String): OtpSubmit? {
        val task = taskId ?: return null
        val ticket = token ?: return null
        if (userId != owner || prepared) return null
        if (now() >= expiresAt) {
            discard()
            return null
        }
        val bound = readTaskCode(task, ticket, digits) ?: return null
        code = bound.code
        prepared = true
        return OtpSubmit(taskCodePath(bound), taskCodeBody(bound), taskCodeLog(bound))
    }

    fun consume(userId: String, task: String): Boolean {
        if (userId != owner || task != taskId || !prepared) return false
        discard()
        return true
    }

    fun holdingCode(): Boolean = code != null

    fun discard() {
        code = null
        prepared = false
        owner = null
        taskId = null
        token = null
        expiresAt = 0
    }

    override fun toString(): String = "OtpHandoff(task=${taskId ?: ""})"
}
