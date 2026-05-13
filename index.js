require('dotenv').config(); // <-- Added this to the very top to be safe
const express = require('express');
const cors = require('cors');
const db = require('./config/db');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); 
app.use(express.json()); 

// Basic test route
app.get('/', (req, res) => {
    res.send('Backend is running!');
});
///////////////////////////////////////////////////////////////////////////


// Simple Login

app.post('/api/users/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const [users] = await db.execute(
            'SELECT id, name, email, role, organization_id FROM app_user WHERE email = ? AND password = ?',
            [email, password]
        );
        
        if (users.length === 0) return res.status(401).json({ message: 'Invalid email or password' });
        res.json({ message: 'Login successful', user: users[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});



// --- WALLET TRANSACTION ENDPOINTS ---

// Record a transaction and update the wallet balance automatically
app.post('/api/transactions', async (req, res) => {
    try {
        const { amount, transaction_type, description, wallet_id, user_id } = req.body;
        
        // 1. Insert the record into the transaction history
        const [result] = await db.execute(
            'INSERT INTO wallet_transaction (amount, transaction_type, description, wallet_id, user_id) VALUES (?, ?, ?, ?, ?)',
            [amount, transaction_type, description, wallet_id, user_id]
        );

        // 2. Automatically update the wallet balance (Add if Credit, Subtract if Debit)
        const operator = transaction_type.toLowerCase() === 'credit' ? '+' : '-';
        await db.execute(
            `UPDATE wallet SET balance = balance ${operator} ? WHERE id = ?`,
            [amount, wallet_id]
        );

        res.status(201).json({ 
            id: result.insertId, amount, transaction_type, message: 'Transaction saved & balance updated!' 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// Fetch all transactions for a specific wallet (for the Activity Log)
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

// Remove a transaction and reverse its effect on the wallet balance
app.delete('/api/transactions/:id', async (req, res) => {
    try {
        const transactionId = req.params.id;

        // 1. Fetch transaction details needed for reversal
        const [tx] = await db.execute(
            'SELECT amount, transaction_type, wallet_id FROM wallet_transaction WHERE id = ?',
            [transactionId]
        );

        if (tx.length === 0) return res.status(404).json({ error: 'Transaction not found' });
        
        const { amount, transaction_type, wallet_id } = tx[0];

        // 2. Delete the transaction record
        await db.execute('DELETE FROM wallet_transaction WHERE id = ?', [transactionId]);

        // 3. Reverse the wallet balance (Subtract if previously Credited, Add if previously Debited)
        const operator = transaction_type.toLowerCase() === 'credit' ? '-' : '+';
        await db.execute(
            `UPDATE wallet SET balance = balance ${operator} ? WHERE id = ?`,
            [amount, wallet_id]
        );

        res.status(200).json({ message: 'Transaction removed and balance reversed!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- SOCIETY ENDPOINTS ---

// Create a new society
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

 // Get all societies
 app.get('/api/societies', async (req, res) => {
     try {
         const [rows] = await db.execute('SELECT * FROM society');
         res.json(rows);
     } catch (error) {
         res.status(500).json({ error: error.message });
     }
 });

// Update a society
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

// Delete a society
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

// Create a new plot
 app.post('/api/plots', async (req, res) => {
     try {
         const { name, block, size, base_cost, description, society_id } = req.body;
 
         // Check for duplicate plot in the same society
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

// Get all plots
app.get('/api/plots', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM plot');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update a plot (e.g., to mark it as sold)
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

// Delete a plot
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

// Create a new client
app.post('/api/clients', async (req, res) => {
     try {
         const { name, phone_number, cnic, default_commission, organization_id } = req.body;
 
         // Check for duplicate name, phone, or cnic
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


// Get all clients
app.get('/api/clients', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM client');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// Update a client
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

// Delete a client
app.delete('/api/clients/:id', async (req, res) => {
    try {
        const [result] = await db.execute('DELETE FROM client WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Client not found' });
        res.json({ message: 'Client deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


app.get('/api/clients/directory', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT 
                c.id,
                c.name,
                c.phone_number,
                c.cnic,
                c.default_commission,
                COUNT(cp.id) AS active_files
            FROM client c
            LEFT JOIN client_plot cp ON c.id = cp.client_id
            GROUP BY c.id
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});



// --- SALES PAGE DATA FETCH ENDPOINTS ---
app.get('/api/sales/form-data', async (req, res) => {
    try {
        const { society_id } = req.query;

        const [clients] = await db.execute(
            'SELECT id, name, phone_number, cnic, default_commission FROM client'
        );

        const [societies] = await db.execute(
            'SELECT id, name, city FROM society'
        );

        let plots;
        if (society_id) {
            [plots] = await db.execute(
                'SELECT id, name, block, size, base_cost FROM plot WHERE society_id = ? AND is_sold = FALSE',
                [society_id]
            );
        } else {
            [plots] = await db.execute(
                'SELECT id, name, block, size, base_cost FROM plot WHERE is_sold = FALSE'
            );
        }

        res.json({ clients, societies, plots });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});




app.post('/api/bookings', async (req, res) => {
     const conn = await db.getConnection();
     try {
         const { total_price, downpayment, agreed_commission, booking_date, cycles, client_id, plot_id, user_id } = req.body;
         const isInstallment = cycles && cycles > 0;
 
         await conn.beginTransaction();
 
         const [bookingResult] = await conn.execute(
             'INSERT INTO client_plot (total_price, downpayment, agreed_commission, booking_date, cycles, client_id, plot_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
             [total_price, downpayment, agreed_commission, booking_date, cycles ?? 0, client_id, plot_id, user_id]
         );
         const bookingId = bookingResult.insertId;
 
         await conn.execute('UPDATE plot SET is_sold = TRUE WHERE id = ?', [plot_id]);

         // Generate installments if payment plan is installments
        if (isInstallment) {
            const remainingAmount = parseFloat(total_price) - parseFloat(downpayment);
            const installmentAmount = parseFloat((remainingAmount / cycles).toFixed(2));
            for (let i = 1; i <= cycles; i++) {
                const dueDate = new Date(booking_date);
                dueDate.setMonth(dueDate.getMonth() + i);
                await conn.execute(
                    'INSERT INTO installment (amount_due, amount_paid, due_date, status, client_plot_id) VALUES (?, 0.00, ?, "Pending", ?)',
                    [installmentAmount, dueDate.toISOString().split('T')[0], bookingId]
                );
            }
        }
 

        // Record down payment (or full payment) in wallet
        const [wallet] = await conn.execute('SELECT id FROM wallet LIMIT 1');
        if (wallet.length === 0) throw new Error('No wallet found');
        const walletId = wallet[0].id;

        const [clientRow] = await conn.execute('SELECT name FROM client WHERE id = ?', [client_id]);
        const [plotRow] = await conn.execute('SELECT name FROM plot WHERE id = ?', [plot_id]);
        const clientName = clientRow[0]?.name || 'Unknown';
        const plotName = plotRow[0]?.name || 'Unknown';

        await conn.execute(
            'INSERT INTO wallet_transaction (amount, transaction_type, description, wallet_id, user_id) VALUES (?, "credit", ?, ?, ?)',
            [
                isInstallment ? downpayment : total_price,
                `${clientName} - Plot ${plotName}`,
                walletId,
                user_id
            ]
        );
 
         await conn.commit();
         res.status(201).json({ id: bookingId, message: isInstallment ? `Booked with ${cycles} installments generated.` : 'Booked with full payment.' });
     } catch (error) {
         await conn.rollback();
         res.status(500).json({ error: error.message });
     } finally {
         conn.release();
     }
 });




app.get('/api/reports', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT 
                cp.id,
                cp.total_price,
                cp.downpayment,
                cp.agreed_commission,
                cp.booking_date,
                cp.cycles,
                cp.is_confirmed,
                c.name         AS client_name,
                c.phone_number AS client_phone,
                c.cnic         AS client_cnic,
                p.name         AS plot_name,
                p.block        AS plot_block,
                p.size         AS plot_size,
                s.name         AS society_name,
     (SELECT COUNT(*) FROM installment i WHERE i.client_plot_id = cp.id AND i.status = 'Paid') AS paid_count,
     (SELECT COUNT(*) FROM installment i WHERE i.client_plot_id = cp.id) AS total_count
            FROM client_plot cp
            JOIN client  c ON cp.client_id = c.id
            JOIN plot    p ON cp.plot_id   = p.id
            JOIN society s ON p.society_id = s.id
            ORDER BY cp.booking_date DESC
        `);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// Get installments for a specific booking
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

// Pay an installment
app.patch('/api/installments/:id/pay', async (req, res) => {
    const conn = await db.getConnection();
    try {
        const { id } = req.params;
        const { amount_paid, user_id } = req.body;

        await conn.beginTransaction();

       // 1. Fetch the installment with client and plot details
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

        // 2. Update installment
        await conn.execute(
            'UPDATE installment SET amount_paid = ?, status = ? WHERE id = ?',
            [newAmountPaid, status, id]
        );

        // 3. Record wallet transaction
        const [wallet] = await conn.execute('SELECT id FROM wallet LIMIT 1');
        if (wallet.length === 0) throw new Error('No wallet found');
        const walletId = wallet[0].id;

        await conn.execute(
            `INSERT INTO wallet_transaction (amount, transaction_type, description, wallet_id, user_id)
             VALUES (?, 'credit', ?, ?, ?)`,
            [
                amount_paid,
                `${installment.client_name} - Plot ${installment.plot_name}`,
                walletId,
                user_id
            ]
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










// Add this simple route for Railway's health check
app.get('/', (req, res) => {
    res.send('Real Estate ERP Backend is Live and Running!');
});





///////////////////////////////////////////////////////////////////////////////////////////
// Start Server
// Triggering Railway redeploy to fix port binding
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});