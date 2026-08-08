-- Run once after the existing inventory migration.
-- Run these two statements only if the columns do not already exist.
ALTER TABLE plot ADD COLUMN is_private BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE plot ADD COLUMN sale_price DECIMAL(15,2) NULL;

CREATE TABLE IF NOT EXISTS plot_stakeholder (
  id INT AUTO_INCREMENT PRIMARY KEY,
  plot_id INT NOT NULL,
  email VARCHAR(255) NOT NULL,
  ownership_percentage DECIMAL(5,2) NOT NULL,
  user_id INT NULL,
  invitation_token_hash CHAR(64) NULL,
  invited_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TIMESTAMP NULL,
  UNIQUE KEY uq_plot_stakeholder_email (plot_id, email),
  INDEX idx_plot_stakeholder_user (user_id),
  CONSTRAINT chk_plot_stakeholder_percentage CHECK (ownership_percentage > 0 AND ownership_percentage <= 100)
);
