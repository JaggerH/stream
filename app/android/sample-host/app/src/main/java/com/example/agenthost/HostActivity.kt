package com.example.agenthost

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
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

/**
 * The indicator, drawn with Jetpack Compose: a pill with the current step; tapping it expands it
 * to show a Stop button. An overlay window has no activity behind it, so the view gets the
 * view-tree owners Compose needs from [OverlayOwners], set on the view itself the way a host
 * usually does. The agent wraps the view in a window root of its own and carries those owners up.
 */
private object Pill : IndicatorView {
    override val gravity: Int get() = Gravity.TOP or Gravity.CENTER_HORIZONTAL
    override val width: Int get() = WindowManager.LayoutParams.WRAP_CONTENT

    override fun create(context: Context, onStop: () -> Unit): View {
        val text = mutableStateOf("")
        val owners = OverlayOwners()
        return ComposeView(context).apply {
            setViewTreeLifecycleOwner(owners)
            setViewTreeViewModelStoreOwner(owners)
            setViewTreeSavedStateRegistryOwner(owners)
            addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
                override fun onViewAttachedToWindow(v: View) = owners.resume()
                override fun onViewDetachedFromWindow(v: View) = owners.destroy()
            })
            tag = text
            setContent { PillContent(text.value, onStop) }
        }
    }

    @Suppress("UNCHECKED_CAST")
    override fun bind(view: View, text: String) {
        (view.tag as MutableState<String>).value = text
    }
}

@Composable
private fun PillContent(text: String, onStop: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val white = TextStyle(color = Color.White, fontSize = 13.sp)
    Column(
        Modifier
            .padding(top = 8.dp)
            .background(Color(0xDD005AA0), RoundedCornerShape(20.dp))
            .clickable { expanded = !expanded }
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        BasicText(text, style = white)
        if (expanded) {
            Spacer(Modifier.height(8.dp))
            Row {
                BasicText(
                    "Stop",
                    style = white,
                    modifier = Modifier
                        .background(Color(0xFFB00020), RoundedCornerShape(12.dp))
                        .clickable { onStop() }
                        .padding(horizontal = 12.dp, vertical = 4.dp),
                )
            }
        }
    }
}

/** Lifecycle, view model store and saved state for a view that lives in an overlay window. */
private class OverlayOwners : LifecycleOwner, ViewModelStoreOwner, SavedStateRegistryOwner {
    private val registry = LifecycleRegistry(this)
    private val saved = SavedStateRegistryController.create(this)
    override val lifecycle: Lifecycle get() = registry
    override val viewModelStore = ViewModelStore()
    override val savedStateRegistry: SavedStateRegistry get() = saved.savedStateRegistry

    init {
        saved.performRestore(null)
        registry.currentState = Lifecycle.State.CREATED
    }

    fun resume() {
        if (registry.currentState != Lifecycle.State.DESTROYED) registry.currentState = Lifecycle.State.RESUMED
    }

    fun destroy() {
        registry.currentState = Lifecycle.State.DESTROYED
        viewModelStore.clear()
    }
}
