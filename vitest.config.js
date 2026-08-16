import { defineConfig } from 'vitest/config'

// Cada montarApp() sobe um JSDOM novo e avalia as ~1.600 linhas do app.js.
// Com os 3 arquivos de teste rodando em paralelo isso passa dos 5s padrão em
// máquina carregada — o gate falhava por sorteio, não por regressão.
export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    testTimeout: 30000,
    hookTimeout: 30000
  }
})
