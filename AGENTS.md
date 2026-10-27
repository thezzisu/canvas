# Canvas

Single-account terminal canvas for existing herdr and tmux windows.

- Use Node.js 24+, npm, TypeScript, Vue 3, VueFlow and xterm.js.
- Canvas transports native clients over PTYs. Pane rendering belongs to providers.
- Never attach tests to real user sessions. Use isolated sockets and synthetic data.
- Keep application code and native tests here; private operational notes and environment E2E live in the owning operations repository.
- Run `npm run typecheck`, `npm test`, and `npm run build` before delivery.
- Keep credentials and runtime databases outside the checkout.
