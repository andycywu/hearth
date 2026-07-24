package tv.titanos.aiagent

import android.content.Context
import android.media.AudioManager
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

/**
 * Native side of the JS bridge consumed by @tv-ai-agent/adapter-aosp.
 * Every @JavascriptInterface method maps 1:1 to the NativeBridge TypeScript
 * interface. Methods returning structured data return JSON strings.
 *
 * NOTE: Volume/app/input control on production TV hardware usually requires
 * system or vendor (MTK/NVT) privileged APIs. The implementations below use the
 * public SDK where possible and are marked TODO where a vendor SDK is needed.
 */
class TvNativeBridge(private val ctx: Context) {

    private val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    @JavascriptInterface
    fun getDeviceInfo(): String = JSONObject()
        .put("os", "aosp")
        .put("osVersion", android.os.Build.VERSION.RELEASE)
        .put("soc", detectSoc())
        .put("model", android.os.Build.MODEL)
        .put("capabilities", JSONObject().put("media", true).put("voice", false))
        .toString()

    @JavascriptInterface
    fun getVolume(): Int {
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        val cur = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
        return (cur * 100 / max)
    }

    @JavascriptInterface
    fun setVolume(level: Int) {
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val target = (level.coerceIn(0, 100) * max / 100)
        audio.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
    }

    @JavascriptInterface
    fun setMute(mute: Boolean) {
        audio.adjustStreamVolume(
            AudioManager.STREAM_MUSIC,
            if (mute) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE, 0
        )
    }

    // Input-source switching is vendor-specific (HDMI-CEC / MTK/NVT SDK).
    @JavascriptInterface fun getInputSource(): String = "app"
    @JavascriptInterface fun setInputSource(source: String) { /* TODO: vendor SDK */ }
    @JavascriptInterface fun powerStandby() { /* TODO: vendor SDK */ }

    @JavascriptInterface
    fun listInstalledApps(): String {
        val pm = ctx.packageManager
        val arr = JSONArray()
        val intent = android.content.Intent(android.content.Intent.ACTION_MAIN)
            .addCategory(android.content.Intent.CATEGORY_LEANBACK_LAUNCHER)
        for (ri in pm.queryIntentActivities(intent, 0)) {
            val ai = ri.activityInfo
            arr.put(JSONObject()
                .put("id", ai.packageName)
                .put("name", ri.loadLabel(pm).toString()))
        }
        return arr.toString()
    }

    @JavascriptInterface
    fun launchApp(appId: String) {
        val launch = ctx.packageManager.getLeanbackLaunchIntentForPackage(appId)
            ?: ctx.packageManager.getLaunchIntentForPackage(appId)
        launch?.let { ctx.startActivity(it.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    @JavascriptInterface fun getForegroundApp(): String = "null"

    @JavascriptInterface fun sendKey(key: String) { /* TODO: inject via accessibility / vendor SDK */ }

    @JavascriptInterface
    fun isOnline(): Boolean {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE)
                as android.net.ConnectivityManager
        return cm.activeNetwork != null
    }

    @JavascriptInterface fun connectionType(): String = "ethernet"

    private val kv = HashMap<String, String>()
    @JavascriptInterface fun kvGet(key: String): String = kv[key] ?: ""
    @JavascriptInterface fun kvSet(key: String, value: String) { kv[key] = value }
    @JavascriptInterface fun kvDelete(key: String) { kv.remove(key) }

    private fun detectSoc(): String {
        val h = (android.os.Build.HARDWARE + " " + android.os.Build.BOARD).lowercase()
        return when {
            h.contains("mt") || h.contains("mediatek") -> "mediatek"
            h.contains("nvt") || h.contains("novatek") -> "novatek"
            else -> "unknown"
        }
    }
}
