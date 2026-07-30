package tv.titanos.aiagent

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

/**
 * Host activity. Loads the web-based agent runtime (bundled into assets) inside
 * a WebView and installs the native bridge the AOSP adapter expects.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

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
            webViewClient = object : WebViewClient() {
                // Keep navigation inside the bundled asset origin.
                override fun shouldOverrideUrlLoading(
                    view: WebView, request: android.webkit.WebResourceRequest,
                ): Boolean {
                    val url = request.url.toString()
                    return !url.startsWith("file:///android_asset/")
                }
            }
            // Expose the native bridge to JS as `TvNativeBridge`.
            addJavascriptInterface(TvNativeBridge(this@MainActivity), "TvNativeBridge")
        }
        setContentView(webView)
        // Runtime web bundle is copied to app/src/main/assets by tools/bundle.mjs.
        // A "start" intent extra lets you open a specific page/query without a
        // rebuild, e.g. for the capability probe:
        //   adb shell am start -n tv.titanos.aiagent/.MainActivity -e start "index.html?diag"
        val start = intent?.getStringExtra("start")?.takeIf { it.startsWith("index.html") } ?: "index.html"
        webView.loadUrl("file:///android_asset/$start")
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
