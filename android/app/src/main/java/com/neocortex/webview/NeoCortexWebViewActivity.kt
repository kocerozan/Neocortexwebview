package com.neocortex.webview

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File

/**
 * NeoCortex kamera webview'i.
 *
 * Web dosyaları APK içinden https://appassets.androidplatform.net/assets/web/ adresiyle
 * sunulur (WebViewAssetLoader) — bu adres "güvenli bağlam" sayıldığı için getUserMedia çalışır.
 * Uzak sunucu kullanmak için EXTRA_URL ile https adresi ver.
 *
 * Sonuç: RESULT_OK + EXTRA_IMAGE_PATH / EXTRA_VIDEO_PATH (uygulamanın files/neocortex klasörü).
 */
class NeoCortexWebViewActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_URL = "neocortex.url"
        const val EXTRA_TITLE = "neocortex.title"
        const val EXTRA_HINT = "neocortex.hint"
        const val EXTRA_IMAGE_PATH = "neocortex.image"
        const val EXTRA_VIDEO_PATH = "neocortex.video"
        const val EXTRA_CLIPS = "neocortex.clips"
        private const val ASSET_ORIGIN = "https://appassets.androidplatform.net"
        private const val DEFAULT_URL = "$ASSET_ORIGIN/assets/web/index.html"
    }

    private lateinit var webView: WebView
    private lateinit var startUri: Uri
    private lateinit var receiver: FileReceiver
    private var pendingPermission: PermissionRequest? = null

    private val cameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val req = pendingPermission ?: return@registerForActivityResult
            pendingPermission = null
            if (granted) req.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
            else {
                req.deny()
                Toast.makeText(this, R.string.camera_denied, Toast.LENGTH_LONG).show()
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        startUri = Uri.parse(intent.getStringExtra(EXTRA_URL) ?: DEFAULT_URL).buildUpon().apply {
            intent.getStringExtra(EXTRA_TITLE)?.let { appendQueryParameter("title", it) }
            intent.getStringExtra(EXTRA_HINT)?.let { appendQueryParameter("hint", it) }
        }.build()
        receiver = FileReceiver(File(filesDir, "neocortex"))

        webView = WebView(this)
        setContentView(webView)

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
        }

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { handlePermission(request) }
            }
        }

        val trustedOrigin = "${startUri.scheme}://${startUri.authority}"
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            // Yalnız kendi kaynağımızdan gelen mesajları kabul et.
            WebViewCompat.addWebMessageListener(webView, "NeoCortexAndroid", setOf(trustedOrigin)) { _, message, _, isMainFrame, _ ->
                if (isMainFrame) message.data?.let { onBridgeMessage(it) }
            }
        } else {
            Toast.makeText(this, "WebView sürümü eski; lütfen Android System WebView'i güncelle.", Toast.LENGTH_LONG).show()
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                setResult(RESULT_CANCELED)
                finish()
            }
        })

        webView.loadUrl(startUri.toString())
    }

    private fun handlePermission(request: PermissionRequest) {
        val origin = request.origin
        val trusted = origin.scheme == startUri.scheme && origin.authority == startUri.authority
        if (!trusted || !request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
            request.deny()
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        } else {
            pendingPermission = request
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    private fun onBridgeMessage(json: String) {
        when (val msg = receiver.handle(json)) {
            is BridgeEvent.Complete -> {
                setResult(RESULT_OK, Intent().apply {
                    msg.image?.let { putExtra(EXTRA_IMAGE_PATH, it.absolutePath) }
                    msg.video?.let { putExtra(EXTRA_VIDEO_PATH, it.absolutePath) }
                    putExtra(EXTRA_CLIPS, msg.clips)
                })
                finish()
            }
            BridgeEvent.Close -> {
                setResult(RESULT_CANCELED)
                finish()
            }
            else -> Unit
        }
    }

    /** Native → Web */
    fun resetCapture() = webView.evaluateJavascript("window.NeoCortex && window.NeoCortex.reset()", null)

    override fun onDestroy() {
        pendingPermission?.deny()
        webView.destroy()
        super.onDestroy()
    }
}
