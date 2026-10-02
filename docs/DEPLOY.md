# Deploying Sky on Cloudflare

Sky has two parts, and only one of them fits inside Cloudflare Workers:

| Part | Where it runs |
| --- | --- |
| **Web app** (`web/`) plus a small Worker (`web/worker/index.ts`) | Cloudflare Workers, with static assets. Free tier is enough. |
| **Back end** (`server/`: Node 22, SQLite, Chromium for the Stars' browser, bubblewrap) | A machine that stays on: your computer, a VM or any container host, reached through a **Cloudflare Tunnel**. |

The Worker serves the app and passes `/api/*` and `/login` to the back end, so
the browser sees one address (no CORS, the sign-in cookie and the live event
stream just work).

## 1. Back end

Either follow "Run it all the time" in [`server/README.md`](../server/README.md), or use the container:

```
docker build -f server/Dockerfile -t sky .
docker run -d --name sky --restart unless-stopped -p 127.0.0.1:8787:8787 -v sky-data:/data \
  -e SKY_PASSWORD='a-long-password' \
  -e SKY_PUBLIC_URL='https://sky.<your-account>.workers.dev' \
  -e SKY_WEB_ORIGIN='https://sky.<your-account>.workers.dev' \
  -e ANTHROPIC_API_KEY=sk-ant-... sky
```

`SKY_PUBLIC_URL` and `SKY_WEB_ORIGIN` must be the address the Worker is served
from (the one people open), so the back end accepts the app's requests.

Give it a public address with a tunnel (free):

```
cloudflared tunnel --url http://localhost:8787      # quick, address changes on restart
# or a named tunnel on your own domain: cloudflared tunnel create sky && cloudflared tunnel route dns sky sky-api.example.com
```

## 2. Web app and Worker

```
cd web
npm install
npx wrangler login                                   # or set CLOUDFLARE_API_TOKEN (and CLOUDFLARE_ACCOUNT_ID)
npx wrangler deploy --var SKY_BACKEND_URL:https://sky-api.example.com   # builds first via `npm run deploy`
```

or set `SKY_BACKEND_URL` once in `web/wrangler.jsonc` and run `npm run deploy`.
`npm run deploy` builds with `vite build --mode cloudflare`, which sets
`VITE_SKYS_API_URL=` (same-origin). Without that variable the app falls back to
its built-in sample data and never talks to a back end.

Try it locally first: `npm run dev:worker` (set `SKY_BACKEND_URL` in `wrangler.jsonc` or pass `--var`).

## The Stars' browser

The back end opens Chromium on first use. It uses Playwright's own download if
present, otherwise a Chrome or Chromium it finds on the machine, and runs
headless when there is no display. If it still can't start, `GET /api/v1/browser`
(and the app) shows why. Fixes: `npx playwright install --with-deps chromium`,
or set `SKY_BROWSER_PATH` to a Chrome/Chromium binary.
