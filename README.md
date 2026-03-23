# Portal Brahim

`portal-brahim` is a small local dashboard that discovers running Docker containers with published TCP ports and exposes them as clickable app cards.

## What it does

- reads the Docker API from the mounted socket
- lists running containers with likely web-facing ports
- links each app to `http://localhost:<published-port>`
- loads the latest apps when the page is opened or refreshed

## Run it

```bash
docker compose up -d --build
```

Then open `http://localhost:3200`.

## How discovery works

The server queries `/containers/json` from the local Docker socket and keeps only running containers that publish TCP ports commonly used by web apps, plus most host ports from `3000` to `9999`.

## Current apps detected on this machine

At the time of implementation, your Docker daemon exposed these app ports:

- `finance-situation-finance-situation-1` -> `http://localhost:3001`
- `sos-medecin-telegram-helper` -> `http://localhost:8787`
- `paycheck-chat-frontend` -> `http://localhost:3010`
- `paycheck-chat-backend` -> `http://localhost:8000`
