require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./config/db');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// Splits `total` into `count` currency-safe (2-decimal) parts that always sum
// exactly to `total` — the last part absorbs any rounding remainder. This
// prevents the "Rs 0.02 left over" drift that plain division + toFixed(2)
// causes when splitting amounts across several installments.
function splitAmountEvenly(total, count) {
    const sign = total < 0 ? -1 : 1;
    const absTotal = Math.abs(total);
    const base = Math.floor((absTotal / count) * 100) / 100;
    const parts = new Array(count).fill(sign * base);
    const allocated = base * (count - 1);
    parts[count - 1] = sign * parseFloat((absTotal - allocated).toFixed(2));
    return parts;
}

// Loads an organization's custom price brackets, cheapest first.
async function getPriceCategories(organizationId) {
    const [rows] = await db.execute(
        'SELECT id, name, max_price FROM price_category WHERE organization_id = ? ORDER BY max_price ASC',
        [organizationId]
    );
    return rows;
}

// Assigns an asset to the smallest bracket whose max_price covers its base_cost.
// Anything above every defined bracket is labeled "Above <highest max_price>".
function computePriceCategory(baseCost, categories) {
    const cost = parseFloat(baseCost);
    for (const cat of categories) {
        if (cost <= parseFloat(cat.max_price)) return cat.name;
    }
    if (categories.length > 0) {
        return `Above ${parseFloat(categories[categories.length - 1].max_price).toLocaleString()}`;
    }
    return null;
}

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const GUEST_SESSION_DAYS = 90;
const APP_TOKEN_SECRET = process.env.APP_TOKEN_SECRET || 'replace-this-development-secret-before-production';
const parseCookies = (request) => Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map((value) => { const [key, ...rest] = value.trim().split('='); return [key, decodeURIComponent(rest.join('='))]; }));
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const createPublicToken = () => crypto.randomBytes(32).toString('hex');
const signAppToken = (payload) => { const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url'); const signature = crypto.createHmac('sha256', APP_TOKEN_SECRET).update(encoded).digest('base64url'); return `${encoded}.${signature}`; };
const readAppToken = (request) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token || !token.includes('.')) return null;
    const [encoded, signature] = token.split('.');
    const expected = crypto.createHmac('sha256', APP_TOKEN_SECRET).update(encoded).digest('base64url');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try { const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()); return payload.exp > Date.now() ? payload : null; } catch { return null; }
};
const requireAppUser = (request, response) => { const user = readAppToken(request); if (!user) { response.status(401).json({ message: 'Please sign in again.' }); return null; } return user; };

async function getGuestOrganization(token) {
    const [rows] = await db.execute('SELECT id, name, guest_qr_token FROM organization WHERE guest_qr_token = ?', [token]);
    return rows[0] || null;
}

async function getGuestInventory(organizationId) {
    const [rows] = await db.execute(`SELECT p.id, p.name, p.block, p.size, p.sale_price, p.description, s.name AS society_name FROM plot p JOIN society s ON p.society_id = s.id WHERE s.organization_id = ? AND p.is_sold = FALSE AND p.is_private = FALSE ORDER BY s.name, p.block, p.name`, [organizationId]);
    return rows;
}

function setGuestCookie(response, token) {
    response.cookie('estatemaster_guest', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: GUEST_SESSION_DAYS * 24 * 60 * 60 * 1000, path: '/api/guest' });
}

// --- FILE UPLOADS (organization logo, client photos) ---
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const logoDir = path.join(__dirname, 'uploads', 'logos');
const clientDir = path.join(__dirname, 'uploads', 'clients');
fs.mkdirSync(logoDir, { recursive: true });
fs.mkdirSync(clientDir, { recursive: true });

// Serve everything in /uploads at http://your-server/uploads/...
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const logoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, logoDir),
    filename: (req, file, cb) => cb(null, `org-${req.params.id}-${Date.now()}${path.extname(file.originalname)}`),
});
const uploadLogo = multer({ storage: logoStorage });

const clientPhotoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, clientDir),
    filename: (req, file, cb) => cb(null, `client-${req.params.id}-${Date.now()}${path.extname(file.originalname)}`),
});
const uploadClientPhoto = multer({ storage: clientPhotoStorage });

// Basic test route
app.get('/', (req, res) => {
    res.send('Backend is running!');
});

// --- ORGANISATION QR & PUBLIC GUEST ACCESS ---

app.get('/api/organizations/:id/guest-qr', async (req, res) => {
    try {
        const [organizations] = await db.execute('SELECT id, guest_qr_token FROM organization WHERE id = ?', [req.params.id]);
        if (organizations.length === 0) return res.status(404).json({ message: 'Organization not found' });
        let token = organizations[0].guest_qr_token;
        if (!token) {
            token = createPublicToken();
            await db.execute('UPDATE organization SET guest_qr_token = ? WHERE id = ?', [token, req.params.id]);
        }
        res.json({ token });
    } catch (error) {
        res.status(500).json({ message: 'Unable to create QR access token.' });
    }
});

app.get('/api/guest/:token', async (req, res) => {
    try {
        const organization = await getGuestOrganization(req.params.token);
        if (!organization) return res.status(404).json({ message: 'This guest QR code is invalid or has expired.' });
        const sessionToken = parseCookies(req).estatemaster_guest;
        let guest = null;
        if (sessionToken) {
            const [sessions] = await db.execute(`SELECT gc.id, gc.name, gc.phone_number FROM guest_session gs JOIN guest_customer gc ON gc.id = gs.guest_customer_id WHERE gs.organization_id = ? AND gs.token_hash = ? AND gs.expires_at > NOW()`, [organization.id, hashToken(sessionToken)]);
            guest = sessions[0] || null;
            if (guest) await db.execute('UPDATE guest_session SET last_seen_at = NOW() WHERE token_hash = ?', [hashToken(sessionToken)]);
        }
        res.json({ organization: { name: organization.name }, guest, inventory: guest ? await getGuestInventory(organization.id) : [] });
    } catch (error) {
        res.status(500).json({ message: 'Unable to open guest access.' });
    }
});

app.post('/api/guest/:token/register', async (req, res) => {
    try {
        const organization = await getGuestOrganization(req.params.token);
        if (!organization) return res.status(404).json({ message: 'This guest QR code is invalid or has expired.' });
        const { name, phone_number, cnic, city, interests = [] } = req.body;
        if (!name?.trim() || !phone_number?.trim()) return res.status(400).json({ message: 'Name and phone number are required.' });
        if (!Array.isArray(interests)) return res.status(400).json({ message: 'Property interests must be a list.' });
        const cleanCnic = cnic?.trim() || null;
        // QR visits are identified by phone number. Reuse that client silently.
        const [clientMatches] = await db.execute('SELECT id FROM client WHERE organization_id = ? AND phone_number = ? LIMIT 1', [organization.id, phone_number.trim()]);
        let clientId;
        if (clientMatches.length) {
            clientId = clientMatches[0].id;
            await db.execute('UPDATE client SET name = ?, phone_number = ?, cnic = ?, city = ?, interests = ? WHERE id = ?', [name.trim(), phone_number.trim(), cleanCnic, city?.trim() || null, JSON.stringify(interests), clientId]);
        } else {
            const [clientResult] = await db.execute('INSERT INTO client (name, phone_number, cnic, organization_id, city, interests) VALUES (?, ?, ?, ?, ?, ?)', [name.trim(), phone_number.trim(), cleanCnic, organization.id, city?.trim() || null, JSON.stringify(interests)]);
            clientId = clientResult.insertId;
        }
        const [matches] = await db.execute('SELECT id FROM guest_customer WHERE organization_id = ? AND phone_number = ? LIMIT 1', [organization.id, phone_number.trim()]);
        let guestId;
        if (matches.length) {
            guestId = matches[0].id;
            await db.execute('UPDATE guest_customer SET name = ?, phone_number = ?, cnic = ?, client_id = ?, last_seen_at = NOW() WHERE id = ?', [name.trim(), phone_number.trim(), cleanCnic, clientId, guestId]);
        } else {
            const [result] = await db.execute('INSERT INTO guest_customer (organization_id, name, phone_number, cnic, client_id) VALUES (?, ?, ?, ?, ?)', [organization.id, name.trim(), phone_number.trim(), cleanCnic, clientId]);
            guestId = result.insertId;
        }
        const rawSessionToken = createPublicToken();
        await db.execute('INSERT INTO guest_session (organization_id, guest_customer_id, token_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))', [organization.id, guestId, hashToken(rawSessionToken), GUEST_SESSION_DAYS]);
        setGuestCookie(res, rawSessionToken);
        const [guests] = await db.execute('SELECT id, name, phone_number FROM guest_customer WHERE id = ?', [guestId]);
        res.status(201).json({ organization: { name: organization.name }, guest: guests[0], inventory: await getGuestInventory(organization.id) });
    } catch (error) {
        res.status(500).json({ message: 'Unable to register guest access.' });
    }
});

// Simple Login
app.post('/api/users/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const [users] = await db.execute(
            'SELECT id, name, email, password, role, organization_id FROM app_user WHERE email = ?',
            [email]
        );
        if (users.length === 0) return res.status(401).json({ message: 'Invalid email or password' });
        const user = users[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ message: 'Invalid email or password' });
        const { password: _pw, ...safeUser } = user;
        const accessToken = signAppToken({ id: user.id, role: user.role, organization_id: user.organization_id, exp: Date.now() + (7 * 24 * 60 * 60 * 1000) });
        res.json({ message: 'Login successful', user: safeUser, accessToken });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- USER MANAGEMENT ---

app.get('/api/users', async (req, res) => {
    try {
        const { organization_id } = req.query;
        const [rows] = await db.execute(
            'SELECT id, name, email, role FROM app_user WHERE organization_id = ?',
            [organization_id]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users', async (req, res) => {
    try {
        const { name, email, password, role, organization_id } = req.body;
        const [existing] = await db.execute(
            'SELECT id FROM app_user WHERE email = ?',
            [email]
        );
        if (existing.length > 0) {
            return res.status(400).json({ message: 'A user with this email already exists.' });
        }
        const hashed = await bcrypt.hash(password, 10);
        const [result] = await db.execute(
            'INSERT INTO app_user (name, email, password, role, organization_id) VALUES (?, ?, ?, ?, ?)',
            [name, email, hashed, role, organization_id]
        );
        res.status(201).json({ id: result.insertId, name, email, role, organization_id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    try {
        const [result] = await db.execute(
            'DELETE FROM app_user WHERE id = ?',
            [req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- SETTINGS: Reset Password ---
app.put('/api/users/:id/password', async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const [users] = await db.execute(
            'SELECT password FROM app_user WHERE id = ?',
            [req.params.id]
        );
        if (users.length === 0) return res.status(404).json({ message: 'User not found' });
        const match = await bcrypt.compare(currentPassword, users[0].password);
        if (!match) return res.status(401).json({ message: 'Current password is incorrect' });
        const hashed = await bcrypt.hash(newPassword, 10);
        await db.execute('UPDATE app_user SET password = ? WHERE id = ?', [hashed, req.params.id]);
        res.json({ message: 'Password updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- SETTINGS: Get organization ---
app.get('/api/organizations/:id', async (req, res) => {
    try {
        const [rows] = await db.execute(
            'SELECT id, name, contact, address, logo_url FROM organization WHERE id = ?',
            [req.params.id]
        );
        if (rows.length === 0) return res.status(404).json({ message: 'Organization not found' });
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- SETTINGS: Update organization ---
app.put('/api/organizations/:id', async (req, res) => {
    try {
        const { name, contact, address } = req.body;
        const [result] = await db.execute(
            'UPDATE organization SET name = ?, contact = ?, address = ? WHERE id = ?',
            [name, contact, address, req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Organization not found' });
        res.json({ message: 'Organization updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- SETTINGS: Upload organization logo ---
// Expects multipart/form-data with a single field named "logo"
app.post('/api/organizations/:id/logo', uploadLogo.single('logo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
        const logoUrl = `/uploads/logos/${req.file.filename}`;
        await db.execute('UPDATE organization SET logo_url = ? WHERE id = ?', [logoUrl, req.params.id]);
        res.json({ logo_url: logoUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- WALLET TRANSACTION ENDPOINTS ---

app.post('/api/transactions', async (req, res) => {
    try {
        const { amount, transaction_type, description, wallet_id, user_id, payment_method = 'cash' } = req.body;

        const [result] = await db.execute(
            'INSERT INTO wallet_transaction (amount, transaction_type, description, wallet_id, user_id, payment_method) VALUES (?, ?, ?, ?, ?, ?)',
            [amount, transaction_type, description, wallet_id, user_id, payment_method]
        );

        const operator = transaction_type.toLowerCase() === 'credit' ? '+' : '-';
        const subBalanceCol = payment_method === 'bank' ? 'bank_balance' : 'cash_balance';

        await db.execute(
            `UPDATE wallet SET balance = balance ${operator} ?, ${subBalanceCol} = ${subBalanceCol} ${operator} ? WHERE id = ?`,
            [amount, amount, wallet_id]
        );

        res.status(201).json({
            id: result.insertId, amount, transaction_type, message: 'Transaction saved & balance updated!'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/wallet/transactions', async (req, res) => {
    try {
        const { organization_id } = req.query;

        const [wallet] = await db.execute(
            'SELECT id, balance, bank_balance, cash_balance FROM wallet WHERE organization_id = ?',
            [organization_id]
        );
        if (wallet.length === 0) return res.status(404).json({ error: 'Wallet not found' });

        const { id: walletId, balance, bank_balance, cash_balance } = wallet[0];

        const [transactions] = await db.execute(
            'SELECT * FROM wallet_transaction WHERE wallet_id = ? ORDER BY id DESC',
            [walletId]
        );

        res.status(200).json({ transactions, walletId, balance, bank_balance, cash_balance });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/transactions/:wallet_id', async (req, res) => {
    try {
        const [transactions] = await db.execute(
            'SELECT * FROM wallet_transaction WHERE wallet_id = ? ORDER BY id DESC',
            [req.params.wallet_id]
        );
        res.status(200).json(transactions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/transactions/:id
// Updates only the description/remarks on a transaction receipt. Amount,
// transaction_type, and wallet balances are untouched — this is purely a
// label/note correction, not a financial change.
app.put('/api/transactions/:id', async (req, res) => {
    try {
        const { description } = req.body;
        const [result] = await db.execute(
            'UPDATE wallet_transaction SET description = ? WHERE id = ?',
            [description, req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Transaction not found' });
        res.json({ message: 'Description updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/transactions/:id', async (req, res) => {
    try {
        const transactionId = req.params.id;

        const [tx] = await db.execute(
            'SELECT amount, transaction_type, wallet_id, payment_method FROM wallet_transaction WHERE id = ?',
            [transactionId]
        );
        if (tx.length === 0) return res.status(404).json({ error: 'Transaction not found' });

        const { amount, transaction_type, wallet_id, payment_method } = tx[0];

        await db.execute('DELETE FROM wallet_transaction WHERE id = ?', [transactionId]);

        const operator = transaction_type.toLowerCase() === 'credit' ? '-' : '+';
        const subBalanceCol = (payment_method === 'bank') ? 'bank_balance' : 'cash_balance';

        await db.execute(
            `UPDATE wallet SET balance = balance ${operator} ?, ${subBalanceCol} = ${subBalanceCol} ${operator} ? WHERE id = ?`,
            [amount, amount, wallet_id]
        );

        res.status(200).json({ message: 'Transaction removed and balance reversed!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- SOCIETY ENDPOINTS ---

app.post('/api/societies', async (req, res) => {
    try {
        const { name, city, description, organization_id } = req.body;
        const [result] = await db.execute(
            'INSERT INTO society (name, city, description, organization_id) VALUES (?, ?, ?, ?)',
            [name, city, description, organization_id]
        );
        res.status(201).json({ id: result.insertId, name, city, description, organization_id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/societies', async (req, res) => {
    try {
        const { organization_id } = req.query;
        const [rows] = await db.execute(
            'SELECT * FROM society WHERE organization_id = ?',
            [organization_id]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/societies/:id', async (req, res) => {
    try {
        const { name, city, description } = req.body;
        const [result] = await db.execute(
            'UPDATE society SET name = ?, city = ?, description = ? WHERE id = ?',
            [name, city, description, req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Society not found' });
        res.json({ message: 'Society updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/societies/:id', async (req, res) => {
    try {
        const [plots] = await db.execute('SELECT COUNT(*) AS count FROM plot WHERE society_id = ?', [req.params.id]);
        const [houses] = await db.execute('SELECT COUNT(*) AS count FROM house WHERE society_id = ?', [req.params.id]);
        if (plots[0].count > 0 || houses[0].count > 0) return res.status(409).json({ message: 'This society has plots or houses. Delete or move them first.' });
        const [result] = await db.execute('DELETE FROM society WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Society not found' });
        res.json({ message: 'Society deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- PLOT ENDPOINTS ---

app.post('/api/plots', async (req, res) => {
    try {
        const { name, block, size, base_cost, sale_price, is_private = false, description, society_id } = req.body;
        const [existing] = await db.execute(
            'SELECT id FROM plot WHERE name = ? AND block = ? AND society_id = ?',
            [name, block, society_id]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'A plot with the same number and block already exists in this society.' });
        }
        const [result] = await db.execute(
            'INSERT INTO plot (name, block, size, base_cost, sale_price, is_private, description, society_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [name, block, size, base_cost, sale_price || null, Boolean(is_private), description, society_id]
        );
        res.status(201).json({
            id: result.insertId, name, block, size, base_cost, sale_price: sale_price || null, is_private: Boolean(is_private), is_sold: 0, description, society_id
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/plots', async (req, res) => {
    try {
        const { organization_id } = req.query;
        const [rows] = await db.execute(
            `SELECT p.*,
                CASE
                    WHEN p.is_sold = FALSE THEN 'available'
                    WHEN EXISTS (
                        SELECT 1 FROM client_plot cp
                        WHERE cp.plot_id = p.id AND cp.booking_type = 'purchase'
                        AND EXISTS (
                            SELECT 1 FROM installment i
                            WHERE i.client_plot_id = cp.id AND i.status != 'Paid'
                        )
                    ) THEN 'purchased'
                    ELSE 'sold'
                END AS status
             FROM plot p
             JOIN society s ON p.society_id = s.id
             WHERE s.organization_id = ?`,
            [organization_id]
        );
        const categories = await getPriceCategories(organization_id);
        res.json(rows.map((row) => ({ ...row, price_category: computePriceCategory(row.base_cost, categories) })));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/plots/:id', async (req, res) => {
    try {
        const { name, block, size, base_cost, sale_price, is_private = false, is_sold, description } = req.body;
        const [result] = await db.execute(
            'UPDATE plot SET name = ?, block = ?, size = ?, base_cost = ?, sale_price = ?, is_private = ?, is_sold = ?, description = ? WHERE id = ?',
            [name, block, size, base_cost, sale_price || null, Boolean(is_private), is_sold, description, req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Plot not found' });
        res.json({ message: 'Plot updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/plots/:id', async (req, res) => {
    try {
        const [bookings] = await db.execute('SELECT COUNT(*) AS count FROM client_plot WHERE plot_id = ?', [req.params.id]);
        if (bookings[0].count > 0) return res.status(409).json({ message: 'This plot has a sale or purchase record and cannot be deleted. Remove the booking first.' });
        const [result] = await db.execute('DELETE FROM plot WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Plot not found' });
        res.json({ message: 'Plot deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- PRIVATE PLOT STAKEHOLDERS ---

async function getAdminPlot(request, response) {
    const user = requireAppUser(request, response);
    if (!user) return null;
    if (user.role !== 'Admin') { response.status(403).json({ message: 'Only organization administrators can manage stakeholders.' }); return null; }
    const [plots] = await db.execute('SELECT p.id, p.name, s.organization_id FROM plot p JOIN society s ON s.id = p.society_id WHERE p.id = ? AND s.organization_id = ?', [request.params.id, user.organization_id]);
    if (!plots.length) { response.status(404).json({ message: 'Plot not found in your organization.' }); return null; }
    return { user, plot: plots[0] };
}

app.get('/api/plots/:id/stakeholders', async (req, res) => {
    try {
        const context = await getAdminPlot(req, res); if (!context) return;
        const [rows] = await db.execute('SELECT id, email, ownership_percentage, accepted_at, invited_at FROM plot_stakeholder WHERE plot_id = ? ORDER BY invited_at DESC', [context.plot.id]);
        res.json(rows);
    } catch (error) { res.status(500).json({ message: 'Unable to load stakeholders.' }); }
});

app.post('/api/plots/:id/stakeholders', async (req, res) => {
    try {
        const context = await getAdminPlot(req, res); if (!context) return;
        const email = req.body.email?.trim().toLowerCase();
        const percentage = Number(req.body.ownership_percentage);
        if (!email || !/^\S+@\S+\.\S+$/.test(email) || !Number.isFinite(percentage) || percentage <= 0 || percentage > 100) return res.status(400).json({ message: 'Enter a valid email and ownership percentage.' });
        const [totalRows] = await db.execute('SELECT COALESCE(SUM(ownership_percentage), 0) AS total FROM plot_stakeholder WHERE plot_id = ?', [context.plot.id]);
        if (Number(totalRows[0].total) + percentage > 100) return res.status(400).json({ message: 'Stakeholder percentages cannot exceed 100%.' });
        const [existing] = await db.execute('SELECT id FROM plot_stakeholder WHERE plot_id = ? AND email = ?', [context.plot.id, email]);
        if (existing.length) return res.status(409).json({ message: 'This email is already a stakeholder for the plot.' });
        const rawToken = createPublicToken();
        const [result] = await db.execute('INSERT INTO plot_stakeholder (plot_id, email, ownership_percentage, invitation_token_hash) VALUES (?, ?, ?, ?)', [context.plot.id, email, percentage, hashToken(rawToken)]);
        res.status(201).json({ id: result.insertId, email, ownership_percentage: percentage, invite_token: rawToken });
    } catch (error) { res.status(500).json({ message: 'Unable to add stakeholder.' }); }
});

app.delete('/api/plots/:id/stakeholders/:stakeholderId', async (req, res) => {
    try {
        const context = await getAdminPlot(req, res); if (!context) return;
        const [result] = await db.execute('DELETE FROM plot_stakeholder WHERE id = ? AND plot_id = ?', [req.params.stakeholderId, context.plot.id]);
        if (!result.affectedRows) return res.status(404).json({ message: 'Stakeholder not found.' });
        res.json({ message: 'Stakeholder removed.' });
    } catch (error) { res.status(500).json({ message: 'Unable to remove stakeholder.' }); }
});

app.get('/api/stakeholder-invites/:token', async (req, res) => {
    try {
        const [rows] = await db.execute(`SELECT ps.email, ps.ownership_percentage, ps.accepted_at, p.name AS plot_name, p.block, p.size, s.name AS society_name
            FROM plot_stakeholder ps JOIN plot p ON p.id = ps.plot_id JOIN society s ON s.id = p.society_id
            WHERE ps.invitation_token_hash = ?`, [hashToken(req.params.token)]);
        if (!rows.length) return res.status(404).json({ message: 'This invitation is invalid.' });
        res.json(rows[0]);
    } catch (error) { res.status(500).json({ message: 'Unable to open invitation.' }); }
});

app.post('/api/stakeholder-invites/:token/activate', async (req, res) => {
    try {
        const { name, password } = req.body;
        if (!name?.trim() || !password || password.length < 8) return res.status(400).json({ message: 'Name and a password of at least 8 characters are required.' });
        const [rows] = await db.execute(`SELECT ps.id, ps.email, ps.user_id, p.id AS plot_id, s.organization_id
            FROM plot_stakeholder ps JOIN plot p ON p.id = ps.plot_id JOIN society s ON s.id = p.society_id WHERE ps.invitation_token_hash = ?`, [hashToken(req.params.token)]);
        if (!rows.length) return res.status(404).json({ message: 'This invitation is invalid.' });
        const invite = rows[0];
        let userId = invite.user_id;
        if (!userId) {
            const [users] = await db.execute('SELECT id, role FROM app_user WHERE email = ?', [invite.email]);
            if (users.length && users[0].role !== 'Stakeholder') return res.status(409).json({ message: 'This email is already used by a staff account.' });
            if (users.length) userId = users[0].id;
            else {
                const [created] = await db.execute('INSERT INTO app_user (name, email, password, role, organization_id) VALUES (?, ?, ?, ?, ?)', [name.trim(), invite.email, await bcrypt.hash(password, 10), 'Stakeholder', invite.organization_id]);
                userId = created.insertId;
            }
            await db.execute('UPDATE plot_stakeholder SET user_id = ?, accepted_at = NOW(), invitation_token_hash = NULL WHERE id = ?', [userId, invite.id]);
        }
        res.json({ message: 'Account activated. You can now sign in.' });
    } catch (error) { res.status(500).json({ message: 'Unable to activate invitation.' }); }
});

app.get('/api/private-portfolio', async (req, res) => {
    try {
        const user = requireAppUser(req, res); if (!user) return;
        if (user.role !== 'Stakeholder') return res.status(403).json({ message: 'This area is for stakeholders only.' });
        const [plots] = await db.execute(`SELECT p.id, p.name, p.block, p.size, p.base_cost, p.sale_price, p.description, s.name AS society_name,
            ps.ownership_percentage, ps.accepted_at,
            (SELECT COUNT(*) FROM client_plot cp WHERE cp.plot_id = p.id) AS transaction_count,
            (SELECT COALESCE(SUM(cp.total_price), 0) FROM client_plot cp WHERE cp.plot_id = p.id) AS transaction_total,
            (SELECT COALESCE(SUM(i.amount_due - i.amount_paid), 0) FROM installment i JOIN client_plot cp ON cp.id = i.client_plot_id WHERE cp.plot_id = p.id AND i.status != 'Paid') AS amount_due
            FROM plot_stakeholder ps JOIN plot p ON p.id = ps.plot_id JOIN society s ON s.id = p.society_id
            WHERE ps.user_id = ? AND ps.accepted_at IS NOT NULL ORDER BY s.name, p.name`, [user.id]);
        res.json(plots);
    } catch (error) { res.status(500).json({ message: 'Unable to load private portfolio.' }); }
});

// --- HOUSE ENDPOINTS ---

app.post('/api/houses', async (req, res) => {
    try {
        const { name, block, size, base_cost, description, society_id } = req.body;
        const [existing] = await db.execute(
            'SELECT id FROM house WHERE name = ? AND block = ? AND society_id = ?',
            [name, block, society_id]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'A house with the same number and block already exists in this society.' });
        }
        const [result] = await db.execute(
            'INSERT INTO house (name, block, size, base_cost, description, society_id) VALUES (?, ?, ?, ?, ?, ?)',
            [name, block, size, base_cost, description, society_id]
        );
        res.status(201).json({
            id: result.insertId, name, block, size, base_cost, is_sold: 0, description, society_id
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/houses', async (req, res) => {
    try {
        const { organization_id } = req.query;
        const [rows] = await db.execute(
            `SELECT h.*,
                CASE
                    WHEN h.is_sold = FALSE THEN 'available'
                    WHEN EXISTS (
                        SELECT 1 FROM client_plot cp
                        WHERE cp.house_id = h.id AND cp.booking_type = 'purchase'
                        AND EXISTS (
                            SELECT 1 FROM installment i
                            WHERE i.client_plot_id = cp.id AND i.status != 'Paid'
                        )
                    ) THEN 'purchased'
                    ELSE 'sold'
                END AS status
             FROM house h
             JOIN society s ON h.society_id = s.id
             WHERE s.organization_id = ?`,
            [organization_id]
        );
        const categories = await getPriceCategories(organization_id);
        res.json(rows.map((row) => ({ ...row, price_category: computePriceCategory(row.base_cost, categories) })));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/houses/:id', async (req, res) => {
    try {
        const { name, block, size, base_cost, is_sold, description } = req.body;
        const [result] = await db.execute(
            'UPDATE house SET name = ?, block = ?, size = ?, base_cost = ?, is_sold = ?, description = ? WHERE id = ?',
            [name, block, size, base_cost, is_sold, description, req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: 'House not found' });
        res.json({ message: 'House updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/houses/:id', async (req, res) => {
    try {
        const [bookings] = await db.execute('SELECT COUNT(*) AS count FROM client_plot WHERE house_id = ?', [req.params.id]);
        if (bookings[0].count > 0) return res.status(409).json({ message: 'This house has a sale or purchase record and cannot be deleted. Remove the booking first.' });
        const [result] = await db.execute('DELETE FROM house WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'House not found' });
        res.json({ message: 'House deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- PRICE CATEGORY ENDPOINTS (org-defined price brackets, auto-applied to Plots & Houses) ---

app.post('/api/price-categories', async (req, res) => {
    try {
        const { name, max_price, organization_id } = req.body;
        const [result] = await db.execute(
            'INSERT INTO price_category (name, max_price, organization_id) VALUES (?, ?, ?)',
            [name, max_price, organization_id]
        );
        res.status(201).json({ id: result.insertId, name, max_price, organization_id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/price-categories', async (req, res) => {
    try {
        const { organization_id } = req.query;
        const categories = await getPriceCategories(organization_id);
        res.json(categories);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/price-categories/:id', async (req, res) => {
    try {
        const { name, max_price } = req.body;
        const [result] = await db.execute(
            'UPDATE price_category SET name = ?, max_price = ? WHERE id = ?',
            [name, max_price, req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Price category not found' });
        res.json({ message: 'Price category updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/price-categories/:id', async (req, res) => {
    try {
        const [result] = await db.execute('DELETE FROM price_category WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Price category not found' });
        res.json({ message: 'Price category deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- CLIENT ENDPOINTS ---

app.post('/api/clients', async (req, res) => {
    try {
        const { name, phone_number, cnic, organization_id, city, interests = [] } = req.body;
        if (!name?.trim() || !phone_number?.trim()) return res.status(400).json({ message: 'Client name and phone number are required.' });
        const [existing] = await db.execute(
            'SELECT id, name FROM client WHERE organization_id = ? AND phone_number = ? LIMIT 1',
            [organization_id, phone_number.trim()]
        );
        if (existing.length > 0) {
            return res.status(409).json({ message: `${existing[0].name} already exists for this phone number.` });
        }
        const [result] = await db.execute(
            'INSERT INTO client (name, phone_number, cnic, organization_id, city, interests) VALUES (?, ?, ?, ?, ?, ?)',
            [name.trim(), phone_number.trim(), cnic || null, organization_id, city?.trim() || null, JSON.stringify(interests)]
        );
        res.status(201).json({
            id: result.insertId, name, phone_number, cnic, organization_id, city, interests
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'A client with this phone number already exists.' });
        }
        res.status(500).json({ error: error.message });
    }
});

// MUST be above /:id/bookings
app.get('/api/clients/directory', async (req, res) => {
    try {
        const { organization_id } = req.query;
        const [rows] = await db.execute(`
            SELECT
                c.id, c.name, c.phone_number, c.cnic, c.photo_url, c.city, c.interests,
                COUNT(cp.id) AS active_files
            FROM client c
            LEFT JOIN client_plot cp ON c.id = cp.client_id
            WHERE c.organization_id = ?
            GROUP BY c.id
        `, [organization_id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/clients/:id/bookings', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT
                cp.id,
                cp.total_price,
                cp.downpayment,
                cp.booking_date,
                cp.cycles,
                COALESCE(p.name, h.name) AS plot_name,
                COALESCE(p.block, h.block) AS plot_block,
                COALESCE(p.size, h.size) AS plot_size,
                IF(cp.house_id IS NOT NULL, 'house', 'plot') AS asset_type,
                s.name AS society_name
            FROM client_plot cp
            LEFT JOIN plot p ON cp.plot_id = p.id
            LEFT JOIN house h ON cp.house_id = h.id
            JOIN society s ON s.id = COALESCE(p.society_id, h.society_id)
            WHERE cp.client_id = ?
            ORDER BY cp.booking_date DESC
        `, [req.params.id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/clients', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM client');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/clients/:id', async (req, res) => {
    try {
        const { name, phone_number, cnic, city, interests = [] } = req.body;
        if (!name?.trim() || !phone_number?.trim()) return res.status(400).json({ message: 'Client name and phone number are required.' });
        const [result] = await db.execute(
            'UPDATE client SET name = ?, phone_number = ?, cnic = ?, city = ?, interests = ? WHERE id = ?',
            [name.trim(), phone_number.trim(), cnic || null, city?.trim() || null, JSON.stringify(interests), req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Client not found' });
        res.json({ message: 'Client updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- CLIENTS: Upload client photo ---
// Expects multipart/form-data with a single field named "photo"
app.post('/api/clients/:id/photo', uploadClientPhoto.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
        const photoUrl = `/uploads/clients/${req.file.filename}`;
        await db.execute('UPDATE client SET photo_url = ? WHERE id = ?', [photoUrl, req.params.id]);
        res.json({ photo_url: photoUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/clients/:id', async (req, res) => {
    try {
        const [bookings] = await db.execute('SELECT COUNT(*) AS count FROM client_plot WHERE client_id = ?', [req.params.id]);
        if (bookings[0].count > 0) return res.status(409).json({ message: 'This client has sale or purchase records and cannot be deleted. Remove those bookings first.' });
        const [result] = await db.execute('DELETE FROM client WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Client not found' });
        res.json({ message: 'Client deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- SALES PAGE DATA FETCH ENDPOINTS ---

app.get('/api/sales/form-data', async (req, res) => {
    try {
        const { society_id, organization_id } = req.query;
        const [clients] = await db.execute(
            'SELECT id, name, phone_number, cnic, photo_url FROM client WHERE organization_id = ?',
            [organization_id]
        );
        const [societies] = await db.execute(
            'SELECT id, name, city FROM society WHERE organization_id = ?',
            [organization_id]
        );
        let plots, houses;
        if (society_id) {
            [plots] = await db.execute(
                'SELECT id, name, block, size, base_cost FROM plot WHERE society_id = ? AND is_sold = FALSE',
                [society_id]
            );
            [houses] = await db.execute(
                'SELECT id, name, block, size, base_cost FROM house WHERE society_id = ? AND is_sold = FALSE',
                [society_id]
            );
        } else {
            [plots] = await db.execute(
                `SELECT p.id, p.name, p.block, p.size, p.base_cost FROM plot p
                 JOIN society s ON p.society_id = s.id
                 WHERE s.organization_id = ? AND p.is_sold = FALSE`,
                [organization_id]
            );
            [houses] = await db.execute(
                `SELECT h.id, h.name, h.block, h.size, h.base_cost FROM house h
                 JOIN society s ON h.society_id = s.id
                 WHERE s.organization_id = ? AND h.is_sold = FALSE`,
                [organization_id]
            );
        }
        const categories = await getPriceCategories(organization_id);
        plots = plots.map((p) => ({ ...p, price_category: computePriceCategory(p.base_cost, categories) }));
        houses = houses.map((h) => ({ ...h, price_category: computePriceCategory(h.base_cost, categories) }));
        res.json({ clients, societies, plots, houses });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- PURCHASE PAGE DATA FETCH (mirrors /api/sales/form-data, same availability filter) ---

app.get('/api/purchases/form-data', async (req, res) => {
    try {
        const { society_id, organization_id } = req.query;
        const [clients] = await db.execute(
            'SELECT id, name, phone_number, cnic, photo_url FROM client WHERE organization_id = ?',
            [organization_id]
        );
        const [societies] = await db.execute(
            'SELECT id, name, city FROM society WHERE organization_id = ?',
            [organization_id]
        );
        let plots, houses;
        if (society_id) {
            [plots] = await db.execute(
                'SELECT id, name, block, size, base_cost FROM plot WHERE society_id = ? AND is_sold = FALSE',
                [society_id]
            );
            [houses] = await db.execute(
                'SELECT id, name, block, size, base_cost FROM house WHERE society_id = ? AND is_sold = FALSE',
                [society_id]
            );
        } else {
            [plots] = await db.execute(
                `SELECT p.id, p.name, p.block, p.size, p.base_cost FROM plot p
                 JOIN society s ON p.society_id = s.id
                 WHERE s.organization_id = ? AND p.is_sold = FALSE`,
                [organization_id]
            );
            [houses] = await db.execute(
                `SELECT h.id, h.name, h.block, h.size, h.base_cost FROM house h
                 JOIN society s ON h.society_id = s.id
                 WHERE s.organization_id = ? AND h.is_sold = FALSE`,
                [organization_id]
            );
        }
        const categories = await getPriceCategories(organization_id);
        plots = plots.map((p) => ({ ...p, price_category: computePriceCategory(p.base_cost, categories) }));
        houses = houses.map((h) => ({ ...h, price_category: computePriceCategory(h.base_cost, categories) }));
        res.json({ clients, societies, plots, houses });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/bookings', async (req, res) => {
    const conn = await db.getConnection();
    try {
        const {
            total_price,
            downpayment,
            agreed_commission,
            booking_date,
            cycles,
            client_id,
            plot_id,
            house_id,
            user_id,
            payment_method = 'cash',
            notes = null,
        } = req.body;

        const assetTable = house_id ? 'house' : 'plot';
        const assetId = house_id || plot_id;
        const assetLabel = house_id ? 'House' : 'Plot';
        if (!assetId) throw new Error('Either plot_id or house_id is required');

        const isInstallment = cycles && cycles > 0;

        await conn.beginTransaction();

        const [assetCheck] = await conn.execute(`SELECT is_sold FROM ${assetTable} WHERE id = ?`, [assetId]);
        if (assetCheck.length === 0) throw new Error(`${assetLabel} not found`);
        if (assetCheck[0].is_sold) throw new Error(`${assetLabel} not available for sale — already sold or purchase installments pending`);

        const [bookingResult] = await conn.execute(
            'INSERT INTO client_plot (total_price, downpayment, agreed_commission, booking_date, cycles, client_id, plot_id, house_id, user_id, payment_method, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [total_price, downpayment, agreed_commission, booking_date, cycles ?? 0, client_id, plot_id || null, house_id || null, user_id, payment_method, notes]
        );
        const bookingId = bookingResult.insertId;

        await conn.execute(`UPDATE ${assetTable} SET is_sold = TRUE WHERE id = ?`, [assetId]);

        if (isInstallment) {
            const remainingAmount = parseFloat(total_price) - parseFloat(downpayment);
            const installmentAmounts = splitAmountEvenly(remainingAmount, cycles);
            for (let i = 1; i <= cycles; i++) {
                const dueDate = new Date(booking_date);
                dueDate.setMonth(dueDate.getMonth() + i);
                await conn.execute(
                    'INSERT INTO installment (amount_due, amount_paid, due_date, status, client_plot_id) VALUES (?, 0.00, ?, ?, ?)',
                    [installmentAmounts[i - 1], dueDate.toISOString().split('T')[0], 'Pending', bookingId]
                );
            }
        }

        const [wallet] = await conn.execute(
            'SELECT id FROM wallet WHERE organization_id = (SELECT organization_id FROM app_user WHERE id = ?)',
            [user_id]
        );
        if (wallet.length === 0) throw new Error('No wallet found');
        const walletId = wallet[0].id;

        const [clientRow] = await conn.execute('SELECT name FROM client WHERE id = ?', [client_id]);
        const [assetRow] = await conn.execute(`SELECT name FROM ${assetTable} WHERE id = ?`, [assetId]);
        const clientName = clientRow[0]?.name || 'Unknown';
        const assetName = assetRow[0]?.name || 'Unknown';

        const txAmount = isInstallment ? downpayment : total_price;
        const subBalanceCol = payment_method === 'bank' ? 'bank_balance' : 'cash_balance';

        await conn.execute(
            'INSERT INTO wallet_transaction (amount, transaction_type, description, wallet_id, user_id, payment_method) VALUES (?, ?, ?, ?, ?, ?)',
            [txAmount, 'credit', `${clientName} - ${assetLabel} ${assetName}`, walletId, user_id, payment_method]
        );

        await conn.execute(
            `UPDATE wallet SET balance = balance + ?, ${subBalanceCol} = ${subBalanceCol} + ? WHERE id = ?`,
            [txAmount, txAmount, walletId]
        );

        await conn.commit();

        res.status(201).json({
            id: bookingId,
            message: isInstallment
                ? `Booked with ${cycles} installments generated.`
                : 'Booked with full payment.',
        });
    } catch (error) {
        await conn.rollback();
        res.status(500).json({ error: error.message });
    } finally {
        conn.release();
    }
});

// --- PURCHASE BOOKING (mirrors /api/bookings, reversed wallet direction) ---

app.post('/api/purchases', async (req, res) => {
    const conn = await db.getConnection();
    try {
        const {
            total_price,
            downpayment,
            agreed_commission,
            booking_date,
            cycles,
            client_id,
            plot_id,
            house_id,
            user_id,
            payment_method = 'cash',
        } = req.body;

        const assetTable = house_id ? 'house' : 'plot';
        const assetId = house_id || plot_id;
        const assetLabel = house_id ? 'House' : 'Plot';
        if (!assetId) throw new Error('Either plot_id or house_id is required');

        const isInstallment = cycles && cycles > 0;
        const amountNow = isInstallment ? parseFloat(downpayment) : parseFloat(total_price);

        await conn.beginTransaction();

        const [assetCheck] = await conn.execute(`SELECT is_sold FROM ${assetTable} WHERE id = ?`, [assetId]);
        if (assetCheck.length === 0) throw new Error(`${assetLabel} not found`);
        if (assetCheck[0].is_sold) throw new Error(`${assetLabel} not available for purchase — already sold or mid-purchase`);

        const [wallet] = await conn.execute(
            'SELECT id, bank_balance, cash_balance FROM wallet WHERE organization_id = (SELECT organization_id FROM app_user WHERE id = ?)',
            [user_id]
        );
        if (wallet.length === 0) throw new Error('No wallet found');
        const walletId = wallet[0].id;
        const subBalanceCol = payment_method === 'bank' ? 'bank_balance' : 'cash_balance';
        const availableBalance = parseFloat(wallet[0][subBalanceCol]);

        if (amountNow > availableBalance) {
            throw new Error(`Insufficient ${payment_method} balance. Available: Rs ${availableBalance.toLocaleString()}, Required: Rs ${amountNow.toLocaleString()}`);
        }

        const [bookingResult] = await conn.execute(
            'INSERT INTO client_plot (total_price, downpayment, agreed_commission, booking_date, cycles, client_id, plot_id, house_id, user_id, booking_type, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [total_price, downpayment, agreed_commission, booking_date, cycles ?? 0, client_id, plot_id || null, house_id || null, user_id, 'purchase', payment_method]
        );
        const bookingId = bookingResult.insertId;

        // Installment purchase: lock the asset from being sold until fully paid off.
        // Full-payment purchase: asset stays available (is_sold already FALSE) for immediate resale.
        if (isInstallment) {
            await conn.execute(`UPDATE ${assetTable} SET is_sold = TRUE WHERE id = ?`, [assetId]);

            const remainingAmount = parseFloat(total_price) - parseFloat(downpayment);
            const installmentAmounts = splitAmountEvenly(remainingAmount, cycles);
            for (let i = 1; i <= cycles; i++) {
                const dueDate = new Date(booking_date);
                dueDate.setMonth(dueDate.getMonth() + i);
                await conn.execute(
                    'INSERT INTO installment (amount_due, amount_paid, due_date, status, client_plot_id) VALUES (?, 0.00, ?, ?, ?)',
                    [installmentAmounts[i - 1], dueDate.toISOString().split('T')[0], 'Pending', bookingId]
                );
            }
        }

        const [clientRow] = await conn.execute('SELECT name FROM client WHERE id = ?', [client_id]);
        const [assetRow] = await conn.execute(`SELECT name FROM ${assetTable} WHERE id = ?`, [assetId]);
        const clientName = clientRow[0]?.name || 'Unknown';
        const assetName = assetRow[0]?.name || 'Unknown';

        await conn.execute(
            'INSERT INTO wallet_transaction (amount, transaction_type, description, wallet_id, user_id, payment_method) VALUES (?, ?, ?, ?, ?, ?)',
            [amountNow, 'debit', `Purchase - ${clientName} - ${assetLabel} ${assetName}`, walletId, user_id, payment_method]
        );

        await conn.execute(
            `UPDATE wallet SET balance = balance - ?, ${subBalanceCol} = ${subBalanceCol} - ? WHERE id = ?`,
            [amountNow, amountNow, walletId]
        );

        await conn.commit();

        res.status(201).json({
            id: bookingId,
            message: isInstallment
                ? `Purchase booked with ${cycles} installments generated.`
                : 'Purchase completed with full payment.',
        });
    } catch (error) {
        await conn.rollback();
        res.status(400).json({ error: error.message });
    } finally {
        conn.release();
    }
});

// PUT /api/bookings/:id
// Updates booking_date, total_price, downpayment.
// Recalculates amount_due on all Pending/Partial installments automatically.
app.put('/api/bookings/:id', async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { id } = req.params;
        const { booking_date, total_price, downpayment } = req.body;

        await conn.beginTransaction();

        await conn.execute(
            'UPDATE client_plot SET booking_date = ?, total_price = ?, downpayment = ? WHERE id = ?',
            [booking_date, total_price, downpayment, id]
        );

        const [allInsts] = await conn.execute(
            'SELECT * FROM installment WHERE client_plot_id = ? ORDER BY due_date ASC',
            [id]
        );

        if (allInsts.length > 0) {
            const pendingInsts = allInsts.filter(
                (i) => i.status === 'Pending' || i.status === 'Partial'
            );

            if (pendingInsts.length > 0) {
                const paidInstTotal = allInsts
                    .filter((i) => i.status === 'Paid')
                    .reduce((sum, i) => sum + parseFloat(i.amount_paid), 0);

                const remaining = parseFloat(total_price) - parseFloat(downpayment) - paidInstTotal;
                const newAmounts = splitAmountEvenly(remaining, pendingInsts.length);

                for (let idx = 0; idx < pendingInsts.length; idx++) {
                    await conn.execute(
                        'UPDATE installment SET amount_due = ? WHERE id = ?',
                        [newAmounts[idx], pendingInsts[idx].id]
                    );
                }
            }
        }

        await conn.commit();
        res.json({ message: 'Booking updated successfully' });
    } catch (error) {
        await conn.rollback();
        res.status(500).json({ error: error.message });
    } finally {
        conn.release();
    }
});

// DELETE /api/bookings/:id
// Removes a mistakenly-created booking: deletes its installment schedule
// and the booking record itself. Wallet balance and asset status are left
// untouched — this is a simple record removal, not a financial reversal.
app.delete('/api/bookings/:id', async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { id } = req.params;
        await conn.beginTransaction();

        const [bookingRows] = await conn.execute('SELECT id FROM client_plot WHERE id = ?', [id]);
        if (bookingRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ error: 'Booking not found' });
        }

        await conn.execute('DELETE FROM installment WHERE client_plot_id = ?', [id]);
        await conn.execute('DELETE FROM client_plot WHERE id = ?', [id]);

        await conn.commit();
        res.json({ message: 'Booking deleted successfully.' });
    } catch (error) {
        await conn.rollback();
        res.status(500).json({ error: error.message });
    } finally {
        conn.release();
    }
});

// --- REPORTS ---

app.get('/api/reports', async (req, res) => {
    try {
        const { organization_id } = req.query;
        const [rows] = await db.execute(`
            SELECT
                cp.id, cp.total_price, cp.downpayment, cp.agreed_commission,
                cp.booking_date, cp.cycles, cp.is_confirmed, cp.booking_type, cp.payment_method, cp.notes,
                c.id AS client_id,
                c.name AS client_name, c.phone_number AS client_phone, c.cnic AS client_cnic, c.photo_url AS client_photo,
                COALESCE(p.name, h.name) AS plot_name,
                COALESCE(p.block, h.block) AS plot_block,
                COALESCE(p.size, h.size) AS plot_size,
                IF(cp.house_id IS NOT NULL, 'house', 'plot') AS asset_type,
                s.name AS society_name,
                (SELECT COUNT(*) FROM installment i WHERE i.client_plot_id = cp.id AND i.status = 'Paid') AS paid_count,
                (SELECT COUNT(*) FROM installment i WHERE i.client_plot_id = cp.id AND i.status = 'Pending') AS pending_count,
                (SELECT COUNT(*) FROM installment i WHERE i.client_plot_id = cp.id) AS total_count
            FROM client_plot cp
            JOIN client c ON cp.client_id = c.id
            LEFT JOIN plot p ON cp.plot_id = p.id
            LEFT JOIN house h ON cp.house_id = h.id
            JOIN society s ON s.id = COALESCE(p.society_id, h.society_id)
            WHERE c.organization_id = ?
            ORDER BY cp.booking_date DESC
        `, [organization_id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- INSTALLMENTS ---

app.get('/api/installments/:client_plot_id', async (req, res) => {
    try {
        const { client_plot_id } = req.params;
        const [rows] = await db.execute(
            'SELECT * FROM installment WHERE client_plot_id = ? ORDER BY due_date ASC',
            [client_plot_id]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PATCH /api/installments/:id/pay
// Records a payment against an installment. Any shortfall or surplus versus
// amount_due is spread evenly across the remaining Pending/Partial siblings.
// If this was the last unpaid installment and it's still short, a new
// installment row is auto-created for the remaining balance, due 1 month later.
// For purchase-type bookings, the wallet is debited instead of credited, an
// insufficient-balance check is applied, and the asset (plot or house) is unlocked
// (is_sold = FALSE) once every installment on the booking is fully paid.
app.patch('/api/installments/:id/pay', async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { id } = req.params;
        const { amount_paid, user_id, payment_method } = req.body;

        await conn.beginTransaction();

        const [rows] = await conn.execute(`
            SELECT i.*, c.name as client_name, COALESCE(p.name, h.name) as plot_name,
                   cp.booking_type, cp.payment_method AS booking_payment_method, cp.house_id
            FROM installment i
            JOIN client_plot cp ON i.client_plot_id = cp.id
            JOIN client c ON cp.client_id = c.id
            LEFT JOIN plot p ON cp.plot_id = p.id
            LEFT JOIN house h ON cp.house_id = h.id
            WHERE i.id = ?`, [id]);

        if (rows.length === 0) throw new Error('Installment not found');
        const installment = rows[0];

        const newAmountPaid = parseFloat(installment.amount_paid) + parseFloat(amount_paid);
        const status = newAmountPaid >= parseFloat(installment.amount_due) ? 'Paid' : 'Partial';

        await conn.execute(
            'UPDATE installment SET amount_paid = ?, status = ? WHERE id = ?',
            [newAmountPaid, status, id]
        );

        // ── Auto-adjust remaining installments for any shortfall/surplus on this payment ──
        const diff = parseFloat(installment.amount_due) - newAmountPaid; // >0 shortfall, <0 surplus
        if (diff !== 0) {
            const [allInsts] = await conn.execute(
                'SELECT * FROM installment WHERE client_plot_id = ? ORDER BY due_date ASC',
                [installment.client_plot_id]
            );

            // Is this installment the last one in the schedule by due_date?
            const maxDueDate = allInsts.reduce(
                (max, i) => (new Date(i.due_date) > new Date(max) ? i.due_date : max),
                allInsts[0].due_date
            );
            const isLastInstallment = new Date(installment.due_date).getTime() === new Date(maxDueDate).getTime();

            if (isLastInstallment && status === 'Partial') {
                // Last installment in the schedule is still short: add one extra row for the shortfall,
                // regardless of whether earlier installments are Paid or Partial.
                const lastDueDate = new Date(installment.due_date);
                lastDueDate.setMonth(lastDueDate.getMonth() + 1);
                const newDueDate = lastDueDate.toISOString().split('T')[0];

                await conn.execute(
                    'INSERT INTO installment (amount_due, amount_paid, due_date, status, client_plot_id) VALUES (?, 0.00, ?, ?, ?)',
                    [diff, newDueDate, 'Pending', installment.client_plot_id]
                );
            } else {
                // Not the last installment: spread the shortfall/surplus evenly across remaining Pending/Partial
                // siblings, with the final sibling absorbing any rounding remainder so totals stay exact.
                const siblings = allInsts.filter(
                    (i) => i.id !== parseInt(id) && (i.status === 'Pending' || i.status === 'Partial')
                );
                if (siblings.length > 0) {
                    const shares = splitAmountEvenly(diff, siblings.length);
                    for (let idx = 0; idx < siblings.length; idx++) {
                        const sib = siblings[idx];
                        const newDue = Math.max(0, parseFloat(sib.amount_due) + shares[idx]);
                        await conn.execute(
                            'UPDATE installment SET amount_due = ? WHERE id = ?',
                            [newDue, sib.id]
                        );
                    }
                }
            }
        }

        const [wallet] = await conn.execute(
            'SELECT id, bank_balance, cash_balance FROM wallet WHERE organization_id = (SELECT organization_id FROM app_user WHERE id = ?)',
            [user_id]
        );
        if (wallet.length === 0) throw new Error('No wallet found');
        const walletId = wallet[0].id;

        // Default to the payment method chosen at booking time, unless explicitly overridden
        const effectivePaymentMethod = payment_method || installment.booking_payment_method || 'cash';
        const subBalanceCol = effectivePaymentMethod === 'bank' ? 'bank_balance' : 'cash_balance';
        const isPurchase = installment.booking_type === 'purchase';

        if (isPurchase) {
            const availableBalance = parseFloat(wallet[0][subBalanceCol]);
            if (parseFloat(amount_paid) > availableBalance) {
                throw new Error(`Insufficient ${effectivePaymentMethod} balance. Available: Rs ${availableBalance.toLocaleString()}, Required: Rs ${parseFloat(amount_paid).toLocaleString()}`);
            }
        }

        // If this was a purchase installment and all installments for this booking are now Paid,
        // the asset is fully bought out — unlock it for future sale.
        if (isPurchase && status === 'Paid') {
            const [remaining] = await conn.execute(
                `SELECT COUNT(*) AS cnt FROM installment WHERE client_plot_id = ? AND status != 'Paid'`,
                [installment.client_plot_id]
            );
            if (remaining[0].cnt === 0) {
                const assetTable = installment.house_id ? 'house' : 'plot';
                const assetIdCol = installment.house_id ? 'house_id' : 'plot_id';
                await conn.execute(
                    `UPDATE ${assetTable} SET is_sold = FALSE WHERE id = (SELECT ${assetIdCol} FROM client_plot WHERE id = ?)`,
                    [installment.client_plot_id]
                );
            }
        }

        await conn.execute(
            'INSERT INTO wallet_transaction (amount, transaction_type, description, wallet_id, user_id, payment_method) VALUES (?, ?, ?, ?, ?, ?)',
            [amount_paid, isPurchase ? 'debit' : 'credit', `${isPurchase ? 'Purchase - ' : ''}${installment.client_name} - Plot ${installment.plot_name}`, walletId, user_id, effectivePaymentMethod]
        );

        await conn.execute(
            `UPDATE wallet SET balance = balance ${isPurchase ? '-' : '+'} ?, ${subBalanceCol} = ${subBalanceCol} ${isPurchase ? '-' : '+'} ? WHERE id = ?`,
            [amount_paid, amount_paid, walletId]
        );

        await conn.commit();
        res.json({ message: `Installment marked as ${status}` });
    } catch (error) {
        await conn.rollback();
        res.status(500).json({ error: error.message });
    } finally {
        conn.release();
    }
});

// PUT /api/installments/:id
// Updates due_date and/or amount_due on a single installment row.
// If amount_due changes, redistributes the remaining balance across all other
// Pending/Partial sibling installments automatically.
app.put('/api/installments/:id', async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { id } = req.params;
        const { due_date, amount_due } = req.body;

        await conn.beginTransaction();

        const [instRows] = await conn.execute(
            'SELECT * FROM installment WHERE id = ?',
            [id]
        );
        if (instRows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ error: 'Installment not found' });
        }
        const inst = instRows[0];

        const newDueDate = due_date ?? inst.due_date;
        const newAmountDue = amount_due !== undefined ? parseFloat(amount_due) : parseFloat(inst.amount_due);

        await conn.execute(
            'UPDATE installment SET due_date = ?, amount_due = ? WHERE id = ?',
            [newDueDate, newAmountDue, id]
        );

        // If amount_due changed, recalculate sibling Pending/Partial installments
        if (amount_due !== undefined && parseFloat(amount_due) !== parseFloat(inst.amount_due)) {
            const [bookingRows] = await conn.execute(
                'SELECT total_price, downpayment FROM client_plot WHERE id = ?',
                [inst.client_plot_id]
            );
            if (bookingRows.length > 0) {
                const { total_price, downpayment } = bookingRows[0];

                const [allInsts] = await conn.execute(
                    'SELECT * FROM installment WHERE client_plot_id = ? ORDER BY due_date ASC',
                    [inst.client_plot_id]
                );

                const paidTotal = allInsts
                    .filter((i) => i.status === 'Paid')
                    .reduce((sum, i) => sum + parseFloat(i.amount_paid), 0);

                const totalRemaining = parseFloat(total_price) - parseFloat(downpayment) - paidTotal;

                const siblings = allInsts.filter(
                    (i) => i.id !== parseInt(id) &&
                    (i.status === 'Pending' || i.status === 'Partial')
                );

                if (siblings.length > 0) {
                    const siblingTotal = totalRemaining - newAmountDue;
                    const siblingAmounts = splitAmountEvenly(siblingTotal, siblings.length);
                    for (let idx = 0; idx < siblings.length; idx++) {
                        await conn.execute(
                            'UPDATE installment SET amount_due = ? WHERE id = ?',
                            [siblingAmounts[idx], siblings[idx].id]
                        );
                    }
                }
            }
        }

        await conn.commit();
        res.json({ message: 'Installment updated successfully' });
    } catch (error) {
        await conn.rollback();
        res.status(500).json({ error: error.message });
    } finally {
        conn.release();
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
