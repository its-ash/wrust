# wrust

Production-grade browser P2P file sharing (AirDrop-style) with:

- Rust/WASM for frontend transfer logic (`/wasm`)
- Cloudflare Worker + Durable Objects in Rust for signaling (`/worker`)
- WebRTC DataChannels for direct peer-to-peer transfer
- Shared protocol crate (`/shared`)
- Vite frontend (`/frontend`)

## Architecture

- Worker is signaling/discovery only.
- File bytes never go through the Worker.
- Durable Object stores session state (`session_id -> sender/receivers/metadata/pin/expiry`).
- Browser peers negotiate WebRTC via Worker WebSocket relay.
- DataChannel carries metadata + chunk packets + resume hints/acks.

## Features Implemented

- `Send` and `Browse` entry flows
- Session creation with short code + QR code
- Optional PIN protection
- Durable Object session lifecycle + expiry alarm cleanup
- Multi-receiver support (sender approval per receiver)
- WebRTC offer/answer/ICE relay via worker signaling
- Binary chunk protocol (~64KB adaptive baseline)
- Backpressure-aware DataChannel send loop
- Resume support (chunk-index offsets persisted in localStorage)
- Presence list (`/api/presence`) with network hint filtering
- Image/video preview before download
- Mobile-responsive UI

## Project Layout

- `frontend/` UI + WebRTC orchestration
- `wasm/` Rust -> WASM transfer utilities
- `worker/` Cloudflare signaling server in Rust
- `shared/` protocol types used by Rust crates

## Local Development

### 1. Prerequisites

- Rust stable
- `wasm-pack`
- Node.js 20+
- Cloudflare Wrangler (`npm i -g wrangler`)

### 2. Build/check Rust

```bash
cargo fmt --all
cargo clippy --all-targets --all-features
cargo check
```

### 3. Build WASM package for frontend

```bash
wasm-pack build wasm --target web --out-dir ../frontend/src/wasm_pkg --out-name wrust_wasm
```

### 4. Run frontend

```bash
cd frontend
npm install
npm run dev
```

By default frontend uses `window.location.origin` for signaling. To point at deployed Worker:

```bash
# frontend/.env.local
VITE_SIGNAL_BASE=https://your-worker.your-subdomain.workers.dev
```

### 5. Run worker locally

```bash
cd worker
wrangler dev
```

## Deploy

### Deploy signaling Worker

1. Deploy:

```bash
cd worker
wrangler deploy
```

The Worker deploys without KV by default. Session signaling still works; only public presence listing (`GET /api/presence`) is disabled until KV is configured.

To enable KV-backed presence:

```bash
cd worker
wrangler kv namespace create SESSIONS_KV
wrangler kv namespace create SESSIONS_KV --preview
```

Then add the returned IDs to `worker/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SESSIONS_KV"
id = "<prod_namespace_id>"
preview_id = "<preview_namespace_id>"
```

### Deploy frontend to Cloudflare Pages

1. Build WASM package first (`wasm-pack ...` above).
2. Build frontend:

```bash
cd frontend
npm ci
npm run build
npx wrangler pages deploy dist --project-name wrust-frontend
```

3. Deploy `frontend/dist` to Cloudflare Pages.
4. Set `VITE_SIGNAL_BASE` to Worker URL in Pages environment.

## API Summary

- `POST /api/session`
  - creates session (returns `{session_id, expires_in, ws_url}`)
- `POST /api/session/join`
  - validates join + PIN, returns receiver WebSocket URL
- `GET /api/presence?network_hint=...`
  - optional public session listing
- `GET /ws/:session_id`
  - WebSocket proxy into Durable Object signaling session

## Notes

- DTLS/SRTP encryption is provided by WebRTC transport by default.
- You can add TURN credentials to ICE config in `frontend/src/webrtc.ts` for stricter NAT environments.
- Worker never stores file contents.
