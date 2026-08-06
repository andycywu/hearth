package tv.aiagent.harness

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The LLM API key, kept off the launch URL.
 *
 * **What this fixes.** The key used to arrive as `?key=sk-…` in the launch flags,
 * which put it in the host's shell history, in the launch intent, and — until
 * this change — on the television itself, because the `?debug` status line
 * printed the query verbatim. On a shipped TV that key is the same for every
 * unit of the model, so any one of those was enough to lose it for everybody.
 * Provisioned here, it is written once and never appears in any of them again.
 *
 * **What this does not fix, and it matters.** The key still lives on the device
 * and the page can still read it through the bridge, because the page is what
 * calls the model. Encrypting it at rest stops it being lifted out of a file or
 * a backup; it does not stop someone who can run code as this app. If the key
 * must never be on the device at all, the app has to talk to a relay you run
 * that holds it instead — `examples/llm-relay` is a working one. That is the
 * only arrangement that actually survives a device in someone else's hands.
 *
 * AES-GCM with a key held in the platform keystore, rather than a crypto
 * library: the mechanism is three calls, and this repo would rather not add a
 * dependency to reach it.
 */
object LlmSecrets {
    private const val PREFS = "tv_agent_secrets"
    private const val PREF_KEY = "llm_api_key"
    private const val ALIAS = "tv.aiagent.llm"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128

    /** Store (or, with a blank value, forget) the key. Never logged. */
    fun save(ctx: Context, apiKey: String) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (apiKey.isBlank()) {
            prefs.edit().remove(PREF_KEY).apply()
            return
        }
        val cipher = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, secretKey()) }
        val body = cipher.doFinal(apiKey.toByteArray(Charsets.UTF_8))
        // IV first: GCM needs a fresh one per encryption and it isn't secret.
        val blob = cipher.iv + body
        prefs.edit().putString(PREF_KEY, Base64.encodeToString(blob, Base64.NO_WRAP)).apply()
    }

    /** The stored key, or null. Returns null rather than throwing on a bad blob. */
    fun load(ctx: Context): String? {
        val stored = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(PREF_KEY, null) ?: return null
        return try {
            val blob = Base64.decode(stored, Base64.NO_WRAP)
            if (blob.size <= IV_BYTES) return null
            val cipher = Cipher.getInstance(TRANSFORM).apply {
                init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, blob, 0, IV_BYTES))
            }
            String(cipher.doFinal(blob, IV_BYTES, blob.size - IV_BYTES), Charsets.UTF_8)
        } catch (e: Exception) {
            // A keystore key is dropped when the screen lock changes or the app's
            // data is restored onto another device. Losing the key is recoverable
            // — re-provision it — but crashing the app on boot is not.
            android.util.Log.w("LlmSecrets", "stored key unreadable (${e.javaClass.simpleName}); re-provision it")
            null
        }
    }

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(
                    ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    // No user-authentication requirement: a TV agent has to work
                    // when nobody is standing in front of it.
                    .setUserAuthenticationRequired(false)
                    .build(),
            )
        }.generateKey()
    }
}
