FROM python:3.11-slim AS base

WORKDIR /app

# System dependencies for LightGBM / XGBoost / numpy / TA-Lib
# NOTE: ta-lib is NOT a Debian package — it must be compiled from source.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    build-essential \
    cmake \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Build TA-Lib C library from source (required by the Python TA-Lib wheel)
RUN wget -q https://github.com/ta-lib/ta-lib/releases/download/v0.7.1/ta-lib-0.7.1-src.tar.gz \
    && tar -xzf ta-lib-0.7.1-src.tar.gz \
    && cd ta-lib-0.7.1 \
    && ./configure --prefix=/usr \
    && make -j"$(nproc)" \
    && make install \
    && cd .. \
    && rm -rf ta-lib-0.7.1 ta-lib-0.7.1-src.tar.gz \
    && ldconfig

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
