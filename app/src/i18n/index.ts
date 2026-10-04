import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import zh from './locales/zh'
import en from './locales/en'

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { zh, en },
    fallbackLng: 'zh',
    supportedLngs: ['zh', 'en'],
    ns: ['common'],
    defaultNS: 'common',
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'stream.lang',
    },
    interpolation: { escapeValue: false }, // React already escapes
    react: { useSuspense: false }, // resources are bundled — no async load
  })

export default i18n
