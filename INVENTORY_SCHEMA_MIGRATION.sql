-- Run once on databases created before Houses and Price Categories were added.
-- No foreign key is used for house_id so this remains compatible with older
-- deployments whose existing ID types differ.

CREATE TABLE IF NOT EXISTS house (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  block VARCHAR(50),
  size VARCHAR(50),
  base_cost DECIMAL(15,2) NOT NULL,
  is_sold BOOLEAN DEFAULT FALSE,
  description TEXT,
  society_id INT NOT NULL,
  INDEX idx_house_society (society_id)
);

CREATE TABLE IF NOT EXISTS price_category (
  id INT AUTO_INCREMENT PRIMARY KEY,
  organization_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  max_price DECIMAL(15,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_price_category_org (organization_id)
);

ALTER TABLE client_plot MODIFY COLUMN plot_id INT NULL;
ALTER TABLE client_plot ADD COLUMN IF NOT EXISTS house_id INT NULL AFTER plot_id;
ALTER TABLE client_plot ADD INDEX IF NOT EXISTS idx_client_plot_house (house_id);
