# Process Audio

This service processes audio for the Upper Room Media Uploader

## Prerequisites

- Google Cloud SDK
- Docker
- A Google Cloud Platform project

## Local Development

1. Make sure you start docker on your machine (open docker from apps)
2. Run `docker build --tag process-audio .` to build the process-audio image
3. Run `docker run --publish 8080:8080 process-audio` to run the image with access to the 8080 port

## Deploying to Google Cloud Run

1. Build the Docker image:

```
gcloud builds submit --tag gcr.io/urm-app/process-audio
```

2. Deploy the image:

```
gcloud run deploy process-audio --image gcr.io/urm-app/process-audio --region us-central1
```
