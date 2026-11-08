package app.scout.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import app.scout.companion.CachedBrowserTask
import app.scout.companion.CachedCart
import app.scout.companion.CachedConversation
import app.scout.companion.CachedEvent
import app.scout.companion.CachedGrocery
import app.scout.companion.CachedMessage
import app.scout.companion.CachedTask
import app.scout.companion.DeviceRecord
import app.scout.companion.LocalDesk
import app.scout.companion.OutboxItem
import app.scout.companion.syncKind
import app.scout.companion.syncWire

@Entity(tableName = "conversations", primaryKeys = ["userId", "id"])
data class ConversationRow(
    val userId: String,
    val id: String,
    val title: String,
    val agent: String,
    val updatedAt: Long,
    val payload: String,
)

@Entity(tableName = "messages", primaryKeys = ["userId", "conversationId", "at"])
data class MessageRow(
    val userId: String,
    val conversationId: String,
    val at: Long,
    val text: String,
)

@Entity(tableName = "events", primaryKeys = ["userId", "id"])
data class EventRow(val userId: String, val id: String, val title: String, val updatedAt: Long)

@Entity(tableName = "groceries", primaryKeys = ["userId", "id"])
data class GroceryRow(val userId: String, val id: String, val query: String, val updatedAt: Long)

@Entity(tableName = "carts", primaryKeys = ["userId", "id"])
data class CartRow(val userId: String, val id: String, val payload: String, val updatedAt: Long)

@Entity(tableName = "tasks", primaryKeys = ["userId", "id"])
data class TaskRow(
    val userId: String,
    val id: String,
    val title: String,
    val status: String,
    val updatedAt: Long,
)

@Entity(tableName = "browser_tasks", primaryKeys = ["userId", "id"])
data class BrowserTaskRow(val userId: String, val id: String, val status: String, val updatedAt: Long)

@Entity(tableName = "outbox", primaryKeys = ["id"])
data class OutboxRow(
    val id: String,
    val userId: String,
    val kind: String,
    val payload: String,
    val attempts: Int,
)

@Entity(tableName = "cursors", primaryKeys = ["userId", "resource"])
data class CursorRow(val userId: String, val resource: String, val at: Long)

@Entity(tableName = "devices", primaryKeys = ["userId", "deviceId"])
data class DeviceRow(
    val userId: String,
    val deviceId: String,
    val pushToken: String,
    val revoked: Int,
)

@Dao
interface ScoutDao {
    @Query("SELECT * FROM conversations WHERE userId = :userId ORDER BY updatedAt DESC")
    suspend fun conversations(userId: String): List<ConversationRow>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveConversation(row: ConversationRow)

    @Query("SELECT * FROM messages WHERE userId = :userId AND conversationId = :conversationId ORDER BY at DESC")
    suspend fun messages(userId: String, conversationId: String): List<MessageRow>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveMessage(row: MessageRow)

    @Query("SELECT * FROM events WHERE userId = :userId ORDER BY updatedAt DESC")
    suspend fun events(userId: String): List<EventRow>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveEvent(row: EventRow)

    @Query("SELECT * FROM groceries WHERE userId = :userId ORDER BY updatedAt DESC")
    suspend fun groceries(userId: String): List<GroceryRow>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveGrocery(row: GroceryRow)

    @Query("SELECT * FROM carts WHERE userId = :userId ORDER BY updatedAt DESC")
    suspend fun carts(userId: String): List<CartRow>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveCart(row: CartRow)

    @Query("SELECT * FROM tasks WHERE userId = :userId ORDER BY updatedAt DESC")
    suspend fun tasks(userId: String): List<TaskRow>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveTask(row: TaskRow)

    @Query("SELECT * FROM browser_tasks WHERE userId = :userId ORDER BY updatedAt DESC")
    suspend fun browserTasks(userId: String): List<BrowserTaskRow>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveBrowserTask(row: BrowserTaskRow)

    @Query("SELECT * FROM outbox WHERE userId = :userId")
    suspend fun outbox(userId: String): List<OutboxRow>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveOutbox(row: OutboxRow)

    @Query("DELETE FROM outbox WHERE id = :id")
    suspend fun removeOutbox(id: String)

    @Query("SELECT at FROM cursors WHERE userId = :userId AND resource = :resource")
    suspend fun cursor(userId: String, resource: String): Long?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveCursor(row: CursorRow)

    @Query("SELECT * FROM devices WHERE userId = :userId")
    suspend fun devices(userId: String): List<DeviceRow>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveDevice(row: DeviceRow)

    @Query("DELETE FROM conversations WHERE userId = :userId")
    suspend fun clearConversations(userId: String)

    @Query("DELETE FROM messages WHERE userId = :userId")
    suspend fun clearMessages(userId: String)

    @Query("DELETE FROM events WHERE userId = :userId")
    suspend fun clearEvents(userId: String)

    @Query("DELETE FROM groceries WHERE userId = :userId")
    suspend fun clearGroceries(userId: String)

    @Query("DELETE FROM carts WHERE userId = :userId")
    suspend fun clearCarts(userId: String)

    @Query("DELETE FROM tasks WHERE userId = :userId")
    suspend fun clearTasks(userId: String)

    @Query("DELETE FROM browser_tasks WHERE userId = :userId")
    suspend fun clearBrowserTasks(userId: String)

    @Query("DELETE FROM outbox WHERE userId = :userId")
    suspend fun clearOutbox(userId: String)

    @Query("DELETE FROM cursors WHERE userId = :userId")
    suspend fun clearCursors(userId: String)

    @Query("DELETE FROM devices WHERE userId = :userId")
    suspend fun clearDevices(userId: String)

    @Transaction
    suspend fun clearUser(userId: String) {
        clearConversations(userId)
        clearMessages(userId)
        clearEvents(userId)
        clearGroceries(userId)
        clearCarts(userId)
        clearTasks(userId)
        clearBrowserTasks(userId)
        clearOutbox(userId)
        clearCursors(userId)
        clearDevices(userId)
    }
}

object ScoutMigrations {
    const val ADD_DEVICE_REVOKED = "ALTER TABLE devices ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0"

    val oneToTwo = object : Migration(1, 2) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL(ADD_DEVICE_REVOKED)
        }
    }
}

@Database(
    entities = [
        ConversationRow::class,
        MessageRow::class,
        EventRow::class,
        GroceryRow::class,
        CartRow::class,
        TaskRow::class,
        BrowserTaskRow::class,
        OutboxRow::class,
        CursorRow::class,
        DeviceRow::class,
    ],
    version = 2,
    exportSchema = false,
)
abstract class ScoutRoom : RoomDatabase() {
    abstract fun dao(): ScoutDao

    companion object {
        @Volatile
        private var instance: ScoutRoom? = null

        fun get(context: Context): ScoutRoom {
            val existing = instance
            if (existing != null) return existing
            return synchronized(this) {
                instance ?: Room.databaseBuilder(context.applicationContext, ScoutRoom::class.java, "scout-companion.db")
                    .addMigrations(ScoutMigrations.oneToTwo)
                    .build()
                    .also { instance = it }
            }
        }
    }
}

class RoomDesk(private val dao: ScoutDao) : LocalDesk {
    override suspend fun conversations(userId: String): List<CachedConversation> {
        return dao.conversations(userId).map {
            CachedConversation(it.userId, it.id, it.title, it.agent, it.updatedAt, it.payload)
        }
    }

    override suspend fun saveConversation(row: CachedConversation) {
        dao.saveConversation(ConversationRow(row.userId, row.id, row.title, row.agent, row.updatedAt, row.payload))
    }

    override suspend fun messages(userId: String, conversationId: String): List<CachedMessage> {
        return dao.messages(userId, conversationId).map { CachedMessage(it.userId, it.conversationId, it.at, it.text) }
    }

    override suspend fun saveMessage(row: CachedMessage) {
        dao.saveMessage(MessageRow(row.userId, row.conversationId, row.at, row.text))
    }

    override suspend fun events(userId: String): List<CachedEvent> {
        return dao.events(userId).map { CachedEvent(it.userId, it.id, it.title, it.updatedAt) }
    }

    override suspend fun saveEvent(row: CachedEvent) {
        dao.saveEvent(EventRow(row.userId, row.id, row.title, row.updatedAt))
    }

    override suspend fun groceries(userId: String): List<CachedGrocery> {
        return dao.groceries(userId).map { CachedGrocery(it.userId, it.id, it.query, it.updatedAt) }
    }

    override suspend fun saveGrocery(row: CachedGrocery) {
        dao.saveGrocery(GroceryRow(row.userId, row.id, row.query, row.updatedAt))
    }

    override suspend fun carts(userId: String): List<CachedCart> {
        return dao.carts(userId).map { CachedCart(it.userId, it.id, it.payload, it.updatedAt) }
    }

    override suspend fun saveCart(row: CachedCart) {
        dao.saveCart(CartRow(row.userId, row.id, row.payload, row.updatedAt))
    }

    override suspend fun tasks(userId: String): List<CachedTask> {
        return dao.tasks(userId).map { CachedTask(it.userId, it.id, it.title, it.status, it.updatedAt) }
    }

    override suspend fun saveTask(row: CachedTask) {
        dao.saveTask(TaskRow(row.userId, row.id, row.title, row.status, row.updatedAt))
    }

    override suspend fun browserTasks(userId: String): List<CachedBrowserTask> {
        return dao.browserTasks(userId).map { CachedBrowserTask(it.userId, it.id, it.status, it.updatedAt) }
    }

    override suspend fun saveBrowserTask(row: CachedBrowserTask) {
        dao.saveBrowserTask(BrowserTaskRow(row.userId, row.id, row.status, row.updatedAt))
    }

    override suspend fun outbox(userId: String): List<OutboxItem> {
        return dao.outbox(userId).mapNotNull { row ->
            val kind = syncKind(row.kind) ?: return@mapNotNull null
            OutboxItem(row.id, row.userId, kind, row.payload, row.attempts)
        }
    }

    override suspend fun saveOutbox(row: OutboxItem) {
        dao.saveOutbox(OutboxRow(row.id, row.userId, syncWire(row.kind), row.payload, row.attempts))
    }

    override suspend fun removeOutbox(id: String) {
        dao.removeOutbox(id)
    }

    override suspend fun cursor(userId: String, resource: String): Long = dao.cursor(userId, resource) ?: 0L

    override suspend fun setCursor(userId: String, resource: String, at: Long) {
        dao.saveCursor(CursorRow(userId, resource, at))
    }

    override suspend fun devices(userId: String): List<DeviceRecord> {
        return dao.devices(userId).map { DeviceRecord(it.userId, it.deviceId, it.pushToken, it.revoked != 0) }
    }

    override suspend fun saveDevice(row: DeviceRecord) {
        dao.saveDevice(DeviceRow(row.userId, row.deviceId, row.pushToken, if (row.revoked) 1 else 0))
    }

    override suspend fun clearUser(userId: String) {
        dao.clearUser(userId)
    }
}
