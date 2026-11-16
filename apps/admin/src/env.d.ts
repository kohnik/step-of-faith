interface ImportMetaEnv {
  /** Username бота без @ - для кнопки «Открыть бота» на странице входа (необязательно). */
  readonly VITE_BOT_USERNAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
