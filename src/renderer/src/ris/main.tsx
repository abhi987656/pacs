import { createRoot } from 'react-dom/client'
import { UiProvider } from '../common/ui'
import { App } from './App'
import '../styles/base.css'
import '../styles/ris.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <UiProvider>
    <App />
  </UiProvider>
)
