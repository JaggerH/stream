package com.streamapp.android.a11y

import android.view.View
import androidx.activity.findViewTreeFullyDrawnReporterOwner
import androidx.activity.findViewTreeOnBackPressedDispatcherOwner
import androidx.activity.setViewTreeFullyDrawnReporterOwner
import androidx.activity.setViewTreeOnBackPressedDispatcherOwner
import androidx.lifecycle.findViewTreeLifecycleOwner
import androidx.lifecycle.findViewTreeViewModelStoreOwner
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.findViewTreeSavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner

/**
 * Gives [to] — a window root the agent puts above the host's [from] — the androidx view-tree
 * owners [from] resolves: lifecycle, view model store, saved state registry, back-press dispatcher
 * and fully-drawn reporter. Some of their users look them up from the window root rather than from
 * the view itself (Compose creates its window recomposer from the root's lifecycle owner, and
 * crashes the process when there is none), so a wrapper the host did not ask for must carry them.
 *
 * The agent compiles against these APIs but does not ship them: a host without one of those
 * libraries has no owner of that kind to carry, and its copy step ends in a [LinkageError] that
 * is skipped. An owner [from] does not have is left as it is on [to].
 */
internal fun copyViewTreeOwners(from: View, to: View) = runEachLinked(
    { from.findViewTreeLifecycleOwner()?.let { to.setViewTreeLifecycleOwner(it) } },
    { from.findViewTreeViewModelStoreOwner()?.let { to.setViewTreeViewModelStoreOwner(it) } },
    { from.findViewTreeSavedStateRegistryOwner()?.let { to.setViewTreeSavedStateRegistryOwner(it) } },
    { from.findViewTreeOnBackPressedDispatcherOwner()?.let { to.setViewTreeOnBackPressedDispatcherOwner(it) } },
    { from.findViewTreeFullyDrawnReporterOwner()?.let { to.setViewTreeFullyDrawnReporterOwner(it) } },
)

/** Runs every step; one whose library is missing at run time (a [LinkageError]) is skipped and the
 *  rest still run. Any other failure propagates. */
internal fun runEachLinked(vararg steps: () -> Unit) {
    for (step in steps) {
        try { step() } catch (_: LinkageError) { /* that owner's library is not in this app */ }
    }
}
