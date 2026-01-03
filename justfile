# Build and start the Docker container for local development

# Default recipe
default:
    @just --list

# Build the Docker image
build:
    @echo "Building Docker image..."
    docker build --tag process-audio .

# Start the service (builds and runs the Docker container)
# Usage: just start-service
start-service: build
    @echo "Starting Docker container..."
    docker run \
        -e NODE_ENV=development \
        -e LOG_LEVEL="info" \
        -e FIREBASE_EMULATOR_HOST="host.docker.internal" \
        -e FIRESTORE_EMULATOR_PORT="8081" \
        -e FIREBASE_AUTH_EMULATOR_PORT="9099" \
        -e FIREBASE_STORAGE_EMULATOR_PORT="9199" \
        -e FIREBASE_DATABASE_EMULATOR_PORT="9000" \
        -e HOME="/home/node" \
        -v "/Users/yasaad/Library/Application Support/Google/Chrome:/home/node/.config/google-chrome:ro" \
        --env-file .env \
        -p 8080:8080 \
        process-audio

# Start the service with debug logging
# Usage: just dev
dev: build
    @echo "Starting Docker container with DEBUG logging..."
    docker run \
        -e NODE_ENV=development \
        -e LOG_LEVEL="debug" \
        -e FIREBASE_EMULATOR_HOST="host.docker.internal" \
        -e FIRESTORE_EMULATOR_PORT="8081" \
        -e FIREBASE_AUTH_EMULATOR_PORT="9099" \
        -e FIREBASE_STORAGE_EMULATOR_PORT="9199" \
        -e FIREBASE_DATABASE_EMULATOR_PORT="9000" \
        -e HOME="/home/node" \
        -v "/Users/yasaad/Library/Application Support/Google/Chrome:/home/node/.config/google-chrome:ro" \
        --env-file .env \
        -p 8080:8080 \
        process-audio
