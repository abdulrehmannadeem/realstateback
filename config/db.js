const mysql = require('mysql2');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT, // <-- We added this
    ssl: {
        rejectUnauthorized: false // <-- Aiven strictly requires this
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

pool.getConnection((err, conn) => {
    if(err) console.error('Database connection failed:', err.message);
    else {
        console.log('Connected to the MySQL database successfully!');
        conn.release();
    }
});

module.exports = pool.promise();