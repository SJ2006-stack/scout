package app.scout.drop

sealed class DropReceipt {
    /** Stored and waiting for review in Scout's chat. */
    data class Ready(val drop: Drop) : DropReceipt()

    /** Nothing usable; [message] is shown to the person. */
    data class Failed(val message: String) : DropReceipt()

    data object Ignored : DropReceipt()
}

/**
 * Validates a share, copies its images, and stores it for [owner] (the signed-in uid, or null).
 * Runs off the main thread. Never uploads anything: the page sends it only after review.
 */
fun receiveShare(
    raw: RawShare,
    ownPackage: String,
    owner: String?,
    inbox: DropInbox,
    source: StreamSource,
    now: () -> Long,
    newId: () -> String,
): DropReceipt {
    val plan = when (val read = readShare(raw, ownPackage)) {
        SharePlan.NotAShare -> return DropReceipt.Ignored
        is SharePlan.Reject -> return DropReceipt.Failed(read.message)
        is SharePlan.Accept -> read
    }
    val id = newId()
    val folder = inbox.stage(id)
    val outcome = DropImporter(source, newId).import(plan.images, folder)
    val notes = plan.notes + outcome.notes
    if (plan.text.isEmpty() && plan.subject == null && outcome.images.isEmpty()) {
        folder.deleteRecursively()
        return DropReceipt.Failed(notes.lastOrNull() ?: "Scout could not read that share.")
    }
    val drop = Drop(id, owner, now(), plan.text, plan.subject, plan.urls, outcome.images, notes)
    inbox.put(drop)
    return DropReceipt.Ready(drop)
}
