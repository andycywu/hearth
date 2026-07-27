package tv.titanos.aiagent

import android.accessibilityservice.AccessibilityService
import android.view.View
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Non-privileged remote-navigation path for AOSP / Android TV.
 *
 * A third-party app cannot inject raw KeyEvents into other apps (that needs the
 * INJECT_EVENTS signature permission). An AccessibilityService, which the user
 * enables once in Settings, can instead perform global actions (home/back/
 * recents) and move directional focus within the active window — enough to drive
 * most 10-foot UIs. This unlocks navigation on retail devices with no special
 * signing. For guaranteed raw key injection, platform-sign the app instead.
 */
class TvAgentAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    // We don't react to events; we only issue actions on demand.
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    /** Returns true if the key was handled by this service. */
    fun pressKey(key: String): Boolean = try {
        when (key) {
            "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "menu" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "up" -> moveFocus(View.FOCUS_UP)
            "down" -> moveFocus(View.FOCUS_DOWN)
            "left" -> moveFocus(View.FOCUS_LEFT)
            "right" -> moveFocus(View.FOCUS_RIGHT)
            "ok" -> clickFocused()
            else -> false // channelup/down, media keys: not reachable this way
        }
    } catch (t: Throwable) {
        false
    }

    private fun moveFocus(direction: Int): Boolean {
        val root = rootInActiveWindow ?: return false
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: root.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
            ?: return false
        val next = focused.focusSearch(direction) ?: return false
        return next.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
    }

    private fun clickFocused(): Boolean {
        val root = rootInActiveWindow ?: return false
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
        return focused.performAction(AccessibilityNodeInfo.ACTION_CLICK)
    }

    companion object {
        @Volatile
        private var instance: TvAgentAccessibilityService? = null

        /** Whether the service is currently connected (i.e. enabled by the user). */
        fun isConnected(): Boolean = instance != null

        /** Route a key press through the service if available. */
        fun tryPressKey(key: String): Boolean = instance?.pressKey(key) ?: false
    }
}
