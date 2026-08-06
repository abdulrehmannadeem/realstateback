-- Existing client-profile changes. Run the ADD statements only if these columns
-- are not already present in your deployed database.
ALTER TABLE client ADD COLUMN city VARCHAR(100) NULL;
ALTER TABLE client ADD COLUMN interests JSON NULL;
-- Run only if the deployed database still has this legacy client field.
ALTER TABLE client DROP COLUMN default_commission;
-- Client identity is organisation-scoped: CNIC is optional and a phone can be
-- registered once in each organisation.
ALTER TABLE client DROP INDEX cnic;
ALTER TABLE client ADD UNIQUE INDEX uq_client_phone_per_organization (organization_id, phone_number);

-- Organisation QR identity.
ALTER TABLE organization ADD COLUMN guest_qr_token CHAR(64) NULL;
ALTER TABLE organization ADD UNIQUE INDEX uq_organization_guest_qr_token (guest_qr_token);

-- Guest contacts are organisation-scoped and are not application users.
CREATE TABLE guest_customer (
  id INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  phone_number VARCHAR(50) NOT NULL,
  cnic VARCHAR(50) NULL,
  client_id INT NULL,
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_guest_phone_per_organization (organization_id, phone_number),
  CONSTRAINT fk_guest_customer_organization FOREIGN KEY (organization_id) REFERENCES organization(id),
  CONSTRAINT fk_guest_customer_client FOREIGN KEY (client_id) REFERENCES client(id)
);

-- Raw session tokens are never stored here: only SHA-256 token hashes.
CREATE TABLE guest_session (
  id INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  guest_customer_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_guest_session_lookup (organization_id, token_hash),
  CONSTRAINT fk_guest_session_organization FOREIGN KEY (organization_id) REFERENCES organization(id),
  CONSTRAINT fk_guest_session_customer FOREIGN KEY (guest_customer_id) REFERENCES guest_customer(id)
);
