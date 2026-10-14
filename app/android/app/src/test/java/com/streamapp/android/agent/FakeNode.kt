package com.streamapp.android.agent

data class FakeNode(
    override val role: String,
    override val name: String = "",
    override val className: String = "android.widget.$role",
    override val text: String = name,
    override val rect: Rect = Rect(0, 0, 10, 10),
    override val children: List<UiNode> = emptyList(),
) : UiNode

fun n(role: String, name: String = "", vararg kids: UiNode) = FakeNode(role, name, children = kids.toList())
