package tv.aiagent.harness

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.tv.TvContract
import android.media.tv.TvInputManager
import android.net.Uri
import android.provider.Settings
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

/**
 * Native side of the JS bridge consumed by @hearthkit/adapter-aosp.
 * Every @JavascriptInterface method maps 1:1 to the NativeBridge TypeScript
 * interface. Methods returning structured data return JSON strings.
 *
 * Signing/privilege model (not a vendor SDK):
 *  - Volume, app list/launch, network: public SDK, no special signing.
 *  - Navigation keys: routed through TvAgentAccessibilityService (user-enabled),
 *    falling back to an in-app KeyEvent when the service is off.
 *  - Input switching: best-effort via the TV Input Framework passthrough Intent;
 *    reliability varies by build. Guaranteed control needs a platform signature.
 *  - Standby: requires the DEVICE_POWER system permission; left unimplemented on
 *    unprivileged builds.
 */
class TvNativeBridge(
    private val ctx: Context,
    /**
     * Speech in and out. Owned by the Activity rather than constructed here,
     * because it needs to evaluate JS in the WebView and must be shut down with
     * the Activity — a live SpeechRecognizer holds the microphone.
     */
    private val voice: TvVoice,
) {

    private val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    @JavascriptInterface
    fun getDeviceInfo(): String = JSONObject()
        .put("os", "aosp")
        .put("osVersion", android.os.Build.VERSION.RELEASE)
        .put("soc", detectSoc())
        .put("model", android.os.Build.MODEL)
        .put("capabilities", JSONObject().put("media", true).put("voice", false))
        .toString()

    /**
     * The HAL speaks 0-100; Android speaks 0..getStreamMaxVolume (often 15 or 25
     * steps). Round rather than truncate in both directions — integer division
     * biased every value downwards, so "set volume to 30" read back as 28 and the
     * error compounded across relative adjustments. Some quantization is
     * unavoidable: with 25 steps the reachable values are multiples of 4.
     */
    @JavascriptInterface
    fun getVolume(): Int {
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        val cur = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
        return Math.round(cur * 100f / max)
    }

    @JavascriptInterface
    fun setVolume(level: Int) {
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        val target = Math.round(level.coerceIn(0, 100) * max / 100f)
        audio.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
    }

    @JavascriptInterface
    fun getMute(): Boolean = audio.isStreamMute(AudioManager.STREAM_MUSIC)

    @JavascriptInterface
    fun setMute(mute: Boolean) {
        audio.adjustStreamVolume(
            AudioManager.STREAM_MUSIC,
            if (mute) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE, 0
        )
    }

    @JavascriptInterface fun getInputSource(): String = "app"

    /**
     * Best-effort input switch with no special signing: find a passthrough TV
     * input (HDMI, etc.) and ask the system TV app to view it. Works on many
     * Android TV builds; throws (caught by the adapter) where the platform
     * restricts it, in which case a platform signature is required.
     */
    @JavascriptInterface
    fun setInputSource(source: String) {
        val tim = ctx.getSystemService(Context.TV_INPUT_SERVICE) as? TvInputManager
            ?: throw UnsupportedOperationException("TV Input Framework unavailable")
        val wanted = source.lowercase()
        val match = tim.tvInputList.firstOrNull { info ->
            info.isPassthroughInput &&
                (info.id.lowercase().contains(wanted) ||
                 info.loadLabel(ctx)?.toString()?.lowercase()?.contains(wanted) == true)
        } ?: throw UnsupportedOperationException("No passthrough input matching '$source'")
        val uri: Uri = TvContract.buildChannelUriForPassthroughInput(match.id)
        ctx.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    // Standby requires the DEVICE_POWER signature permission; unavailable here.
    @JavascriptInterface
    fun powerStandby() { throw UnsupportedOperationException("Not supported: powerStandby (needs system signature)") }

    @JavascriptInterface
    fun listInstalledApps(): String {
        val pm = ctx.packageManager
        val intent = android.content.Intent(android.content.Intent.ACTION_MAIN)
            .addCategory(android.content.Intent.CATEGORY_LEANBACK_LAUNCHER)
        // One package can expose several launcher activities (this app declares
        // both LEANBACK_LAUNCHER and LAUNCHER), and the agent identifies apps by
        // package, so without this the model sees the same TV twice.
        val seen = LinkedHashMap<String, String>()
        for (ri in pm.queryIntentActivities(intent, 0)) {
            val id = ri.activityInfo.packageName
            if (!seen.containsKey(id)) seen[id] = ri.loadLabel(pm).toString()
        }
        val arr = JSONArray()
        for ((id, name) in seen) arr.put(JSONObject().put("id", id).put("name", name))
        return arr.toString()
    }

    @JavascriptInterface
    fun launchApp(appId: String) {
        val launch = ctx.packageManager.getLeanbackLaunchIntentForPackage(appId)
            ?: ctx.packageManager.getLaunchIntentForPackage(appId)
        launch?.let { ctx.startActivity(it.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    @JavascriptInterface fun getForegroundApp(): String = "null"

    /**
     * Route navigation through the AccessibilityService when the user has enabled
     * it (works on retail devices, no signing). If the service is off, throw so
     * the adapter surfaces it as unavailable and the UI can prompt to enable it.
     */
    @JavascriptInterface
    fun sendKey(key: String) {
        if (TvAgentAccessibilityService.tryPressKey(key)) return
        if (!TvAgentAccessibilityService.isConnected()) {
            throw UnsupportedOperationException(
                "Not supported: accessibility service not enabled — call openAccessibilitySettings()")
        }
        throw UnsupportedOperationException("Not supported: key '$key' via accessibility")
    }

    /** True when the navigation AccessibilityService is enabled and connected. */
    @JavascriptInterface
    fun isAccessibilityEnabled(): Boolean = TvAgentAccessibilityService.isConnected()

    /** Deep-link the user to the Accessibility settings screen to enable it. */
    @JavascriptInterface
    fun openAccessibilitySettings() {
        ctx.startActivity(
            Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    @JavascriptInterface
    fun isOnline(): Boolean {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE)
                as android.net.ConnectivityManager
        return cm.activeNetwork != null
    }

    @JavascriptInterface fun connectionType(): String = "ethernet"

    /**
     * SharedPreferences, not a HashMap: this backs `platform.storage`, and the
     * agent's `persistKey` promises a conversation survives an app reload. An
     * in-memory map made that silently false on every device.
     */
    private val prefs by lazy { ctx.getSharedPreferences("hearth", Context.MODE_PRIVATE) }
    @JavascriptInterface fun kvGet(key: String): String = prefs.getString(key, "") ?: ""
    @JavascriptInterface fun kvSet(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }
    @JavascriptInterface fun kvDelete(key: String) { prefs.edit().remove(key).apply() }

    /**
     * The provisioned LLM API key, or "" when there isn't one.
     *
     * Deliberately not in the ordinary key-value store: that one is readable by
     * any skill, and this is a credential. Provision it with
     * `am start -e llmKey …` (see MainActivity) rather than in the launch URL.
     *
     * The page does receive the key here — it is the page that calls the model —
     * so this keeps the key out of the URL, the shell history, the logs and the
     * screen, not out of the app. [LlmSecrets] spells out that boundary.
     */
    @JavascriptInterface fun getLlmApiKey(): String = LlmSecrets.load(ctx) ?: ""

    /**
     * The ModelPilot credential, provisioned the same way and for the same
     * reason: it must never be a launch flag. A television's launch URL lives in
     * shell history, in the intent and in logcat, and on a shipped model that key
     * is identical on every unit.
     */
    @JavascriptInterface
    fun getModelPilotApiKey(): String = LlmSecrets.load(ctx, LlmSecrets.MODELPILOT_KEY) ?: ""

    private fun detectSoc(): String {
        val h = (android.os.Build.HARDWARE + " " + android.os.Build.BOARD).lowercase()
        return when {
            h.contains("mt") || h.contains("mediatek") -> "mediatek"
            h.contains("nvt") || h.contains("novatek") -> "novatek"
            else -> "unknown"
        }
    }

    // ---------------------------------------------------------------- voice --
    //
    // The first capability here that is genuinely asynchronous, so it is also the
    // first that needs to talk *back* into JS. Everything above is a synchronous
    // call the WebView makes; recognition results arrive whenever the user stops
    // speaking, so they are pushed to `window.__tvVoice` instead.
    //
    // Privilege model, which is the reason this is Android-first: both APIs are
    // public SDK. TTS needs nothing at all; recognition needs RECORD_AUDIO, a
    // normal runtime permission the user grants — no platform signature, no
    // vendor relationship. That is not true of Samsung's or LG's voice stacks.

    @JavascriptInterface
    fun ttsAvailable(): Boolean = voice.ttsReady()

    @JavascriptInterface
    fun speak(text: String) = voice.speak(text)

    @JavascriptInterface
    fun stopSpeaking() = voice.stopSpeaking()

    /**
     * Whether speech recognition can run *right now* — a service exists and the
     * microphone permission is granted. Two separate reasons it may be false, so
     * `sttUnavailableReason()` says which.
     */
    @JavascriptInterface
    fun sttAvailable(): Boolean = voice.sttReady()

    @JavascriptInterface
    fun sttUnavailableReason(): String = voice.sttReason()

    /** Ask for RECORD_AUDIO. No-op when already granted or when there's no Activity. */
    @JavascriptInterface
    fun requestMicPermission() = voice.requestMicPermission()

    @JavascriptInterface
    fun startListening() = voice.startListening()

    @JavascriptInterface
    fun stopListening() = voice.stopListening()
}
