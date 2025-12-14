 import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: [
        'kitty-metro-icon-hello-kitty.svg',
        'kitty-metro-icon-maskable.svg',
        'apple-touch-icon-180x180.png',
        'pwa-64x64.png',
        'pwa-192x192.png',
        'pwa-512x512.png',
        'maskable-icon-512x512.png',
      ],
      filename: 'kitty-metro-sw.js',
      manifestFilename: 'kitty-metro-manifest.webmanifest',
      devOptions: {
        enabled: true,
        type: 'module',
        suppressWarnings: true,
      },
      manifest: {
        id: '/',
        scope: '/',
        name: 'Hello Kitty Метро Москва',
        short_name: 'Kitty Metro',
        description:
          'Розовое офлайн-приложение для построения маршрутов в московском метро во вселенной Hello Kitty.',
        theme_color: '#ff9ecb',
        background_color: '#ffe4f1',
        display: 'standalone',
        orientation: 'portrait-primary',
        lang: 'ru-RU',
        start_url: '/',
        icons: [
          {
            src: '/pwa-64x64.png',
            sizes: '64x64',
            type: 'image/png',
          },
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/kitty-metro-[name]-[hash].js',
        chunkFileNames: 'assets/kitty-metro-[name]-[hash].js',
        assetFileNames: 'assets/kitty-metro-[name]-[hash][extname]',
      },
    },
  },
})
