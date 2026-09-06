FROM node:22-bookworm-slim

WORKDIR /app/apps/desktop/frontend
COPY apps/desktop/frontend/package.json apps/desktop/frontend/package-lock.json ./
RUN npm ci
COPY packages/learning-client /app/packages/learning-client
COPY apps/desktop/frontend ./
RUN npm run build

EXPOSE 4174
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "4174"]
