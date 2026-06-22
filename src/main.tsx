import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import faviconUrl from './assets/gb_encurtado.png'

// Aponta o <link id="favicon"> do index.html pro logo Gaviões (asset processado pelo Vite)
const favicon = document.getElementById('favicon') as HTMLLinkElement | null;
if (favicon) favicon.href = faviconUrl;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
