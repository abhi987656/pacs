import { createRoot } from 'react-dom/client'
import { UiProvider } from '../common/ui'
import { App } from './App'
import { AccessGate } from './AccessGate'
import '../styles/base.css'
import '../styles/ris.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <UiProvider>
    <AccessGate>
      <App />
    </AccessGate>
  </UiProvider>
)
