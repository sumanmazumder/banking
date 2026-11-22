-- Phase 1: Foundation & Auth (SRS sections 5.1, 5.2, 8, 10)

CREATE TABLE users (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  public_id           CHAR(36)     NOT NULL,
  email               VARCHAR(255) NOT NULL,
  mobile              VARCHAR(20)  NULL,
  password_hash       VARCHAR(255) NOT NULL,
  role                ENUM('super_admin','admin','finance_officer','auditor','customer') NOT NULL DEFAULT 'customer',
  status              ENUM('draft','kyc_pending','under_review','active','rejected','suspended','closed') NOT NULL DEFAULT 'draft',
  full_name           VARCHAR(150) NOT NULL,
  email_verified_at   DATETIME NULL,
  mobile_verified_at  DATETIME NULL,
  consent_accepted_at DATETIME NULL,
  failed_login_count  INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until        DATETIME NULL,
  last_login_at       DATETIME NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_public_id (public_id),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_mobile (mobile),
  KEY idx_users_role_status (role, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per login/device. id is the `sid` claim inside the access token.
CREATE TABLE user_sessions (
  id                        CHAR(36)     NOT NULL PRIMARY KEY,
  user_id                   BIGINT UNSIGNED NOT NULL,
  refresh_token_hash        CHAR(64)     NOT NULL,
  prev_refresh_token_hash   CHAR(64)     NULL,   -- previous token, kept to detect replay/reuse
  token_family_id           CHAR(36)     NOT NULL,
  device_name               VARCHAR(120) NULL,
  browser                   VARCHAR(80)  NULL,
  os                        VARCHAR(80)  NULL,
  ip_address                VARCHAR(64)  NULL,   -- stored masked
  user_agent                VARCHAR(512) NULL,
  is_active                 TINYINT(1)   NOT NULL DEFAULT 1,
  created_at                DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at                DATETIME     NOT NULL,
  revoked_at                DATETIME     NULL,
  revoked_reason            VARCHAR(100) NULL,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  KEY idx_sessions_user_active (user_id, is_active),
  KEY idx_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Denylist so a logged-out access token stops working immediately, until its natural exp.
CREATE TABLE revoked_tokens (
  jti         CHAR(36) NOT NULL PRIMARY KEY,
  session_id  CHAR(36) NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  expires_at  DATETIME NOT NULL,
  revoked_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_revoked_jti_exp (jti, expires_at),
  KEY idx_revoked_exp (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Email / mobile OTPs (hashed), FR-CUS-02
CREATE TABLE otp_verifications (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  channel     ENUM('email','mobile') NOT NULL,
  purpose     ENUM('verify','password_reset') NOT NULL DEFAULT 'verify',
  code_hash   CHAR(64) NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at  DATETIME NOT NULL,
  consumed_at DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_otp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  KEY idx_otp_lookup (user_id, channel, purpose, consumed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_profiles (
  user_id         BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  customer_number VARCHAR(20) NULL,
  address         VARCHAR(500) NULL,
  date_of_birth   DATE NULL,
  kyc_status      ENUM('not_started','pending','under_review','approved','rejected') NOT NULL DEFAULT 'not_started',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_customer_number (customer_number),
  CONSTRAINT fk_profile_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only audit trail (FR-ADM-05). Application code only INSERTs.
CREATE TABLE audit_logs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_id    BIGINT UNSIGNED NULL,
  actor_role  VARCHAR(30) NULL,
  session_id  CHAR(36) NULL,
  action      VARCHAR(100) NOT NULL,
  entity      VARCHAR(60)  NULL,
  entity_id   VARCHAR(64)  NULL,
  before_json JSON NULL,
  after_json  JSON NULL,
  reason      VARCHAR(500) NULL,
  ip_address  VARCHAR(64)  NULL,
  user_agent  VARCHAR(512) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_actor (actor_id, created_at),
  KEY idx_audit_entity (entity, entity_id),
  KEY idx_audit_action (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

admin@example.com
Smn@12345678