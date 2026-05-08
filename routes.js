const express = require('express');
const cors = require('cors');
const db = require('./config/db');

const app = express();
const PORT = process.env.PORT || 5173;

// Middleware
app.use(cors()); 
app.use(express.json()); 

// Basic test route
app.get('/', (req, res) => {
    res.send('Backend is running!');
});

// --- ORGANIZATION ENDPOINTS ---

// Create a new organization
app.post('/api/organizations', async (req, res) => {
    try {
        const { name, contact, address } = req.body;
        const [result] = await db.execute(
            'INSERT INTO organization (name, contact, address) VALUES (?, ?, ?)',
            [name, contact, address]
        );
        res.status(201).json({ id: result.insertId, name, contact, address });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get all organizations (Added this missing route)
app.get('/api/organizations', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM organization');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update an organization
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

// Delete an organization
app.delete('/api/organizations/:id', async (req, res) => {
    try {
        const [result] = await db.execute('DELETE FROM organization WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Organization not found' });
        res.json({ message: 'Organization deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- APP USER ENDPOINTS ---

// Create a new user
app.post('/api/users', async (req, res) => {
    try {
        const { name, email, password, role, organization_id } = req.body;
        const [result] = await db.execute(
            'INSERT INTO app_user (name, email, password, role, organization_id) VALUES (?, ?, ?, ?, ?)',
            [name, email, password, role, organization_id]
        );
        res.status(201).json({ id: result.insertId, name, email, role, organization_id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// Get all users
app.get('/api/users', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT id, name, email, role, organization_id, created_at FROM app_user');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});



// --- WALLET ENDPOINTS ---

// Create a company wallet (1 per organization)
app.post('/api/wallets', async (req, res) => {
    try {
        const { balance, organization_id } = req.body;
        const [result] = await db.execute(
            'INSERT INTO wallet (balance, organization_id) VALUES (?, ?)',
            [balance || 0.00, organization_id]
        );
        res.status(201).json({ id: result.insertId, balance: balance || 0.00, organization_id });
    } catch (error) {
        // Prevent creating multiple wallets for the same organization
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: 'This organization already has a wallet' });
        }
        res.status(500).json({ error: error.message });
    }
});

// Get the wallet details
app.get('/api/wallets', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM wallet');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get all bookings
app.get('/api/bookings', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM client_plot');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});




// --- INSTALLMENT ENDPOINTS ---

// Schedule a new installment

// Get all installments


app.post('/api/installments', async (req, res) => {
    try {
        const { amount_due, due_date, client_plot_id } = req.body;
        const [result] = await db.execute(
            'INSERT INTO installment (amount_due, due_date, client_plot_id) VALUES (?, ?, ?)',
            [amount_due, due_date, client_plot_id]
        );
        res.status(201).json({ 
            id: result.insertId, 
            message: 'Installment scheduled successfully!' 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


app.get('/api/installments', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM installment');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});







// Start Server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});






// --- BOOKING ENDPOINT ---


app.post('/api/bookings', async (req, res) => {
    const conn = await db.getConnection();
    try {
        const {
            total_price,
            downpayment,
            agreed_commission,
            booking_date,
            cycles,          // 0 or null means full payment
            client_id,
            plot_id,
            user_id
        } = req.body;

        const isInstallment = cycles && cycles > 0;

        await conn.beginTransaction();

        // 1. Create booking record
        const [bookingResult] = await conn.execute(
            `INSERT INTO client_plot 
                (total_price, downpayment, agreed_commission, booking_date, cycles, client_id, plot_id, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [total_price, downpayment, agreed_commission, booking_date, cycles ?? 0, client_id, plot_id, user_id]
        );
        const bookingId = bookingResult.insertId;

        // 2. Mark plot as sold
        await conn.execute('UPDATE plot SET is_sold = TRUE WHERE id = ?', [plot_id]);

        // 3. Auto-generate installments if payment plan is installments
        if (isInstallment) {
            const remainingAmount = parseFloat(total_price) - parseFloat(downpayment);
            const installmentAmount = parseFloat((remainingAmount / cycles).toFixed(2));

            for (let i = 1; i <= cycles; i++) {
                // Each due date is booking_date + i months
                const dueDate = new Date(booking_date);
                dueDate.setMonth(dueDate.getMonth() + i);
                const dueDateStr = dueDate.toISOString().split('T')[0];

                await conn.execute(
                    `INSERT INTO installment (amount_due, amount_paid, due_date, status, client_plot_id)
                     VALUES (?, 0.00, ?, 'Pending', ?)`,
                    [installmentAmount, dueDateStr, bookingId]
                );
            }
        }

        // 4. Record wallet transaction
        const [wallet] = await conn.execute('SELECT id FROM wallet LIMIT 1');
        if (wallet.length === 0) throw new Error('No wallet found');
        const walletId = wallet[0].id;

        const transactionType = isInstallment ? 'downpayment' : 'fullpayment';
        const transactionAmount = isInstallment ? downpayment : total_price;

        await conn.execute(
            `INSERT INTO wallet_transaction (amount, transaction_type, description, wallet_id, user_id)
             VALUES (?, ?, ?, ?, ?)`,
            [
                transactionAmount,
                transactionType,
                `Booking ID ${bookingId} - Plot ID ${plot_id}`,
                walletId,
                user_id
            ]
        );

        await conn.commit();

        res.status(201).json({
            id: bookingId,
            message: isInstallment
                ? `Plot booked with ${cycles} monthly installments generated.`
                : 'Plot booked with full payment recorded.'
        });

    } catch (error) {
        await conn.rollback();
        res.status(500).json({ error: error.message });
    } finally {
        conn.release();
    }
});


// --- INSTALLMENT ENDPOINTS ---








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
 
         await conn.commit();
         res.status(201).json({ id: bookingId, message: isInstallment ? `Booked with ${cycles} installments generated.` : 'Booked with full payment.' });
     } catch (error) {
         await conn.rollback();
         res.status(500).json({ error: error.message });
     } finally {
         conn.release();
     }
 });

 app.post('/api/bookings', async (req, res) => {
     try {
         const { total_price, downpayment, agreed_commission, booking_date, cycles, client_id, plot_id, user_id } = req.body;
         
         // 1. Create the booking record
         const [result] = await db.execute(
             'INSERT INTO client_plot (total_price, downpayment, agreed_commission, booking_date, cycles, client_id, plot_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
             [total_price, downpayment, agreed_commission, booking_date, cycles, client_id, plot_id, user_id]
         );
 
         // 2. Automatically mark the plot as sold!
         await db.execute('UPDATE plot SET is_sold = TRUE WHERE id = ?', [plot_id]);
 
         res.status(201).json({ 
             id: result.insertId, 
             message: 'Plot booked successfully and marked as sold!' 
         });
     } catch (error) {
         res.status(500).json({ error: error.message });
     }
 });
 