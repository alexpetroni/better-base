#!/bin/bash
# Runs once on a fresh volume. POSTGRES_DB (better_sleep) already exists;
# create the other per-site database and the integration-test database.
set -euo pipefail

for db in better_life better_test; do
	psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
		-c "CREATE DATABASE $db OWNER $POSTGRES_USER;"
done
