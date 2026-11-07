import { createRoot } from 'react-dom/client'
import { UiProvider } from '../common/ui'
import { ViewerApp } from './ViewerApp'
import '../styles/base.css'
import '../styles/viewer.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <UiProvider>
    <ViewerApp />
  </UiProvider>
)
