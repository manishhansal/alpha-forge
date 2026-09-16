## AlphaForge — local Docker workflow
##
## Usage:
##   make rebuild-app     build + restart the Next.js app container
##   make rebuild-worker  build + restart the background worker
##   make rebuild-all     rebuild both
##   make logs-app        tail app logs
##   make logs-worker     tail worker logs
##   make logs-all        tail app + worker logs side by side
##   make status          show running container health
##   make stop            stop app + worker (keeps infra running)
##   make start           start app + worker (after stop)

# ── Config ─────────────────────────────────────────────────────────────────
APP_IMAGE      := alpha-forge-app-local
WORKER_IMAGE   := alpha-forge-worker-local
APP_CONTAINER  := alpha-forge-app
WORKER_CONTAINER := alpha-forge-worker
NETWORK        := alpha-forge_alphaforge

# ENV strategy:
#   1. Start with .env.docker  (Docker-internal service URLs, NODE_ENV=production)
#   2. Layer .env.local on top (real API keys, secrets from your local config)
#   3. Override a small set of Docker-specific values that .env.local gets wrong
#      when run inside a container (localhost → host.docker.internal for
#      DATA_SERVICE_URL, and strip the broken ALERT_EMAIL_FROM format).
ENV_FLAGS := \
	--env-file .env.docker \
	--env-file .env.local \
	-e DATA_SERVICE_URL=http://host.docker.internal:8200 \
	-e NEXT_PUBLIC_DATA_SERVICE_URL=http://localhost:8200 \
	-e DATABASE_URL=postgresql://crypto:crypto@postgres:5432/crypto_dashboard \
	-e REDIS_URL=redis://redis:6379 \
	-e ML_SERVICE_URL=http://ml-service:8100 \
	-e ALERT_EMAIL_FROM=alerts@alphaforge.local

DOCKER_RUN_BASE := docker run -d \
	--network $(NETWORK) \
	--add-host=host.docker.internal:host-gateway \
	$(ENV_FLAGS)

# ── App ─────────────────────────────────────────────────────────────────────
.PHONY: rebuild-app
rebuild-app:
	@echo "▶  Building app image…"
	docker build -f Dockerfile.app -t $(APP_IMAGE) .
	@echo "▶  Restarting app container…"
	-docker stop $(APP_CONTAINER) 2>/dev/null
	-docker rm   $(APP_CONTAINER) 2>/dev/null
	$(DOCKER_RUN_BASE) \
		--name $(APP_CONTAINER) \
		-p 3000:3000 \
		-e SENTINEL_PULSE_URL=http://host.docker.internal:3001 \
		$(APP_IMAGE)
	@echo "✓  App live at http://localhost:3000"

# ── Worker ──────────────────────────────────────────────────────────────────
.PHONY: rebuild-worker
rebuild-worker:
	@echo "▶  Building worker image…"
	docker build -f Dockerfile.worker -t $(WORKER_IMAGE) .
	@echo "▶  Restarting worker container…"
	-docker stop $(WORKER_CONTAINER) 2>/dev/null
	-docker rm   $(WORKER_CONTAINER) 2>/dev/null
	$(DOCKER_RUN_BASE) \
		--name $(WORKER_CONTAINER) \
		-e WORKER_APP_BASE_URL=http://$(APP_CONTAINER):3000 \
		$(WORKER_IMAGE)
	@echo "✓  Worker running"

# ── Both ────────────────────────────────────────────────────────────────────
.PHONY: rebuild-all
rebuild-all: rebuild-app rebuild-worker

# ── Logs ────────────────────────────────────────────────────────────────────
.PHONY: logs-app
logs-app:
	docker logs -f $(APP_CONTAINER)

.PHONY: logs-worker
logs-worker:
	docker logs -f $(WORKER_CONTAINER)

.PHONY: logs-all
logs-all:
	@docker logs -f $(APP_CONTAINER)    2>&1 | sed 's/^/\033[36m[app]   \033[0m/' & \
	 docker logs -f $(WORKER_CONTAINER) 2>&1 | sed 's/^/\033[33m[worker]\033[0m/' ; \
	 wait

# ── Lifecycle ───────────────────────────────────────────────────────────────
.PHONY: stop
stop:
	-docker stop $(APP_CONTAINER) $(WORKER_CONTAINER) 2>/dev/null
	@echo "✓  App + worker stopped"

.PHONY: start
start:
	-docker start $(APP_CONTAINER)    2>/dev/null
	-docker start $(WORKER_CONTAINER) 2>/dev/null
	@echo "✓  App + worker started"

# ── Status ──────────────────────────────────────────────────────────────────
.PHONY: status
status:
	@docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" \
		--filter "name=alpha-forge" \
		--filter "name=data-service"
