# Use an argument to specify the Node.js version
ARG NODE_VERSION=18.12.0
ARG PNPM_VERSION=6.32.3

# ---------- Build stage ----------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /usr/src/app

# Install Python3 and other build dependencies
RUN apk add --no-cache python3 make g++
# ✅ Add the latest yt-dlp binary (always fetched fresh on each build)
RUN wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && yt-dlp --version

# Install pnpm
RUN npm install -g pnpm@${PNPM_VERSION}

# Copy package.json and pnpm-lock.yaml
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy the rest of the source files into the image
COPY . .

# Build the application
RUN pnpm build

# ---------- Production stage ----------
FROM node:${NODE_VERSION}-alpine AS production
ENV NODE_ENV=production
WORKDIR /usr/src/app

# Install Python3 and other build dependencies
RUN apk add --no-cache python3 make g++

# ✅ Add yt-dlp (latest release)
RUN wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp?$(date +%s) \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && yt-dlp --version

# Copy package files and install production dependencies
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@${PNPM_VERSION} && pnpm install --frozen-lockfile --prod

# Copy built app from build stage
COPY --from=build /usr/src/app/dist ./dist

# Change ownership to node user
RUN chown -R node:node /usr/src/app
USER node

# Start the app
CMD ["pnpm", "start"]
