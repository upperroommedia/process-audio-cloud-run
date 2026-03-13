# Use Node 22 (required by yt-dlp JS runtime) with Debian-slim (required for glibc DNS in ffmpeg)
ARG NODE_VERSION=22
ARG PNPM_VERSION=9.12.3
ARG YT_DLP_VERSION=2026.03.03
ARG BGUTIL_YTDLP_POT_PROVIDER_VERSION=1.3.1
ARG DEBIAN_MIRROR=https://mirrors.edge.kernel.org/debian
ARG DEBIAN_SECURITY_MIRROR=https://security.debian.org/debian-security
ARG DEBIAN_UPDATES_MIRROR=https://mirrors.edge.kernel.org/debian

# ---------- Build stage ----------
FROM node:${NODE_VERSION}-slim AS build
ARG DEBIAN_MIRROR
ARG DEBIAN_SECURITY_MIRROR
ARG DEBIAN_UPDATES_MIRROR
WORKDIR /usr/src/app

# Install build dependencies (needed for native modules during npm install)
RUN apt-get update -o Acquire::Retries=3 -o Acquire::http::No-Cache=true -o Acquire::http::Pipeline-Depth=0 \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::By-Hash "yes";\n' > /etc/apt/apt.conf.d/99byhash \
    && printf "deb %s bookworm main\n" "$DEBIAN_MIRROR" > /etc/apt/sources.list \
    && printf "deb %s bookworm-security main\n" "$DEBIAN_SECURITY_MIRROR" >> /etc/apt/sources.list \
    && printf "deb %s bookworm-updates main\n" "$DEBIAN_UPDATES_MIRROR" >> /etc/apt/sources.list \
    && apt-get update -o Acquire::Retries=3 -o Acquire::https::No-Cache=true -o Acquire::http::Pipeline-Depth=0 \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

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
ARG YT_DLP_VERSION
ARG BGUTIL_YTDLP_POT_PROVIDER_VERSION
ARG DEBIAN_MIRROR
ARG DEBIAN_SECURITY_MIRROR
ARG DEBIAN_UPDATES_MIRROR
ENV NODE_ENV=production
WORKDIR /usr/src/app

# Install runtime dependencies:
# - python3, make, g++: needed for native Node modules (protobufjs, etc.)
# - python3-pip: installs plugin-capable yt-dlp + PO token plugin
# - ffmpeg: includes ffmpeg + ffprobe (dynamically linked, supports DNS)
RUN apt-get update -o Acquire::Retries=3 -o Acquire::http::No-Cache=true -o Acquire::http::Pipeline-Depth=0 \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::By-Hash "yes";\n' > /etc/apt/apt.conf.d/99byhash \
    && printf "deb %s bookworm main\n" "$DEBIAN_MIRROR" > /etc/apt/sources.list \
    && printf "deb %s bookworm-security main\n" "$DEBIAN_SECURITY_MIRROR" >> /etc/apt/sources.list \
    && printf "deb %s bookworm-updates main\n" "$DEBIAN_UPDATES_MIRROR" >> /etc/apt/sources.list \
    && apt-get update -o Acquire::Retries=3 -o Acquire::https::No-Cache=true -o Acquire::http::Pipeline-Depth=0 \
    && apt-get install -y --no-install-recommends python3 python3-pip make g++ ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install plugin-capable yt-dlp and the bgutil PO token provider plugin.
# The plugin talks to an external bgutil provider over HTTP, configured via
# YTDLP_POT_PROVIDER_BASE_URL at runtime.
RUN python3 -m pip install --break-system-packages --no-cache-dir \
       "yt-dlp==${YT_DLP_VERSION}" \
       "bgutil-ytdlp-pot-provider==${BGUTIL_YTDLP_POT_PROVIDER_VERSION}" \
    && echo "yt-dlp version: $(yt-dlp --version)" \
    && python3 -m pip show bgutil-ytdlp-pot-provider

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
