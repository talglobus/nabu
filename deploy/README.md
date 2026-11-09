# deploy/

Running your own Nabu instance (gameplan §14.5): the web app and the API behind Caddy over HTTPS,
with Postgres. One `.env` file configures it.

| File | What |
|---|---|
| `compose.yaml` | Postgres, the API, Caddy with the web app; optional `llm` (Ollama) and `speech` profiles |
| `Caddyfile` | HTTPS for your domain; the app and the API on one origin |
| `api.Dockerfile`, `web.Dockerfile`, `speech.Dockerfile` | The images, built from the repository root |
| `.env.example` | Every setting, with what it does |
| `smoke.sh` | A running instance, end to end: sign up, upload, sync, export, delete |
| `firebase/` | Rules for the report intake (ADR 0055), merged into a shared project's |
| `pages/` | The GitHub Pages demo (local-only) |

## Run it

On a server with Docker, and a domain pointing at it (ports 80 and 443 open):

```sh
git clone https://github.com/iwsfutcmd/nabu && cd nabu
cp deploy/.env.example deploy/.env      # set NABU_DOMAIN and POSTGRES_PASSWORD at least
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
deploy/smoke.sh https://your.domain     # optional: checks the instance end to end
```

- **HTTPS:** Caddy gets a certificate for `NABU_DOMAIN` by itself. The microphone and the
  service worker need a secure context.
- **Trying it on your own machine:** `NABU_DOMAIN=localhost` makes Caddy use its own local CA.
  `smoke.sh` skips certificate checks for localhost. A browser needs the CA trusted first
  (`docker compose -f deploy/compose.yaml exec web caddy trust`); until then it refuses the
  service worker.
- **The database:** migrations run when the API starts. Postgres keeps its data in the
  `postgres` volume.
- **API binding:** Compose sets `NABU_HOST=0.0.0.0` inside the API container without publishing
  its port to the host. Standalone API processes default to `127.0.0.1`. The `--dev` flag always
  uses loopback and separate `NABU_DEV_DATABASE_URL` / `NABU_DEV_PGLITE` settings.
- **Test routes:** startup rejects `NABU_TEST_HOOKS=1` when `NODE_ENV=production`.
- **Abuse limits** are on (ADR 0067). Caddy passes the client's address; `NABU_RATE_LIMITS=off`
  turns them off.
- **Minors:** if the instance may serve them, set `NABU_MIN_AGE` (ADR 0069). Sign-up then asks the
  person's age, neutrally, and keeps nothing of it. Which age is right depends on where you serve.

## Options

- **Leagues, reminders, review:** `NABU_LEAGUES`, `NABU_PUSH` and `NABU_ADMIN_TOKEN` in `.env`
  (see `.env.example`).
- **Reviewers** (ADR 0074): with `NABU_ADMIN_TOKEN` set, make an account a reviewer of some
  courses (`["*"]`: all):

  ```sh
  curl -X PUT https://<host>/admin/v1/reviewers -H "Authorization: Bearer $NABU_ADMIN_TOKEN" \
    -H "Content-Type: application/json" -d '{"email": "…", "handle": "…", "courses": ["fa"]}'
  ```

  They review from the app's course list. Their sign-offs come out of
  `GET /admin/v1/signoffs?course=fa`, a file `nabu review apply` takes as it is. Approved reports
  come out of `GET /admin/v1/reports.jsonl?status=approved`, for `nabu reports promote`.
- **Game rules** (§12): to change them, mount a `game.json` into both the web image
  (`/srv/www/game.json`) and the API (set `NABU_GAME` to its path). The API checks the file when
  it starts.
- **A local model** for the AI features: `--profile llm` starts Ollama. Pull a model
  (`docker compose … exec ollama ollama pull <model>`), then set `NABU_LLM=ollama`,
  `NABU_LLM_URL=http://ollama:11434` and `NABU_LLM_MODEL`. The judge stays off until evaluations
  open its gates (`evals/`).
- **Speech scoring**, tiers 1–2: `--profile speech` builds the speech service. CPU PyTorch and the
  recognizers make it several gigabytes, and CI does not build it. Then set
  `NABU_SPEECH_URL=http://speech:8790`.

## Back up and restore

```sh
# A dump, from the running instance (plain SQL; compress it as you like):
docker compose -f deploy/compose.yaml --env-file deploy/.env exec -T postgres \
  pg_dump -U nabu -d nabu --clean --if-exists > nabu-$(date +%F).sql

# Restore into a running instance (it replaces what is there):
docker compose -f deploy/compose.yaml --env-file deploy/.env exec -T postgres \
  psql -U nabu -d nabu < nabu-2026-11-06.sql
```

Everything an instance knows is in Postgres: accounts, the event logs, the review queues. The
`caddy-data` volume holds the certificates, which Caddy can always get again.

## Upgrade

```sh
git pull
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
```

Back up first. The API applies new migrations when it starts. Migrations are only ever added,
never edited (CLAUDE.md), so an upgrade never rewrites old data in place.
