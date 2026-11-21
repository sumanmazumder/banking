-- Manual alternative to `npm run db:create`. Run as MySQL root, e.g.:
--   "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p < sql/init-database.sql
-- Replace the password before running. Tables are created by `npm run db:migrate` (see ../migrations).

CREATE DATABASE IF NOT EXISTS banking_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS banking_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'banking_app'@'localhost' IDENTIFIED BY 'REPLACE_WITH_STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON banking_db.*   TO 'banking_app'@'localhost';
GRANT ALL PRIVILEGES ON banking_test.* TO 'banking_app'@'localhost';
FLUSH PRIVILEGES;
