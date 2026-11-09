package com.streamapp.android.policy

import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStream

/**
 * The word tables behind sensitive-action detection, shipped as a data file with the app
 * (`assets/policy/words.json`) and loaded once per process; no runtime hot reload. The tables
 * cover the eleven UI languages the app ships, and the commit, money, install, call, setting,
 * password and one-time-code tables are taken from the Pinky project (Apache-2.0), credited in
 * NOTICE and THIRD-PARTY-NOTICE.
 *
 * A false positive costs one extra approval; a false negative lets a commit through, so the
 * tables lean towards matching.
 */
class Words(o: JSONObject) {
    private val e = { key: String -> strings(o.optJSONArray(key) ?: JSONArray()) }
    private val s = { key: String -> (e(key)).toSet() }

    val commitVerbs = s("commitVerbs")
    val commitPhrases = e("commitPhrases")
    /** Sort-menu shapes that start with a commit verb but are not commits: "Order history". */
    val excludedStarts = e("excludedStarts")
    val slideVerbs = s("slideVerbs")
    val cjkCommitPrefixes = e("cjkCommitPrefixes")
    val moneyWords = s("moneyWords")
    val moneyPhrases = e("moneyPhrases")
    val cjkMoneyKeywords = e("cjkMoneyKeywords")
    val negativeWords = s("negativeWords")
    val cjkNegatives = e("cjkNegatives")
    val affirmativeWords = s("affirmativeWords")
    val cjkAffirmatives = e("cjkAffirmatives")
    val installVerbs = s("installVerbs")
    val cjkInstallPrefixes = e("cjkInstallPrefixes")
    val callWords = s("callWords")
    val callPhrases = e("callPhrases")
    val cjkCallPrefixes = e("cjkCallPrefixes")
    val settingVerbs = s("settingVerbs")
    val searchWords = e("searchWords")
    val passwordWords = e("passwordWords")
    val otpWords = e("otpWords")
    val otpTokens = e("otpTokens").toSet()
    val otpNegatives = e("otpNegatives")
    val notCodePhrases = e("notCodePhrases")
    val cjkCodeKeywords = e("cjkCodeKeywords")
    val currencyWords = s("currencyWords")
    val unitWords = s("unitWords")
    val monthWords = s("monthWords")
    /** Labels that name giving up rather than going ahead: they start like buttons but are not commits. */
    val cancelWords = e("cancelWords")
    val cjkCancelPrefixes = e("cjkCancelPrefixes")
    val currencySigns = o.getString("currencySigns")
    val unitRunes = o.getString("unitRunes")

    companion object {
        /** [open] maps an asset path to its stream: `assets` in the app, the source tree in tests. */
        fun load(open: (String) -> InputStream): Words =
            Words(JSONObject(open("policy/words.json").bufferedReader().readText()))

        private fun strings(a: JSONArray) = (0 until a.length()).map { a.getString(it) }
    }
}
