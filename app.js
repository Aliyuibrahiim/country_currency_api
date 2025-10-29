const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Database configuration with better error handling
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 3306,
    connectTimeout: 60000,
    acquireTimeout: 60000,
    timeout: 60000,
    reconnect: true
};

// Create connection pool
let pool;
try {
    pool = mysql.createPool(dbConfig);
    console.log('Database pool created');
} catch (error) {
    console.error('Failed to create database pool:', error);
}

// Helper function to get database connection with retry
async function getConnection() {
    try {
        const connection = await pool.getConnection();
        return connection;
    } catch (error) {
        console.error('Database connection failed:', error);
        throw error;
    }
}

// Helper function for random number
function getRandomNumber(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 1. POST /countries/refresh - Fetch and cache countries
app.post('/countries/refresh', async (req, res) => {
    let connection;
    try {
        console.log('Starting refresh process...');
        
        // Fetch from external APIs
        console.log('Fetching countries from REST Countries API...');
        const countriesResponse = await axios.get(
            'https://restcountries.com/v3.1/all?fields=name,capital,region,population,flags,currencies',
            { timeout: 30000 }
        );
        
        console.log('Fetching exchange rates from ER API...');
        const exchangeResponse = await axios.get(
            'https://open.er-api.com/v6/latest/USD',
            { timeout: 30000 }
        );
        
        const exchangeRates = exchangeResponse.data.rates;
        const countries = countriesResponse.data;
        
        console.log(`Processing ${countries.length} countries...`);
        
        connection = await getConnection();
        
        // Clear existing data
        await connection.execute('DELETE FROM countries');
        
        let successCount = 0;
        
        for (const country of countries.slice(0, 50)) { // Process 50 for speed
            try {
                let currencyCode = null;
                let exchangeRate = null;
                let estimatedGDP = null;
                
                // Extract currency code
                if (country.currencies) {
                    const currencyKeys = Object.keys(country.currencies);
                    if (currencyKeys.length > 0) {
                        currencyCode = currencyKeys[0];
                        
                        // Match with exchange rates
                        if (currencyCode && exchangeRates[currencyCode]) {
                            exchangeRate = parseFloat(exchangeRates[currencyCode]);
                            const randomMultiplier = getRandomNumber(1000, 2000);
                            
                            // GDP calculation: population × random(1000-2000) ÷ exchange_rate
                            estimatedGDP = (country.population * randomMultiplier) / exchangeRate;
                        }
                    }
                }
                
                // Insert country
                await connection.execute(
                    `INSERT INTO countries 
                     (name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        country.name?.common || 'Unknown',
                        country.capital ? country.capital[0] : null,
                        country.region || null,
                        country.population || 0,
                        currencyCode,
                        exchangeRate,
                        estimatedGDP,
                        country.flags?.png || null
                    ]
                );
                
                successCount++;
                
            } catch (error) {
                console.error(`Failed to process ${country.name?.common}:`, error.message);
                continue;
            }
        }
        
        await connection.execute('COMMIT');
        
        res.status(201).json({
            message: `Successfully refreshed ${successCount} countries`,
            total_countries: successCount,
            last_refreshed_at: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Refresh failed:', error);
        
        if (error.code === 'ECONNREFUSED' || error.response) {
            return res.status(503).json({
                error: 'External data source unavailable',
                details: 'Could not fetch data from external APIs'
            });
        }
        
        res.status(500).json({ 
            error: 'Internal server error',
            details: error.message 
        });
    } finally {
        if (connection) {
            await connection.execute('ROLLBACK');
            connection.release();
        }
    }
});

// 2. GET /countries - Get all countries with filtering
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
        
        // Apply sorting
        if (sort === 'gdp_desc') {
            query += ' ORDER BY estimated_gdp DESC';
        } else if (sort === 'population_desc') {
            query += ' ORDER BY population DESC';
        } else {
            query += ' ORDER BY name ASC';
        }
        
        const [countries] = await connection.execute(query, params);
        
        res.json(countries);
        
    } catch (error) {
        console.error('GET /countries failed:', error);
        res.status(500).json({ 
            error: 'Failed to fetch countries',
            details: error.message 
        });
    } finally {
        if (connection) connection.release();
    }
});

// 3. GET /countries/:name - Get one country by name
app.get('/countries/:name', async (req, res) => {
    let connection;
    try {
        const countryName = req.params.name;
        
        if (!countryName) {
            return res.status(400).json({ error: 'Country name is required' });
        }
        
        connection = await getConnection();
        
        const [countries] = await connection.execute(
            'SELECT * FROM countries WHERE name = ?',
            [countryName]
        );
        
        if (countries.length === 0) {
            return res.status(404).json({ error: 'Country not found' });
        }
        
        res.json(countries[0]);
        
    } catch (error) {
        console.error('GET /countries/:name failed:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        if (connection) connection.release();
    }
});

// 4. DELETE /countries/:name - Delete a country
app.delete('/countries/:name', async (req, res) => {
    let connection;
    try {
        const countryName = req.params.name;
        
        if (!countryName) {
            return res.status(400).json({ error: 'Country name is required' });
        }
        
        connection = await getConnection();
        
        const [result] = await connection.execute(
            'DELETE FROM countries WHERE name = ?',
            [countryName]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Country not found' });
        }
        
        res.status(204).send();
        
    } catch (error) {
        console.error('DELETE /countries/:name failed:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        if (connection) connection.release();
    }
});

// 5. GET /status - Show API status
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
            last_refreshed_at: last_refreshed_at || null
        });
        
    } catch (error) {
        console.error('GET /status failed:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        if (connection) connection.release();
    }
});

// 6. GET /countries/image - Simple image endpoint
app.get('/countries/image', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        const [[{ total_countries }]] = await connection.execute(
            'SELECT COUNT(*) as total_countries FROM countries'
        );
        
        // Create simple SVG image
        const svg = `
<svg width="400" height="200" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#1a1a2e"/>
  <text x="50%" y="30%" text-anchor="middle" fill="white" font-family="Arial" font-size="20">
    Country Currency API
  </text>
  <text x="50%" y="50%" text-anchor="middle" fill="white" font-family="Arial" font-size="16">
    Total Countries: ${total_countries}
  </text>
  <text x="50%" y="70%" text-anchor="middle" fill="white" font-family="Arial" font-size="12">
    Generated ${new Date().toLocaleDateString()}
  </text>
</svg>
        `;
        
        res.setHeader('Content-Type', 'image/svg+xml');
        res.send(svg);
        
    } catch (error) {
        console.error('GET /countries/image failed:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        if (connection) connection.release();
    }
});

app.get('/', (req, res) => {
    res.json({ 
        message: 'Country Currency API is running!',
        status: 'OK',
        timestamp: new Date().toISOString(),
        environment: {
            DB_HOST: process.env.DB_HOST ? 'Set' : 'Missing',
            DB_USER: process.env.DB_USER ? 'Set' : 'Missing', 
            DB_NAME: process.env.DB_NAME ? 'Set' : 'Missing',
            DB_PASSWORD: process.env.DB_PASSWORD ? 'Set' : ' Missing'
        }
    });
});

// Global error handler
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        error: 'Internal server error',
        details: error.message 
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Database: ${process.env.DB_HOST}`);
});

module.exports = app;