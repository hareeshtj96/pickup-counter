/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL for API calls. Defaults to "/api" (proxied by the Vite dev server). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
