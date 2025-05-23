# Build stage
FROM node:22-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build application
RUN npm run build

# Production stage
FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package*.json .
COPY db            db

# Install production dependencies only
RUN npm ci --omit=dev
# FIXME: Why is this needed? Where does the version conflict come from?
RUN ln -s /root/.cache/ms-playwright/chromium-1161 /root/.cache/ms-playwright/chromium-1169

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

RUN ln -s /app/dist/cli.js /app/docs-cli

# Set data directory for the container
ENV DOCS_MCP_STORE_PATH=/data

# Define volumes
VOLUME /data

# Expose the ports the applications listen on
EXPOSE 6280
EXPOSE 6281

# Set the command to run the application
CMD ["node", "dist/server.js"]
