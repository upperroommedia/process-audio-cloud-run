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

1. Build the Docker image:

```
gcloud builds submit --tag gcr.io/urm-app/process-audio
```

2. Deploy the image:

```
gcloud run deploy process-audio --image gcr.io/urm-app/process-audio --region us-central1
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
                "id": "ID",
                "youtubeUrl": "https://www.youtube.com/watch?v=MUIw7qrSW6k",
                "startTime": 5155,
                "duration": 1320
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

> Follow these instructions: https://github.com/yt-dlp/yt-dlp/wiki/Extractors

1. Open a new private browsing/incognito window and log into YouTube (use the auth@upperroommedia.org google profile password Iam\*\*\*)
2. In same window and same tab from step 1, navigate to https://www.youtube.com/robots.txt (this should be the only private/incognito browsing tab open)
3. Export youtube.com cookies from the browser, then close the private browsing/incognito window so that the session is never opened in the browser again. (use the get cookies extension and export all cookies)
4. encode the `cookies.txt` by running the following command:

```zh
cat cookies.txt | base64 | pbcopy
```

5. Navigate (in a normal chrome window) to https://console.firebase.google.com/project/urm-app/database/urm-app-default-rtdb/data and paste the encoded value in the `yt-dlp-cookies` field

## Download the latest yt-dlp binary

https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
