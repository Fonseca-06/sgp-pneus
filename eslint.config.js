import js from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['node_modules/**', 'coverage/**'] },

  // Código servido ao navegador: script clássico, sem módulos.
  {
    files: ['app.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        supabase: 'readonly',
        // Handlers publicados como window.X e chamados por onclick no HTML
        // gerado — o ESLint não enxerga a atribuição via window.
        abrirFicha: 'readonly', abrirPedido: 'readonly', addItemPedido: 'readonly',
        editarCliente: 'readonly', editarProduto: 'readonly', escolherClientePedido: 'readonly',
        filtrarRadar: 'readonly', novoPedidoDoCliente: 'readonly', removerItem: 'readonly',
        setDescItem: 'readonly', setQtdItem: 'readonly', toggleCliente: 'readonly',
        toggleFornecedor: 'readonly', transicionar: 'readonly', trocarClientePedido: 'readonly'
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
      // O BOM do Excel é removido por regex literal em parseCSV — legítimo.
      'no-irregular-whitespace': ['error', { skipRegExps: true, skipStrings: true }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'no-implicit-globals': 'off'
    }
  },

  // Testes e scripts de apoio: Node, ESM.
  {
    files: ['test/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js', 'vitest.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'none' }]
    }
  }
]
