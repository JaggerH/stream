package com.streamapp.android.policy

import com.streamapp.android.agent.Rect
import com.streamapp.android.agent.UiNode
import java.util.Locale

/**
 * Label detection over the word tables: whether a button label commits, moves money, installs,
 * calls, changes a setting, and whether a field takes a password or a one-time code. Latin and
 * Cyrillic labels are matched word by word; labels in scripts without spaces (Chinese, Japanese,
 * Korean) by prefix after punctuation, digits and prices are removed. Structure (a clickable
 * button, a password field) is checked by the caller and outweighs the tables; unrecognized
 * commit-shaped labels still gate through the conservative fallback.
 */
class Detect(private val w: Words) {
    val commitPhrases = w.commitPhrases.map { tokenize(it) }
    val excludedStarts = w.excludedStarts.map { tokenize(it) }
    val moneyPhrases = w.moneyPhrases.map { tokenize(it) }
    val callPhrases = w.callPhrases.map { tokenize(it) }
    private val cancelSingles = w.cancelWords.filter { !it.contains(' ') }.toSet()
    private val cancelPhrases = w.cancelWords.filter { it.contains(' ') }.map { tokenize(it) }

    // ---- normalization ---------------------------------------------------------------

    /** Lower-case words of letters and digits, keeping in-word apostrophes and hyphens. */
    fun tokenize(text: String): List<String> {
        val out = mutableListOf<String>()
        val b = StringBuilder()
        val rs = text.lowercase(Locale.ROOT).toCharArray()
        fun flush() { if (b.isNotEmpty()) { out += b.toString(); b.clear() } }
        for ((i, r) in rs.withIndex()) {
            when {
                r.isLetterOrDigit() || type(r) == java.lang.Character.NON_SPACING_MARK.toInt() -> b.append(r)
                (r == '\'' || r == '’' || r == '-') && b.isNotEmpty() && i + 1 < rs.size && rs[i + 1].isLetter() -> {
                    b.append(if (r == '’') '\'' else r)
                }
                else -> flush()
            }
        }
        flush()
        return out
    }

    /** Words of a label without numbers, so prices and counts do not count towards its length. */
    fun labelWords(label: String) = tokenize(label).filter { !isNumber(it) }

    private fun isNumber(t: String) = t.isNotEmpty() && t.all { it.isDigit() }

    fun hasCJK(s: String) = s.any {
        val sc = Character.UnicodeScript.of(it.code)
        sc == java.lang.Character.UnicodeScript.HAN || sc == java.lang.Character.UnicodeScript.HIRAGANA ||
            sc == java.lang.Character.UnicodeScript.KATAKANA || sc == java.lang.Character.UnicodeScript.HANGUL
    }

    private fun type(r: Char): Int = Character.getType(r).toInt()
    private val punctRange = Character.DASH_PUNCTUATION.toInt()..Character.OTHER_PUNCTUATION.toInt()
    private val quotePunct = intArrayOf(Character.INITIAL_QUOTE_PUNCTUATION.toInt(), Character.FINAL_QUOTE_PUNCTUATION.toInt())
    private val symbolRange = Character.MATH_SYMBOL.toInt()..Character.OTHER_SYMBOL.toInt()
    private val currencySymbol = Character.CURRENCY_SYMBOL.toInt()
    private fun isPunct(r: Char): Boolean = type(r) in punctRange || type(r) in quotePunct
    private fun isSymbol(r: Char): Boolean = type(r) in symbolRange || type(r) == currencySymbol

    /** A CJK label without whitespace, punctuation, symbols and digits: 「去结算(3)」→「去结算」. */
    fun cjkCore(s: String) = buildString {
        for (r in s) {
            if (r.isWhitespace() || isPunct(r) || isSymbol(r) || r.isDigit()) continue
            append(r.lowercaseChar())
        }
    }

    // ---- commit ---------------------------------------------------------------------

    private fun startsWithPhrase(ws: List<String>, ps: List<List<String>>) =
        ps.any { p -> p.size <= ws.size && ws.subList(0, p.size) == p }

    private fun startsWithPhrase(ws: List<String>, from: Int, ps: List<List<String>>) =
        ps.any { p -> p.size <= ws.size - from && ws.subList(from, from + p.size) == p }

    private fun containsPhrase(ws: List<String>, ps: List<List<String>>) =
        ps.any { p -> (0..ws.size - p.size).any { ws.subList(it, it + p.size) == p } }

    private fun containsAny(s: String, subs: List<String>) = subs.any { s.contains(it) }
    private fun hasPrefixAny(s: String, prefixes: List<String>) = prefixes.any { s.startsWith(it) }

    private val cjkJoints = listOf("并", "並", "して", "하고", "및")

    /** Whether a button label is a commit, in any supported language. */
    fun isCommitLabel(label: String): Boolean {
        if (label.isEmpty() || isDismissal(label)) return false
        if (hasCJK(label)) {
            val core = cjkCore(label)
            val runes = core.codePointCount(0, core.length)
            if (core.isEmpty() || runes > MAX_CJK_RUNES || containsAny(core, w.cjkNegatives)) return false
            if (hasPrefixAny(core, w.cjkCommitPrefixes)) return true
            // 「同意并支付」「確認して購入」: a commit after a conjunction.
            for (p in w.cjkCommitPrefixes) for (j in cjkJoints) if (core.contains(j + p)) return true
            // Mixed labels such as "Send 发送" fall through to the word check.
        }
        val ws = labelWords(label)
        if (ws.isEmpty() || ws.size > MAX_COMMIT_WORDS || ws.any { w.negativeWords.contains(it) }) return false
        if (startsWithPhrase(ws, excludedStarts)) return false
        if (startsWithPhrase(ws, commitPhrases)) return true
        if (w.commitVerbs.contains(ws[0])) return true
        // "Yes, delete", "OK, send it".
        if (w.affirmativeWords.contains(ws[0]) && ws.size >= 2 &&
            (w.commitVerbs.contains(ws[1]) || startsWithPhrase(ws, 1, commitPhrases))
        ) return true
        // "Slide to pay", "Swipe to confirm", "Tap to send".
        if (ws.size >= 3 && w.slideVerbs.contains(ws[0]) && ws[1] in listOf("to", "pour", "para", "zum") &&
            (w.commitVerbs.contains(ws[2]) || startsWithPhrase(ws, 2, commitPhrases))
        ) return true
        return false
    }

    /** Whether a label confirms a dialog: OK, Yes, 确定. */
    fun isAffirmative(label: String): Boolean {
        if (hasCJK(label)) {
            val core = cjkCore(label)
            return w.cjkAffirmatives.any { core == it }
        }
        val ws = labelWords(label)
        return ws.size in 1..2 && w.affirmativeWords.contains(ws[0])
    }

    /** Whether a label names giving up rather than going ahead: 取消, Back, Cancel — matched as a
     *  leading word or prefix, so "send it back" stays a commit. */
    fun isDismissal(label: String): Boolean {
        if (hasCJK(label) && hasPrefixAny(cjkCore(label), w.cjkCancelPrefixes)) return true
        val ws = labelWords(label)
        if (ws.isEmpty()) return false
        if (cancelSingles.contains(ws[0])) return true
        return startsWithPhrase(ws, cancelPhrases)
    }

    /** Whether a label names a place rather than an action: "Order history", 「订单明细」. */
    fun isPlaceLabel(label: String): Boolean {
        if (labelWords(label).any { w.negativeWords.contains(it) }) return true
        return hasCJK(label) && containsAny(cjkCore(label), w.cjkNegatives)
    }

    /** Whether a label marks a search control: 搜索, Find, Rechercher. */
    fun isSearchLabel(label: String) = containsAny(label.lowercase(Locale.ROOT), w.searchWords)

    /** Whether a sentence talks about a commit: "Delete this message?". */
    fun mentionsCommit(text: String): Boolean {
        if (hasCJK(text)) {
            val core = cjkCore(text)
            if (w.cjkCommitPrefixes.any { core.contains(it) }) return true
        }
        val ws = labelWords(text)
        return ws.indices.any { w.commitVerbs.contains(ws[it]) || startsWithPhrase(ws, it, commitPhrases) }
    }

    /** Whether a commit's label moves money by itself: pays, buys, sells, swaps, lends, borrows. */
    fun movesMoney(label: String): Boolean {
        if (hasCJK(label) && containsAny(cjkCore(label), w.cjkMoneyKeywords)) return true
        val ws = labelWords(label)
        return ws.any { w.moneyWords.contains(it) } || containsPhrase(ws, moneyPhrases)
    }

    /** Both halves of a commit judgment on one label. */
    fun commitParts(label: String): Pair<Boolean, Boolean> {
        val commit = isCommitLabel(label)
        return commit to (commit && movesMoney(label))
    }

    /** Install buttons in app stores and the system's package dialog. A price alone buys an app too. */
    fun isInstallLabel(label: String): Boolean {
        if (hasCJK(label)) return hasPrefixAny(cjkCore(label), w.cjkInstallPrefixes)
        val ws = labelWords(label)
        if (ws.isEmpty()) return hasCurrency(label)
        return ws.size <= MAX_COMMIT_WORDS && w.installVerbs.contains(ws[0])
    }

    /** Call buttons, by label. */
    fun isCallLabel(label: String): Boolean {
        if (hasCJK(label)) return hasPrefixAny(cjkCore(label), w.cjkCallPrefixes)
        val ws = labelWords(label)
        if (ws.isEmpty() || ws.size > MAX_COMMIT_WORDS) return false
        return w.callWords.contains(ws[0]) || startsWithPhrase(ws, callPhrases)
    }

    /** Buttons that change a setting, in the Settings app. */
    fun isSettingLabel(label: String): Boolean {
        val ws = labelWords(label)
        return ws.size in 1..MAX_COMMIT_WORDS && w.settingVerbs.contains(ws[0])
    }

    fun isQuestion(s: String): Boolean {
        val t = s.trim()
        return t.contains('?') || t.contains('？') || t.endsWith("吗") || t.endsWith("嗎") ||
            t.endsWith("か") || t.endsWith("까")
    }

    // ---- money on screen ------------------------------------------------------------

    private val cryptoTickers =
        "BTC|ETH|USDT|USDC|USDE|DAI|BNB|SOL|XRP|ADA|DOGE|TRX|TON|AVAX|DOT|MATIC|POL|LTC|BCH|SUI|APT|ARB|OP|ENA|WBTC|WETH|STETH|EURC|FDUSD|PYUSD|SATS"

    private val currencyRe = Regex(
        """(?:US\$|HK\$|NT\$|A\$|C\$|S\$|R\$|\$|€|£|¥|￥|₩|₹|₽|₺|₫|฿|₱|₪|CHF|USD|EUR|GBP|CNY|RMB|JPY|KRW|HKD|TWD|INR|RUB|AUD|CAD|SGD|BRL|MXN)\s?\d""" +
            """|\d(?:[\d.,\s]*\d)?\s?(?:€|元|円|원|₽|zł|kr|Kč|руб|USD|EUR|GBP|CNY|RMB|JPY|KRW|HKD|TWD|INR|RUB|AUD|CAD|SGD|BRL|MXN)""" +
            """|\b(?:$cryptoTickers)\s?\d|\d(?:[\d.,\s]*\d)?\s?(?:$cryptoTickers)\b""",
    )

    /** Whether s shows an amount of money. */
    fun hasCurrency(s: String) = currencyRe.containsMatchIn(s)

    /** Whether the screen around [root] shows an amount of money. */
    fun screenHasCurrency(root: UiNode): Boolean {
        var found = false
        fun walk(n: UiNode) {
            if (found) return
            if (hasCurrency(n.name)) { found = true; return }
            n.children.forEach(::walk)
        }
        walk(root)
        return found
    }

    // ---- fields ---------------------------------------------------------------------

    private val domainRe = Regex("""^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$""")

    /** Whether a link label is a web address. */
    fun looksLikeURL(s: String): Boolean {
        val t = s.trim()
        val l = t.lowercase(Locale.ROOT)
        if (l.contains("://") || l.startsWith("www.")) return true
        return !t.contains(' ') && !t.contains('\t') && domainRe.containsMatchIn(l)
    }

    /** Whether an input is a search box, by its label or resource id. */
    fun isSearchField(label: String, viewId: String): Boolean {
        val text = label.lowercase(Locale.ROOT) + " " + viewId.lowercase(Locale.ROOT)
        return containsAny(text, w.searchWords)
    }

    /** Whether typing into a field with these traits would hand a password or one-time code to the agent. */
    fun isCredentialField(isPassword: Boolean, label: String, viewId: String): Boolean {
        if (isPassword) return true
        val text = label.lowercase(Locale.ROOT) + " " + viewId.lowercase(Locale.ROOT).replace('_', ' ')
        if (containsAny(text, w.passwordWords)) return true
        if (containsAny(text, w.otpNegatives)) return false
        if (containsAny(text, w.otpWords)) return true
        return tokenize(text).any { w.otpTokens.contains(it) }
    }

    /** Whether a text is about a one-time code (an input's caption, a notification body), and so
     *  any long digit run in it is a code, not a price or an order number. */
    fun isCodeContext(text: String): Boolean {
        val lower = text.lowercase(Locale.ROOT)
        if (containsAny(lower, w.notCodePhrases)) return false
        if (containsAny(lower, w.otpWords) || containsAny(lower, w.passwordWords)) return true
        if (tokenize(lower).any { w.otpTokens.contains(it) }) return true
        return hasCJK(text) && containsAny(cjkCore(text), w.cjkCodeKeywords)
    }

    companion object {
        /** "Place order · $12.80" yes, a paragraph that happens to start with "Send" no. */
        const val MAX_COMMIT_WORDS = 6
        /** The same bound for labels without spaces. */
        const val MAX_CJK_RUNES = 14
    }
}
