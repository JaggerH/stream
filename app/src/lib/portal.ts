// react-reverse-portal 2.3 ships class-component types built against @types/react 16,
// which React 19's stricter JSX typing rejects ("not a valid JSX element type") even
// though the components render fine. Re-export them as plain function components so
// callers get correct prop typing without the conflict.
import {
  InPortal as RawInPortal,
  OutPortal as RawOutPortal,
  createHtmlPortalNode,
  type HtmlPortalNode,
} from 'react-reverse-portal'
import type { FC, ReactNode } from 'react'

export const InPortal = RawInPortal as unknown as FC<{ node: HtmlPortalNode; children: ReactNode }>
export const OutPortal = RawOutPortal as unknown as FC<{ node: HtmlPortalNode }>
export { createHtmlPortalNode, type HtmlPortalNode }
