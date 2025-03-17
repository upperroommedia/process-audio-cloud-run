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
