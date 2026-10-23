-- Executed by the official postgres image only when the data volume is empty.
-- Creates a separate database for integration tests so they never touch
-- development data. It is owned by POSTGRES_USER (the user running this script).
CREATE DATABASE pickup_counter_test;

-- Marker that designates this database as disposable. The test setup refuses to
-- reset any database that does not carry exactly this comment
-- (see backend/tests/helpers/testDatabase.ts). The comment is stored in the
-- server catalog, so it survives the schema reset done before each test run.
COMMENT ON DATABASE pickup_counter_test IS 'pickup-counter:disposable-test-database';
