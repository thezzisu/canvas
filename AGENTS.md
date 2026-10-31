# Canvas

Single-account terminal canvas for existing herdr windows.

- Use Node.js 24+, npm, TypeScript, Vue 3, VueFlow and xterm.js.
- Canvas connects directly to herdr sockets. Herdr owns pane layout and runtime.
- Canvas is not yet in production use. Keep the implementation clean; do not add compatibility layers or data migrations.
- Never attach tests to real user sessions. Use isolated sockets and synthetic data.
- Place unit tests beside their modules; keep server integration tests in `server/`.
- Keep application code and native tests here; private operational notes and environment E2E live in the owning operations repository.
- Run `npm run typecheck`, `npm test`, and `npm run build` before delivery.
- Keep credentials and runtime databases outside the checkout.
