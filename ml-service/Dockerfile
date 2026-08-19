FROM python:3.11-slim AS base

WORKDIR /app

# System dependencies for LightGBM / XGBoost / numpy
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create model artifacts directory
RUN mkdir -p /app/artifacts

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import httpx; r = httpx.get('http://localhost:8100/health'); r.raise_for_status()"

EXPOSE 8100

CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8100", "--workers", "2"]
