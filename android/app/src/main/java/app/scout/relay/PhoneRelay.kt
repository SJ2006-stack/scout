package app.scout.relay

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.security.KeyStore
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val TAG = "ScoutRelay"
private const val KEY_ALIAS = "scout_vault"
private const val CONNECT_TIMEOUT_MS = 10_000

/** Pulls the Scout session id out of a WebView cookie header. */
fun sessionFromCookies(cookies: String?): String? =
    cookies?.let { Regex("(?:^|;\\s*)scout_session=([a-f0-9]{32})").find(it)?.groupValues?.get(1) }

/**
 * Holds one WebSocket to Scout while the app is open. Scout's browser sends
 * Blinkit, Zepto, and Instamart connections through it, so the stores see this
 * phone's address. It also keeps the sealed copies of the user's site sign-ins.
 */
class PhoneRelay(
    private val origin: String,
    private val cookies: () -> String?,
    private val store: CopyStore,
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val streams = Executors.newCachedThreadPool()
    private val retries = Executors.newSingleThreadScheduledExecutor()
    private val sockets = ConcurrentHashMap<Int, Socket>()
    @Volatile private var socket: WebSocket? = null
    @Volatile private var running = false
    @Volatile private var attempt = 0

    @Synchronized
    fun start() {
        if (running) return
        running = true
        attempt = 0
        connect()
    }

    @Synchronized
    fun stop() {
        running = false
        socket?.close(1000, "app closed")
        socket = null
        closeStreams()
    }

    private fun connect() {
        if (!running || socket != null) return
        val session = sessionFromCookies(cookies())
        if (session == null) {
            retry()
            return
        }
        val url = origin.trimEnd('/').replaceFirst("http", "ws") + RELAY_PATH
        val request = Request.Builder()
            .url(url)
            .header("cookie", "scout_session=$session")
            .header("x-scout-session", session)
            .build()
        socket = client.newWebSocket(request, Listener())
    }

    private fun retry() {
        if (!running) return
        val delay = minOf(30L, 2L shl minOf(attempt, 4))
        attempt += 1
        retries.schedule({ synchronized(this) { connect() } }, delay, TimeUnit.SECONDS)
    }

    private fun send(frame: ByteArray) {
        socket?.send(frame.toByteString())
    }

    private fun closeStreams() {
        for (open in sockets.values) {
            try {
                open.close()
            } catch (_: IOException) {
            }
        }
        sockets.clear()
    }

    private fun receive(bytes: ByteArray) {
        val frame = decodeFrame(bytes) ?: return
        when (frame.kind) {
            RelayKind.OPEN -> openStream(frame.stream, String(frame.payload, Charsets.UTF_8))
            RelayKind.DATA -> {
                val open = sockets[frame.stream] ?: return
                try {
                    synchronized(open) { open.getOutputStream().write(frame.payload) }
                } catch (_: IOException) {
                    send(encodeFrame(RelayKind.CLOSE, frame.stream))
                }
            }
            RelayKind.CLOSE -> try {
                sockets[frame.stream]?.shutdownOutput()
            } catch (_: IOException) {
            }
            RelayKind.VAULT -> when (val message = decodeVault(frame.payload)) {
                is VaultMessage.Put -> store.put(message.copy)
                is VaultMessage.Drop -> store.drop(message.domain, message.at)
                is VaultMessage.Offer, null -> Unit
            }
            else -> Unit
        }
    }

    private fun openStream(id: Int, value: String) {
        val target = relayTarget(value)
        if (target == null) {
            send(encodeFrame(RelayKind.FAIL, id))
            return
        }
        streams.execute {
            val open = Socket()
            var opened = false
            try {
                open.tcpNoDelay = true
                open.connect(InetSocketAddress(target.first, target.second), CONNECT_TIMEOUT_MS)
                sockets[id] = open
                opened = true
                send(encodeFrame(RelayKind.OPENED, id))
                val input = open.getInputStream()
                val buffer = ByteArray(32 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    send(encodeFrame(RelayKind.DATA, id, buffer.copyOf(read)))
                }
                send(encodeFrame(RelayKind.CLOSE, id))
            } catch (_: IOException) {
                send(encodeFrame(if (opened) RelayKind.CLOSE else RelayKind.FAIL, id))
            } finally {
                sockets.remove(id)
                try {
                    open.close()
                } catch (_: IOException) {
                }
            }
        }
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            attempt = 0
            for (copy in store.list()) webSocket.send(encodeVault(VaultMessage.Offer(copy)).toByteString())
            Log.i(TAG, "Relay connected")
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (webSocket === socket) receive(bytes.toByteArray())
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = ended(webSocket)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "Relay dropped: ${response?.code ?: t.javaClass.simpleName}")
            ended(webSocket)
        }

        private fun ended(webSocket: WebSocket) {
            synchronized(this@PhoneRelay) {
                if (socket !== webSocket) return
                socket = null
                closeStreams()
            }
            retry()
        }
    }

    companion object {
        /** A store in app-private, never-backed-up storage, sealed with a Keystore key. */
        fun copyStore(context: Context): CopyStore {
            val key = keystoreKey()
            return CopyStore(
                dir = File(context.noBackupFilesDir, "vault"),
                seal = { plain ->
                    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                    cipher.init(Cipher.ENCRYPT_MODE, key)
                    cipher.iv + cipher.doFinal(plain)
                },
                unseal = { sealed ->
                    if (sealed.size < 28) {
                        null
                    } else {
                        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, sealed, 0, 12))
                        cipher.doFinal(sealed, 12, sealed.size - 12)
                    }
                },
            )
        }

        private fun keystoreKey(): SecretKey {
            val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (keys.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            generator.init(
                KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            return generator.generateKey()
        }
    }
}
