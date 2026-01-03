# Use Node 22 (required by yt-dlp JS runtime) with Debian-slim (required for glibc DNS in ffmpeg)
ARG NODE_VERSION=22
ARG PNPM_VERSION=9.12.3

# ---------- Build stage ----------
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /usr/src/app

# Install build dependencies (needed for native modules during npm install)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm@${PNPM_VERSION}

# Copy package.json and pnpm-lock.yaml
COPY package.json pnpm-lock.yaml ./

# Install dependencies (includes devDependencies for TypeScript compilation)
RUN pnpm install --frozen-lockfile

# Copy the rest of the source files into the image
COPY . .

# Build the application
RUN pnpm build

# ---------- Production stage ----------
FROM node:${NODE_VERSION}-slim AS production
ENV NODE_ENV=production
WORKDIR /usr/src/app

# Install runtime dependencies:
# - python3, make, g++: needed for native Node modules (protobufjs, etc.)
# - wget: for yt-dlp download
# - ffmpeg: includes ffmpeg + ffprobe (dynamically linked, supports DNS)
RUN apt-get update && apt-get install -y python3 make g++ wget ffmpeg && rm -rf /var/lib/apt/lists/*

# Add yt-dlp (latest release)
# yt-dlp will use Node.js 20+ (in container) as its JavaScript runtime
RUN wget -O /usr/local/bin/yt-dlp \
       "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp?$(date +%s)" \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && echo "yt-dlp version: $(yt-dlp --version)"

# Install pnpm and copy package files
RUN npm install -g pnpm@${PNPM_VERSION}
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built app from build stage
COPY --from=build /usr/src/app/dist ./dist

# Change ownership to node user
RUN chown -R node:node /usr/src/app
USER node

# Start the app
CMD ["pnpm", "start"]