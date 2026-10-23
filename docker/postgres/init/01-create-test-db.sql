-- Executed by the official postgres image only when the data volume is empty.
-- Creates a separate database for integration tests so they never touch
-- development data. It is owned by POSTGRES_USER (the user running this script).
CREATE DATABASE pickup_counter_test;
