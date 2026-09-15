# Deploying

The app is one Node process that serves **both** the API and the built site on one port. That is deliberate: the
router uses history mode (`createWebHistory`), so the SPA fallback and the API have to live on the same origin — and
so does the session cookie (`SameSite=Lax`), which is what makes login work without any CORS or cookie-domain
configuration.

```
VPS
├─ caddy     :80/:443   automatic HTTPS + compression, in front of everything
└─ app       :8787      /            the built SPA (web/dist)
                        /api         the JSON API
                        /data/app.db SQLite, on a host volume
```

---

## What the VPS needs

* **1 vCPU, 1 GB RAM, 10 GB disk** is comfortable. 512 MB is not: the image build runs Vite, which gets OOM-killed.
  Debian 12 or Ubuntu 22.04+ are the safe choices.
* **Docker with the Compose v2 plugin.** The compose file uses v2 syntax, so the old Python `docker-compose` will not
  work. Install with:

  ```bash
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" && newgrp docker     # or prefix everything with sudo
  docker compose version                               # must print "Docker Compose version v2.x"
  ```

* **Ports 80 and 443 open — in the host firewall *and* in your provider's security group**, if it has one. This is
  the single most common reason the certificate never issues. Nothing else needs to be open: the app port 8787 is
  published on loopback only.

  ```bash
  sudo ufw allow 80,443/tcp        # if ufw is enabled
  ```

* **A domain with an A record pointing at the VPS**, which you need for automatic HTTPS and later for WeChat. You can
  dry-run on the bare IP first (below).

## Getting the code

```bash
git clone https://github.com/Quasimurdock/portfolio.git
cd portfolio
```

The repository is public, so no credentials are needed on the server. (For a private copy, add a deploy key and clone
over `git@github.com:…` instead.)

---

## The short version

On a VPS with Docker (and a domain whose A record already points at it):

```bash
git clone https://github.com/Quasimurdock/portfolio.git portfolio && cd portfolio
cp deploy/.env.example .env      # set DOMAIN and COOKIE_SECRET
docker compose up -d --build
```

That is the whole deployment. First boot seeds a fresh database, Caddy fetches a Let's Encrypt certificate for
`DOMAIN`, and the site is at `https://DOMAIN` with the back office at `https://DOMAIN/admin`.

Generate the cookie secret with `openssl rand -base64 48`. The only two settings you must not leave as-is are
`DOMAIN` and `COOKIE_SECRET`.

### Then, immediately: make yourself an account

The seed ships demo accounts whose password (`portfolio`) is in the README, so the first thing to do on a real
server is create your own and disable theirs:

```bash
docker compose exec app node server/src/cli.js users
docker compose exec app node server/src/cli.js create --email you@example.com --name "You" --role owner
# prints a generated password once — paste it into the sign-in form and change it
for e in owner editor author viewer; do
  docker compose exec app node server/src/cli.js status --email $e@portfolio.test --set disabled
done
```

Sign in at `https://DOMAIN/admin`, then optionally clear the demo content (keeps users, roles and sections):

```bash
docker compose exec app node server/src/cli.js wipe-content --yes
```

### Verify the deployment

The repo ships the API test used during development. It creates and deletes its own article, so it is safe to run:

```bash
docker compose exec app node scripts/smoke.mjs     # expects 36 passed, 0 failed
```

Health check, if you prefer curl: `curl -s localhost:8787/api/health` → `{"ok":true,...}` (the app port is published
on loopback only, so it is not reachable from outside).

### Want to see it before touching DNS? Dry-run on the IP

Caddy cannot get a certificate for a bare IP, so serve plain HTTP for the test — and **turn Secure cookies off**
while you do, because with `HTTPS=1` the browser silently drops the session cookie over HTTP and sign-in looks
broken (you land back on the login page with no error):

```bash
sed -i 's/^HTTPS=.*/HTTPS=0/' .env                 # otherwise login silently fails over HTTP
sed -i 's/^DOMAIN=.*/DOMAIN=:80/' .env             # ":80" = plain HTTP, no certificate
docker compose up -d --build
curl -s localhost:8787/api/health                  # from the box
# then browse http://<your-vps-ip>/
```

Move back to the real thing once DNS resolves: set `DOMAIN=your.domain`, `HTTPS=1`, and `docker compose up -d`
again (Caddy will fetch the certificate).

---

## Without Docker

Works the same way on a bare VPS — Node 20 and Caddy, no containers:

```bash
sudo useradd --system --create-home --home-dir /srv/portfolio portfolio
sudo -u portfolio git clone https://github.com/Quasimurdock/portfolio.git /srv/portfolio
cd /srv/portfolio
sudo -u portfolio npm ci
sudo -u portfolio npm --workspace web run build     # writes web/dist — the site the API serves
sudo -u portfolio npm run seed                      # skips if server/data/app.db already exists
cp deploy/.env.example .env                         # edit DOMAIN, COOKIE_SECRET, DATABASE_FILE=./data/app.db
sudo cp deploy/portfolio.service /etc/systemd/system/
sudo systemctl enable --now portfolio
```

`deploy/portfolio.service` runs the API as the `portfolio` user, restarting on failure. Point Caddy at it — copy
`deploy/Caddyfile` to `/etc/caddy/Caddyfile` and change `reverse_proxy app:8787` to
`reverse_proxy 127.0.0.1:8787` — then `sudo systemctl reload caddy`.

The CLI is the same, without the `docker compose exec app` prefix: `npm --workspace server run cli -- users`.

---

## Updating

```bash
git pull
docker compose up -d --build      # rebuilds the image, restarts, leaves ./data alone
```

The database is a file on the host (`./data/app.db`), so a deploy never touches content. Migrations are not a thing
yet: `server/src/schema.sql` is applied on every boot with `CREATE TABLE IF NOT EXISTS`, so additive changes land
automatically, but a change to an existing column needs a migration you write yourself.

## Backups

Everything that matters is one file plus one folder:

```bash
docker compose exec app node -e "require('better-sqlite3')" >/dev/null   # (sanity: the container is alive)
tar czf portfolio-$(date +%F).tar.gz data/                               # the SQLite database
```

`data/` contains `app.db` and its WAL sidecar; copying the folder while the app runs is fine because SQLite
checkpoints on its own, but for a guaranteed-consistent snapshot stop the app for a second
(`docker compose stop app && tar czf … data/ && docker compose start app`). For continuous replication,
[litestream](https://litestream.io) understands this exact setup and needs no application changes.

Images are **not** in that backup: they live on OSS/CDN and the database only stores their URLs, so back up the
bucket separately (or enable versioning on it).

## WeChat login in production

1. Register the domain in the WeChat 开放平台 console (网站应用 for QR sign-in, or 公众号 for in-app).
2. Set `WECHAT_APP_ID`, `WECHAT_APP_SECRET`, and
   `WECHAT_REDIRECT_URI=https://DOMAIN/api/auth/wechat/callback`.
3. **Leave `WECHAT_MOCK` unset.** It follows `WECHAT_APP_ID` on its own: while the app id is empty mock is on (so a
   fresh deploy works with no credentials at all), and once a real app id is present the callback really calls
   `api.weixin.qq.com`. Setting `WECHAT_MOCK=0` with an empty app id breaks the callback with
   `wechat_not_configured` (HTTP 500) — the most common false alarm on a new deployment.
4. New WeChat users are created with `WECHAT_DEFAULT_ROLE` (`author`): they can write their own drafts but cannot
   publish.

## OSS in production

The server never stores image bytes; it signs uploads. With `OSS_PROVIDER=mock` the admin's upload button works but
only records URLs. For real uploads set `OSS_ACCESS_KEY_ID`, `OSS_ACCESS_KEY_SECRET`, `OSS_BUCKET`, `OSS_REGION`
and `OSS_PUBLIC_BASE`, then allow the admin origin in the bucket's CORS rules — the browser posts the file straight
to the bucket.

## Troubleshooting

| symptom | what it is |
|---|---|
| Caddy logs `no such host`, or the certificate never issues | the A record does not point at this box yet, or 80/443 are closed upstream (provider security group, not just ufw) |
| `bind: address already in use` on 80/443 | the VPS image ships nginx or apache: `sudo systemctl disable --now nginx` |
| `docker compose` → "is not a docker command" | only the legacy `docker-compose` is installed; you need the v2 plugin |
| Sign-in appears to do nothing, you bounce back to the login page | the cookie is `Secure` but you are on plain HTTP — set `HTTPS=0` (see the IP dry-run above) |
| The smoke test's two WeChat checks fail (`HTTP 500`, then `unauthorized`) | `WECHAT_MOCK=0` while `WECHAT_APP_ID` is empty, so the callback tries to reach WeChat with no credentials. Comment the line out and `docker compose up -d --force-recreate app`; `docker compose logs app` says `wechat_not_configured` |
| `docker compose exec app …` → "service is not running" | the app is restarting because of a boot error: `docker compose logs app` |
| The image build is very slow, or fails fetching packages | the repo ships `.npmrc` pointing at a Chinese mirror. It works worldwide, but if you would rather use the default registry, delete the `COPY … .npmrc` line in the `Dockerfile` |
| Build killed, exit code 137 | out of memory — Vite needs roughly 1 GB to build |
| Everything works but the site is empty | expected after `cli wipe-content`, or if you have only saved drafts: the public API serves **published** rows only. Add and publish content in `/admin` |

## Known limits

* **One instance only.** SQLite plus in-process sessions means you run exactly one app container; scale vertically.
* **No password reset by email.** There is no mail server, so `cli passwd` is the reset path. Invitations created in
  the admin return a one-time token, and `cli passwd --email <invitee>` is what turns that invitation into a usable
  account.
* **No rate limiting** on the API. Put Caddy (or a firewall) in front if the admin will be exposed to the open
  internet.
* **Run as root inside the container.** It keeps the bind-mounted `./data` volume writable without ownership
  juggling; switch to a named volume plus `USER node` if you prefer.
* The image ships dev dependencies too (simpler, larger). `npm prune --omit=dev` in the runtime stage would shrink it.
