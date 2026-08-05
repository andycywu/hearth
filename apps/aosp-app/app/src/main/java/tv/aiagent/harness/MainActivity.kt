package tv.aiagent.harness

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader

/**
 * Host activity. Loads the web-based agent runtime (bundled into assets) inside
 * a WebView and installs the native bridge the AOSP adapter expects.
 *
 * The bundle is served through [WebViewAssetLoader] on a virtual origin rather
 * than `file:///android_asset/`. This is not cosmetic: `file://` pages have a
 * null origin, so the engine refuses to load `main.js` as an ES module ("blocked
 * by CORS policy: Cross origin requests are only supported for protocol schemes:
 * http, data, chrome, https") and the runtime never starts. A real origin also
 * makes the shipped CSP, `localStorage` and `fetch` behave as in every other host.
 *
 * That origin is **http**, deliberately. An on-device model server (llama.cpp,
 * Ollama, vLLM) speaks plain http on localhost, and WebView — unlike desktop
 * Chrome — does not exempt localhost from mixed-content blocking, so an https
 * page cannot reach it at all: `fetch` fails with a bare "Failed to fetch", and
 * `MIXED_CONTENT_COMPATIBILITY_MODE` doesn't help because fetch/XHR stay
 * blockable. Serving the app over http makes those calls same-scheme, which lets
 * us keep [WebSettings.MIXED_CONTENT_NEVER_ALLOW].
 *
 * The trade-off is that the page is not a secure context, so browser-level
 * `getUserMedia`/Web Speech are unavailable — on this platform voice comes
 * through the native bridge anyway. Requests are still constrained by the CSP in
 * `index.html` (`script-src 'self'`, `connect-src` limited to localhost and
 * https), by `res/xml/network_security_config.xml` (cleartext for loopback only)
 * and by navigation being pinned to this origin in [WebViewClient].
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    private val assetLoader: WebViewAssetLoader by lazy {
        WebViewAssetLoader.Builder()
            .setHttpAllowed(true)   // see the class comment: local model servers are http
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // Hardening: the bundle is local; deny cross-origin file access and
            // block the WebView from loading arbitrary remote content itself.
            // These setters are deprecated but still honoured, and on minSdk 26
            // they are the only way to pin the values (defaults differ per API).
            @Suppress("DEPRECATION")
            settings.allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            settings.allowUniversalAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            // Keep the strictest mixed-content policy. We can afford it because
            // the app itself is served over http from the virtual origin below,
            // so talking to a local model server is same-scheme, not mixed.
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            webViewClient = object : WebViewClient() {
                // Serve APP_BASE/* out of the APK's assets.
                override fun shouldInterceptRequest(
                    view: WebView, request: WebResourceRequest,
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

                // Keep navigation inside our own origin.
                override fun shouldOverrideUrlLoading(
                    view: WebView, request: WebResourceRequest,
                ): Boolean = !request.url.toString().startsWith(APP_BASE)
            }
            // Without a WebChromeClient, a WebView silently cancels JS dialogs —
            // window.confirm() returns false, so every confirm-required tool
            // (switch input, launch app) would appear to be declined by a user
            // who was never asked. Render a real, remote-focusable dialog instead.
            webChromeClient = object : WebChromeClient() {
                override fun onJsConfirm(
                    view: WebView?, url: String?, message: String?, result: JsResult,
                ): Boolean {
                    AlertDialog.Builder(this@MainActivity)
                        .setMessage(message ?: "")
                        .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                        .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                        .setOnCancelListener { result.cancel() }
                        .show()
                    return true
                }

                override fun onJsAlert(
                    view: WebView?, url: String?, message: String?, result: JsResult,
                ): Boolean {
                    AlertDialog.Builder(this@MainActivity)
                        .setMessage(message ?: "")
                        .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                        .setOnCancelListener { result.cancel() }
                        .show()
                    return true
                }
            }
            // Expose the native bridge to JS as `TvNativeBridge`.
            addJavascriptInterface(TvNativeBridge(this@MainActivity, voice), "TvNativeBridge")
        }
        setContentView(webView)
        // TextToSpeech init is asynchronous and slow enough to swallow the first
        // reply, so start it now rather than on the first thing the agent says.
        voice.warmUp()
        load(intent)
    }

    /**
     * Speech in and out. Held by the Activity because it evaluates JS in this
     * WebView and has to be shut down with us — a live SpeechRecognizer keeps the
     * microphone open.
     */
    private val voice by lazy {
        TvVoice(this) { js ->
            // `evaluateJavascript` must run on the UI thread and only after the
            // WebView exists; recognition events can arrive during teardown.
            if (::webView.isInitialized) webView.evaluateJavascript(js, null)
        }
    }

    /**
     * The activity is `singleTop`, so a second `am start` re-uses this instance
     * and arrives here instead of onCreate. Reloading on a new intent is what
     * lets bring-up switch pages (`?diag`, `?llm=…`) on a running app — and it
     * matters that the process survives: force-stopping the app makes Android
     * drop it from the enabled-accessibility-services list, which silently
     * disables navigation.
     */
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        load(intent)
    }

    /**
     * Runtime web bundle is copied to app/src/main/assets by tools/bundle.mjs.
     * A "start" intent extra opens a specific page/query without a rebuild:
     *   adb shell am start -n tv.aiagent.harness/.MainActivity -e start "index.html?diag"
     * Constrained to our own index.html so an untrusted intent can't point the
     * WebView somewhere else.
     */
    private fun load(intent: Intent?) {
        val start = intent?.getStringExtra("start")?.takeIf { it.startsWith("index.html") } ?: "index.html"
        webView.loadUrl(APP_BASE + start)
    }

    /**
     * Give the page first refusal on BACK.
     *
     * Android routes the hardware BACK key to the Activity, not into the WebView
     * as a key event, so a modal in the page never sees it — pressing Back on a
     * confirmation prompt closed the whole app instead of declining. The page
     * exposes `window.__tvBack` while something is open; anything else falls
     * through to the normal behaviour.
     *
     * `evaluateJavascript` is asynchronous, so the decision happens in its
     * callback rather than by returning from here.
     */
    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        webView.evaluateJavascript(
            "(typeof window.__tvBack === 'function' && window.__tvBack() === true)",
        ) { handled ->
            if (handled != "true") defaultBack()
        }
    }

    private fun defaultBack() {
        if (webView.canGoBack()) webView.goBack() else finish()
    }

    override fun onDestroy() {
        // Before the WebView: TvVoice posts JS into it, and a live recognizer
        // holds the microphone open until it's destroyed.
        voice.destroy()
        webView.destroy()
        super.onDestroy()
    }

    /**
     * Tell the page how the microphone request went, so it can enable the mic
     * button without the user having to trigger it again.
     */
    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != TvVoice.MIC_PERMISSION_REQUEST) return
        val granted = grantResults.firstOrNull() == android.content.pm.PackageManager.PERMISSION_GRANTED
        webView.evaluateJavascript(
            "window.__tvVoice && window.__tvVoice.onEvent({\"type\":\"micPermission\",\"granted\":$granted})",
            null,
        )
    }

    companion object {
        /** Virtual origin WebViewAssetLoader serves the APK's assets on. */
        private const val APP_BASE = "http://appassets.androidplatform.net/assets/"
    }
}
