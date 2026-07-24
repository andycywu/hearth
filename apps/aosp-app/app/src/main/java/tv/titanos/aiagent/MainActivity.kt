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
            webViewClient = WebViewClient()
            // Expose the native bridge to JS as `TvNativeBridge`.
            addJavascriptInterface(TvNativeBridge(this@MainActivity), "TvNativeBridge")
        }
        setContentView(webView)
        // Runtime web bundle is copied to app/src/main/assets by tools/bundle.mjs
        webView.loadUrl("file:///android_asset/index.html")
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
