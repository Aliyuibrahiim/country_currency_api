const mysql = require('mysql2');
require('dotenv').config();

const connection = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 3306
});

connection.connect((err) => {
    if (err) {
        console.error('❌ Connection failed:', err);
    } else {
        console.log('✅ Successfully connected to FreeSQLDatabase!');
        
        // Test query
        connection.query('SHOW TABLES', (err, results) => {
            if (err) {
                console.error('❌ Query failed:', err);
            } else {
                console.log('✅ Tables in database:', results);
            }
            connection.end();
        });
    }
});