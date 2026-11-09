package app.scout.companion.automation

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import app.scout.R

/**
 * Take control and Stop, drawn over whichever app Scout is driving.
 * The window is only as big as the bar, so taps elsewhere reach that app.
 */
internal class ControlOverlay(private val service: AccessibilityService) {
    private val window = service.getSystemService(WindowManager::class.java)
    private var bar: LinearLayout? = null
    private var primary: TextView? = null

    fun show(holding: Boolean, onDown: () -> Unit, onToggle: () -> Unit, onStop: () -> Unit) {
        if (bar == null) attach(onDown, onToggle, onStop)
        val label = service.getString(if (holding) R.string.automation_resume else R.string.automation_take)
        primary?.text = label
        primary?.contentDescription = label
    }

    fun hide() {
        val row = bar ?: return
        bar = null
        primary = null
        try {
            window.removeView(row)
        } catch (_: RuntimeException) {
        }
    }

    private fun attach(onDown: () -> Unit, onToggle: () -> Unit, onStop: () -> Unit) {
        val take = button(service.getString(R.string.automation_take), FILL, onToggle)
        val stop = button(service.getString(R.string.automation_stop), STOP, onStop)
        val row = Bar(service, onDown).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), dp(6), dp(6), dp(6))
            background = GradientDrawable().apply {
                cornerRadius = dp(28).toFloat()
                setColor(BAR)
            }
            addView(take)
            addView(stop)
        }
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = statusOffset()
        }
        try {
            window.addView(row, params)
        } catch (_: RuntimeException) {
            return
        }
        bar = row
        primary = take
    }

    private fun button(label: String, fill: Int, click: () -> Unit): TextView {
        return TextView(service).apply {
            text = label
            contentDescription = label
            setTextColor(Color.WHITE)
            textSize = 15f
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(12), dp(16), dp(12))
            background = GradientDrawable().apply {
                cornerRadius = dp(22).toFloat()
                setColor(fill)
            }
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                marginStart = dp(4)
                marginEnd = dp(4)
            }
            setOnClickListener { click() }
        }
    }

    private fun dp(value: Int): Int = (value * service.resources.displayMetrics.density).toInt()

    private fun statusOffset(): Int {
        val id = service.resources.getIdentifier("status_bar_height", "dimen", "android")
        val bar = if (id > 0) service.resources.getDimensionPixelSize(id) else dp(24)
        return bar + dp(8)
    }

    private class Bar(context: Context, private val onDown: () -> Unit) : LinearLayout(context) {
        override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
            if (ev.action == MotionEvent.ACTION_DOWN) onDown()
            return super.dispatchTouchEvent(ev)
        }
    }

    private companion object {
        const val BAR = 0xF01C1C1E.toInt()
        const val FILL = 0xFF3A3A3C.toInt()
        const val STOP = 0xFFFF3B30.toInt()
    }
}
