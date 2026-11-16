/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Username бота без @ - для ссылки «Открыть в Telegram» на страницах вне Telegram. Необязательно. */
  readonly VITE_BOT_USERNAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
