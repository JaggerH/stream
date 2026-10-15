package com.streamapp.android.net

/** What the app says after the computer removed this phone; it outlives the stopped connection. */
const val REVOKED_STATUS = "这台手机已在电脑上被移除，请重新配对"

/**
 * The status line on the main page. Once unpaired, whatever the connection last said (已连接 …)
 * is stale: 取消配对 stops the service without it saying anything more.
 */
fun shownStatus(status: String, paired: Boolean): String =
    if (paired || status == REVOKED_STATUS) status else "未配对"
