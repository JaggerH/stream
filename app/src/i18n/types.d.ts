import 'i18next'
import type zh from './locales/zh'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: typeof zh
  }
}
