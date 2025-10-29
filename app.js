const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// FreeSQLDatabase connection configuration
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 3306,
    acquireTimeout: 60000,
    connectTimeout: 60000,
    timeout: 60000,
    reconnect: true,
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 0
};

// Create connection pool instead of single connection
const pool = mysql.createPool(dbConfig);
let lastRefreshTime = null;

// Function to get a database connection
async function getConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('Got database connection');
        return connection;
    } catch (error) {
        console.error('Failed to get database connection:', error);
        throw error;
    }
}

// Test database connection on startup
async function testConnection() {
    try {
        const connection = await getConnection();
        const [rows] = await connection.execute('SELECT 1 as test');
        console.log('Database connection test successful');
        connection.release(); // Always release connection back to pool
        return true;
    } catch (error) {
        console.error('Database connection test failed:', error);
        return false;
    }
}

// POST /countries/refresh - Fixed version
app.post('/countries/refresh', async (req, res) => {
    let connection;
    try {
        console.log('Starting countries refresh...');
        
        // Get a fresh database connection
        connection = await getConnection();
        
        // Fetch countries data
        console.log('Fetching countries data...');
        const countriesResponse = await axios.get(
            'https://restcountries.com/v2/all?fields=name,capital,region,population,flag,currencies',
            { timeout: 30000 }
        );
        
        // Fetch exchange rates
        console.log('Fetching exchange rates...');
        const exchangeResponse = await axios.get(
            'https://open.er-api.com/v6/latest/USD',
            { timeout: 30000 }
        );
        const exchangeRates = exchangeResponse.data.rates;
        
        const countries = countriesResponse.data;
        let processedCount = 0;
        let successCount = 0;
        
        console.log(`Processing ${countries.length} countries...`);
        
        // Process each country
        for (const country of countries.slice(0, 10)) { // Process only 10 for testing
            try {
                let currencyCode = null;
                let exchangeRate = null;
                let estimatedGDP = null;
                
                // Get first currency if available
                if (country.currencies && country.currencies.length > 0) {
                    currencyCode = country.currencies[0].code;
                    
                    // Get exchange rate if currency code exists in rates
                    if (currencyCode && exchangeRates[currencyCode]) {
                        exchangeRate = exchangeRates[currencyCode];
                        const randomMultiplier = Math.random() * 1000 + 1000; // 1000-2000
                        estimatedGDP = (country.population * randomMultiplier) / exchangeRate;
                    }
                }
                
                // Check if country exists
                const [existing] = await connection.execute(
                    'SELECT id FROM countries WHERE name = ?',
                    [country.name]
                );
                
                if (existing.length > 0) {
                    // Update existing country
                    await connection.execute(
                        `UPDATE countries SET 
                         capital = ?, region = ?, population = ?, currency_code = ?, 
                         exchange_rate = ?, estimated_gdp = ?, flag_url = ?, last_refreshed_at = NOW() 
                         WHERE name = ?`,
                        [
                            country.capital || null,
                            country.region || null,
                            country.population,
                            currencyCode,
                            exchangeRate,
                            estimatedGDP,
                            country.flag || null,
                            country.name
                        ]
                    );
                } else {
                    // Insert new country
                    await connection.execute(
                        `INSERT INTO countries 
                         (name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            country.name,
                            country.capital || null,
                            country.region || null,
                            country.population,
                            currencyCode,
                            exchangeRate,
                            estimatedGDP,
                            country.flag || null
                        ]
                    );
                }
                
                successCount++;
                processedCount++;
                
                // Log progress every 10 countries
                if (processedCount % 10 === 0) {
                    console.log(`Processed ${processedCount} countries...`);
                }
                
            } catch (countryError) {
                console.error(`Error processing country ${country.name}:`, countryError);
                processedCount++;
                continue; // Continue with next country
            }
        }
        
        lastRefreshTime = new Date().toISOString();
        
        res.json({
            message: `Successfully refreshed ${successCount} out of ${processedCount} countries`,
            total_processed: processedCount,
            successful: successCount,
            last_refreshed_at: lastRefreshTime
        });
        
    } catch (error) {
        console.error('Refresh failed:', error);
        
        if (error.response) {
            return res.status(503).json({
                error: 'External data source unavailable',
                details: `Could not fetch data from external API: ${error.message}`
            });
        }
        
        res.status(500).json({ 
            error: 'Internal server error',
            details: error.message 
        });
        
    } finally {
        // Always release connection back to pool
        if (connection) {
            connection.release();
            console.log('Released database connection');
        }
    }
});

// GET /countries - Get all countries with filters
app.get('/countries', async (req, res) => {
    let connection;
    try {
        const { region, currency, sort } = req.query;
        
        connection = await getConnection();
        
        let query = 'SELECT * FROM countries WHERE 1=1';
        const params = [];
        
        if (region) {
            query += ' AND region = ?';
            params.push(region);
        }
        
        if (currency) {
            query += ' AND currency_code = ?';
            params.push(currency);
        }
        
        if (sort === 'gdp_desc') {
            query += ' ORDER BY estimated_gdp DESC';
        } else if (sort === 'gdp_asc') {
            query += ' ORDER BY estimated_gdp ASC';
        } else if (sort === 'population_desc') {
            query += ' ORDER BY population DESC';
        } else {
            query += ' ORDER BY name ASC';
        }
        
        const [countries] = await connection.execute(query, params);
        
        res.json(countries);
        
    } catch (error) {
        console.error('Error fetching countries:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        if (connection) connection.release();
    }
});

// GET /status - Show total countries and last refresh timestamp
app.get('/status', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        const [[{ total_countries }]] = await connection.execute(
            'SELECT COUNT(*) as total_countries FROM countries'
        );
        
        const [[{ last_refreshed_at }]] = await connection.execute(
            'SELECT MAX(last_refreshed_at) as last_refreshed_at FROM countries'
        );
        
        res.json({
            total_countries,
            last_refreshed_at: last_refreshed_at || lastRefreshTime
        });
        
    } catch (error) {
        console.error('Error fetching status:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        if (connection) connection.release();
    }
});

// Simple test endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'Country Currency API is running!',
        status: 'OK',
        endpoints: {
            'POST /countries/refresh': 'Refresh country data',
            'GET /countries': 'Get all countries',
            'GET /status': 'Get API status'
        }
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Testing database connection...');
    
    const connected = await testConnection();
    if (connected) {
        console.log('Database connection established');
    } else {
        console.log('Database connection failed - some features may not work');
    }

    console.log('API Ready!');
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    await pool.end();
    process.exit(0);
});

module.exports = app;