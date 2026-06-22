import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Carrega TODO o .env (inclusive vars sem VITE_) p/ injetar o token do scraper
  // no proxy — assim o token NÃO vai pro bundle do navegador.
  const env = loadEnv(mode, process.cwd(), '')
  const SCRAPER_TARGET = env.SCRAPER_URL || 'http://localhost:8088'
  const SCRAPER_TOKEN = env.SCRAPER_TOKEN || ''
  return {
  plugins: [
    react(),
    VitePWA({
      // SW se atualiza sozinho: novo deploy → próxima visita já pega a versão nova.
      registerType: 'autoUpdate',
      // Assets estáticos (fora do bundle) que entram no precache do app shell.
      includeAssets: ['favicon-32x32.png', 'apple-touch-icon.png', 'icons/*.png'],
      manifest: {
        name: 'Gaviões 24h Dashboard',
        short_name: 'Gaviões',
        description: 'Painel de gestão Gaviões — membros, financeiro, marketing e comercial.',
        lang: 'pt-BR',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#141414',
        categories: ['business', 'productivity'],
        icons: [
          { src: 'icons/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precacheia o app shell (JS/CSS/HTML/ícones). Chunks pesados (recharts,
        // xlsx) são lazy — entram no limite abaixo só se couberem; senão carregam
        // da rede sob demanda (dashboard depende de dado ao vivo de qualquer jeito).
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        // SPA: navegações caem no index.html — MENOS as rotas de API/proxy, que
        // precisam ir sempre pra rede (dados frescos do servidor/EVO).
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/evo-api/, /^\/evo-integracao/, /^\/definir-senha/],
        runtimeCaching: [
          {
            // Google Fonts (CSS + arquivos) — cache longo, recurso estável.
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      // SW só em build/preview — não interfere no proxy/HMR do `vite dev`.
      devOptions: { enabled: false },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // Separa vendors estáveis em chunks próprios (mudam raramente → cache longo
        // do browser entre deploys). Libs pesadas usadas só em telas lazy (xlsx,
        // html2canvas, recharts) continuam em chunks lazy — manualChunks não as
        // torna eager, só dá nome/estabilidade ao chunk.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react-vendor';
          if (id.includes('framer-motion') || id.includes('motion-dom') || id.includes('motion-utils')) return 'motion-vendor';
          if (id.includes('recharts') || id.includes('/d3-') || id.includes('victory-vendor')) return 'charts-vendor';
          if (id.includes('lucide-react')) return 'icons-vendor';
        },
      },
    },
  },
  server: {
    proxy: {
      // Scraper EVO5 (conta web) — fonte de dados quando não há API de integração.
      // Injeta o Authorization: Bearer aqui, então o token não vai pro bundle.
      '/scraper': {
        target: SCRAPER_TARGET,
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/scraper/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (SCRAPER_TOKEN) proxyReq.setHeader('Authorization', `Bearer ${SCRAPER_TOKEN}`);
          });
        },
      },
      // Mini-backend local (convites + /api/history). Suba com: node server/index.mjs
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/evo-api': {
        target: 'https://evo-integracao-api.w12app.com.br',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/evo-api/, ''),
      },
      '/evo-integracao': {
        target: 'https://evo-integracao.w12app.com.br',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/evo-integracao/, ''),
      },
    },
  },
  }
})
