# Warehouse

dbt builds the `marts` schema inside the kitchen app's own Azure SQL database, from the app's own tables (ADR-28, card W1). There is no separate warehouse database and no export step.

- `models/staging/_sources.yml`: the app's tables in `dbo`, including the daily `pantry_snapshot` (card K4).
- `models/staging/stg_*.sql`: one view per source table, with renamed columns and money also in dollars. The marts in cards W2a and W2b build on these.
- `models/staging/_staging.yml` and `tests/`: the dbt tests. They gate every build.
- `macros/generate_schema_name.sql`: everything builds in `marts`, whatever schema a model names.
- `profiles.yml`: two targets. `fixture` is a throwaway SQL Server with a SQL login. `azure` signs in with the Azure CLI's session.
- `requirements.txt`: dbt-core and dbt-sqlserver, pinned with hashes. To change a version, edit `requirements.in` and recompile it as its header says. Dependabot bumps it monthly.

## Who can do what

The nightly build signs in as `kitchen-github-<env>-warehouse`, and the Deploy Dev migration step gives it its database rights. `packages/db/sql/warehouse-builder.sql` grants them:

- `SELECT` on `dbo`, so it can read the app tables and write none. Two things are denied: the bank connection tables (`plaid_*`) and `user.entra_object_id`.
- Ownership of `marts`, plus `CREATE TABLE` and `CREATE VIEW`. It can build, rebuild and drop objects in `marts` only, because creating in any other schema also needs `ALTER` on that schema.

`marts` is owned by the builder, not by `dbo`. That breaks the ownership chain from its views to the app's tables, so a view in `marts` can't be used to write app data. `packages/db/src/warehouseBuilder.test.ts` checks this.

One consequence for W3: a reader with `SELECT` on `marts` alone can read the marts *tables*, but not the staging *views*, because those views read `dbo` with the reader's own rights. The MCP's analytics tools should read mart tables.

## CI

- **Pull request workflow, "dbt build against fixtures"**: runs `scripts/fixture-build.sh`. It applies the migrations to a throwaway SQL Server and loads `fixtures/fixture-data.sql`. Then it runs `dbt build` as a login that has only the warehouse builder grants. Last, it breaks one row to prove the tests catch it.
- **Warehouse nightly** (`.github/workflows/warehouse-nightly.yml`): at 08:40 UTC it runs `dbt build --target azure` against Dev. When a build fails it sends a phone alert through ntfy (`scripts/alert.sh`). The alert goes to the topic in the vault's `ntfy-topic` secret, the same one the bank sync uses. On pull requests, and from **Run workflow** with *dry run* ticked, it does a dry run instead: it installs dbt, parses the project for the Azure target, lists what would build and shows the alert, but signs in to nothing.

Setup steps for Adam are in `infra/README.md`, under "Warehouse".

## Run it locally

You need Python 3.13, the Microsoft ODBC driver for SQL Server (17 or 18), and a SQL Server container. From the repository root, in Git Bash:

```bash
python -m venv .venv-dbt && .venv-dbt/Scripts/pip install -r warehouse/requirements.in
docker run -d --name kitchen-warehouse-sql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Kitchen_Test_1!' -p 14338:1433 mcr.microsoft.com/mssql/server:2022-CU20-ubuntu-22.04
MSYS_NO_PATHCONV=1 \
SQLCMD='docker exec kitchen-warehouse-sql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P Kitchen_Test_1!' \
SQL_SERVER=localhost SQL_PORT=14338 SQL_ODBC_DRIVER='ODBC Driver 17 for SQL Server' \
DBT=.venv-dbt/Scripts/dbt bash warehouse/scripts/fixture-build.sh
```

On Windows, install from `requirements.in`, not `requirements.txt`: the hashes in `requirements.txt` are for the Linux runners. `MSYS_NO_PATHCONV=1` stops Git Bash from rewriting the container's sqlcmd path.

To build against Dev as yourself, run `az login` and then `dbt build --profiles-dir . --target azure` from `warehouse/`, with `SQL_SERVER` set. Your own account needs database rights for that. Day to day, leave Dev's builds to the nightly workflow.
