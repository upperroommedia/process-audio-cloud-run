# If you need more help, visit the Dockerfile reference guide at
# https://docs.docker.com/go/dockerfile-reference/

# Use an argument to specify the Node.js version
ARG NODE_VERSION=18.12.0
ARG PNPM_VERSION=6.32.3

# Build stage
FROM node:${NODE_VERSION}-alpine AS build

# Set the working directory in the container
WORKDIR /usr/src/app

# Install Python3 and other build dependencies
RUN apk add --no-cache python3 make g++

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

# Production stage
FROM node:${NODE_VERSION}-alpine AS production

# Set NODE_ENV to production to exclude development dependencies
ENV NODE_ENV production

# Use production node environment by default.
WORKDIR /usr/src/app

# Install Python3 and other build dependencies
RUN apk add --no-cache python3 make g++

# Copy package.json and pnpm-lock.yaml
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only
RUN npm install -g pnpm@${PNPM_VERSION} && pnpm install --frozen-lockfile --prod

# Copy the built application from the build stage
COPY --from=build /usr/src/app/dist ./dist
COPY ./bin ./bin
# Set the executable permission on the binaries
RUN chmod +x ./bin/*

# Change ownership of the entire working directory so the node user can write to it
RUN chown -R node:node /usr/src/app

# Run the application as a non-root user for security
USER node

# Set the command to start the application
CMD pnpm start


