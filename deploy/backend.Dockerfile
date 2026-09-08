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
# Role Atlas admin archive bindings are inspected as source, never executed by Python.
COPY apps/role-atlas/lib/research-collection /app/apps/role-atlas/lib/research-collection
COPY apps/role-atlas/app/admin/research /app/apps/role-atlas/app/admin/research
COPY apps/role-atlas/app/api/admin/research /app/apps/role-atlas/app/api/admin/research

EXPOSE 8010
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8010", "--proxy-headers", "--forwarded-allow-ips=*"]
