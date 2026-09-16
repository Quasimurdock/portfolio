/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface ImportMetaEnv {
  readonly VITE_API_TARGET?: string
  readonly VITE_SITE_NAME?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
