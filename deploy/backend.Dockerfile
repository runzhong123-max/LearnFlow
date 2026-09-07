FROM python:3.12-slim

WORKDIR /app/backend
COPY backend/requirements.txt ./requirements.txt
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r requirements.txt
COPY packages/learning-core /app/packages/learning-core
COPY backend ./
# Registry bindings inspect these versioned source assets in the running image.
COPY frontend /app/frontend
COPY packages/learning-client /app/packages/learning-client
COPY labs/golden-role /app/labs/golden-role

EXPOSE 8010
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8010", "--proxy-headers", "--forwarded-allow-ips=*"]
