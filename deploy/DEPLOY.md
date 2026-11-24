# Deployment (CI/CD to the VPS)

| Part | URL | How it runs |
|---|---|---|
| Frontend | https://bosch-agent.suryathink.com | Static React build served by nginx from `/var/www/bosch-agent.suryathink.com/current` |
| Backend | https://bosch-agent.api.suryathink.com | Docker container `product-agent-server` on `127.0.0.1:3001`, behind nginx (streaming-safe) |
| Health | https://bosch-agent.api.suryathink.com/api/health | Vector store + MongoDB status |

Both run on the same DigitalOcean droplet (`139.59.90.145`) as `chat.suryathink.com`, with their own nginx sites,
folders, port (3001) and container, so the two apps don't affect each other. HTTPS comes from Let's Encrypt.

## How deploys work

| Workflow | Runs when these change | What it does |
|---|---|---|
| [Deploy Backend](../.github/workflows/deploy-server.yml) | `backend/**`, the catalog CSV, `deploy/Dockerfile.backend`, `deploy/deploy-server.sh` | Smoke-test the tools (no LLM) → build the image and push it to Docker Hub as `suryathink/product-search-agent-server:latest` and `:sha-<commit>` → SSH to the server → [deploy-server.sh](deploy-server.sh) pulls the image, replaces the container and checks `/api/health`. If the new container is unhealthy it **rolls back** to the previous image and the job fails. Finally the public health URL is checked. |
| [Deploy Frontend](../.github/workflows/deploy-client.yml) | `frontend/**`, `deploy/deploy-client.sh` | `npm ci` + build with `VITE_API_BASE_URL=https://bosch-agent.api.suryathink.com` → upload → [deploy-client.sh](deploy-client.sh) unpacks into `releases/<commit>` and **atomically** switches the `current` symlink. The last 5 releases are kept. |

Both can be started manually from the **Actions** tab (*Run workflow*). Changes elsewhere (README, docs) don't deploy.

## One-time setup

### 1. DNS at Hostinger
hPanel → Domains → suryathink.com → **DNS / Nameservers** → add two **A** records:

| Type | Name | Points to | TTL |
|---|---|---|---|
| A | `bosch-agent` | `139.59.90.145` | 3600 |
| A | `bosch-agent.api` | `139.59.90.145` | 3600 |

Check (may take a few minutes): `nslookup bosch-agent.api.suryathink.com` → `139.59.90.145`.

### 2. MongoDB Atlas: allow the server
Atlas → **Network Access** → *Add IP Address* → `139.59.90.145`. Without this the backend starts but logs
"MongoDB unavailable" and only writes log files.

### 3. Prepare the server (nginx sites, folders, HTTPS)
From the repo root on your PC (replace `<user>` with the same SSH user as in your other app, e.g. `root`):
```bash
scp -r deploy <user>@139.59.90.145:/tmp/product-agent-deploy
ssh <user>@139.59.90.145 "sudo bash /tmp/product-agent-deploy/setup-vps.sh bosch-agent.api.suryathink.com bosch-agent.suryathink.com <your-email> <user>"
```
It installs only what's missing, adds this app's two nginx sites, creates `/opt/product-agent` and
`/var/www/bosch-agent.suryathink.com`, and gets the certificates. It does not touch the chat app.

### 4. Backend secrets on the server
The container reads `/opt/product-agent/server.env` (never stored in git or in the image). Copy your local `backend/.env`:
```bash
scp backend/.env <user>@139.59.90.145:/opt/product-agent/server.env
ssh <user>@139.59.90.145 "chmod 600 /opt/product-agent/server.env"
```
Recommended production values in that file:
```
INTERACTION_FILE_LOGS=false                              # conversations only in MongoDB, not on disk
CORS_ORIGINS=*                                           # or https://bosch-agent.suryathink.com to allow only the app
```
`HOST`, `PORT`, `NODE_ENV` and `TRUST_PROXY` are set by `deploy-server.sh`.

### 5. GitHub secrets and variables
Repo → **Settings → Secrets and variables → Actions**. Same secret names (and values) as `ai-customer-support-web-app`:

| Secret | Value |
|---|---|
| `DOCKER_USERNAME` | Docker Hub username |
| `DOCKER_PASSWORD` | Docker Hub access token (Read & Write) |
| `DROPLET_HOST` | `139.59.90.145` |
| `DROPLET_USER` | SSH user on the server |
| `DROPLET_SSH_KEY` | Private key whose public key is in that user's `~/.ssh/authorized_keys` |
| `DROPLET_KNOWN_HOSTS` | Output of `ssh-keyscan 139.59.90.145` |

Or with the GitHub CLI (values are read from your terminal, never typed into files):
```bash
gh secret set DOCKER_USERNAME
gh secret set DOCKER_PASSWORD
gh secret set DROPLET_HOST --body 139.59.90.145
gh secret set DROPLET_USER
gh secret set DROPLET_SSH_KEY < ~/.ssh/<your-deploy-key>
ssh-keyscan 139.59.90.145 | gh secret set DROPLET_KNOWN_HOSTS
```

| Variable (already set) | Value |
|---|---|
| `API_DOMAIN` | `bosch-agent.api.suryathink.com` |
| `APP_DOMAIN` | `bosch-agent.suryathink.com` |

### 6. First deploy
Actions tab → **Deploy Backend** → *Run workflow*, then **Deploy Frontend** → *Run workflow*.
After that, every push to `main` deploys whatever changed.

## Verify
```bash
curl https://bosch-agent.api.suryathink.com/api/health
# {"ok":true,...,"vector_store":{"type":"qdrant","vectors":2261},"persistence":{"mongodb":true,...}}
```
Open https://bosch-agent.suryathink.com and ask a question; the answer should stream word by word.

## Operations
| Task | Command (on the server) |
|---|---|
| Backend logs | `docker logs -f product-agent-server` |
| App log files | `docker run --rm -v product-agent-logs:/logs alpine ls -la /logs` |
| Restart backend | `docker restart product-agent-server` |
| Roll back backend | Re-run *Deploy Backend* for an older commit, or `bash deploy-server.sh suryathink/product-search-agent-server:sha-<old-commit>` |
| Roll back frontend | `ln -sfn /var/www/bosch-agent.suryathink.com/releases/<old-commit> /var/www/bosch-agent.suryathink.com/current` |
| Certificates | Renew automatically (`systemctl list-timers | grep certbot`) |

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| certbot fails | DNS not pointing to `139.59.90.145` yet; wait and re-run step 3 |
| Answers appear all at once, not streamed | Something buffers the stream: confirm the `location = /api/chat/stream` block (`proxy_buffering off`) is in the site config |
| `/api/health` shows `"mongodb": false` | Atlas Network Access doesn't include `139.59.90.145`, or `MONGO_URI` is missing in `server.env` |
| `/api/health` shows `"semantic_search": false` | Qdrant cluster suspended (free tier idles out) or `QDRANT_*` missing in `server.env`; search still works with keywords |
| Browser shows a CORS error | `CORS_ORIGINS` in `server.env` doesn't include `https://bosch-agent.suryathink.com` (or use `*`) |
| Deploy job: `Missing /opt/product-agent/server.env` | Do step 4 |
