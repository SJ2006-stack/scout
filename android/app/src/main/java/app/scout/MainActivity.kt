package app.scout

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.os.SystemClock
import android.provider.Settings
import android.view.View
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.ValueCallback
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import app.scout.drop.DropInbox
import app.scout.drop.DropReceipt
import app.scout.drop.ResolverSource
import app.scout.drop.dropForPage
import app.scout.drop.rawShare
import app.scout.drop.receiveShare
import app.scout.drop.shareKey
import app.scout.drop.shouldImport
import app.scout.relay.PhoneRelay
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.firebase.Firebase
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.auth.auth
import com.google.firebase.firestore.firestore
import com.google.firebase.messaging.FirebaseMessaging
import app.scout.companion.ApiPlan
import app.scout.companion.automation.CartAutomation
import app.scout.companion.BridgeCall
import app.scout.companion.BridgeDecision
import app.scout.companion.PhoneActions
import app.scout.companion.PhoneResult
import app.scout.companion.jsonField
import app.scout.companion.readPhoneAction
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import app.scout.companion.QrRead
import app.scout.companion.SpeechResult
import app.scout.companion.allowBridge
import app.scout.companion.beginCheckout
import app.scout.companion.bridgeResponse
import app.scout.companion.planRequest
import app.scout.companion.speechUrl
import app.scout.data.androidDeviceId
import app.scout.data.postScout
import app.scout.data.postSpeech
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.Base64

class MainActivity : AppCompatActivity() {
    private lateinit var desk: WebView
    private val phoneActions by lazy { PhoneActions(this) }
    private val relay by lazy {
        val origin = getString(R.string.azure_origin)
        PhoneRelay(origin, { CookieManager.getInstance().getCookie(origin) }, PhoneRelay.copyStore(this))
    }
    private lateinit var signInPanel: View
    private lateinit var googleButton: MaterialButton
    private lateinit var signOutButton: MaterialButton
    private lateinit var status: TextView
    private lateinit var permissionsPanel: View
    private lateinit var openSettingsButton: View
    private lateinit var micState: TextView
    private lateinit var locationState: TextView
    private lateinit var cameraState: TextView
    private lateinit var noticeState: TextView
    private lateinit var micEnable: MaterialButton
    private lateinit var locationEnable: MaterialButton
    private lateinit var cameraEnable: MaterialButton
    private lateinit var noticeEnable: MaterialButton
    private lateinit var automationState: TextView
    private lateinit var automationEnable: MaterialButton
    private lateinit var auth: FirebaseAuth
    private lateinit var profiles: UserProfile
    private lateinit var credentialManager: CredentialManager
    private var deskLoaded = false
    private var handledShare: String? = null
    private var boundUid: String? = null
    @Volatile private var deskHost: String? = null
    private var otpReceiver: BroadcastReceiver? = null
    private var pendingLocationOrigin: String? = null
    private var pendingLocation: GeolocationPermissions.Callback? = null
    private var pendingMedia: PermissionRequest? = null
    private var pendingFile: ValueCallback<Array<Uri>>? = null
    private val locationPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        val origin = pendingLocationOrigin
        val callback = pendingLocation
        pendingLocationOrigin = null
        pendingLocation = null
        val granted = grants[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        if (origin == null || callback == null) {
            replyNative(if (granted) """{"op":"location","granted":true}""" else """{"op":"location","granted":false}""")
            return@registerForActivityResult
        }
        callback.invoke(origin, granted, false)
    }
    private var speechRecorder: MediaRecorder? = null
    private var speechFile: File? = null
    private var speechAsking = false
    private var speechUploading = false
    private var recordAfterGrant = false
    private var micAskedAt = 0L
    private var micDialog: AlertDialog? = null
    private val speechPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        speechAsking = false
        val shouldRecord = recordAfterGrant
        recordAfterGrant = false
        val web = pendingMedia
        pendingMedia = null
        if (!granted) {
            web?.deny()
            val skipped = SystemClock.elapsedRealtime() - micAskedAt < 400
            if (shouldRecord) {
                replyNative(speechPayload(granted = false, recording = false, text = null, error = "Microphone permission is needed to talk."))
            }
            if (skipped || !ActivityCompat.shouldShowRequestPermissionRationale(this, Manifest.permission.RECORD_AUDIO)) {
                showMicPrompt()
            }
            return@registerForActivityResult
        }
        dismissMicPrompt()
        if (web != null) {
            val resources = web.resources.filter { resource ->
                resource == PermissionRequest.RESOURCE_AUDIO_CAPTURE || resource == PermissionRequest.RESOURCE_VIDEO_CAPTURE
            }.toTypedArray()
            if (resources.isEmpty()) web.deny() else web.grant(resources)
        }
        if (shouldRecord) startSpeech()
    }
    private val noticePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) postMicNotice()
    }
    private var settingsPermissionName: String? = null
    private var settingsAskedAt = 0L
    private val settingsPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val name = settingsPermissionName
        settingsPermissionName = null
        if (!granted && name != null && SystemClock.elapsedRealtime() - settingsAskedAt < 400) openMicSettings()
        showPermissionStates()
    }
    private val mediaPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        val request = pendingMedia
        pendingMedia = null
        if (request == null) return@registerForActivityResult
        val resources = request.resources.filter { resource ->
            when (resource) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> grants[Manifest.permission.RECORD_AUDIO] == true
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> grants[Manifest.permission.CAMERA] == true
                else -> false
            }
        }.toTypedArray()
        if (resources.isEmpty()) request.deny() else request.grant(resources)
    }
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        replyNative(if (granted) """{"op":"notification","granted":true}""" else """{"op":"notification","granted":false}""")
    }
    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = pendingFile
        pendingFile = null
        callback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
    }
    private val otpConsent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val message = result.data?.getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE)
        if (result.resultCode != RESULT_OK || message == null || !trustedDesk()) return@registerForActivityResult
        deliverOtp(message)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)
        auth = Firebase.auth
        profiles = UserProfile(Firebase.firestore(UserProfile.DATABASE))
        credentialManager = CredentialManager.create(this)
        desk = findViewById(R.id.desk)
        signInPanel = findViewById(R.id.sign_in)
        googleButton = findViewById(R.id.google_sign_in)
        signOutButton = findViewById(R.id.sign_out)
        status = findViewById(R.id.sign_in_status)
        permissionsPanel = findViewById(R.id.permissions)
        openSettingsButton = findViewById(R.id.open_settings)
        micState = findViewById(R.id.mic_state)
        locationState = findViewById(R.id.location_state)
        cameraState = findViewById(R.id.camera_state)
        noticeState = findViewById(R.id.notice_state)
        micEnable = findViewById(R.id.mic_enable)
        locationEnable = findViewById(R.id.location_enable)
        cameraEnable = findViewById(R.id.camera_enable)
        noticeEnable = findViewById(R.id.notice_enable)
        automationState = findViewById(R.id.automation_state)
        automationEnable = findViewById(R.id.automation_enable)
        val frame = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(frame) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val top = if (bars.top > 0) bars.top else barSize("status_bar_height")
            val bottom = if (bars.bottom > 0) bars.bottom else barSize("navigation_bar_height")
            view.setPadding(bars.left, top, bars.right, bottom)
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(frame)
        desk.settings.javaScriptEnabled = true
        desk.settings.domStorageEnabled = true
        desk.settings.setGeolocationEnabled(true)
        desk.settings.setSupportMultipleWindows(true)
        desk.settings.javaScriptCanOpenWindowsAutomatically = true
        desk.settings.cacheMode = WebSettings.LOAD_NO_CACHE
        desk.clearCache(true)
        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setAcceptThirdPartyCookies(desk, true)
        desk.addJavascriptInterface(OtpBridge(), "ScoutOtp")
        desk.addJavascriptInterface(PayBridge(), "ScoutPay")
        desk.addJavascriptInterface(NativeBridge(), "ScoutNative")
        desk.webChromeClient = DeskChrome()
        desk.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                return openOutside(request.url)
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                deskHost = url?.let { Uri.parse(it).host }
                super.onPageStarted(view, url, favicon)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                CookieManager.getInstance().flush()
                super.onPageFinished(view, url)
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                deskHost = url?.let { Uri.parse(it).host }
                super.doUpdateVisitedHistory(view, url, isReload)
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (permissionsPanel.visibility == View.VISIBLE) {
                    closePermissions()
                    return
                }
                if (desk.visibility == View.VISIBLE && desk.canGoBack()) desk.goBack() else finish()
            }
        })
        googleButton.setOnClickListener { signInWithGoogle() }
        signOutButton.setOnClickListener { signOut() }
        openSettingsButton.setOnClickListener { openPermissions() }
        findViewById<View>(R.id.permissions_done).setOnClickListener { closePermissions() }
        micEnable.setOnClickListener { enablePermission(Manifest.permission.RECORD_AUDIO) }
        locationEnable.setOnClickListener { enablePermission(Manifest.permission.ACCESS_FINE_LOCATION) }
        cameraEnable.setOnClickListener { enablePermission(Manifest.permission.CAMERA) }
        noticeEnable.setOnClickListener { enablePermission(Manifest.permission.POST_NOTIFICATIONS) }
        automationEnable.setOnClickListener { openAccessibilitySettings() }
        takeShare(intent, savedInstanceState?.getString(SHARE_KEY))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        takeShare(intent, null)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        handledShare?.let { outState.putString(SHARE_KEY, it) }
    }

    /** Copies a share into the private inbox off the main thread. The page shows it for review; nothing is sent here. */
    private fun takeShare(intent: Intent?, savedKey: String?) {
        val raw = rawShare(intent)
        if (!shouldImport(raw, savedKey)) {
            if (savedKey != null) handledShare = savedKey
            return
        }
        handledShare = shareKey(raw)
        val app = application as ScoutApp
        val owner = auth.currentUser?.uid
        val source = ResolverSource(contentResolver)
        app.dropWork.execute {
            val receipt = receiveShare(raw, packageName, owner, app.drops, source, System::currentTimeMillis, DropInbox::newId)
            runOnUiThread { shareReceived(receipt) }
        }
    }

    private fun shareReceived(receipt: DropReceipt) {
        if (isDestroyed) return
        when (receipt) {
            is DropReceipt.Ready -> {
                val uid = auth.currentUser?.uid
                if (uid == null) {
                    Toast.makeText(this, "Sign in to Scout to review what you shared.", Toast.LENGTH_LONG).show()
                    return
                }
                (application as ScoutApp).drops.claim(uid)
                replyNative("""{"op":"drop"}""")
            }
            is DropReceipt.Failed -> Toast.makeText(this, receipt.message, Toast.LENGTH_LONG).show()
            DropReceipt.Ignored -> Unit
        }
    }

    private fun dropReply(call: BridgeCall): String {
        val inbox = (application as ScoutApp).drops
        val uid = auth.currentUser?.uid?.takeIf { it == boundUid }
        return try {
            when (call) {
                BridgeCall.DropTake -> JSONObject()
                    .put("accepted", true)
                    .put("drop", inbox.take(uid)?.let(::dropForPage) ?: JSONObject.NULL)
                    .toString()
                is BridgeCall.DropImage -> {
                    val image = inbox.image(uid, call.dropId, call.imageId) ?: return DROP_REFUSED
                    JSONObject()
                        .put("accepted", true)
                        .put("mime", image.mime)
                        .put("data", Base64.getEncoder().encodeToString(image.file.readBytes()))
                        .toString()
                }
                is BridgeCall.DropDone -> JSONObject().put("accepted", inbox.done(uid, call.dropId)).toString()
                else -> DROP_REFUSED
            }
        } catch (_: IOException) {
            DROP_REFUSED
        }
    }

    public override fun onStart() {
        super.onStart()
        val user = auth.currentUser
        if (user == null) showSignIn() else bindScout(user)
        relay.start()
    }

    override fun onPause() {
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onStop() {
        relay.stop()
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            dismissMicPrompt()
        }
        showPermissionStates()
    }

    private fun openPermissions() {
        permissionsPanel.visibility = View.VISIBLE
        openSettingsButton.visibility = View.GONE
        showPermissionStates()
    }

    private fun closePermissions() {
        permissionsPanel.visibility = View.GONE
        openSettingsButton.visibility = View.VISIBLE
    }

    private fun enablePermission(name: String) {
        if (name == Manifest.permission.POST_NOTIFICATIONS && Build.VERSION.SDK_INT < 33) {
            openMicSettings()
            return
        }
        if (ContextCompat.checkSelfPermission(this, name) == PackageManager.PERMISSION_GRANTED) {
            openMicSettings()
            return
        }
        settingsPermissionName = name
        settingsAskedAt = SystemClock.elapsedRealtime()
        settingsPermission.launch(name)
    }

    private fun showPermissionStates() {
        if (!::micState.isInitialized) return
        paintPermission(micState, micEnable, Manifest.permission.RECORD_AUDIO)
        val locationGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        paintGranted(locationState, locationEnable, locationGranted)
        paintPermission(cameraState, cameraEnable, Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT < 33) paintGranted(noticeState, noticeEnable, true)
        else paintPermission(noticeState, noticeEnable, Manifest.permission.POST_NOTIFICATIONS)
        val automationOn = CartAutomation.serviceOn(this)
        automationState.text = getString(if (automationOn) R.string.perm_allowed else R.string.perm_blocked)
        automationEnable.text = getString(if (automationOn) R.string.perm_change else R.string.perm_open_settings)
    }

    private fun openAccessibilitySettings() {
        try {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        } catch (_: ActivityNotFoundException) {
        }
    }

    private fun paintPermission(state: TextView, button: MaterialButton, name: String) {
        paintGranted(state, button, ContextCompat.checkSelfPermission(this, name) == PackageManager.PERMISSION_GRANTED)
    }

    private fun paintGranted(state: TextView, button: MaterialButton, granted: Boolean) {
        state.text = getString(if (granted) R.string.perm_allowed else R.string.perm_blocked)
        button.text = getString(if (granted) R.string.perm_change else R.string.perm_enable)
    }

    private fun signInWithGoogle() {
        googleButton.isEnabled = false
        hideStatus()
        val option = GetSignInWithGoogleOption.Builder(getString(R.string.default_web_client_id)).build()
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(option)
            .build()
        lifecycleScope.launch {
            try {
                val result = credentialManager.getCredential(this@MainActivity, request)
                val credential = result.credential
                if (credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    showStatus(getString(R.string.sign_in_failed))
                    return@launch
                }
                val google = GoogleIdTokenCredential.createFrom(credential.data)
                val firebaseCredential = GoogleAuthProvider.getCredential(google.idToken, null)
                auth.signInWithCredential(firebaseCredential)
                    .addOnSuccessListener(this@MainActivity) { result ->
                        val user = result.user
                        if (user == null) {
                            showStatus(getString(R.string.sign_in_failed))
                        } else {
                            bindScout(user)
                        }
                    }
                    .addOnFailureListener(this@MainActivity) {
                        showStatus(getString(R.string.sign_in_failed))
                    }
            } catch (_: GetCredentialCancellationException) {
                showStatus(getString(R.string.sign_in_cancelled))
            } catch (_: GetCredentialException) {
                showStatus(getString(R.string.sign_in_failed))
            } finally {
                googleButton.isEnabled = true
            }
        }
    }

    private fun listenForOtp() {
        if (!trustedDesk()) return
        if (otpReceiver == null) {
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    if (SmsRetriever.SMS_RETRIEVED_ACTION != intent.action) return
                    val extras = intent.extras ?: return
                    val status = statusExtra(extras) ?: return
                    if (status.statusCode != CommonStatusCodes.SUCCESS) return
                    val consent = consentIntent(extras)
                    if (consent != null) {
                        try {
                            otpConsent.launch(consent)
                        } catch (_: ActivityNotFoundException) {
                        }
                        return
                    }
                    val message = extras.getString(SmsRetriever.EXTRA_SMS_MESSAGE) ?: return
                    deliverOtp(message)
                }
            }
            ContextCompat.registerReceiver(
                this,
                receiver,
                IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION),
                SmsRetriever.SEND_PERMISSION,
                null,
                ContextCompat.RECEIVER_EXPORTED,
            )
            otpReceiver = receiver
        }
        val client = SmsRetriever.getClient(this)
        client.startSmsRetriever()
        client.startSmsUserConsent(null)
    }

    private fun deliverOtp(message: String) {
        if (!trustedDesk()) return
        val code = readConsentOtp(message) ?: return
        val uid = auth.currentUser?.uid
        val app = application as ScoutApp
        if (uid != null) {
            val submit = app.otp.offerMessage(uid, message)
            if (submit != null) sendBoundCode(uid, submit.path, submit.body)
        }
        desk.evaluateJavascript(otpFillScript(code), null)
    }

    private fun sendBoundCode(uid: String, path: String, body: String) {
        val user = auth.currentUser ?: return
        user.getIdToken(false).addOnSuccessListener(this) { result ->
            val token = result.token ?: return@addOnSuccessListener
            lifecycleScope.launch {
                val app = application as ScoutApp
                val device = app.runtime.device(uid, androidDeviceId(this@MainActivity))
                val plan = planRequest(uid, token, device, "POST", path, body, background = false)
                if (plan !is ApiPlan.Ready) return@launch
                val status = withContext(Dispatchers.IO) { postScout(plan.method, plan.path, plan.authorization, plan.body) }
                val task = Regex("/api/browser/tasks/([a-f0-9]{32})/code").find(path)?.groupValues?.get(1)
                if (status in 200..299 && task != null) app.otp.consume(uid, task)
                else app.otp.discard()
            }
        }
    }

    private fun statusExtra(extras: Bundle): Status? {
        return if (Build.VERSION.SDK_INT >= 33) {
            extras.getParcelable(SmsRetriever.EXTRA_STATUS, Status::class.java)
        } else {
            @Suppress("DEPRECATION")
            extras.getParcelable(SmsRetriever.EXTRA_STATUS)
        }
    }

    private fun consentIntent(extras: Bundle): Intent? {
        return if (Build.VERSION.SDK_INT >= 33) {
            extras.getParcelable(SmsRetriever.EXTRA_CONSENT_INTENT, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            extras.getParcelable(SmsRetriever.EXTRA_CONSENT_INTENT)
        }
    }

    private fun trustedDesk(): Boolean {
        val host = desk.url?.let { Uri.parse(it).host } ?: return false
        return isScoutHost(host)
    }

    private fun openOutside(uri: Uri): Boolean {
        if (!leavesScout(uri.toString())) return false
        val scheme = uri.scheme?.lowercase()
        val target = if (scheme == "http" || scheme == "https") uri else payTarget(uri.toString())
        if (target == null) return true
        try {
            startActivity(Intent(Intent.ACTION_VIEW, target))
        } catch (_: ActivityNotFoundException) {
        }
        return true
    }

    private fun allowLocation(origin: String, callback: GeolocationPermissions.Callback) {
        if (!isScoutHost(Uri.parse(origin).host)) {
            callback.invoke(origin, false, false)
            return
        }
        val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (fine || coarse) {
            callback.invoke(origin, true, false)
            return
        }
        pendingLocation?.invoke(pendingLocationOrigin ?: origin, false, false)
        pendingLocationOrigin = origin
        pendingLocation = callback
        locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }

    private fun allowMedia(request: PermissionRequest) {
        if (!isScoutHost(request.origin.host)) {
            request.deny()
            return
        }
        val wanted = request.resources.filter {
            it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || it == PermissionRequest.RESOURCE_VIDEO_CAPTURE
        }
        if (wanted.isEmpty()) {
            request.deny()
            return
        }
        val missing = mutableListOf<String>()
        if (wanted.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
        ) {
            missing.add(Manifest.permission.RECORD_AUDIO)
        }
        if (wanted.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
        ) {
            missing.add(Manifest.permission.CAMERA)
        }
        if (missing.isEmpty()) {
            request.grant(wanted.toTypedArray())
            return
        }
        if (missing == listOf(Manifest.permission.RECORD_AUDIO)) {
            pendingMedia?.deny()
            pendingMedia = request
            promptMicrophone()
            return
        }
        pendingMedia?.deny()
        pendingMedia = request
        mediaPermission.launch(missing.toTypedArray())
    }

    private fun promptMicrophone() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            dismissMicPrompt()
            return
        }
        if (speechAsking) return
        recordAfterGrant = false
        speechAsking = true
        micAskedAt = SystemClock.elapsedRealtime()
        speechPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    private fun showMicPrompt() {
        if (isFinishing) return
        postMicNotice()
        if (micDialog?.isShowing == true) return
        micDialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.mic_title)
            .setMessage(R.string.mic_body)
            .setPositiveButton(R.string.mic_allow) { _, _ -> openMicSettings() }
            .setNegativeButton(R.string.mic_later, null)
            .show()
    }

    private fun postMicNotice() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            noticePermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (!manager.areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(MIC_CHANNEL, getString(R.string.mic_title), NotificationManager.IMPORTANCE_HIGH),
            )
        }
        val settings = PendingIntent.getActivity(
            this,
            MIC_NOTICE,
            micSettingsIntent(),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notice = NotificationCompat.Builder(this, MIC_CHANNEL)
            .setSmallIcon(R.drawable.ic_mic_notice)
            .setContentTitle(getString(R.string.mic_title))
            .setContentText(getString(R.string.mic_body))
            .setContentIntent(settings)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        manager.notify(MIC_NOTICE, notice)
    }

    private fun openMicSettings() {
        try {
            startActivity(micSettingsIntent())
        } catch (_: ActivityNotFoundException) {
        }
    }

    private fun micSettingsIntent(): Intent {
        return Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", packageName, null)
        }
    }

    private fun dismissMicPrompt() {
        micDialog?.dismiss()
        micDialog = null
        getSystemService(NotificationManager::class.java)?.cancel(MIC_NOTICE)
    }

    override fun onDestroy() {
        releaseSpeech()
        pendingMedia?.deny()
        pendingMedia = null
        pendingFile?.onReceiveValue(null)
        pendingFile = null
        pendingLocation?.invoke(pendingLocationOrigin ?: "", false, false)
        pendingLocation = null
        pendingLocationOrigin = null
        otpReceiver?.let { unregisterReceiver(it) }
        otpReceiver = null
        super.onDestroy()
    }

    private fun signOut() {
        val uid = auth.currentUser?.uid
        auth.signOut()
        boundUid = null
        deskLoaded = false
        (application as ScoutApp).otp.discard()
        (application as ScoutApp).drops.discard()
        if (uid != null) lifecycleScope.launch { (application as ScoutApp).runtime.logout(uid) }
        clearWebSession {
            desk.loadUrl("about:blank")
            showSignIn()
        }
    }

    /** Ties this Google account to its own Scout user, then opens the chief chat. */
    private fun bindScout(user: FirebaseUser) {
        (application as ScoutApp).drops.claim(user.uid)
        if (boundUid == user.uid && deskLoaded) {
            showDesk(user)
            return
        }
        val origin = getString(R.string.azure_origin)
        val switched = rememberedUid() != user.uid
        boundUid = user.uid
        val open = {
            rememberUid(user.uid)
            if (switched) {
                deskLoaded = false
                desk.loadUrl("about:blank")
            }
            attachSession(user, origin)
        }
        if (switched) clearWebSession(open) else open()
    }

    private fun attachSession(user: FirebaseUser, origin: String) {
        user.getIdToken(false)
            .addOnSuccessListener(this) { tokenResult ->
                val token = tokenResult.token
                lifecycleScope.launch {
                    if (!token.isNullOrBlank()) {
                        val cookie = withContext(Dispatchers.IO) { exchangeGoogleSession(origin, token) }
                        if (cookie != null) {
                            CookieManager.getInstance().setCookie(origin, cookie)
                            CookieManager.getInstance().flush()
                        }
                    }
                    if (auth.currentUser?.uid == user.uid) showDesk(user)
                }
            }
            .addOnFailureListener(this) {
                if (auth.currentUser?.uid == user.uid) showDesk(user)
            }
    }

    private fun clearWebSession(done: () -> Unit) {
        val origin = getString(R.string.azure_origin)
        val cookies = CookieManager.getInstance()
        cookies.setCookie(origin, "scout_session=; Path=/; Max-Age=0")
        WebStorage.getInstance().deleteAllData()
        getSharedPreferences(ACCOUNT_PREFS, MODE_PRIVATE).edit().remove(ACCOUNT_UID).apply()
        cookies.removeAllCookies {
            cookies.flush()
            runOnUiThread(done)
        }
    }

    private fun rememberedUid(): String? =
        getSharedPreferences(ACCOUNT_PREFS, MODE_PRIVATE).getString(ACCOUNT_UID, null)

    private fun rememberUid(uid: String) {
        getSharedPreferences(ACCOUNT_PREFS, MODE_PRIVATE).edit().putString(ACCOUNT_UID, uid).apply()
    }

    private fun showDesk(user: FirebaseUser) {
        signInPanel.visibility = View.GONE
        desk.visibility = View.VISIBLE
        if (!deskLoaded) {
            deskLoaded = true
            desk.loadUrl(getString(R.string.azure_origin))
        }
        registerDevice(user.uid)
        profiles.save(user) { error ->
            if (error != null) {
                showSignIn()
                signOutButton.visibility = View.VISIBLE
                showStatus(getString(R.string.profile_save_failed))
            }
        }
    }

    private fun showSignIn() {
        signInPanel.visibility = View.VISIBLE
        desk.visibility = View.GONE
        signOutButton.visibility = if (auth.currentUser != null) View.VISIBLE else View.GONE
    }

    private fun showStatus(message: String) {
        status.text = message
        status.visibility = View.VISIBLE
        googleButton.isEnabled = true
    }

    private fun hideStatus() {
        status.visibility = View.GONE
    }

    private fun barSize(name: String): Int {
        val id = resources.getIdentifier(name, "dimen", "android")
        return if (id > 0) resources.getDimensionPixelSize(id) else 0
    }

    private inner class DeskChrome : WebChromeClient() {
        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
            allowLocation(origin, callback)
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread { allowMedia(request) }
        }

        override fun onShowFileChooser(
            webView: WebView?,
            filePathCallback: ValueCallback<Array<Uri>>?,
            fileChooserParams: FileChooserParams?,
        ): Boolean {
            if (filePathCallback == null || fileChooserParams == null) return false
            pendingFile?.onReceiveValue(null)
            pendingFile = filePathCallback
            return try {
                fileChooser.launch(fileChooserParams.createIntent())
                true
            } catch (_: ActivityNotFoundException) {
                pendingFile = null
                filePathCallback.onReceiveValue(null)
                false
            }
        }

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            if (!isUserGesture) return false
            val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
            val popup = WebView(view.context)
            popup.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(popupView: WebView, request: WebResourceRequest): Boolean {
                    val uri = request.url
                    if (isScoutHost(uri.host)) desk.loadUrl(uri.toString()) else openOutside(uri)
                    popupView.destroy()
                    return true
                }
            }
            transport.webView = popup
            resultMsg.sendToTarget()
            return true
        }
    }

    private fun registerDevice(uid: String) {
        FirebaseMessaging.getInstance().token.addOnSuccessListener(this) { push ->
            lifecycleScope.launch {
                (application as ScoutApp).runtime.registerDevice(uid, androidDeviceId(this@MainActivity), push)
            }
        }
    }

    private fun performBridge(call: BridgeCall) {
        when (call) {
            BridgeCall.DropTake, is BridgeCall.DropImage, is BridgeCall.DropDone -> Unit
            BridgeCall.Location -> requestBridgeLocation()
            BridgeCall.Microphone -> beginSpeech()
            BridgeCall.Camera -> requestBridgeMedia(audio = false)
            is BridgeCall.Qr -> replyNative(qrReply(call.read))
            BridgeCall.Notification -> {
                if (Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                else replyNative("""{"op":"notification","granted":true}""")
            }
            is BridgeCall.Share -> {
                val share = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, call.text)
                }
                startActivity(Intent.createChooser(share, null))
            }
            BridgeCall.Biometric -> confirmPresence()
            BridgeCall.Permissions -> openPermissions()
            is BridgeCall.Checkout -> beginCheckout(this, call.app)
        }
    }

    private fun requestBridgeLocation() {
        val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (fine || coarse) {
            replyNative("""{"op":"location","granted":true}""")
            return
        }
        locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }

    private fun beginSpeech() {
        if (speechUploading) return
        if (speechRecorder != null) {
            finishSpeech()
            return
        }
        if (speechAsking) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            recordAfterGrant = true
            speechAsking = true
            micAskedAt = SystemClock.elapsedRealtime()
            speechPermission.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        startSpeech()
    }

    private fun startSpeech() {
        if (speechRecorder != null || speechUploading) return
        val file = File(cacheDir, "speech.m4a")
        if (file.exists()) file.delete()
        val recorder = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }
        try {
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setMaxDuration(30_000)
            recorder.setOutputFile(file)
            recorder.setOnInfoListener { _, what, _ ->
                if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) runOnUiThread { finishSpeech() }
            }
            recorder.prepare()
            recorder.start()
        } catch (_: Exception) {
            recorder.release()
            file.delete()
            replyNative(speechPayload(granted = true, recording = false, text = null, error = "The microphone could not be started."))
            return
        }
        speechRecorder = recorder
        speechFile = file
        replyNative(speechPayload(granted = true, recording = true, text = null, error = null))
    }

    private fun finishSpeech() {
        val recorder = speechRecorder ?: return
        val file = speechFile
        speechRecorder = null
        speechFile = null
        speechUploading = true
        try {
            recorder.stop()
        } catch (_: RuntimeException) {
        }
        recorder.release()
        val bytes = if (file != null && file.exists()) file.readBytes() else ByteArray(0)
        file?.delete()
        val origin = getString(R.string.azure_origin)
        val cookie = CookieManager.getInstance().getCookie(origin) ?: ""
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                val url = speechUrl(origin)
                if (url == null) SpeechResult.Failed("Speech could not be read.") else postSpeech(url, cookie, "audio/mp4", bytes)
            }
            speechUploading = false
            when (result) {
                is SpeechResult.Heard -> replyNative(speechPayload(granted = true, recording = false, text = result.text, error = null))
                is SpeechResult.Failed -> replyNative(speechPayload(granted = true, recording = false, text = null, error = result.message))
            }
        }
    }

    private fun releaseSpeech() {
        val recorder = speechRecorder
        speechRecorder = null
        speechFile?.delete()
        speechFile = null
        if (recorder == null) return
        try {
            recorder.stop()
        } catch (_: RuntimeException) {
        }
        recorder.release()
    }

    private fun speechPayload(granted: Boolean, recording: Boolean, text: String?, error: String?): String {
        val payload = JSONObject()
        payload.put("op", "microphone")
        payload.put("granted", granted)
        if (recording) payload.put("recording", true)
        if (text != null) payload.put("text", text)
        if (error != null) payload.put("error", error)
        return payload.toString()
    }

    private fun requestBridgeMedia(audio: Boolean) {
        val permission = if (audio) Manifest.permission.RECORD_AUDIO else Manifest.permission.CAMERA
        if (ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED) {
            replyNative("""{"granted":true}""")
            return
        }
        mediaPermission.launch(arrayOf(permission))
    }

    private fun confirmPresence() {
        val allowed = BiometricManager.from(this).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK)
        if (allowed != BiometricManager.BIOMETRIC_SUCCESS) {
            replyNative("""{"op":"biometric","granted":false}""")
            return
        }
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                replyNative("""{"op":"biometric","granted":true}""")
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                replyNative("""{"op":"biometric","granted":false}""")
            }
        })
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Scout")
            .setNegativeButtonText("Cancel")
            .build()
        prompt.authenticate(info)
    }

    private fun qrReply(read: QrRead): String {
        return when (read) {
            is QrRead.Page -> """{"op":"qr","url":${org.json.JSONObject.quote(read.url)}}"""
            is QrRead.PairCode -> """{"op":"qr","paired":true}"""
            is QrRead.Reject -> """{"op":"qr","accepted":false}"""
        }
    }

    private fun replyNative(json: String) {
        if (!trustedDesk()) return
        val quoted = org.json.JSONObject.quote(json)
        desk.evaluateJavascript("window.dispatchEvent(new CustomEvent(\"scout-native\",{detail:$quoted}))", null)
    }

    private inner class OtpBridge {
        @JavascriptInterface
        fun listen() {
            runOnUiThread { listenForOtp() }
        }

        @JavascriptInterface
        fun listen(taskId: String, token: String) {
            val uid = auth.currentUser?.uid ?: return
            val started = (application as ScoutApp).otp.begin(uid, taskId, token)
            if (!started) return
            runOnUiThread { listenForOtp() }
        }

        @JavascriptInterface
        fun submit(taskId: String, token: String, code: String) {
            val uid = auth.currentUser?.uid ?: return
            val app = application as ScoutApp
            if (!app.otp.begin(uid, taskId, token)) return
            val ready = app.otp.offerCode(uid, code) ?: return
            runOnUiThread { sendBoundCode(uid, ready.path, ready.body) }
        }
    }

    private inner class NativeBridge {
        @JavascriptInterface
        fun request(json: String): String {
            if (jsonField(json, "op") == "action") return phoneAction(json)
            val decision = allowBridge(deskHost, json, System.currentTimeMillis())
            val call = (decision as? BridgeDecision.Allow)?.call
            if (call is BridgeCall.Checkout) return beginCheckout(this@MainActivity, call.app)
            if (call == BridgeCall.DropTake || call is BridgeCall.DropImage || call is BridgeCall.DropDone) return dropReply(call)
            if (decision is BridgeDecision.Allow) runOnUiThread { performBridge(decision.call) }
            return bridgeResponse(decision)
        }
    }

    private fun phoneAction(json: String): String {
        val action = readPhoneAction(json, System.currentTimeMillis())
        if (!isScoutHost(deskHost) || action == null) return """{"op":"action","accepted":false}"""
        if (action.confirm || action.name == "app_cart_add") {
            runOnUiThread {
                MaterialAlertDialogBuilder(this)
                    .setTitle("Allow Scout?")
                    .setMessage(action.summary.ifBlank { "Add these items to the cart?" })
                    .setPositiveButton("Allow") { _, _ ->
                        if (action.name == "app_cart_add" || action.name == "send_whatsapp" || action.name == "app_event_book") {
                            Thread {
                                val result = phoneActions.run(action)
                                runOnUiThread { replyNative(result.toJson()) }
                            }.start()
                        } else {
                            replyNative(phoneActions.run(action).toJson())
                        }
                    }
                    .setNegativeButton("Not now") { _, _ -> replyNative(PhoneResult(action.id, "failed", "You declined it on the phone.").toJson()) }
                    .show()
            }
            return PhoneResult(action.id, "needs_approval", "Waiting for you to tap Allow.").toJson()
        }
        val latch = CountDownLatch(1)
        var result = PhoneResult(action.id, "failed", "The phone did not finish in time.")
        runOnUiThread {
            result = phoneActions.run(action)
            latch.countDown()
        }
        latch.await(3, TimeUnit.SECONDS)
        return result.toJson()
    }

    private inner class PayBridge {
        @JavascriptInterface
        fun open(url: String) {
            val target = payTarget(url) ?: return
            runOnUiThread {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, target))
                } catch (_: ActivityNotFoundException) {
                }
            }
        }
    }

    private companion object {
        const val MIC_CHANNEL = "scout-microphone"
        const val MIC_NOTICE = 17
        const val ACCOUNT_PREFS = "scout-account"
        const val ACCOUNT_UID = "uid"
        const val SHARE_KEY = "scout-drop-handled"
        const val DROP_REFUSED = """{"accepted":false}"""
    }
}
