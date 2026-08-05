package tv.aiagent.harness

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import org.json.JSONObject
import java.util.Locale

/**
 * Speech in and out, using nothing but the public Android SDK.
 *
 * This is why voice landed on Android first: `TextToSpeech` needs no permission
 * at all and `SpeechRecognizer` needs RECORD_AUDIO, an ordinary runtime
 * permission the user grants from a dialog. Neither wants a platform signature
 * or a vendor agreement, which is not true of Samsung's or LG's voice stacks.
 *
 * Two Android rules shape the whole class:
 *  - `SpeechRecognizer` must be created and called on the main thread. The
 *    WebView calls in on its own thread, so every entry point hops.
 *  - Recognition is asynchronous, so results are pushed into JS rather than
 *    returned. `postToJs` hands them to `window.__tvVoice`.
 */
class TvVoice(
    private val ctx: Context,
    /** Evaluate JS in the host WebView. Called on the main thread. */
    private val postToJs: (String) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())

    private var tts: TextToSpeech? = null
    private var ttsInitialised = false
    private var ttsInitFailed = false

    /**
     * What to say as soon as the engine finishes initialising.
     *
     * `TextToSpeech` takes a couple of seconds to bind, and the agent can answer
     * in well under that — with an offline model it answers instantly. So the
     * very first reply, the one that greets you, arrived while the engine was
     * still connecting and was silently dropped; warming up at launch narrowed
     * the window but never closed it. Holding one utterance closes it. Only one:
     * `speak` uses QUEUE_FLUSH, so a newer reply supersedes an older one anyway.
     */
    private var pending: String? = null

    private var recognizer: SpeechRecognizer? = null
    private var listening = false

    companion object {
        const val MIC_PERMISSION_REQUEST = 4711
    }

    /**
     * TTS init is asynchronous and slow enough to be visible, so it starts at
     * app launch rather than on the first reply — otherwise the first thing the
     * agent says is silently dropped.
     */
    fun warmUp() {
        main.post {
            if (tts != null) return@post
            tts = TextToSpeech(ctx) { status ->
                ttsInitialised = status == TextToSpeech.SUCCESS
                if (!ttsInitialised) {
                    android.util.Log.w("TvVoice", "TextToSpeech init failed with status $status")
                    ttsInitFailed = true
                    // Release anything that was waiting on the engine, or the
                    // avatar keeps its mouth open forever.
                    if (pending != null) {
                        pending = null
                        emit("speakDone", JSONObject().put("spoken", false))
                    }
                    return@TextToSpeech
                }
                /*
                 * Speak as an assistant, not as media.
                 *
                 * TextToSpeech defaults to STREAM_MUSIC — which is the exact
                 * stream `set_mute` mutes. So asking the agent to mute the TV
                 * silenced its own reply, and every turn after it: it would
                 * announce what it had done, inaudibly. USAGE_ASSISTANT is
                 * routed as speech and survives a media mute.
                 */
                tts?.setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(
                            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
                                AudioAttributes.USAGE_ASSISTANT
                            } else {
                                AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY
                            },
                        )
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                // Say whatever arrived while we were connecting.
                pending?.let { pending = null; speak(it) }
            }
        }
    }

    fun ttsReady(): Boolean = ttsInitialised

    fun speak(text: String) {
        if (text.isBlank()) return
        main.post {
            val engine = tts
            if (engine != null && !ttsInitialised && !ttsInitFailed) {
                // Still connecting — hold it rather than lose it. See `pending`.
                pending = text
                return@post
            }
            if (engine == null || !ttsInitialised) {
                // Report completion anyway: the avatar's speaking state must not
                // stick on for a device with no working engine.
                emit("speakDone", JSONObject().put("spoken", false))
                return@post
            }
            engine.setOnUtteranceProgressListener(object : android.speech.tts.UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) = emit("speakStart", JSONObject())
                override fun onDone(utteranceId: String?) =
                    emit("speakDone", JSONObject().put("spoken", true))
                @Deprecated("Required by the abstract class")
                override fun onError(utteranceId: String?) {
                    android.util.Log.w("TvVoice", "utterance failed")
                    emit("speakDone", JSONObject().put("spoken", false))
                }
            })
            val queued = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "reply")
            if (queued != TextToSpeech.SUCCESS) {
                android.util.Log.w("TvVoice", "speak() refused by the engine: $queued")
                emit("speakDone", JSONObject().put("spoken", false))
            }
        }
    }

    fun stopSpeaking() {
        main.post { tts?.stop() }
    }

    // ------------------------------------------------------------------ stt --

    fun sttReady(): Boolean = sttReason().isEmpty()

    /** Empty when recognition can run; otherwise why it can't, for `?diag`. */
    fun sttReason(): String = when {
        !SpeechRecognizer.isRecognitionAvailable(ctx) ->
            "no speech recognition service on this build — install one, or use text input"
        !micGranted() ->
            "microphone permission not granted — call requestMicPermission()"
        else -> ""
    }

    private fun micGranted(): Boolean =
        ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    fun requestMicPermission() {
        val activity = ctx as? Activity ?: return
        if (micGranted()) return
        main.post {
            activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), MIC_PERMISSION_REQUEST)
        }
    }

    fun startListening() {
        main.post {
            val reason = sttReason()
            if (reason.isNotEmpty()) {
                emit("error", JSONObject().put("message", reason))
                return@post
            }
            if (listening) return@post

            val r = recognizer ?: SpeechRecognizer.createSpeechRecognizer(ctx).also { recognizer = it }
            r.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) = emit("listening", JSONObject())
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {
                    // Drives the avatar's mouth. Android reports roughly -2..10 dB;
                    // normalise so the UI never has to know that.
                    val level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
                    emit("level", JSONObject().put("level", level.toDouble()))
                }
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}

                override fun onError(error: Int) {
                    listening = false
                    emit("error", JSONObject().put("message", describeError(error)))
                    emit("stopped", JSONObject())
                }

                override fun onPartialResults(partialResults: Bundle?) {
                    firstResult(partialResults)?.let {
                        emit("transcript", JSONObject().put("text", it).put("isFinal", false))
                    }
                }

                override fun onResults(results: Bundle?) {
                    listening = false
                    val text = firstResult(results)
                    if (text != null) {
                        emit("transcript", JSONObject().put("text", text).put("isFinal", true))
                    }
                    emit("stopped", JSONObject())
                }

                override fun onEvent(eventType: Int, params: Bundle?) {}
            })

            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                // The default is the device locale, which is right for a TV: the
                // agent already answers in the language it was addressed in.
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            }
            listening = true
            try {
                r.startListening(intent)
            } catch (e: Exception) {
                listening = false
                emit("error", JSONObject().put("message", "startListening failed: ${e.message}"))
                emit("stopped", JSONObject())
            }
        }
    }

    fun stopListening() {
        main.post {
            if (!listening) return@post
            listening = false
            recognizer?.stopListening()
            emit("stopped", JSONObject())
        }
    }

    fun destroy() {
        main.post {
            recognizer?.destroy()
            recognizer = null
            tts?.shutdown()
            tts = null
            ttsInitialised = false
            pending = null
        }
    }

    private fun firstResult(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
            ?.takeIf { it.isNotBlank() }

    /**
     * Push an event to `window.__tvVoice`. Guarded on the JS side existing,
     * because native events can outlive a page reload.
     */
    private fun emit(type: String, payload: JSONObject) {
        val json = payload.put("type", type).toString()
        main.post { postToJs("window.__tvVoice && window.__tvVoice.onEvent($json)") }
    }

    private fun describeError(code: Int): String = when (code) {
        SpeechRecognizer.ERROR_AUDIO -> "audio recording failed"
        SpeechRecognizer.ERROR_CLIENT -> "recognition client error"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "microphone permission denied"
        SpeechRecognizer.ERROR_NETWORK -> "recognition needs a network and there isn't one"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "recognition network timeout"
        SpeechRecognizer.ERROR_NO_MATCH -> "didn't catch that"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "recognizer busy"
        SpeechRecognizer.ERROR_SERVER -> "recognition server error"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no speech heard"
        else -> "recognition error $code"
    }
}
