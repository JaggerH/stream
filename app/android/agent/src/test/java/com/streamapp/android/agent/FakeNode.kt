package com.streamapp.android.agent

internal data class FakeNode(
    override val role: String,
    override val name: String = "",
    override val className: String = "android.widget.$role",
    override val text: String = name,
    override val rect: Rect = Rect(0, 0, 10, 10),
    override val children: List<UiNode> = emptyList(),
    override val isPassword: Boolean = false,
    override val isEditable: Boolean = false,
    override val isClickable: Boolean = false,
    override val isScrollable: Boolean = false,
    override val viewId: String = "",
    override val hintText: String = "",
    override val isShowingHint: Boolean = false,
    override val isVisible: Boolean = true,
    override val scrollAxis: String? = null,
    override val scrollsForward: Boolean = isScrollable,
    override val scrollsBackward: Boolean = isScrollable,
    override val checked: Boolean? = null,
    override val range: RangeValue? = null,
    override val stateDescription: String = "",
) : UiNode

internal fun n(role: String, name: String = "", vararg kids: UiNode) = FakeNode(role, name, children = kids.toList())
