package com.example.agenthost

import android.app.Activity
import android.os.Bundle
import android.widget.TextView
import com.streamapp.android.StreamAgent
import com.streamapp.android.UserStopListener
import kotlin.concurrent.thread

/** The smallest embedding: pair from an intent extra, start, and show the agent's state. */
class HostActivity : Activity() {
    private lateinit var label: TextView
    private var watching: AutoCloseable? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        label = TextView(this)
        setContentView(label)
        StreamAgent.userStopListener = UserStopListener { label.post { label.append("\nstopped by the user") } }
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

    override fun onResume() {
        super.onResume()
        watching = StreamAgent.observe(this) { s ->
            runOnUiThread {
                label.text = "${s.displayStatus}\naccessibility: ${s.accessibilityEnabled}\nhealth: ${s.health}"
            }
        }
    }

    override fun onPause() {
        watching?.close()
        watching = null
        super.onPause()
    }
}
