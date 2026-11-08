package app.scout

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskCodeTest {
    @Test
    fun bindsANumericCodeToOneTaskAndKeepsItOutOfTheLog() {
        val taskId = "a".repeat(32)
        val token = "b".repeat(32)
        val code = "918273"
        val task = readTaskCode(taskId, token, code)
        assertEquals(taskId, task?.taskId)
        assertEquals("/api/browser/tasks/$taskId/code", task?.let { taskCodePath(it) })
        assertTrue(task?.let { taskCodeBody(it) }?.contains(code) == true)
        assertFalse(task?.let { taskCodeLog(it) }?.contains(code) == true)
        assertNull(readTaskCode(taskId, token, "12"))
        assertNull(readTaskCode(taskId, token, "not-a-code"))
        assertNull(readTaskCode("short", token, code))
    }
}
