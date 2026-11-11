# Canvas

Single-account terminal canvas for existing herdr windows.

- Use Node.js 24+, npm, TypeScript, Vue 3, VueFlow and xterm.js.
- Canvas connects directly to herdr sockets. Herdr owns pane layout and runtime.
- Canvas is not yet in production use. Keep the implementation clean; do not add compatibility layers or data migrations.
- Never attach tests to real user sessions. Use isolated sockets and synthetic data.
- Place unit tests beside their modules; keep server integration tests in `server/`.
- Keep application code and native tests here; private operational notes and environment E2E live in the owning operations repository.
- Run `npm run check` (format, lint, types, unused code, tests) and `npm run build` before delivery.
- Format with Prettier (`npm run format`); never hand-compress code onto long lines.
- Frontend layout, under `web/src`: `app` (entry, router, shell), `views` (routed pages), `stores`
  (Pinia: session, workspace, edits, shell, view), `canvas/scene` (one module per canvas concern,
  joined by `createCanvasScene`), then one folder per domain (`terminal`, `notes`, `files`,
  `workspace`, `instances`, `notifications`, `settings`), `lib` (domain-free helpers) and
  `components` (shared presentational parts).
- Build UI from stock Nuxt UI components and `i-lucide-*` icons. Write a custom widget only where
  none fits (the terminal, the canvas graph, the mobile key deck).
- Raise notices through `lib/notify`; every notice dismisses itself.
- Have an independent agent review each change for best practices, simplicity and related inconsistencies before delivery.
- Keep credentials and runtime databases outside the checkout.
