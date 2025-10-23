# Use an argument to specify the Node.js version
ARG NODE_VERSION=18.20.4
ARG PNPM_VERSION=9.12.3

# ---------- Build stage ----------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /usr/src/app

# Install build dependencies (needed for native modules during npm install)
RUN apk add --no-cache python3 make g++

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
FROM node:${NODE_VERSION}-alpine AS production
ENV NODE_ENV=production
WORKDIR /usr/src/app

# Install build dependencies needed for native Node modules (ffmpeg-static, protobufjs, etc.)
RUN apk add --no-cache python3 make g++

# Add yt-dlp (latest release)
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