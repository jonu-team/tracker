import { signal } from '@preact/signals'

/** Режим редактора текстов: визуальный или markdown. Запоминается в браузере. */
export type EditorMode = 'visual' | 'markdown'

const MODE_KEY = 'tracker.editorMode'

export const editorMode = signal<EditorMode>(localStorage.getItem(MODE_KEY) === 'markdown' ? 'markdown' : 'visual')

export function setEditorMode(mode: EditorMode): void {
  editorMode.value = mode
  localStorage.setItem(MODE_KEY, mode)
}
