package com.streamapp.android.a11y

import android.content.Context
import android.graphics.PixelFormat
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.activity.OnBackPressedDispatcher
import androidx.activity.OnBackPressedDispatcherOwner
import androidx.activity.findViewTreeOnBackPressedDispatcherOwner
import androidx.activity.setViewTreeOnBackPressedDispatcherOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.findViewTreeLifecycleOwner
import androidx.lifecycle.findViewTreeViewModelStoreOwner
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.findViewTreeSavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The indicator's window root carries the host view's view-tree owners. [NeedsRootLifecycle]
 * stands in for a Compose view: when it attaches it looks the lifecycle owner up from the window
 * root, as Compose does when it creates the window recomposer, and throws the same error without one.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class OwnTouchFrameTest {
    private val ctx: Context = RuntimeEnvironment.getApplication()
    private val wm = ctx.getSystemService(WindowManager::class.java)
    private val added = mutableListOf<View>()

    @After fun tearDown() {
        added.forEach { if (it.isAttachedToWindow) wm.removeViewImmediate(it) }
    }

    @Test fun aComposeLikeViewAttachesThroughTheFrame() {
        val owners = Owners()
        val host = NeedsRootLifecycle(ctx).also { owners.setOn(it) }
        attach(OwnTouchFrame(ctx, host))
        assertTrue(host.attached)
        assertSame(owners, host.rootLifecycleOwner)
    }

    @Test fun ownersTheHostSetsAfterCreateAreCarriedAtAttach() {
        val owners = Owners()
        val host = NeedsRootLifecycle(ctx)
        val frame = OwnTouchFrame(ctx, host)
        owners.setOn(host)
        attach(frame)
        assertTrue(host.attached)
        assertSame(owners, host.rootLifecycleOwner)
    }

    @Test fun everyOwnerKindIsCarried() {
        val owners = Owners()
        val host = View(ctx).also { owners.setOn(it) }
        val frame = OwnTouchFrame(ctx, host)
        assertSame(owners, frame.findViewTreeLifecycleOwner())
        assertSame(owners, frame.findViewTreeViewModelStoreOwner())
        assertSame(owners, frame.findViewTreeSavedStateRegistryOwner())
        assertSame(owners, frame.findViewTreeOnBackPressedDispatcherOwner())
    }

    @Test fun aHostViewWithoutOwnersStillAttaches() {
        val host = View(ctx)
        attach(OwnTouchFrame(ctx, host))
        assertTrue(host.isAttachedToWindow)
    }

    /** The check itself: a plain wrapper (what the frame was before) fails the way the device did. */
    @Test fun aPlainWrapperReproducesTheCrash() {
        val host = NeedsRootLifecycle(ctx).also { Owners().setOn(it) }
        val plain = FrameLayout(ctx).apply { addView(host) }
        try {
            attach(plain)
            fail("attached without a lifecycle owner at the window root")
        } catch (e: IllegalStateException) {
            assertTrue(e.message, e.message!!.startsWith("ViewTreeLifecycleOwner not found from"))
        }
    }

    @Test fun aMissingLibrarySkipsOnlyItsOwnStep() {
        val ran = mutableListOf<Int>()
        runEachLinked({ ran += 1 }, { throw NoClassDefFoundError("androidx/activity/X") }, { ran += 3 })
        assertEquals(listOf(1, 3), ran)
        try {
            runEachLinked({ throw IllegalStateException("boom") })
            fail("a non-linkage failure was swallowed")
        } catch (_: IllegalStateException) { }
    }

    private fun attach(root: View) {
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, 0, PixelFormat.TRANSLUCENT,
        )
        added += root
        wm.addView(root, lp)
        shadowOf(Looper.getMainLooper()).idle()
    }

    private class NeedsRootLifecycle(context: Context) : View(context) {
        var attached = false
        var rootLifecycleOwner: LifecycleOwner? = null

        override fun onAttachedToWindow() {
            super.onAttachedToWindow()
            val root = rootView
            rootLifecycleOwner = checkNotNull(root.findViewTreeLifecycleOwner()) { "ViewTreeLifecycleOwner not found from $root" }
            attached = true
        }
    }

    /** One object owning all the kinds, the way a host's overlay helper usually does. */
    private class Owners : LifecycleOwner, ViewModelStoreOwner, SavedStateRegistryOwner, OnBackPressedDispatcherOwner {
        private val registry = LifecycleRegistry(this)
        private val saved = SavedStateRegistryController.create(this)
        override val lifecycle: Lifecycle get() = registry
        override val viewModelStore = ViewModelStore()
        override val savedStateRegistry: SavedStateRegistry get() = saved.savedStateRegistry
        override val onBackPressedDispatcher = OnBackPressedDispatcher()

        init {
            saved.performRestore(null)
            registry.currentState = Lifecycle.State.RESUMED
        }

        fun setOn(v: View) {
            v.setViewTreeLifecycleOwner(this)
            v.setViewTreeViewModelStoreOwner(this)
            v.setViewTreeSavedStateRegistryOwner(this)
            v.setViewTreeOnBackPressedDispatcherOwner(this)
        }
    }
}
