# Matchy Campus — web app

React 19 + Vite + Redux Toolkit + Tailwind 4. The copilot chat is on the left; the workspace on the right
changes through **UI actions** (copilot tool results, legacy agent headers, notification clicks, deep links
and the user's own clicks — see `docs/contracts/UI-ACTIONS.md` and `docs/contracts/FRONTEND.md`).

## Run

```bash
cp .env.example .env      # defaults call the API on the same origin through the Vite proxy
npm run dev               # http://localhost:5173 (proxies /api and /socket.io to VITE_DEV_BACKEND_URL)
npm run build             # production bundle in dist/
npm run lint
npm test                  # node --test test/ (pure modules: workspace registry, UI actions, store, API clients)
```

Phones on the same Wi-Fi (camera QR scanner, geolocation and web push need HTTPS):

```bash
npm run cert              # once: self-signed certificate in .cert/
npm run dev:lan           # https://<LAN-IP>:5173
```

## Environment (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `VITE_API_BASE_URL` | empty | Backend origin without `/api/v1`; empty = same origin |
| `VITE_DEV_BACKEND_URL` | `http://127.0.0.1:8000` | Dev-proxy target for `/api` and `/socket.io` |
| `VITE_GOOGLE_CLIENT_ID` | empty | Google sign-in client id (= backend `CLIENT_ID`); empty hides the button |
| `VITE_APP_NAME` | `Matchy Campus` | Product name in the UI and tab title |

## Routes

`/` app shell · `/attend?s=&t=` attendance QR deep link · `/present/:sessionId` presenter QR ·
`/reset-password/:token[?invite=1]` · `/report-issue`. Production hosting must serve `index.html` for every
non-asset path, and the backend `FRONTEND_URL` must be the origin phones open.

## Layout

- `src/workspace/` — panel registry (`panels.js`), role → modes (`modes.js`), `applyUiActions`/`openPanel`,
  header routing, deep links, the workspace view and the lazy feature-panel registry (`featurePanels.js`).
- `src/ui/` — shared stark UI kit (Panel, Modal, ConfirmDialog, Tabs, toasts, `useAsync`, formatters).
- `src/features/` — auth/session, notifications (+ web push via `public/sw.js`), help, and the feature areas.
- `src/lib/` — `http.js` (shared axios client), `socket.js`/`realtime.js`, `config.js`, `storage.js`, `api/*` clients.
