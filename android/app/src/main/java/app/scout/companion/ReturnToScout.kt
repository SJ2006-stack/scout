package app.scout.companion

import android.content.Context
import android.content.Intent
import app.scout.MainActivity

/**
 * A finished task comes back to Scout. A handoff stays in the other app, because the person
 * still has to tap Send or pick up where Scout stopped.
 */
fun shouldReturnToScout(status: String): Boolean = status != "handoff_started"

fun returnToScout(context: Context) {
    context.startActivity(
        Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
    )
}
