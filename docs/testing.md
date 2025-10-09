# Integration Test Setup

The backend integration tests talk to a real Postgres database. To spin up an ephemeral instance locally, use the dedicated compose file:

```bash
docker compose -f docker-compose.test.yml up -d
```

This starts Postgres on port `5433` with the database/user both named `papercrate` and password `papercrate_test`. Point the test harness at it:

```bash
export TEST_DATABASE_URL=postgres://papercrate:papercrate_test@localhost:5433/papercrate_test
```

Run the tests as usual:

```bash
cargo test
```

When you are done, stop the container:

```bash
docker compose -f docker-compose.test.yml down
```

The compose file uses a tmpfs volume, so each run starts with a clean database.
