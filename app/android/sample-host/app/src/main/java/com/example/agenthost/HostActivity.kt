package com.example.agenthost

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.widget.TextView
import com.streamapp.android.IndicatorProvider
import com.streamapp.android.IndicatorView
import com.streamapp.android.OccupancyHint
import com.streamapp.android.StreamAgent
import com.streamapp.android.UserStopListener
import kotlin.concurrent.thread

/** The smallest embedding: pair from an intent extra, start, and show the agent's state. It also
 *  replaces the indicator with its own view and tells the agent not to take the screen from it
 *  while it is in front. */
class HostActivity : Activity() {
    private lateinit var label: TextView
    private var watching: AutoCloseable? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        label = TextView(this)
        setContentView(label)
        StreamAgent.userStopListener = UserStopListener { label.post { label.append("\nstopped by the user") } }
        StreamAgent.indicatorProvider = IndicatorProvider { service, onStop -> StreamAgent.overlayIndicator(service, onStop, Pill) }
        StreamAgent.occupancyHint = OccupancyHint { pkg -> if (pkg == packageName && resumed) true else null }
        val backend = intent.getStringExtra("backend")
        val code = intent.getStringExtra("code")
        if (backend != null && code != null) {
            thread {
                StreamAgent.pair(this, backend, code, "Agent Host")
                    .onSuccess { StreamAgent.start(this) }
            }
        } else if (StreamAgent.state(this).paired) {
            StreamAgent.start(this)
        }
    }

    @Volatile private var resumed = false

    override fun onResume() {
        super.onResume()
        resumed = true
        watching = StreamAgent.observe(this) { s ->
            runOnUiThread {
                label.text = "${s.displayStatus}\naccessibility: ${s.accessibilityEnabled}\nhealth: ${s.health}"
            }
        }
    }

    override fun onPause() {
        resumed = false
        watching?.close()
        watching = null
        super.onPause()
    }
}

/** A one-line indicator; tapping it stops the agent. */
private object Pill : IndicatorView {
    override fun create(context: Context, onStop: () -> Unit): View = TextView(context).apply {
        setBackgroundColor(Color.argb(200, 0, 90, 160))
        setTextColor(Color.WHITE)
        setPadding(24, 8, 24, 8)
        setOnClickListener { onStop() }
    }

    override fun bind(view: View, text: String) {
        (view as TextView).text = text
    }
}
