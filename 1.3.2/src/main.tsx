import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import AppSlim from './slim/AppSlim'
import './styles/main.scss'

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <HashRouter>
      <AppSlim />
    </HashRouter>
  </React.StrictMode>
)
