import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root，页面无法挂载')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
