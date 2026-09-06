/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_GOOGLE_CLIENT_ID: string;
  readonly VITE_MAX_ZIP_SIZE_MB?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
