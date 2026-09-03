FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Scrapling with fetcher dependencies (Playwright + Chromium)
# Runs during image BUILD — not at container startup — to meet the 90s startup SLA
RUN pip install --no-cache-dir "scrapling[fetchers]==0.4.*" && scrapling install

COPY src/ ./src/

EXPOSE 8200

CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8200"]
