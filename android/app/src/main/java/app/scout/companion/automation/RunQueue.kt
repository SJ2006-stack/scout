package app.scout.companion.automation

import java.util.concurrent.locks.ReentrantLock

/** One cart run at a time. Later runs wait, in order, until the current one finishes. */
object RunQueue {
    private val lock = ReentrantLock(true)

    fun <T> run(block: () -> T): T {
        lock.lock()
        try {
            return block()
        } finally {
            lock.unlock()
        }
    }
}
