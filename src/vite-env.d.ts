/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Репозиторий с задачами в виде `owner/name`. */
  readonly VITE_TASKS_REPO?: string
  /** Префикс ключей задач: DEV → DEV-26. */
  readonly VITE_KEY_PREFIX?: string
  readonly VITE_APP_TITLE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
