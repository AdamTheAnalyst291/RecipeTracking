-- What the weekly export (card S2) needs to read the whole database with SqlPackage, and
-- nothing more: it can read every table and every object's definition, and write nothing.
-- $(BACKUP_READER) is the database user's name (a sqlcmd variable). Safe to run again.
-- Used by ensureBackupReader (src/backupReader.ts) in the Deploy Prod workflow, and by
-- infra/scripts/tests/export-database.integration.sh, which proves it is enough.
ALTER ROLE db_datareader ADD MEMBER [$(BACKUP_READER)];
GRANT VIEW DEFINITION TO [$(BACKUP_READER)];
