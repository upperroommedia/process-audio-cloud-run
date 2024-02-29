# Process Audio

This service processes audio for the Upper Room Media Uploader

## Prerequisites

- Google Cloud SDK
- Docker
- A Google Cloud Platform project

## Local Development

1. Make sure you start docker on your machine (open docker from apps)
2. Run `docker build --tag process-audio .` to build the process-audio image
3. Run

```
docker run \
-e GOOGLE_APPLICATION_CREDENTIALS=/Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-395dfcef08.json \
-v $GOOGLE_APPLICATION_CREDENTIALS:/Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-395dfcef08.json:ro \
--publish 8080:8080 \
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

```
curl \
-X POST \
-H 'Content-Type: application/json' \
-H "Authorization: Bearer $(gcloud auth print-identity-token)" \
https://process-audio-yshbijirxq-uc.a.run.app/process-audio \
-d '{
                "id": "9104375d-eebf-49ab-9d8e-9e7cdff85be4",
                "youtubeUrl": "https://www.youtube.com/watch?v=MUIw7qrSW6k",
                "startTime": 5155,
                "duration": 1320
}'
```
