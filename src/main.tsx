import { render } from 'preact'
import { restoreSession } from './store.ts'
import { App } from './ui/App.tsx'
import './styles.css'

// Внутри чужого фрейма не работаем: заголовок frame-ancestors мета-тегом не задать.
if (window.top !== window.self) {
  document.body.textContent = 'Трекер нельзя открыть внутри другого сайта.'
} else {
  render(<App />, document.getElementById('app')!)
  void restoreSession()
}
