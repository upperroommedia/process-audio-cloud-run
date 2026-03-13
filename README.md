# Process Audio

This service processes audio for the Upper Room Media Uploader

## Prerequisites

- Google Cloud SDK
- Docker
- A Google Cloud Platform project

### Generate yt-dlp-cookies in realtimeDB

1. Make sure to have the proper variables in a `.env` file colocated with the `yt-dlp-cookies-script.sh`

```
EMAIL=""
PASSWORD=""
FIREBASE_API_KEY=""
FIREBASE_DB_URL="https://example.firebaseio.com/"
```

2. To run this script on a schedule (mac) copy the `com.user.ytdlp-script.plist` to `~/Library/LaunchAgents/com.user.ytdlp-script.plist` and edit the `path-to-script` and `path-to-working-directory`

- load the plist into launchctl using: `launchctl load ~/Library/LaunchAgents/com.user.ytdlp-script.plist`
- if you make any edits make sure to `unload` then `load` again to update
- you can verify that the script is running with `launchctl list | grep com.user.ytdlp-script`

## Local Development

1. Make sure you start docker on your machine (open docker from apps)
2. Run `docker build --tag process-audio .` to build the process-audio image
3. Run

```
docker run \
-e GOOGLE_APPLICATION_CREDENTIALS="/Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-aec4d133ad.json" \
-v /Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-aec4d133ad.json:/Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-aec4d133ad.json \
--env-file .env \
-p 8080:8080 \
process-audio
```

to run the image with access to the 8080 port. Replace the path of the Credentials with the appropriate path

### Using Firebase Emulator with Docker

When running the Docker container with the Firebase emulator, you need to configure the container to connect to the emulator running on your host machine:

```
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

**Note:**

- `FIREBASE_EMULATOR_HOST` should be `host.docker.internal` on Mac/Windows, or your host machine's IP address on Linux
- Make sure your Firebase emulator ports match the values you set (defaults: Firestore 8081, Auth 9099, Storage 9199, Database 9000)
- If your app uses port 8080, the Firestore emulator will typically use a different port (check your emulator startup logs)

## Deploying to Google Cloud Run

Set `PROCESS_AUDIO_ALERT_RECIPIENTS` on the service to a comma-separated list of alert recipients before deploying if you want runtime failures to queue email notifications.

YouTube downloads in Cloud Run now assume a separate bgutil PO-token provider service is available. The GitHub Actions deploy workflows for `staging` and `main` now provision that provider automatically through `cloudbuild.yaml` and inject its service URL into `YTDLP_POT_PROVIDER_BASE_URL` on the corresponding `process-audio` Cloud Run service.

Production extraction policy:

- public videos: provider-first, no cookies by default
- gated videos: provider + RTDB cookies
- hard auth/session failures after cookie escalation: optional browser fallback worker via `YOUTUBE_BROWSER_FALLBACK_URL`

Example provider deployment:

```bash
gcloud run deploy ytdlp-pot-provider \
  --image docker.io/brainicism/bgutil-ytdlp-pot-provider \
  --region us-central1 \
  --allow-unauthenticated
```

Then deploy `process-audio` with the provider URL:

```bash
gcloud run deploy process-audio \
  --image gcr.io/urm-app/process-audio \
  --region us-central1 \
  --min-instances 0 \
  --cpu-throttling \
  --set-env-vars YTDLP_POT_PROVIDER_BASE_URL=https://ytdlp-pot-provider-<hash>-uc.a.run.app
```

Optional:

- Set `YTDLP_POT_DISABLE_INNERTUBE=true` if the provider is working but tokens still fail for some videos. This enables the `disable_innertube=1` provider option described in the bgutil provider docs.
- `YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS=false` is the default and should stay false unless you are debugging a specific public-video regression.
- `YTDLP_CONCURRENT_FRAGMENTS=1` is the default to reduce burstiness against YouTube.
- `YOUTUBE_RETRY_DELAY_MS=1500` controls delay before cookie or browser fallback escalation.
- `YTDLP_COOKIE_HEALTHCHECK_ENABLED=true` enables a lightweight authenticated probe before cookie-backed attempts.
- `YOUTUBE_BROWSER_FALLBACK_URL` enables the final browser-backed fallback. The worker should accept a JSON POST body with `action`, `youtubeUrl`, optional `startTime`, optional `duration`, and return either `{ "url": "..." }` for `resolve_audio_url` or `{ "downloadUrl": "...", "ext": "m4a" }` for `download_section`.

1. Build the Docker image:

```
gcloud builds submit --tag gcr.io/urm-app/process-audio
```

2. Deploy the image:

```
gcloud run deploy process-audio --image gcr.io/urm-app/process-audio --region us-central1 --min-instances 0 --cpu-throttling
```

## Test

GET

```
curl \
-H "Authorization: Bearer $(gcloud auth print-identity-token)" \
https://process-audio-yshbijirxq-uc.a.run.app
```

POST

```
curl \
-X POST \
-H 'Content-Type: application/json' \
-H "Authorization: Bearer $(gcloud auth print-identity-token)" \
https://process-audio-yshbijirxq-uc.a.run.app/process-audio \
-d '{
    "data":{
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

Local

```
curl \
-X POST \
-H 'Content-Type: application/json' \
-H "Authorization: Bearer $(gcloud auth print-identity-token)" \
http://localhost:8080/process-audio \
-d '{
    "data":{
                "id": "ID",
                "youtubeUrl": "https://www.youtube.com/watch?v=MUIw7qrSW6k",
                "startTime": 5155,
                "duration": 1320
            }
}'
```

# INSTRUCTIONS FOR ROTATING YT-DLP COOKIES

Production reads YouTube cookies from Realtime Database key `yt-dlp-cookies` on each request, so updating that value takes effect without redeploying Cloud Run. Cookies are only used when the public provider path indicates account-required or challenged content. The service also stores cookie health and last-attempt details in `yt-dlp-cookies-meta`.

> Follow these instructions: https://github.com/yt-dlp/yt-dlp/wiki/Extractors

1. Open a new private browsing/incognito window and log into YouTube (use the auth@upperroommedia.org google profile password Iam\*\*\*)
2. In same window and same tab from step 1, navigate to https://www.youtube.com/robots.txt (this should be the only private/incognito browsing tab open)
3. Export youtube.com cookies from the browser, then close the private browsing/incognito window so that the session is never opened in the browser again. Use the `Get cookies.txt LOCALLY` extension and export all cookies.
4. encode the `cookies.txt` by running the following command:

```zh
cat cookies.txt | base64 | pbcopy
```

5. Navigate (in a normal chrome window) to https://console.firebase.google.com/project/urm-app/database/urm-app-default-rtdb/data and paste the encoded value in the `yt-dlp-cookies` field

Optional but recommended metadata to store in `yt-dlp-cookies-meta`:

```json
{
  "rotatedAt": "2026-03-13T21:30:00.000Z",
  "sourceAccount": "youtube-service-account@upperroommedia.org"
}
```

## Verifying PO-token setup

After deployment, run a YouTube job and check Cloud Run logs. A healthy setup should show:

- `Applying yt-dlp extractor args with PO token provider`
- public videos should first log a `public_provider` attempt without cookies
- a non-empty `poTokenProviderBaseUrl`
- yt-dlp verbose output that no longer reports `PO Token Providers: none`
- if yt-dlp still reports `The page needs to be reloaded`, rotate the RTDB cookie value from a fresh private browsing session because the session itself is stale or challenged

## Download the latest yt-dlp binary

https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
