# OpenPong domain service — the vendored OmniPong FastAPI backend (Apache-2.0).
#
# It owns ratings, matches, tournaments, league sync and the inbound SMS webhook.
# League sync and tournament signup drive a real browser, so this image bakes
# Playwright's Chromium (plus its system libraries) in. That is exactly why this
# service cannot run on Cloudflare Workers: there is no Chromium there.
#
# Run it on a VM, a Docker host, or a Render private service. See docs/DEPLOY.md.
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    # SQLite file lives under /data so a volume can persist it.
    OMNIPONG_DB=/data/omnipong.db \
    # Keep the downloaded browsers in one predictable, cacheable directory.
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Dependencies first so edits to the app do not re-download the world.
COPY requirements.txt ./
RUN pip install --upgrade pip && pip install --no-cache-dir -r requirements.txt

# Playwright's bundled Node driver needs libatomic1, which python:slim omits;
# without it the driver fails to start before --with-deps can install anything.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libatomic1 \
    && rm -rf /var/lib/apt/lists/*

# Chromium and every apt package it needs. `--with-deps` installs the OS
# libraries; the browser build lands in PLAYWRIGHT_BROWSERS_PATH above.
RUN python -m playwright install --with-deps chromium

COPY . .

# SQLite (OMNIPONG_DB) is written here; mount a volume to persist it. Playwright
# profiles default to ./playwright_data relative to WORKDIR (/app) and should be
# persisted too so scraper logins survive a restart.
RUN mkdir -p /data

EXPOSE 8000

# Bind 0.0.0.0 so the container is reachable from the compose network / Render
# private network. Local `pnpm dev:omnipong` uses 127.0.0.1:8000 instead.
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
