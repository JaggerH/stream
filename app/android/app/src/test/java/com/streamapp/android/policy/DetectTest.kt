package com.streamapp.android.policy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The word tables and label detection: hits and misses in the eleven UI languages, the
 *  exclusions that keep sort menus and prices out, and the conservative fallback. */
class DetectTest {
    private lateinit var d: Detect

    @Before fun setUp() {
        d = Detect(Words.load { java.io.File("src/main/assets/$it").inputStream() })
    }

    private fun commit(label: String) = d.isCommitLabel(label)
    private fun money(label: String) = d.commitParts(label).second

    @Test fun englishHits() {
        assertTrue(commit("Pay now"))
        assertTrue(commit("Place order"))
        assertTrue(commit("Delete this chat"))
        assertTrue(commit("Check out"))
        assertTrue(commit("Withdraw funds"))
        assertTrue(money("Pay now"))
        assertTrue(money("Place order"))
        assertFalse(money("Delete this chat"))
    }

    @Test fun simplifiedChineseCjkPrefixes() {
        assertTrue(commit("确认收货"))
        assertTrue(commit("立即还款"))
        assertTrue(commit("去结算"))
        assertTrue(commit("提交订单"))
        assertTrue(commit("转账给 张三"))
        assertTrue(money("立即还款"))
        assertTrue(money("确认收货").not())
    }

    @Test fun traditionalChinese() {
        assertTrue(commit("結帳"))
        assertTrue(commit("傳送訊息"))
        assertTrue(commit("刪除帳號"))
        assertTrue(commit("立即還款"))
    }

    @Test fun japanese() {
        assertTrue(commit("送信"))
        assertTrue(commit("お支払い"))
        assertTrue(commit("削除する"))
        assertTrue(commit("注文を確定"))
        assertTrue(money("お支払い"))
    }

    @Test fun korean() {
        assertTrue(commit("결제하기"))
        assertTrue(commit("보내기"))
        assertTrue(commit("삭제"))
        assertTrue(commit("주문하기"))
    }

    @Test fun spanish() {
        assertTrue(commit("Enviar"))
        assertTrue(commit("Pagar ahora"))
        assertTrue(commit("Eliminar cuenta"))
        assertTrue(commit("Finalizar compra"))
    }

    @Test fun french() {
        assertTrue(commit("Envoyer"))
        assertTrue(commit("Payer"))
        assertTrue(commit("Supprimer"))
        assertTrue(commit("Passer commande"))
    }

    @Test fun german() {
        assertTrue(commit("Jetzt kaufen"))
        assertTrue(commit("Senden"))
        assertTrue(commit("Löschen"))
        assertTrue(commit("Bezahlen"))
    }

    @Test fun portuguese() {
        assertTrue(commit("Enviar"))
        assertTrue(commit("Pagar"))
        assertTrue(commit("Finalizar pedido"))
        assertTrue(commit("Excluir conta"))
    }

    @Test fun italian() {
        assertTrue(commit("Invia"))
        assertTrue(commit("Paga ora"))
        assertTrue(commit("Elimina"))
        assertTrue(commit("Procedi all'acquisto"))
    }

    @Test fun russian() {
        assertTrue(commit("Отправить"))
        assertTrue(commit("Оплатить"))
        assertTrue(commit("Удалить"))
        assertTrue(commit("Оформить заказ"))
    }

    @Test fun installAndCallAndSettingDirections() {
        assertTrue(d.isInstallLabel("Install"))
        assertTrue(d.isInstallLabel("安装"))
        assertTrue(d.isInstallLabel("Update app"))
        assertTrue(d.isInstallLabel("$4.99")) // a price alone buys an app in a store
        assertTrue(d.isCallLabel("Call mom"))
        assertTrue(d.isCallLabel("呼叫 张三"))
        assertTrue(d.isCallLabel("Video call"))
        assertTrue(d.isCallLabel("позвонить"))
        assertTrue(d.isSettingLabel("Remove device"))
        assertTrue(d.isSettingLabel("Forget this network"))
        assertTrue(d.isSettingLabel("Reset network settings"))
    }

    @Test fun slideToPay() {
        assertTrue(commit("Slide to pay"))
        assertTrue(commit("Swipe to confirm"))
        assertTrue(money("Slide to pay"))
    }

    @Test fun affirmativeAfterCommitVerb() {
        assertTrue(commit("Yes, delete"))
        assertTrue(commit("OK, send it"))
    }

    @Test fun exclusionsDoNotFire() {
        assertFalse(commit("Order history"))
        assertFalse(commit("sort by"))
        assertFalse(commit("Order by date"))
        assertFalse(commit("Payment methods"))
        assertFalse(commit("Tracking"))
        assertFalse(commit("send to back"))
        assertFalse(commit("Book mark"))
        assertTrue(d.isPlaceLabel("Order history"))
        // 「确认收货」 must not be eaten by the 记录 negative: it is a commit.
        assertTrue(commit("确认收货"))
    }

    @Test fun longParagraphIsNotAButton() {
        val paragraph = "Send us your feedback about the app and we will get back to you within three business days, thanks a lot"
        assertFalse(commit(paragraph))
        // Numbers do not count towards the length: 「立即支付 ¥12.80」 stays a button.
        assertTrue(commit("立即支付 ¥12.80"))
        assertTrue(commit("Place order · 12.80"))
    }

    @Test fun cancellationIsNotACommit() {
        assertFalse(commit("取消"))
        assertFalse(commit("Cancel"))
        assertFalse(commit("キャンセル"))
        assertFalse(commit("취소"))
        assertFalse(commit("Abbrechen"))
        assertFalse(commit("Отмена"))
    }

    @Test fun dialogQuestionMentionsCommit() {
        assertTrue(d.mentionsCommit("Delete this message?"))
        assertTrue(d.mentionsCommit("确认要删除这条消息吗？"))
        assertTrue(d.isQuestion("Delete this message?"))
        assertTrue(d.isQuestion("要删除吗？"))
        assertFalse(d.mentionsCommit("Your package is on the way"))
    }

    // ---- credential fields -----------------------------------------------------------

    private fun cred(isPassword: Boolean, label: String, viewId: String = "") =
        d.isCredentialField(isPassword, label, viewId)

    @Test fun passwordFieldByStateOrByWords() {
        assertTrue(cred(true, "", ""))
        assertTrue(cred(false, "Password", ""))
        assertTrue(cred(false, "密码", ""))
        assertTrue(cred(false, "Пароль", ""))
        assertTrue(cred(false, "비밀번호", ""))
        assertTrue(cred(false, "パスワード", ""))
        assertTrue(cred(false, "passcode", ""))
        assertTrue(cred(false, "", "com.bank:id/password_input"))
        assertTrue(cred(false, "", "com.app:id/passwort"))
    }

    @Test fun otpFieldsByWordsAndTokens() {
        assertTrue(cred(false, "验证码", ""))
        assertTrue(cred(false, "Verification code", ""))
        assertTrue(cred(false, "認証コード", ""))
        assertTrue(cred(false, "인증번호", ""))
        assertTrue(cred(false, "SMS code", ""))
        assertTrue(cred(false, "", "com.app:id/otp_edit"))
        assertTrue(cred(false, "PIN", ""))
        assertTrue(cred(false, "", "com.app:id/pin_code"))
        assertTrue(cred(false, "código de verificación", ""))
    }

    @Test fun otpExclusionsKeepPromoAndPostalCodes() {
        assertFalse(cred(false, "Promo code", ""))
        assertFalse(cred(false, "Postal code", ""))
        assertFalse(cred(false, "ZIP code", ""))
        assertFalse(cred(false, "邀请码", ""))
        assertFalse(cred(false, "邮编", ""))
        assertFalse(cred(false, "Coupon code", ""))
        assertFalse(cred(false, "Area code", ""))
    }

    @Test fun searchFieldsAreNotCredentialAndNotCommit() {
        assertFalse(cred(false, "搜索商家或商品", ""))
        assertTrue(d.isSearchLabel("搜索商家或商品"))
        assertTrue(d.isSearchField("搜索商家或商品", ""))
        assertTrue(d.isSearchLabel("Search"))
        assertFalse(commit("搜索"))
    }

    @Test fun codeContextAndDigitRuns() {
        assertTrue(d.isCodeContext("您的验证码是 482913"))
        assertTrue(d.isCodeContext("Your verification code is 482913"))
        assertFalse(d.isCodeContext("Order number 482913"))
        assertFalse(d.isCodeContext("订单号 482913"))
        assertFalse(d.isCodeContext("Promo code 482913"))
        assertFalse(d.isCodeContext("价格 ¥4829.13"))
    }
}
