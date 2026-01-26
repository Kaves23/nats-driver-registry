const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'us-east-3.pg.psdb.cloud',
  port: parseInt(process.env.DB_PORT) || 6432,
  database: process.env.DB_DATABASE || 'postgres',
  user: process.env.DB_USERNAME || 'postgres.xhjhjl0nh1cp',
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000
});

async function createRaceResultsTable() {
  try {
    // Create race_results table for detailed results and lap times
    const createTable = await pool.query(`
      CREATE TABLE IF NOT EXISTS race_results (
        result_id VARCHAR(255) PRIMARY KEY,
        driver_id VARCHAR(255) NOT NULL,
        event_id VARCHAR(255) NOT NULL,
        session_type VARCHAR(50) NOT NULL,
        position INTEGER,
        best_lap_time DECIMAL(10,3),
        average_lap_time DECIMAL(10,3),
        total_laps INTEGER,
        gap_to_leader VARCHAR(50),
        gap_to_ahead VARCHAR(50),
        fastest_lap BOOLEAN DEFAULT FALSE,
        dnf BOOLEAN DEFAULT FALSE,
        dns BOOLEAN DEFAULT FALSE,
        dsq BOOLEAN DEFAULT FALSE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by VARCHAR(255),
        FOREIGN KEY (driver_id) REFERENCES drivers(driver_id),
        FOREIGN KEY (event_id) REFERENCES events(event_id)
      );
    `);
    
    console.log('✅ race_results table created/verified');
    
    // Create lap_times table for individual lap time tracking
    const createLapTable = await pool.query(`
      CREATE TABLE IF NOT EXISTS lap_times (
        lap_id VARCHAR(255) PRIMARY KEY,
        result_id VARCHAR(255) NOT NULL,
        driver_id VARCHAR(255) NOT NULL,
        lap_number INTEGER NOT NULL,
        lap_time DECIMAL(10,3) NOT NULL,
        sector_1 DECIMAL(10,3),
        sector_2 DECIMAL(10,3),
        sector_3 DECIMAL(10,3),
        position_at_lap INTEGER,
        is_fastest_lap BOOLEAN DEFAULT FALSE,
        is_personal_best BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (result_id) REFERENCES race_results(result_id),
        FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
      );
    `);
    
    console.log('✅ lap_times table created/verified');
    
    // Check tables exist
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('race_results', 'lap_times')
      ORDER BY table_name;
    `);
    
    console.log('\n📊 Results tables:');
    tables.rows.forEach(t => console.log('  -', t.table_name));
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

createRaceResultsTable();
