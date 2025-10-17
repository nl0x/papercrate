# Papercrate

## Local Development

Use the provided `papercrate.tmux` to spin up the full stack in one tmux session:

```bash
tmux -f papercrate.tmux attach
```

This creates windows for the compose stack, frontend dev server, backend API, and background worker using the repository-relative paths defined in the tmux file. Detach with `Ctrl+b d` and reattach later with the same command.

## Backend Integration Tests

Integration tests require a running Postgres instance (and, optionally, Quickwit for OCR indexing). The repository includes a lightweight compose file for local runs:

```bash
docker compose -f docker-compose.test.yml up -d
export TEST_DATABASE_URL=postgres://papercrate:papercrate_test@localhost:5433/papercrate_test
# optional, enables Quickwit indexing jobs
export QUICKWIT_ENDPOINT=http://localhost:7280
export QUICKWIT_INDEX=documents
cargo test
```

Stop the database when you are done:

```bash
docker compose -f docker-compose.test.yml down
```

The compose service uses tmpfs storage, giving each test run a clean database.

## Runtime Dependencies

- `ocrmypdf` (optional but recommended): Used by the OCR worker to extract text from PDFs when no embedded text layer is available. Ensure it is installed and available on the worker hosts if OCR is desired.
- Quickwit (optional): The Quickwit indexer is used to ingest extracted text for search. Set `QUICKWIT_ENDPOINT` and `QUICKWIT_INDEX` in the environment when running workers if you want indexing jobs to run. The local compose file starts a Quickwit instance on `http://localhost:7280` and seeds the `documents` index automatically.

## Configuration

The backend reads its settings from environment variables (see `backend/.env` for local defaults). In particular:

- `DATABASE_URL` – connection string for the primary Postgres database (required).
- `DATABASE_MAX_POOL_SIZE` – optional override for the r2d2 connection pool size. Defaults to `2`; increase it in staging/production to match expected concurrency.

On startup each binary logs the effective configuration with secrets redacted (for example, the database password is masked). This makes it easier to confirm the runtime settings in staging without exposing credentials.

## Running Migrations in Kubernetes

The backend container image ships the `diesel` CLI, so schema migrations can be executed as a short-lived Job (or Helm hook) before rolling out new pods. Example manifest:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: papercrate-migrate
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: migrate
          image: ghcr.io/example/papercrate-backend:<TAG>
          command: ["/usr/local/bin/diesel", "migration", "run"]
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: papercrate-db
                  key: DATABASE_URL
```

Run the Job manually (`kubectl apply -f migrate-job.yaml`) or configure it as a Helm pre-install/pre-upgrade hook so migrations run automatically on each deployment. Once the Job succeeds, deploy/update the backend `Deployment` as usual.
