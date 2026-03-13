# Process Audio

Cloud Run service for processing uploaded audio and YouTube-backed sermon audio for Upper Room Media.

## YouTube Extraction Model

The YouTube path now follows a strict access order:

1. `public_provider`
   Uses `yt-dlp` with the bgutil PO-token provider and no cookies.
2. `cookie_provider`
   Only used when the public path indicates auth is required and the RTDB cookie session is healthy.
3. `browser_fallback`
   Final authority when the public path is challenged or the cookie session is stale/challenged.

This is intentional. A Cloud Run IP challenge is not fixed by retrying `yt-dlp` more aggressively, and stale cookies are not a durable recovery path.

## What Changed

- Request-scoped YouTube access decisions are cached so one sermon request does not repeatedly probe YouTube after a known failure.
- Cookie metadata in RTDB now tracks validation state and a circuit breaker.
- Cookie stale/challenged failures open the breaker and skip further cookie attempts until rotation.
- Operational alerts now classify YouTube failures into:
  - `public_ip_or_reputation_block`
  - `cookie_session_stale`
  - `account_required_no_valid_session`
  - `browser_fallback_failed`
  - `provider_unhealthy`
- The service exposes `GET /healthz`.
- A local Docker validation loop now gates changes before deployment.

## Prerequisites

- Docker
- `pnpm`
- Google Cloud SDK
- A GCP project with the required service accounts and secrets

## Environment Variables

Core runtime:

- `GOOGLE_APPLICATION_CREDENTIALS`
- `PROCESS_AUDIO_BUCKET`
- `RUNTIME_ALERT_RECIPIENTS` or the Secret Manager binding used by deploy

YouTube extraction:

- `YTDLP_POT_PROVIDER_BASE_URL`
- `YOUTUBE_BROWSER_FALLBACK_URL`
- `YOUTUBE_BROWSER_FALLBACK_ENABLED`
- `YOUTUBE_BROWSER_FALLBACK_TIMEOUT_MS`
- `YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS=false`
- `YTDLP_CONCURRENT_FRAGMENTS=1`
- `YTDLP_COOKIE_HEALTHCHECK_ENABLED=true`
- `YOUTUBE_RETRY_DELAY_MS=1500`
- `YOUTUBE_PUBLIC_PROVIDER_MAX_ATTEMPTS=1`
- `YOUTUBE_COOKIE_PROVIDER_MAX_ATTEMPTS=1`
- `YOUTUBE_COOKIE_CIRCUIT_BREAKER_MINUTES=30`
- `YTDLP_SLEEP_REQUESTS_SECONDS`
- `YTDLP_SLEEP_INTERVAL_SECONDS`
- `YTDLP_MAX_SLEEP_INTERVAL_SECONDS`
- `YTDLP_JS_RUNTIME=deno`

## Local Development

Build the image:

```bash
docker build --tag process-audio .
```

Run the container against real Firebase:

```bash
docker run \
  -e GOOGLE_APPLICATION_CREDENTIALS="/Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-aec4d133ad.json" \
  -v /Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-aec4d133ad.json:/Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-aec4d133ad.json \
  --env-file .env \
  -p 8080:8080 \
  process-audio
```

Run the container against the Firebase emulator:

```bash
docker run \
  -e NODE_ENV=development \
  -e GOOGLE_APPLICATION_CREDENTIALS="/Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-aec4d133ad.json" \
  -e FIREBASE_EMULATOR_HOST="host.docker.internal" \
  -e FIRESTORE_EMULATOR_PORT="8081" \
  -e FIREBASE_AUTH_EMULATOR_PORT="9099" \
  -e FIREBASE_STORAGE_EMULATOR_PORT="9199" \
  -e FIREBASE_DATABASE_EMULATOR_PORT="9000" \
  -v /Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-aec4d133ad.json:/Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-aec4d133ad.json \
  --env-file .env \
  -p 8080:8080 \
  process-audio
```

## Local Docker Validation Loop

The repo now contains a reproducible YouTube validation harness that mirrors the production topology:

- `server`
- `ytdlp-pot-provider`
- `browser-fallback`
- deterministic fake `yt-dlp` scenarios for negative-path tests

Run the loop:

```bash
pnpm verify:youtube:loop
```

Equivalent direct command:

```bash
bash scripts/test-youtube-loop.sh
```

The loop validates:

- public-path success without cookies
- stale-cookie classification and circuit-breaker behavior
- browser fallback for direct URL resolution
- browser fallback for section downloads

Artifacts are written to `.tmp/youtube-loop/`.

Deployment rule:

- Do not deploy YouTube extraction changes until the local loop passes.

## Local Test Topology

`compose.youtube-test.yaml` adds:

- `browser-fallback`
  - mock service implementing `POST /fallback`
  - `GET /healthz`
  - `GET /session-status`
- `ytdlp-pot-provider`
  - bgutil provider container
- `server`
  - same app container with YouTube env vars wired for the local loop

The validation harness uses deterministic scenarios for:

- public success
- public bot challenge
- stale cookie failure
- provider unavailable
- browser fallback recovery

Keep at least one live smoke test in staging, but use the deterministic local loop as the default regression gate.

## Deploying to Google Cloud Run

Runtime failure alert recipients are injected from the Secret Manager secret `RUNTIME_ALERT_RECIPIENTS` during Cloud Run deploys. The app also supports `PROCESS_AUDIO_ALERT_RECIPIENTS`, `RUNTIME_ALERT_RECIPIENTS`, or `RUNTIME_ALERT_EMAILS`, but deploy should bind `RUNTIME_ALERT_RECIPIENTS`.

The production YouTube stack assumes:

- `process-audio` runs as the orchestrator on Cloud Run
- a separate bgutil PO-token provider service is deployed
- an optional but recommended browser fallback worker is deployed on a stateful host with:
  - persistent Chromium profile storage
  - a dedicated YouTube service account
  - stable outbound IP

Example PO-token provider deployment:

```bash
gcloud run deploy ytdlp-pot-provider \
  --image docker.io/brainicism/bgutil-ytdlp-pot-provider \
  --region us-central1 \
  --allow-unauthenticated
```

Deploy `process-audio` with the provider URL:

```bash
gcloud run deploy process-audio \
  --image gcr.io/urm-app/process-audio \
  --region us-central1 \
  --min-instances 0 \
  --cpu-throttling \
  --set-env-vars YTDLP_POT_PROVIDER_BASE_URL=https://ytdlp-pot-provider-<hash>-uc.a.run.app
```

Recommended production defaults:

- keep `YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS=false`
- keep `YTDLP_CONCURRENT_FRAGMENTS=1`
- keep `YOUTUBE_PUBLIC_PROVIDER_MAX_ATTEMPTS=1`
- keep `YOUTUBE_COOKIE_PROVIDER_MAX_ATTEMPTS=1`
- keep `YTDLP_JS_RUNTIME=deno`
- configure `YOUTUBE_BROWSER_FALLBACK_URL`
- pin the provider image digest before promoting to production
- prefer deterministic egress for Cloud Run so outbound IP reputation is measurable

Optional:

- Set `YTDLP_POT_DISABLE_INNERTUBE=true` if the provider is healthy but token usage still fails for a subset of videos.

## Browser Fallback Contract

The browser worker endpoint referenced by `YOUTUBE_BROWSER_FALLBACK_URL` must accept JSON `POST` requests.

Supported actions:

- `action=resolve_audio_url`
  - request body: `youtubeUrl`
  - response body: `{ "url": "...", "format": "m4a", "duration": 123 }`
- `action=download_section`
  - request body: `youtubeUrl`, `startTime`, `duration`
  - response body: `{ "downloadUrl": "...", "ext": "m4a" }`

Operational endpoints expected on the worker:

- `GET /healthz`
- `GET /session-status`

## Cookie Rotation Workflow

Production reads YouTube cookies from RTDB key `yt-dlp-cookies` and metadata from `yt-dlp-cookies-meta`.

Cookies are now an emergency compatibility layer, not the primary recovery path for Cloud Run IP challenges.

Use a dedicated YouTube service account only. Do not use a human browsing profile.

Required workflow:

1. Open a fresh private/incognito window.
2. Log into YouTube with the dedicated service account only.
3. In the same tab, navigate to [https://www.youtube.com/robots.txt](https://www.youtube.com/robots.txt).
4. Export `youtube.com` cookies using a local cookies exporter.
5. Close the private/incognito window immediately.
6. Never reopen or browse with that session again.
7. Base64-encode the exported `cookies.txt`.
8. Update `yt-dlp-cookies` in RTDB.
9. Update `yt-dlp-cookies-meta` atomically with the new metadata.

Base64 command on macOS:

```bash
cat cookies.txt | base64 | pbcopy
```

Recommended metadata payload:

```json
{
  "rotatedAt": "2026-03-13T21:30:00.000Z",
  "exportedAt": "2026-03-13T21:29:30.000Z",
  "exportMethod": "Get cookies.txt LOCALLY",
  "profileType": "incognito",
  "sourceAccount": "youtube-service-account@upperroommedia.org",
  "cookieHash": "sha256:<hash>",
  "lastHealthStatus": "unknown",
  "consecutiveFailures": 0,
  "disabledUntil": null
}
```

Important rules:

- Manual RTDB pasting is emergency fallback only.
- Preferred steady state is a controlled cookie-rotation utility that uploads both `yt-dlp-cookies` and `yt-dlp-cookies-meta` together.
- If RTDB metadata shows `disabledUntil` in the future, the cookie circuit breaker is open and the service will skip cookie-backed attempts.
- If a cookie healthcheck fails with `The page needs to be reloaded`, rotate the session instead of retrying.

## Verifying the Production Setup

After deployment, run a YouTube job and inspect logs.

Healthy signals:

- `Applying yt-dlp extractor args with PO token provider`
- `public_provider` attempted first
- a non-empty `poTokenProviderBaseUrl`
- `healthz` reports `ytDlpJsRuntime: deno`
- browser fallback only used after classified public/cookie failure
- logs showing one access-decision flow rather than repeated provider thrash

Failure interpretation:

- `public_ip_or_reputation_block`
  - Cloud Run public path was challenged; verify outbound IP reputation and browser fallback health
- `cookie_session_stale`
  - rotate cookies from a fresh private session
- `account_required_no_valid_session`
  - content requires auth and there is no usable cookie/browser session
- `provider_unhealthy`
  - check bgutil provider deployment, readiness, and revision
- `browser_fallback_failed`
  - check worker `healthz`, `session-status`, persistent profile storage, and account login state

## Cloud Run Smoke Test

GET:

```bash
curl \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  https://process-audio-yshbijirxq-uc.a.run.app
```

POST:

```bash
curl \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  https://process-audio-yshbijirxq-uc.a.run.app/process-audio \
  -d '{
    "data": {
      "deleteOriginal": true,
      "id": "fbff2e40-ff55-4ce0-95b8-60ed455188af",
      "introUrl": "https://firebasestorage.googleapis.com/v0/b/urm-app.appspot.com/o/intros%2FBible%20Studies_intro.mp3?alt=media&token=21e3ed85-c569-4609-9f71-258f2cadc491",
      "outroUrl": "https://firebasestorage.googleapis.com/v0/b/urm-app.appspot.com/o/outros%2Fdefault_outro.mp3?alt=media&token=c0748088-dc68-4619-a9a7-ec4f6272f055",
      "duration": 713.5,
      "startTime": 2570.5,
      "youtubeUrl": "https://www.youtube.com/watch?v=MVQ_TCo28jU"
    }
  }'
```

Local:

```bash
curl \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  http://localhost:8080/process-audio \
  -d '{
    "data": {
      "id": "ID",
      "youtubeUrl": "https://www.youtube.com/watch?v=MUIw7qrSW6k",
      "startTime": 5155,
      "duration": 1320
    }
  }'
```

## Download the Latest yt-dlp Binary

[https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp](https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp)
