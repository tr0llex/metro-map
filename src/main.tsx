import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import ProdApp from './ProdApp.tsx'
import { installErrorReporter, recordError } from './utils/errorLog.ts'
import { trackEvent } from './utils/events.ts'

// Перехватчики ставим до рендера, чтобы поймать в том числе падения на старте.
installErrorReporter()

// Установка как приложения — единственный шаг воронки, о котором сервер не
// узнаёт никак: браузер ставит PWA из уже скачанного кеша, не спрашивая нас.
// Событие одноразовое, слушателя снимать незачем.
window.addEventListener('appinstalled', () => {
  trackEvent('pwa_install')
})

createRoot(document.getElementById('root')!, {
  // Ошибку, пойманную ErrorBoundary, React 19 отдаёт сюда. Так журнал получает
  // её, не трогая сам компонент ErrorBoundary.
  onCaughtError(error) {
    recordError('render', error)
  },
  onUncaughtError(error) {
    recordError('render', error)
  },
}).render(
  <StrictMode>
    <ProdApp />
  </StrictMode>,
)
