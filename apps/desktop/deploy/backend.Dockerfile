FROM python:3.12-slim

WORKDIR /app/apps/desktop/backend
COPY apps/desktop/backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY packages/learning-core /app/packages/learning-core
COPY apps/desktop/backend ./
COPY apps/desktop/frontend /app/apps/desktop/frontend
COPY packages/learning-client /app/packages/learning-client

EXPOSE 8010
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8010", "--proxy-headers", "--forwarded-allow-ips=*"]
