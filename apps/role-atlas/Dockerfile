FROM node:22-bookworm-slim

ARG NODE_BUILD_MEMORY_MB=1280

WORKDIR /app/apps/role-atlas
COPY apps/role-atlas/package.json apps/role-atlas/package-lock.json ./
RUN npm ci
COPY apps/role-atlas ./
COPY frontend/src/learning-path-contract-v2.ts frontend/src/learning-path-protocol.ts /app/frontend/src/
RUN NODE_OPTIONS="--max-old-space-size=${NODE_BUILD_MEMORY_MB}" npm run build

# workerd uses the OS trust store for outbound HTTPS (including GLM search).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 3000
CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", "3000"]
