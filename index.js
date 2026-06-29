require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./config/db');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Basic test route
app.get('/', (req, res) => {
    res.send('Backend is running!');
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
        res.json({ message: 'Login successful', user: safeUser });
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
            'SELECT id, name, contact, address FROM organization WHERE id = ?',
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

// --- WALLET TRANSACTION ENDPOINTS ---

// POST /api/transactions
// Accepts payment_method ('cash' | 'bank'), updates total balance + the respective sub-balance
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

// GET /api/wallet/transactions
// Returns wallet balances (total, bank, cash) + all transactions for the org
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

// GET /api/transactions/:wallet_id
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

// DELETE /api/transactions/:id
// Reads payment_method from the row and reverses both total balance and the correct sub-balance
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

        // Reverse: credit was +, so on delete we -, and vice versa
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
        const { name, block, size, base_cost, description, society_id } = req.body;
        const [existing] = await db.execute(
            'SELECT id FROM plot WHERE name = ? AND block = ? AND society_id = ?',
            [name, block, society_id]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'A plot with the same number and block already exists in this society.' });
        }
        const [result] = await db.execute(
            'INSERT INTO plot (name, block, size, base_cost, description, society_id) VALUES (?, ?, ?, ?, ?, ?)',
            [name, block, size, base_cost, description, society_id]
        );
        res.status(201).json({
            id: result.insertId, name, block, size, base_cost, is_sold: 0, description, society_id
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/plots', async (req, res) => {
    try {
        const { organization_id } = req.query;
        const [rows] = await db.execute(
            `SELECT p.* FROM plot p
             JOIN society s ON p.society_id = s.id
             WHERE s.organization_id = ?`,
            [organization_id]
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/plots/:id', async (req, res) => {
    try {
        const { name, block, size, base_cost, is_sold, description } = req.body;
        const [result] = await db.execute(
            'UPDATE plot SET name = ?, block = ?, size = ?, base_cost = ?, is_sold = ?, description = ? WHERE id = ?',
            [name, block, size, base_cost, is_sold, description, req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Plot not found' });
        res.json({ message: 'Plot updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/plots/:id', async (req, res) => {
    try {
        const [result] = await db.execute('DELETE FROM plot WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Plot not found' });
        res.json({ message: 'Plot deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- CLIENT ENDPOINTS ---

app.post('/api/clients', async (req, res) => {
    try {
        const { name, phone_number, cnic, default_commission, organization_id } = req.body;
        const [existing] = await db.execute(
            'SELECT id FROM client WHERE name = ? OR phone_number = ? OR cnic = ?',
            [name, phone_number, cnic]
        );
        if (existing.length > 0) {
            return res.status(400).json({ message: 'A client with the same name, phone number, or CNIC already exists.' });
        }
        const [result] = await db.execute(
            'INSERT INTO client (name, phone_number, cnic, default_commission, organization_id) VALUES (?, ?, ?, ?, ?)',
            [name, phone_number, cnic, default_commission, organization_id]
        );
        res.status(201).json({
            id: result.insertId, name, phone_number, cnic, default_commission, organization_id
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: 'A client with this CNIC already exists.' });
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
                c.id, c.name, c.phone_number, c.cnic, c.default_commission,
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
                p.name AS plot_name,
                p.block AS plot_block,
                p.size AS plot_size,
                s.name AS society_name
            FROM client_plot cp
            JOIN plot p ON cp.plot_id = p.id
            JOIN society s ON p.society_id = s.id
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
        const { name, phone_number, cnic, default_commission } = req.body;
        const [result] = await db.execute(
            'UPDATE client SET name = ?, phone_number = ?, cnic = ?, default_commission = ? WHERE id = ?',
            [name, phone_number, cnic, default_commission, req.params.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Client not found' });
        res.json({ message: 'Client updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/clients/:id', async (req, res) => {
    try {
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
            'SELECT id, name, phone_number, cnic, default_commission FROM client WHERE organization_id = ?',
            [organization_id]
        );
        const [societies] = await db.execute(
            'SELECT id, name, city FROM society WHERE organization_id = ?',
            [organization_id]
        );
        let plots;
        if (society_id) {
            [plots] = await db.execute(
                'SELECT id, name, block, size, base_cost FROM plot WHERE society_id = ? AND is_sold = FALSE',
                [society_id]
            );
        } else {
            [plots] = await db.execute(
                `SELECT p.id, p.name, p.block, p.size, p.base_cost FROM plot p
                 JOIN society s ON p.society_id = s.id
                 WHERE s.organization_id = ? AND p.is_sold = FALSE`,
                [organization_id]
            );
        }
        res.json({ clients, societies, plots });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/bookings
// Accepts payment_method ('cash' | 'bank').
// Inserts the transaction with payment_method and updates both total balance + sub-balance.
// Also fixes the pre-existing bug where wallet.balance was never updated on a booking.
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
            user_id,
            payment_method = 'cash',
        } = req.body;

        const isInstallment = cycles && cycles > 0;

        await conn.beginTransaction();

        // 1. Create the booking record
        const [bookingResult] = await conn.execute(
            'INSERT INTO client_plot (total_price, downpayment, agreed_commission, booking_date, cycles, client_id, plot_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [total_price, downpayment, agreed_commission, booking_date, cycles ?? 0, client_id, plot_id, user_id]
        );
        const bookingId = bookingResult.insertId;

        // 2. Mark plot as sold
        await conn.execute('UPDATE plot SET is_sold = TRUE WHERE id = ?', [plot_id]);

        // 3. Generate installment rows if applicable
        if (isInstallment) {
            const remainingAmount = parseFloat(total_price) - parseFloat(downpayment);
            const installmentAmount = parseFloat((remainingAmount / cycles).toFixed(2));
            for (let i = 1; i <= cycles; i++) {
                const dueDate = new Date(booking_date);
                dueDate.setMonth(dueDate.getMonth() + i);
                await conn.execute(
                    'INSERT INTO installment (amount_due, amount_paid, due_date, status, client_plot_id) VALUES (?, 0.00, ?, ?, ?)',
                    [installmentAmount, dueDate.toISOString().split('T')[0], 'Pending', bookingId]
                );
            }
        }

        // 4. Resolve wallet for this org via the user's organization
        const [wallet] = await conn.execute(
            'SELECT id FROM wallet WHERE organization_id = (SELECT organization_id FROM app_user WHERE id = ?)',
            [user_id]
        );
        if (wallet.length === 0) throw new Error('No wallet found');
        const walletId = wallet[0].id;

        // 5. Resolve names for the transaction description
        const [clientRow] = await conn.execute('SELECT name FROM client WHERE id = ?', [client_id]);
        const [plotRow] = await conn.execute('SELECT name FROM plot WHERE id = ?', [plot_id]);
        const clientName = clientRow[0]?.name || 'Unknown';
        const plotName = plotRow[0]?.name || 'Unknown';

        const txAmount = isInstallment ? downpayment : total_price;
        const subBalanceCol = payment_method === 'bank' ? 'bank_balance' : 'cash_balance';

        // 6. Insert the wallet transaction
        await conn.execute(
            'INSERT INTO wallet_transaction (amount, transaction_type, description, wallet_id, user_id, payment_method) VALUES (?, ?, ?, ?, ?, ?)',
            [txAmount, 'credit', `${clientName} - Plot ${plotName}`, walletId, user_id, payment_method]
        );

        // 7. Update total balance + sub-balance (this was missing in the original)
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

// --- REPORTS ---

app.get('/api/reports', async (req, res) => {
    try {
        const { organization_id } = req.query;
        const [rows] = await db.execute(`
            SELECT
                cp.id, cp.total_price, cp.downpayment, cp.agreed_commission,
                cp.booking_date, cp.cycles, cp.is_confirmed,
                c.name AS client_name, c.phone_number AS client_phone, c.cnic AS client_cnic,
                p.name AS plot_name, p.block AS plot_block, p.size AS plot_size,
                s.name AS society_name,
                (SELECT COUNT(*) FROM installment i WHERE i.client_plot_id = cp.id AND i.status = 'Paid') AS paid_count,
                (SELECT COUNT(*) FROM installment i WHERE i.client_plot_id = cp.id) AS total_count
            FROM client_plot cp
            JOIN client c ON cp.client_id = c.id
            JOIN plot p ON cp.plot_id = p.id
            JOIN society s ON p.society_id = s.id
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
// Accepts payment_method ('cash' | 'bank'), updates total balance + sub-balance.
app.patch('/api/installments/:id/pay', async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { id } = req.params;
        const { amount_paid, user_id, payment_method = 'cash' } = req.body;

        await conn.beginTransaction();

        const [rows] = await conn.execute(`
            SELECT i.*, c.name as client_name, p.name as plot_name
            FROM installment i
            JOIN client_plot cp ON i.client_plot_id = cp.id
            JOIN client c ON cp.client_id = c.id
            JOIN plot p ON cp.plot_id = p.id
            WHERE i.id = ?`, [id]);

        if (rows.length === 0) throw new Error('Installment not found');
        const installment = rows[0];

        const newAmountPaid = parseFloat(installment.amount_paid) + parseFloat(amount_paid);
        const status = newAmountPaid >= parseFloat(installment.amount_due) ? 'Paid' : 'Partial';

        await conn.execute(
            'UPDATE installment SET amount_paid = ?, status = ? WHERE id = ?',
            [newAmountPaid, status, id]
        );

        const [wallet] = await conn.execute(
            'SELECT id FROM wallet WHERE organization_id = (SELECT organization_id FROM app_user WHERE id = ?)',
            [user_id]
        );
        if (wallet.length === 0) throw new Error('No wallet found');
        const walletId = wallet[0].id;

        const subBalanceCol = payment_method === 'bank' ? 'bank_balance' : 'cash_balance';

        await conn.execute(
            'INSERT INTO wallet_transaction (amount, transaction_type, description, wallet_id, user_id, payment_method) VALUES (?, ?, ?, ?, ?, ?)',
            [amount_paid, 'credit', `${installment.client_name} - Plot ${installment.plot_name}`, walletId, user_id, payment_method]
        );

        await conn.execute(
            `UPDATE wallet SET balance = balance + ?, ${subBalanceCol} = ${subBalanceCol} + ? WHERE id = ?`,
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});