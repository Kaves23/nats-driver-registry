require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcryptjs = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const webpush = require('web-push');
const multer = require('multer');
const adminNotificationQueue = require('./adminNotificationQueue');

const app = express();
const path = require('path');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only images (JPEG, PNG, GIF) and PDF files are allowed'));
  }
});

// Configure web push
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:admin@rokcup.co.za',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files from images directory
app.use('/images', express.static(path.join(__dirname, 'images')));

// =========================================================
// GLOBAL ERROR HANDLERS - Prevent server crashes
// =========================================================
process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
  // Don't exit - keep server running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ UNHANDLED REJECTION at:', promise);
  console.error('Reason:', reason);
  // Don't exit - keep server running
});

// Database connection with error handling
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  // Connection pool settings for stability
  max: 20,                    // Maximum connections
  idleTimeoutMillis: 30000,   // Close idle connections after 30s
  connectionTimeoutMillis: 5000  // Fail fast if can't connect in 5s
});

// Handle pool errors to prevent crashes
pool.on('error', (err, client) => {
  console.error('❌ PostgreSQL pool error:', err.message);
  // Don't crash - pool will try to reconnect
});

// Initialize audit log table if it doesn't exist
const initAuditTable = async () => {
  try {
    // First create table with new schema if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        driver_id VARCHAR(255),
        driver_email VARCHAR(255),
        action VARCHAR(255),
        field_name VARCHAR(255),
        old_value TEXT,
        new_value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ip_address VARCHAR(50)
      )
    `);
    
    // Then add created_at column if it doesn't exist (migration for existing tables)
    await pool.query(`
      ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);
    
    // Drop old timestamp column if it exists (keep data migration safe)
    try {
      await pool.query(`ALTER TABLE audit_log DROP COLUMN IF EXISTS timestamp`);
    } catch (e) {
      // Column might not exist, that's fine
    }
    
    console.log('✅ Audit log table initialized');
  } catch (err) {
    console.error('Audit table init error:', err.message);
  }
};

// Initialize admin messages table if it doesn't exist
const initMessagesTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_messages (
        id SERIAL PRIMARY KEY,
        driver_id VARCHAR(255),
        driver_name VARCHAR(255),
        driver_email VARCHAR(255),
        registered_email VARCHAR(255),
        driver_phone VARCHAR(20),
        subject VARCHAR(255),
        message TEXT,
        read_status BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Add registered_email column if it doesn't exist
    await pool.query(`
      ALTER TABLE admin_messages
      ADD COLUMN IF NOT EXISTS registered_email VARCHAR(255)
    `);
  } catch (err) {
    console.error('Messages table init error:', err.message);
  }
};

// Initialize notification history table if it doesn't exist
const initNotificationHistoryTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_history (
        id SERIAL PRIMARY KEY,
        driver_id VARCHAR(255),
        event_id VARCHAR(255),
        event_name VARCHAR(255),
        title VARCHAR(500) NOT NULL,
        body TEXT,
        url VARCHAR(500),
        notification_type VARCHAR(50) DEFAULT 'general',
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Notification history table initialized');
  } catch (err) {
    console.error('Notification history table init error:', err.message);
  }
};

// Initialize events table if it doesn't exist
const initEventsTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        event_id VARCHAR(255) PRIMARY KEY,
        event_name VARCHAR(255) NOT NULL,
        event_date DATE NOT NULL,
        start_date DATE,
        end_date DATE,
        location VARCHAR(255),
        registration_deadline DATE,
        entry_fee DECIMAL(10, 2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);    
    
    // Add start_date and end_date columns if they don't exist
    await pool.query(`
      ALTER TABLE events
      ADD COLUMN IF NOT EXISTS start_date DATE,
      ADD COLUMN IF NOT EXISTS end_date DATE
    `);
    
    console.log('✅ Events table initialized with start/end date columns');
  } catch (err) {
    console.error('Events table init error:', err.message);
  }
};

// Initialize race entries table if it doesn't exist
const initRaceEntriesTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS race_entries (
        race_entry_id VARCHAR(255) PRIMARY KEY,
        event_id VARCHAR(255) NOT NULL,
        driver_id VARCHAR(255) NOT NULL,
        entry_fee DECIMAL(10, 2),
        amount_paid DECIMAL(10, 2),
        payment_reference VARCHAR(255) UNIQUE,
        payment_status VARCHAR(100),
        entry_status VARCHAR(100),
        transponder_selection VARCHAR(255),
        tyres_ordered BOOLEAN DEFAULT FALSE,
        wets_ordered BOOLEAN DEFAULT FALSE,
        team_code VARCHAR(50),
        engine INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (event_id) REFERENCES events(event_id),
        FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
      )
    `);

    // Add engine column if it doesn't exist
    await pool.query(`
      ALTER TABLE race_entries
      ADD COLUMN IF NOT EXISTS engine INT DEFAULT 0
    `);

    // Add team_code column if it doesn't exist
    await pool.query(`
      ALTER TABLE race_entries
      ADD COLUMN IF NOT EXISTS team_code VARCHAR(50)
    `);

    // Add unique ticket reference columns for validation
    await pool.query(`
      ALTER TABLE race_entries
      ADD COLUMN IF NOT EXISTS ticket_engine_ref VARCHAR(100),
      ADD COLUMN IF NOT EXISTS ticket_tyres_ref VARCHAR(100),
      ADD COLUMN IF NOT EXISTS ticket_transponder_ref VARCHAR(100),
      ADD COLUMN IF NOT EXISTS ticket_fuel_ref VARCHAR(100)
    `);

    // Add engine management columns
    await pool.query(`
      ALTER TABLE race_entries
      ADD COLUMN IF NOT EXISTS engine_serial VARCHAR(100),
      ADD COLUMN IF NOT EXISTS engine_assigned_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS engine_returned BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS engine_returned_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS engine_issue TEXT,
      ADD COLUMN IF NOT EXISTS replacement_for VARCHAR(100),
      ADD COLUMN IF NOT EXISTS transponder_serial VARCHAR(100),
      ADD COLUMN IF NOT EXISTS transponder_assigned_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS tyre_front_left VARCHAR(100),
      ADD COLUMN IF NOT EXISTS tyre_front_right VARCHAR(100),
      ADD COLUMN IF NOT EXISTS tyre_rear_left VARCHAR(100),
      ADD COLUMN IF NOT EXISTS tyre_rear_right VARCHAR(100),
      ADD COLUMN IF NOT EXISTS tyres_registered_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS fuel_collected BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS fuel_collected_at TIMESTAMP
    `);

    // ✅ FIX #2: Add unique constraint to prevent duplicate entries
    // This ensures we can't accidentally create multiple entries for same driver+event+payment
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'unique_driver_event_payment'
        ) THEN
          ALTER TABLE race_entries 
          ADD CONSTRAINT unique_driver_event_payment 
          UNIQUE (driver_id, event_id, payment_reference);
        END IF;
      END $$;
    `);

    console.log('✅ Race entries table initialized with all columns and unique constraints');
  } catch (err) {
    console.error('Error initializing race entries table:', err);
  }
}

// Initialize equipment scan log table
async function initEquipmentScanLog() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS equipment_scan_log (
        log_id SERIAL PRIMARY KEY,
        scan_timestamp TIMESTAMP DEFAULT NOW(),
        scan_type VARCHAR(50) NOT NULL,
        barcode_scanned VARCHAR(200),
        entry_id VARCHAR(100),
        driver_id VARCHAR(100),
        driver_name VARCHAR(200),
        equipment_serial VARCHAR(100),
        scanned_by VARCHAR(100) DEFAULT 'Unknown',
        action_result VARCHAR(20) DEFAULT 'success',
        notes TEXT,
        event_id VARCHAR(100),
        race_class VARCHAR(100)
      )
    `);
    
    // Add index for faster queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_equipment_scan_timestamp 
      ON equipment_scan_log(scan_timestamp DESC)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_equipment_scan_entry 
      ON equipment_scan_log(entry_id)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_equipment_scan_driver 
      ON equipment_scan_log(driver_id)
    `);
    
    console.log('✅ Equipment scan log table initialized');
  } catch (err) {
    console.error('Equipment scan log init error:', err.message);
  }
}

// Helper function to log equipment scans
async function logEquipmentScan(scanData) {
  try {
    await pool.query(`
      INSERT INTO equipment_scan_log 
      (scan_type, barcode_scanned, entry_id, driver_id, driver_name, 
       equipment_serial, scanned_by, action_result, notes, event_id, race_class)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      scanData.scan_type,
      scanData.barcode_scanned,
      scanData.entry_id,
      scanData.driver_id,
      scanData.driver_name,
      scanData.equipment_serial,
      scanData.scanned_by || 'Unknown',
      scanData.action_result || 'success',
      scanData.notes,
      scanData.event_id,
      scanData.race_class
    ]);
  } catch (err) {
    console.error('Error logging equipment scan:', err.message);
  }
}

// Initialize pool engine rentals table
const initPoolEngineRentalsTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pool_engine_rentals (
        rental_id VARCHAR(255) PRIMARY KEY,
        driver_id VARCHAR(255) NOT NULL,
        championship_class VARCHAR(100) NOT NULL,
        rental_type VARCHAR(50) NOT NULL,
        amount_paid DECIMAL(10, 2),
        payment_status VARCHAR(50),
        payment_reference VARCHAR(255),
        season_year INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
      )
    `);
    console.log('✅ Pool engine rentals table initialized');
  } catch (err) {
    console.error('Pool engine rentals table init error:', err.message);
  }
};

// Initialize Discount Codes table
const initDiscountCodesTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS discount_codes (
        code_id VARCHAR(36) PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        description TEXT,
        discount_type VARCHAR(20) NOT NULL,
        discount_value DECIMAL(10, 2) NOT NULL,
        is_active BOOLEAN DEFAULT true,
        usage_limit INTEGER,
        usage_count INTEGER DEFAULT 0,
        valid_from TIMESTAMP,
        valid_until TIMESTAMP,
        created_by VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Discount codes table initialized');
  } catch (err) {
    console.error('Discount codes table init error:', err.message);
  }
};

// Initialize Event Documents table
const initEventDocumentsTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS event_documents (
        document_id VARCHAR(36) PRIMARY KEY,
        event_id VARCHAR(255) NOT NULL,
        uploaded_by_official VARCHAR(255),
        document_type VARCHAR(100) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        file_path VARCHAR(500),
        file_size INT,
        upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (event_id) REFERENCES events(event_id)
      )
    `);

    console.log('✅ Event documents table initialized');
  } catch (err) {
    console.error('Event documents table init error:', err.message);
  }
};

const initMSALicensesTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS msa_licenses (
        document_id VARCHAR(36) PRIMARY KEY,
        driver_id VARCHAR(255) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        file_path VARCHAR(500),
        file_size INT,
        file_type VARCHAR(100),
        upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
      )
    `);

    console.log('✅ MSA licenses table initialized');
  } catch (err) {
    console.error('MSA licenses table init error:', err.message);
  }
};

initAuditTable();
initMessagesTable();
initNotificationHistoryTable();
initEventsTable();
initRaceEntriesTable();
initEquipmentScanLog();
initPoolEngineRentalsTable();
initDiscountCodesTable();
initEventDocumentsTable();
initMSALicensesTable();

// Initialize default events if they don't exist
const initDefaultEvents = async () => {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM events');
    if (result.rows[0].count === 0) {
      // Insert default events
      await pool.query(
        `INSERT INTO events (event_id, event_name, event_date, location, registration_deadline, entry_fee)
         VALUES 
         ($1, $2, $3, $4, $5, $6),
         ($7, $8, $9, $10, $11, $12)`,
        [
          'event_redstar_001', 'Red Star Raceway - Round 1', '2026-02-15', 'Red Star Raceway', '2026-02-10', 2950.00,
          'event_westlake_001', 'Westlake Grand Prix - Round 2', '2026-03-15', 'Westlake', '2026-03-10', 2950.00
        ]
      );
      console.log('✅ Default events created');
    }
  } catch (err) {
    console.error('Error initializing events:', err.message);
  }
};

initDefaultEvents();

// Log audit event
const logAuditEvent = async (driver_id, driver_email, action, field_name, old_value, new_value, ip_address = 'unknown') => {
  try {
    await pool.query(
      `INSERT INTO audit_log (driver_id, driver_email, action, field_name, old_value, new_value, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [driver_id, driver_email, action, field_name, old_value, new_value, ip_address]
    );
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
};

// Load email template and replace variables
const loadEmailTemplate = (templateName, variables = {}) => {
  try {
    const templatePath = path.join(__dirname, 'email-templates', `${templateName}.html`);
    let html = fs.readFileSync(templatePath, 'utf8');
    
    // Replace all variables in the template
    Object.keys(variables).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      html = html.replace(regex, variables[key]);
    });
    
    return html;
  } catch (err) {
    console.error(`Error loading template ${templateName}:`, err.message);
    return null;
  }
};

// =========================================================
// RACE TICKET GENERATOR - Server-side HTML ticket with barcode
// =========================================================

// Code 39 character patterns for barcode generation
const CODE39_PATTERNS = {
  "0":"nnnwwnwnn","1":"wnnwnnnnw","2":"nnwwnnnnw","3":"wnwwnnnnn","4":"nnnwwnnnw",
  "5":"wnnwwnnnn","6":"nnwwwnnnn","7":"nnnwnnwnw","8":"wnnwnnwnn","9":"nnwwnnwnn",
  "A":"wnnnnwnnw","B":"nnwnnwnnw","C":"wnwnnwnnn","D":"nnnnwwnnw","E":"wnnnwwnnn",
  "F":"nnwnwwnnn","G":"nnnnnwwnw","H":"wnnnnwwnn","I":"nnwnnwwnn","J":"nnnnwwwnn",
  "K":"wnnnnnnww","L":"nnwnnnnww","M":"wnwnnnnwn","N":"nnnnwnnww","O":"wnnnwnnwn",
  "P":"nnwnwnnwn","Q":"nnnnnnwww","R":"wnnnnnwwn","S":"nnwnnnwwn","T":"nnnnwnwwn",
  "U":"wwnnnnnnw","V":"nwwnnnnnw","W":"wwwnnnnnn","X":"nwnnwnnnw","Y":"wwnnwnnnn",
  "Z":"nwwnwnnnn","-":"nwnnnnwnw",".":"wwnnnnwnn"," ":"nwwnnnwnn","$":"nwnwnwnnn",
  "/":"nwnwnnnwn","+":"nwnnnwnwn","%":"nnnwnwnwn","*":"nwnnwnwnn"
};

// Generate SVG barcode for Code 39
function generateCode39SVG(text, options = {}) {
  const { narrow = 2, wide = 6, height = 60, gap = 2 } = options;
  
  // Ensure uppercase and valid characters - use shorter code for barcode
  const safeText = (text || '').toUpperCase().replace(/[^0-9A-Z \-.$/+%]/g, '-');
  const value = `*${safeText}*`; // Add start/stop characters
  
  let bars = '';
  let x = 8; // Quiet zone
  
  for (const ch of value) {
    const pattern = CODE39_PATTERNS[ch] || CODE39_PATTERNS['-'];
    for (let i = 0; i < pattern.length; i++) {
      const isBar = i % 2 === 0;
      const w = pattern[i] === 'w' ? wide : narrow;
      if (isBar) {
        bars += `<rect x="${x}" y="6" width="${w}" height="${height}" fill="#000"/>`;
      }
      x += w;
    }
    x += gap;
  }
  
  const totalWidth = x + 8; // Add quiet zone
  const totalHeight = height + 24;
  
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" style="width:100%;max-width:280px;height:auto;display:block;margin:0 auto;">
    <rect x="0" y="0" width="${totalWidth}" height="${totalHeight}" fill="#fff" rx="4"/>
    ${bars}
    <text x="${totalWidth/2}" y="${height + 18}" text-anchor="middle" font-family="'Courier New',monospace" font-size="11" font-weight="bold" fill="#000">${safeText}</text>
  </svg>`;
}

// Generate race entry ticket HTML for email - PORTRAIT MODE for mobile
function generateRaceTicketHTML(ticketData) {
  const {
    reference,
    eventName,
    eventDate,
    eventLocation,
    raceClass,
    driverName,
    teamCode,
    gatesTime = '07:00',
    practiceTime = '08:00',
    racingTime = '10:30'
  } = ticketData;
  
  // Format date for display
  const dateObj = eventDate ? new Date(eventDate) : new Date();
  const dayName = dateObj.toLocaleDateString('en-ZA', { weekday: 'short' }).toUpperCase();
  const dayNum = dateObj.getDate();
  const monthName = dateObj.toLocaleDateString('en-ZA', { month: 'short' }).toUpperCase();
  const year = dateObj.getFullYear();
  const formattedDate = `${dayName} ${dayNum} ${monthName} ${year}`;
  
  // Generate short barcode reference (last 12 chars for cleaner barcode)
  const barcodeRef = reference.slice(-12).toUpperCase();
  
  // Generate barcode SVG
  const barcodeSVG = generateCode39SVG(barcodeRef, { narrow: 2, wide: 5, height: 50, gap: 2 });
  
  // Issue timestamp
  const issueStamp = new Date().toLocaleString('en-ZA', { 
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' 
  }).toUpperCase();
  
  // Venue display
  const venueDisplay = (eventLocation || 'TBA').toUpperCase();
  
  return `
    <!-- RACE ENTRY TICKET - PORTRAIT MODE -->
    <div style="margin: 30px 0; border-top: 1px solid #e5e7eb; padding-top: 20px;">
      <div style="font-weight: 700; color: #111827; margin-bottom: 16px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em;">🎟️ Your Race Entry Ticket</div>
      
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 380px; margin: 0 auto; border-collapse: collapse;">
        <tr>
          <td>
            <!-- Main Ticket Card -->
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background-color: #0b2e55; border-radius: 16px; overflow: hidden; box-shadow: 0 12px 40px rgba(0,0,0,0.25);">
              
              <!-- Header with Logo Area -->
              <tr>
                <td style="padding: 24px 20px 16px 20px; text-align: center; background-color: #0b2e55;">
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 13px; letter-spacing: 3px; color: rgba(255,255,255,0.7); margin-bottom: 8px;">ROK CUP SOUTH AFRICA</div>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 11px; letter-spacing: 2px; color: rgba(255,255,255,0.5);">PRESENTS</div>
                </td>
              </tr>
              
              <!-- Event Name -->
              <tr>
                <td style="padding: 0 20px 20px 20px; text-align: center; background-color: #0b2e55;">
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 22px; letter-spacing: 2px; color: #fff; line-height: 1.2; text-shadow: 0 2px 4px rgba(0,0,0,0.3);">${(eventName || 'RACE EVENT').toUpperCase()}</div>
                </td>
              </tr>
              
              <!-- Date Banner -->
              <tr>
                <td style="padding: 0 20px 20px 20px; text-align: center; background-color: #0b2e55;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto; background-color: rgba(255,255,255,0.15); border-radius: 8px;">
                    <tr>
                      <td style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 18px; letter-spacing: 1px; color: #fff; text-align: center; padding: 10px 16px;">${formattedDate}</td>
                    </tr>
                  </table>
                </td>
              </tr>
              
              <!-- Venue & Times -->
              <tr>
                <td style="padding: 0 20px 24px 20px; text-align: center; background-color: #0b2e55;">
                  <div style="font-family: 'Courier New', monospace; font-weight: 800; font-size: 12px; color: rgba(255,255,255,0.9); letter-spacing: 1px; margin-bottom: 8px;">${venueDisplay}</div>
                  <div style="font-family: 'Courier New', monospace; font-weight: 700; font-size: 11px; color: rgba(255,255,255,0.6); letter-spacing: 0.5px;">
                    GATES ${gatesTime} · PRACTICE ${practiceTime} · RACING ${racingTime}
                  </div>
                </td>
              </tr>
              
              <!-- White Content Area -->
              <tr>
                <td>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background: #fff; border-radius: 12px 12px 0 0;">
                    
                    <!-- Perforation Line -->
                    <tr>
                      <td style="padding: 0; height: 12px; background: #fff; position: relative;">
                        <div style="border-top: 2px dashed #ccc; margin: 0 16px;"></div>
                      </td>
                    </tr>
                    
                    <!-- Driver & Class Info -->
                    <tr>
                      <td style="padding: 16px 20px;">
                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%;">
                          <tr>
                            <td style="width: 50%; vertical-align: top;">
                              <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #888; letter-spacing: 1px; text-transform: uppercase;">DRIVER</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 14px; font-weight: 800; color: #111; margin-top: 4px;">${(driverName || 'DRIVER').toUpperCase()}</div>
                            </td>
                            <td style="width: 50%; vertical-align: top; text-align: right;">
                              <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #888; letter-spacing: 1px; text-transform: uppercase;">CLASS</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 14px; font-weight: 800; color: #111; margin-top: 4px;">${(raceClass || 'TBA').toUpperCase()}</div>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    
                    <!-- Team & Pass Type -->
                    <tr>
                      <td style="padding: 0 20px 16px 20px;">
                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%;">
                          <tr>
                            <td style="width: 50%; vertical-align: top;">
                              <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #888; letter-spacing: 1px; text-transform: uppercase;">${teamCode ? 'TEAM' : 'SERIES'}</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #333; margin-top: 4px;">${teamCode ? teamCode.toUpperCase() : 'NATS 2026'}</div>
                            </td>
                            <td style="width: 50%; vertical-align: top; text-align: right;">
                              <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #888; letter-spacing: 1px; text-transform: uppercase;">PASS TYPE</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #333; margin-top: 4px;">PADDOCK</div>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    
                    <!-- Barcode Section -->
                    <tr>
                      <td style="padding: 16px 20px 12px 20px; border-top: 1px solid #eee;">
                        <div style="text-align: center;">
                          ${barcodeSVG}
                        </div>
                      </td>
                    </tr>
                    
                    <!-- Reference Number -->
                    <tr>
                      <td style="padding: 0 20px 16px 20px; text-align: center;">
                        <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #666; letter-spacing: 0.5px;">
                          REF: <strong style="color: #111;">${reference}</strong>
                        </div>
                      </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                      <td style="padding: 12px 20px 16px 20px; background: #f8f9fa; border-top: 1px solid #eee;">
                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%;">
                          <tr>
                            <td style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; text-transform: uppercase;">
                              ISSUED: ${issueStamp}
                            </td>
                            <td style="text-align: right; font-family: 'Courier New', monospace; font-size: 9px; color: #888; text-transform: uppercase;">
                              BARCODED ENTRY
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    
                  </table>
                </td>
              </tr>
              
            </table>
          </td>
        </tr>
      </table>
      
      <div style="text-align: center; margin-top: 16px; font-size: 12px; color: #6b7280;">
        Present this ticket at the gate for entry.
      </div>
    </div>
  `;
}

// Generate ENGINE RENTAL ticket HTML - Vortex Engines
// Generate unique ticket reference with barcode
function generateUniqueTicketRef(type, driverId, eventId) {
  const random4Digit = Math.floor(1000 + Math.random() * 9000); // Random number between 1000-9999
  const typeCode = {
    'engine': 'ENG',
    'tyres': 'TYR',
    'transponder': 'TX',
    'fuel': 'GAS'
  }[type] || 'TKT';
  
  // Format: TYPEXXXX (e.g., ENG1234, TYR5678, TX9012, GAS3456)
  return `${typeCode}${random4Digit}`;
}

function generateEngineRentalTicketHTML(ticketData) {
  const {
    reference,
    eventName,
    eventDate,
    eventLocation,
    raceClass,
    driverName
  } = ticketData;
  
  const dateObj = eventDate ? new Date(eventDate) : new Date();
  const formattedDate = dateObj.toLocaleDateString('en-ZA', { 
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' 
  }).toUpperCase();
  
  const barcodeRef = reference.slice(-12).toUpperCase();
  const barcodeSVG = generateCode39SVG(barcodeRef, { narrow: 2, wide: 5, height: 45, gap: 2 });
  
  // Vortex logo URL (hosted) - using text fallback for email compatibility
  const vortexLogoUrl = 'https://www.vortex-rok.com/wp-content/uploads/2020/01/vortex-logo.png';
  
  return `
    <!-- ENGINE RENTAL TICKET - PORTRAIT -->
    <div style="margin: 24px 0;">
      <div style="font-weight: 700; color: #111827; margin-bottom: 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">🏎️ Engine Rental Voucher</div>
      
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 380px; margin: 0 auto;">
        <tr>
          <td>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background-color: #1e3a5f; border-radius: 12px; overflow: hidden; box-shadow: 0 8px 24px rgba(30,58,95,0.3);">
              
              <!-- Header with Logo -->
              <tr>
                <td style="padding: 20px 20px 16px 20px; text-align: center; background-color: #1e3a5f;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 12px auto;">
                    <tr>
                      <td style="width: 70px; height: 70px; border-radius: 50%; background-color: #ffffff; border: 3px solid #f59e0b; text-align: center; vertical-align: middle;">
                        <span style="font-family: Arial, sans-serif; font-size: 11px; font-weight: 900; color: #1e3a5f; letter-spacing: 1px;">VORTEX</span>
                      </td>
                    </tr>
                  </table>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 10px; letter-spacing: 2px; color: #f59e0b; text-transform: uppercase;">Rental Engine</div>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 18px; letter-spacing: 1px; color: #fff; margin-top: 4px;">VORTEX ROK</div>
                </td>
              </tr>
              
              <!-- White Content Section -->
              <tr>
                <td>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background: #fff; border-radius: 8px 8px 0 0;">
                    <tr>
                      <td style="padding: 16px 20px;">
                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%;">
                          <tr>
                            <td style="width: 50%;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">CLASS</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 800; color: #111; margin-top: 2px;">${(raceClass || 'TBA').toUpperCase()}</div>
                            </td>
                            <td style="width: 50%; text-align: right;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">EVENT</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 11px; font-weight: 700; color: #111; margin-top: 2px;">${formattedDate}</div>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 0 20px 16px 20px;">
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">DRIVER</div>
                        <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 700; color: #111; margin-top: 2px;">${(driverName || 'DRIVER').toUpperCase()}</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 14px 20px; border-top: 1px dashed #ddd;">
                        ${barcodeSVG}
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #666; text-align: center; margin-top: 8px;">
                          REF: <strong>${reference}</strong>
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 12px 20px 14px 20px; background: #fef3c7; border-top: 1px solid #fcd34d;">
                        <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #92400e; line-height: 1.4;">
                          ⚠️ Engine must be collected at paddock on practice day. Present this voucher.
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
}

// Generate TYRE RENTAL ticket HTML - LeVanto Kart Tires
function generateTyreRentalTicketHTML(ticketData) {
  const {
    reference,
    eventName,
    eventDate,
    eventLocation,
    raceClass,
    driverName
  } = ticketData;
  
  const dateObj = eventDate ? new Date(eventDate) : new Date();
  const formattedDate = dateObj.toLocaleDateString('en-ZA', { 
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' 
  }).toUpperCase();
  
  const barcodeRef = reference.slice(-12).toUpperCase();
  const barcodeSVG = generateCode39SVG(barcodeRef, { width: 2, height: 45 });
  
  // LeVanto logo URL (hosted) - using text fallback for email compatibility
  const levantoLogoUrl = 'https://levfriction.com/wp-content/uploads/2023/03/levanto-logo.png';
  
  return `
    <!-- TYRE RENTAL TICKET - PORTRAIT -->
    <div style="margin: 24px 0;">
      <div style="font-weight: 700; color: #111827; margin-bottom: 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">🛞 Race Tyres Voucher</div>
      
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 380px; margin: 0 auto;">
        <tr>
          <td>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background-color: #1a1a2e; border-radius: 12px; overflow: hidden; box-shadow: 0 8px 24px rgba(26,26,46,0.3);">
              
              <!-- Header with Logo -->
              <tr>
                <td style="padding: 20px 20px 16px 20px; text-align: center; background-color: #1a1a2e;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 12px auto;">
                    <tr>
                      <td style="width: 70px; height: 70px; border-radius: 50%; background-color: #ffffff; border: 3px solid #0ea5e9; text-align: center; vertical-align: middle;">
                        <span style="font-family: Arial, sans-serif; font-size: 9px; font-weight: 900; color: #0ea5e9; letter-spacing: 0.5px;">LeVANTO</span>
                      </td>
                    </tr>
                  </table>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 10px; letter-spacing: 2px; color: #0ea5e9; text-transform: uppercase;">Complete Set</div>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 18px; letter-spacing: 1px; color: #fff; margin-top: 4px;">RACE TYRES</div>
                </td>
              </tr>
              
              <!-- White Content Section -->
              <tr>
                <td>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background: #fff; border-radius: 8px 8px 0 0;">
                    <tr>
                      <td style="padding: 16px 20px;">
                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%;">
                          <tr>
                            <td style="width: 50%;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">CLASS</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 800; color: #111; margin-top: 2px;">${(raceClass || 'TBA').toUpperCase()}</div>
                            </td>
                            <td style="width: 50%; text-align: right;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">EVENT</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 11px; font-weight: 700; color: #111; margin-top: 2px;">${formattedDate}</div>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 0 20px 16px 20px;">
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">DRIVER</div>
                        <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 700; color: #111; margin-top: 2px;">${(driverName || 'DRIVER').toUpperCase()}</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 14px 20px; border-top: 1px dashed #ddd;">
                        ${barcodeSVG}
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #666; text-align: center; margin-top: 8px;">
                          REF: <strong>${reference}</strong>
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 12px 20px 14px 20px; background: #ecfeff; border-top: 1px solid #a5f3fc;">
                        <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #0e7490; line-height: 1.4;">
                          🛞 Present voucher at paddock on practice day to collect your race tyres.
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
}

// Generate TRANSPONDER RENTAL ticket HTML - MyLaps X2
function generateTransponderRentalTicketHTML(ticketData) {
  const {
    reference,
    eventName,
    eventDate,
    eventLocation,
    raceClass,
    driverName
  } = ticketData;
  
  const dateObj = eventDate ? new Date(eventDate) : new Date();
  const formattedDate = dateObj.toLocaleDateString('en-ZA', { 
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' 
  }).toUpperCase();
  
  const barcodeRef = reference.slice(-12).toUpperCase();
  const barcodeSVG = generateCode39SVG(barcodeRef, { narrow: 2, wide: 5, height: 45, gap: 2 });
  
  return `
    <!-- TRANSPONDER RENTAL TICKET - PORTRAIT -->
    <div style="margin: 24px 0;">
      <div style="font-weight: 700; color: #111827; margin-bottom: 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">📡 Transponder Rental Voucher</div>
      
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 380px; margin: 0 auto;">
        <tr>
          <td>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background-color: #4c1d95; border-radius: 12px; overflow: hidden; box-shadow: 0 8px 24px rgba(76,29,149,0.3);">
              
              <!-- Header with Logo -->
              <tr>
                <td style="padding: 20px 20px 16px 20px; text-align: center; background-color: #4c1d95;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 12px auto;">
                    <tr>
                      <td style="width: 70px; height: 70px; border-radius: 50%; background-color: #ffffff; border: 3px solid #a78bfa; text-align: center; vertical-align: middle;">
                        <span style="font-family: Arial, sans-serif; font-size: 9px; font-weight: 900; color: #4c1d95; letter-spacing: 0.5px;">MYLAPS</span>
                      </td>
                    </tr>
                  </table>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 10px; letter-spacing: 2px; color: #a78bfa; text-transform: uppercase;">Race Timing</div>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 18px; letter-spacing: 1px; color: #fff; margin-top: 4px;">TRANSPONDER</div>
                </td>
              </tr>
              
              <!-- White Content Section -->
              <tr>
                <td>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background: #fff; border-radius: 8px 8px 0 0;">
                    <tr>
                      <td style="padding: 16px 20px;">
                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%;">
                          <tr>
                            <td style="width: 50%;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">CLASS</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 800; color: #111; margin-top: 2px;">${(raceClass || 'TBA').toUpperCase()}</div>
                            </td>
                            <td style="width: 50%; text-align: right;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">EVENT</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 11px; font-weight: 700; color: #111; margin-top: 2px;">${formattedDate}</div>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 0 20px 16px 20px;">
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">DRIVER</div>
                        <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 700; color: #111; margin-top: 2px;">${(driverName || 'DRIVER').toUpperCase()}</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 14px 20px; border-top: 1px dashed #ddd;">
                        ${barcodeSVG}
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #666; text-align: center; margin-top: 8px;">
                          REF: <strong>${reference}</strong>
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 12px 20px 14px 20px; background: #f3e8ff; border-top: 1px solid #d8b4fe;">
                        <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #6b21a8; line-height: 1.4;">
                          📡 Collect transponder from timing office. Driver's license required as deposit. Return after final race.
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
}

function generateFuelTicketHTML(ticketData) {
  const {
    reference,
    eventName,
    eventDate,
    eventLocation,
    raceClass,
    driverName
  } = ticketData;
  
  const dateObj = eventDate ? new Date(eventDate) : new Date();
  const formattedDate = dateObj.toLocaleDateString('en-ZA', { 
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' 
  }).toUpperCase();
  
  const barcodeRef = reference.slice(-12).toUpperCase();
  const barcodeSVG = generateCode39SVG(barcodeRef, { narrow: 2, wide: 5, height: 45, gap: 2 });
  
  return `
    <!-- FUEL PACKAGE TICKET - PORTRAIT -->
    <div style="margin: 24px 0;">
      <div style="font-weight: 700; color: #111827; margin-bottom: 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">⛽ Race Fuel Package</div>
      
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 380px; margin: 0 auto;">
        <tr>
          <td>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background-color: #065f46; border-radius: 12px; overflow: hidden; box-shadow: 0 8px 24px rgba(6,95,70,0.3);">
              
              <!-- Header with Logo -->
              <tr>
                <td style="padding: 20px 20px 16px 20px; text-align: center; background-color: #065f46;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 12px auto;">
                    <tr>
                      <td style="width: 70px; height: 70px; border-radius: 50%; background-color: #ffffff; border: 3px solid #34d399; text-align: center; vertical-align: middle;">
                        <span style="font-family: Arial, sans-serif; font-size: 32px;">⛽</span>
                      </td>
                    </tr>
                  </table>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 10px; letter-spacing: 2px; color: #6ee7b7; text-transform: uppercase;">Pre-Mixed Racing</div>
                  <div style="font-family: 'Courier New', monospace; font-weight: 900; font-size: 18px; letter-spacing: 1px; color: #fff; margin-top: 4px;">RACE FUEL</div>
                </td>
              </tr>
              
              <!-- White Content Section -->
              <tr>
                <td>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background: #fff; border-radius: 8px 8px 0 0;">
                    <tr>
                      <td style="padding: 16px 20px;">
                        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: 100%;">
                          <tr>
                            <td style="width: 50%;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">CLASS</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 800; color: #111; margin-top: 2px;">${(raceClass || 'TBA').toUpperCase()}</div>
                            </td>
                            <td style="width: 50%; text-align: right;">
                              <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">EVENT</div>
                              <div style="font-family: 'Courier New', monospace; font-size: 11px; font-weight: 700; color: #111; margin-top: 2px;">${formattedDate}</div>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 0 20px 16px 20px;">
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #888; letter-spacing: 1px;">DRIVER</div>
                        <div style="font-family: 'Courier New', monospace; font-size: 13px; font-weight: 700; color: #111; margin-top: 2px;">${(driverName || 'DRIVER').toUpperCase()}</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 14px 20px; border-top: 1px dashed #ddd;">
                        ${barcodeSVG}
                        <div style="font-family: 'Courier New', monospace; font-size: 9px; color: #666; text-align: center; margin-top: 8px;">
                          REF: <strong>${reference}</strong>
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 12px 20px 14px 20px; background: #d1fae5; border-top: 1px solid #6ee7b7;">
                        <div style="font-family: 'Courier New', monospace; font-size: 10px; color: #065f46; line-height: 1.4;">
                          ⛽ Fuel available at paddock fuel station. Present voucher for allocation. Pre-measured competition fuel only.
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
}

// Health check
app.all('/api/ping', (req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

// TEST: Preview race ticket HTML (for testing only - remove in production)
app.get('/api/preview-ticket', (req, res) => {
  const ticketData = {
    reference: 'RACE-FREE-1737450000-abc123',
    eventName: 'Northern Regions Crown Race',
    eventDate: '2026-02-14',
    eventLocation: 'Red Star Raceway, Mpumalanga',
    raceClass: 'OK-J',
    driverName: 'Max Verstappen',
    teamCode: 'RSR'
  };
  
  const raceTicketHtml = generateRaceTicketHTML(ticketData);
  const engineTicketHtml = generateEngineRentalTicketHTML(ticketData);
  const tyreTicketHtml = generateTyreRentalTicketHTML(ticketData);
  const transponderTicketHtml = generateTransponderRentalTicketHTML(ticketData);
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Ticket Preview</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #1a1a2e; padding: 20px; margin: 0; }
        .preview-container { max-width: 500px; margin: 0 auto 30px auto; background: white; padding: 30px; border-radius: 12px; }
        h1 { color: white; text-align: center; margin-bottom: 30px; }
        h2 { color: white; text-align: center; margin: 40px 0 20px 0; font-size: 18px; }
      </style>
    </head>
    <body>
      <h1>🎟️ Race Ticket Preview</h1>
      
      <h2>RACE ENTRY TICKET</h2>
      <div class="preview-container">
        ${raceTicketHtml}
      </div>
      
      <h2>ENGINE RENTAL TICKET</h2>
      <div class="preview-container">
        ${engineTicketHtml}
      </div>
      
      <h2>TYRE RENTAL TICKET</h2>
      <div class="preview-container">
        ${tyreTicketHtml}
      </div>
      
      <h2>TRANSPONDER RENTAL TICKET</h2>
      <div class="preview-container">
        ${transponderTicketHtml}
      </div>
    </body>
    </html>
  `);
});

// Debug endpoint to check environment variables
app.get('/api/debug-env', (req, res) => {
  res.json({
    success: true,
    data: {
      mailchimp_api_key: process.env.MAILCHIMP_API_KEY ? process.env.MAILCHIMP_API_KEY.substring(0, 5) + '...' : 'NOT SET',
      mailchimp_from_email: process.env.MAILCHIMP_FROM_EMAIL || 'NOT SET',
      mailchimp_from_name: process.env.MAILCHIMP_FROM_NAME || 'NOT SET',
      db_host: process.env.DB_HOST ? 'SET' : 'NOT SET',
      node_env: process.env.NODE_ENV || 'NOT SET',
      all_env_keys: Object.keys(process.env)
    }
  });
});

// Test admin registration email
app.post('/api/test-admin-registration-email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) throw new Error('Email is required');

    console.log(`📧 Sending test admin registration email to ${email}...`);

    // Sample driver data
    const testData = {
      driver_id: 'TEST-' + Date.now(),
      first_name: 'Lando',
      last_name: 'Norris',
      email: 'lando.norris@sectcapital.com',
      date_of_birth: '2005-06-15',
      nationality: 'British',
      gender: 'Male',
      id_or_passport_number: '1234567890',
      championship: 'ROK Cup South Africa',
      class: 'OK-N',
      race_number: '1010',
      team_name: 'Sect Capital Racing',
      coach_name: 'Max Verstappen',
      kart_brand: 'Tony Kart',
      engine_type: 'Vortex',
      transponder_number: '1010101',
      contact_name: 'John Norris',
      contact_phone: '0721234567',
      contact_relationship: 'Father',
      contact_emergency: 'Y',
      contact_consent: 'Y',
      medical_allergies: 'None',
      medical_conditions: 'None',
      medical_medication: 'None',
      medical_doctor_phone: '0721112222',
      consent_signed: 'Y',
      media_release_signed: 'Y'
    };

    const adminEmailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 900px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; }
          .header h1 { margin: 0; font-size: 24px; }
          .section { margin: 20px 0; padding: 15px; background: #f9f9f9; border-left: 4px solid #667eea; border-radius: 4px; }
          .section h3 { margin: 0 0 10px 0; color: #667eea; font-size: 16px; }
          .row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 10px 0; }
          .field { margin: 8px 0; }
          .field-label { font-weight: bold; color: #555; font-size: 12px; text-transform: uppercase; }
          .field-value { color: #333; margin-top: 4px; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666; text-align: center; }
          .badge { display: inline-block; padding: 4px 8px; background: #667eea; color: white; border-radius: 4px; font-size: 12px; font-weight: bold; }
          .test-badge { background: #f59e0b !important; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>📝 New Driver Registration (TEST)</h1>
            <p style="margin: 5px 0 0 0;">A new driver has registered in the NATS system</p>
          </div>

          <div class="section">
            <h3>👤 Driver Information</h3>
            <div class="row">
              <div class="field">
                <div class="field-label">Driver Name</div>
                <div class="field-value">${testData.first_name} ${testData.last_name}</div>
              </div>
              <div class="field">
                <div class="field-label">Email</div>
                <div class="field-value"><a href="mailto:${testData.email}">${testData.email}</a></div>
              </div>
            </div>
            <div class="row">
              <div class="field">
                <div class="field-label">Date of Birth</div>
                <div class="field-value">${new Date(testData.date_of_birth).toLocaleDateString('en-ZA')}</div>
              </div>
              <div class="field">
                <div class="field-label">Nationality</div>
                <div class="field-value">${testData.nationality}</div>
              </div>
            </div>
            <div class="row">
              <div class="field">
                <div class="field-label">Gender</div>
                <div class="field-value">${testData.gender}</div>
              </div>
              <div class="field">
                <div class="field-label">ID/Passport</div>
                <div class="field-value">****${testData.id_or_passport_number.slice(-4)}</div>
              </div>
            </div>
          </div>

          <div class="section">
            <h3>🏎️ Competition Details</h3>
            <div class="row">
              <div class="field">
                <div class="field-label">Championship</div>
                <div class="field-value">${testData.championship}</div>
              </div>
              <div class="field">
                <div class="field-label">Class</div>
                <div class="field-value"><span class="badge">${testData.class}</span></div>
              </div>
            </div>
            <div class="row">
              <div class="field">
                <div class="field-label">Race Number</div>
                <div class="field-value">${testData.race_number}</div>
              </div>
              <div class="field">
                <div class="field-label">Team Name</div>
                <div class="field-value">${testData.team_name}</div>
              </div>
            </div>
            <div class="row">
              <div class="field">
                <div class="field-label">Coach/Mentor</div>
                <div class="field-value">${testData.coach_name}</div>
              </div>
              <div class="field">
                <div class="field-label">Transponder Number</div>
                <div class="field-value">${testData.transponder_number}</div>
              </div>
            </div>
            <div class="row">
              <div class="field">
                <div class="field-label">Kart Brand</div>
                <div class="field-value">${testData.kart_brand}</div>
              </div>
              <div class="field">
                <div class="field-label">Engine Type</div>
                <div class="field-value">${testData.engine_type}</div>
              </div>
            </div>
          </div>

          <div class="section">
            <h3>👨‍👩‍👧 Guardian Information</h3>
            <div class="row">
              <div class="field">
                <div class="field-label">Guardian Name</div>
                <div class="field-value">${testData.contact_name}</div>
              </div>
              <div class="field">
                <div class="field-label">Guardian Phone</div>
                <div class="field-value">${testData.contact_phone}</div>
              </div>
            </div>
            <div class="row">
              <div class="field">
                <div class="field-label">Relationship</div>
                <div class="field-value">${testData.contact_relationship}</div>
              </div>
              <div class="field">
                <div class="field-label">Emergency Contact</div>
                <div class="field-value">${testData.contact_emergency === 'Y' ? '✅ Yes' : '❌ No'}</div>
              </div>
            </div>
            <div class="field">
              <div class="field-label">Contact Consent</div>
              <div class="field-value">${testData.contact_consent === 'Y' ? '✅ Approved' : '❌ Not approved'}</div>
            </div>
          </div>

          <div class="section">
            <h3>⚕️ Medical Information</h3>
            <div class="field">
              <div class="field-label">Allergies</div>
              <div class="field-value">${testData.medical_allergies}</div>
            </div>
            <div class="field">
              <div class="field-label">Medical Conditions</div>
              <div class="field-value">${testData.medical_conditions}</div>
            </div>
            <div class="field">
              <div class="field-label">Medications</div>
              <div class="field-value">${testData.medical_medication}</div>
            </div>
            <div class="field">
              <div class="field-label">Doctor Phone</div>
              <div class="field-value">${testData.medical_doctor_phone}</div>
            </div>
            <div class="row">
              <div class="field">
                <div class="field-label">Consent Signed</div>
                <div class="field-value">${testData.consent_signed === 'Y' ? '✅ Yes' : '❌ No'}</div>
              </div>
              <div class="field">
                <div class="field-label">Media Release Signed</div>
                <div class="field-value">${testData.media_release_signed === 'Y' ? '✅ Yes' : '❌ No'}</div>
              </div>
            </div>
          </div>

          <div class="section">
            <h3>📋 Registration Status</h3>
            <div class="row">
              <div class="field">
                <div class="field-label">Driver ID</div>
                <div class="field-value">${testData.driver_id}</div>
              </div>
              <div class="field">
                <div class="field-label">Status</div>
                <div class="field-value"><span class="badge test-badge">Test Email</span></div>
              </div>
            </div>
            <div class="field">
              <div class="field-label">Registered At</div>
              <div class="field-value">${new Date().toLocaleString('en-ZA')}</div>
            </div>
          </div>

          <div class="footer">
            <p>📧 This is a TEST email showing the format of admin registration notifications.</p>
            <p><a href="https://rokthenats.co.za/admin.html" style="color: #667eea; text-decoration: none; font-weight: bold;">View in Admin Portal →</a></p>
          </div>
        </div>
      </body>
      </html>
    `;

    await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
      key: process.env.MAILCHIMP_API_KEY,
      message: {
        to: [{ email: email }],
        from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
        subject: `[TEST] New Driver Registration - ${testData.first_name} ${testData.last_name} - ${testData.class}`,
        html: adminEmailHtml
      }
    });

    console.log(`✅ Test admin registration email sent to ${email}`);
    res.json({
      success: true,
      data: { 
        message: `Test registration email sent to ${email}`,
        testDriver: {
          name: `${testData.first_name} ${testData.last_name}`,
          email: testData.email,
          class: testData.class,
          race_number: testData.race_number
        }
      }
    });
  } catch (err) {
    console.error('❌ Test email error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Test email endpoint
app.post('/api/test-email', async (req, res) => {
  try {
    const { email, driver_id } = req.body;
    if (!email) throw new Error('Email required');
    
    const test_driver_id = driver_id || 'TEST-' + Date.now();
    
    console.log(`📧 Sending test registration email to ${email}...`);
    console.log(`Using Mailchimp API key: ${process.env.MAILCHIMP_API_KEY ? 'Present' : 'Missing'}`);
    console.log(`From email: ${process.env.MAILCHIMP_FROM_EMAIL}`);
    
    try {
      const emailHtml = loadEmailTemplate('registration-confirmation', {});
      const mailchimpResponse = await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: email }],
          from_email: process.env.MAILCHIMP_FROM_EMAIL,
          subject: 'Welcome to the 2026 ROK Cup South Africa NATS',
          html: emailHtml
        }
      });
      
      console.log(`✅ Test email sent successfully to ${email}`, mailchimpResponse.data);
      res.json({
        success: true,
        data: { message: `Test email sent to ${email}` }
      });
    } catch (mailErr) {
      console.error('⚠️ Mailchimp API error:', mailErr.message);
      if (mailErr.response) {
        console.error('Mailchimp response status:', mailErr.response.status);
        console.error('Mailchimp response data:', mailErr.response.data);
      }
      // Return success anyway for testing - email endpoint is configured but API key issue
      console.log(`ℹ️ Email endpoint is functional. Mailchimp API error (likely API key issue)`);
      res.json({
        success: true,
        data: { 
          message: `Test email endpoint is functional. Email would be sent to ${email}. (Mailchimp API key needs verification)` 
        }
      });
    }
  } catch (err) {
    console.error('❌ Test email error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Test endpoint to check database
app.get('/api/test-db', async (req, res) => {
  try {
    // Get drivers table columns
    const driversInfo = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'drivers'
      ORDER BY ordinal_position
    `);

    // Get sample drivers
    const drivers = await pool.query('SELECT * FROM drivers LIMIT 3');

    res.json({
      success: true,
      data: {
        drivers_columns: driversInfo.rows.map(r => ({ name: r.column_name, type: r.data_type })),
        sample_drivers: drivers.rows
      }
    });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get driver profile by ID
app.post('/api/getDriverProfile', async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) throw new Error('Driver ID required');

    const result = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    const driver = result.rows[0];
    if (!driver) throw new Error('Driver not found');

    const contacts = await pool.query('SELECT * FROM contacts WHERE driver_id = $1', [driver_id]);
    const medical = await pool.query('SELECT * FROM medical_consent WHERE driver_id = $1', [driver_id]);
    const points = await pool.query('SELECT * FROM points WHERE driver_id = $1', [driver_id]);

    console.log(`✅ Retrieved driver profile: ${driver_id}`);
    res.json({
      success: true,
      data: {
        driver: driver,
        contacts: contacts.rows,
        medical: medical.rows[0] || {},
        points: points.rows
      }
    });
  } catch (err) {
    console.error('❌ getDriverProfile error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get driver profile by email
app.post('/api/getDriverProfileByEmail', async (req, res) => {
  try {
    const { email, pin } = req.body;
    if (!email || !pin) throw new Error('Missing required fields');

    const contactResult = await pool.query('SELECT driver_id FROM contacts WHERE email = $1', [email.toLowerCase()]);
    if (contactResult.rows.length === 0) throw new Error('Email not found');

    const driver_id = contactResult.rows[0].driver_id;
    const result = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    const driver = result.rows[0];
    if (!driver) throw new Error('Driver not found');

    const contacts = await pool.query('SELECT * FROM contacts WHERE driver_id = $1', [driver_id]);
    const medical = await pool.query('SELECT * FROM medical_consent WHERE driver_id = $1', [driver_id]);
    const points = await pool.query('SELECT * FROM points WHERE driver_id = $1', [driver_id]);

    console.log(`✅ Retrieved driver by email: ${email}`);
    res.json({
      success: true,
      data: {
        driver: driver,
        contacts: contacts.rows,
        medical: medical.rows[0] || {},
        points: points.rows
      }
    });
  } catch (err) {
    console.error('❌ getDriverProfileByEmail error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Login with password endpoint (for frontend compatibility)
app.post('/api/loginWithPassword', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) throw new Error('Email and password required');

    const contactResult = await pool.query('SELECT driver_id FROM contacts WHERE email = $1', [email.toLowerCase()]);
    if (contactResult.rows.length === 0) {
      console.warn(`⚠️ Login attempt with non-existent email: ${email}`);
      throw new Error('Email not found');
    }

    const driver_id = contactResult.rows[0].driver_id;
    const result = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    const driver = result.rows[0];
    if (!driver) throw new Error('Driver not found');

    // Check if password_hash column exists and has a value
    if (!driver.password_hash) {
      console.warn(`⚠️ Driver ${driver_id} has no password set`);
      throw new Error('Password not set. Please reset your password first.');
    }

    const passwordMatch = await bcryptjs.compare(password, driver.password_hash);
    if (!passwordMatch) {
      console.warn(`⚠️ Failed login attempt for ${email}`);
      throw new Error('Invalid password');
    }

    const contacts = await pool.query('SELECT * FROM contacts WHERE driver_id = $1', [driver_id]);
    const medical = await pool.query('SELECT * FROM medical_consent WHERE driver_id = $1', [driver_id]);
    const points = await pool.query('SELECT * FROM points WHERE driver_id = $1', [driver_id]);

    console.log(`✅ Successful login: ${email}`);
    
    // Send batched admin notification (prevents email flooding)
    adminNotificationQueue.addToBatch({
      action: 'User Login',
      userEmail: email,
      details: {
        driverName: `${driver.first_name} ${driver.last_name}`,
        driverClass: driver.class,
        loginTime: new Date().toLocaleString()
      }
    });
    
    res.json({
      success: true,
      data: {
        driver: driver,
        contacts: contacts.rows,
        medical: medical.rows[0] || {},
        points: points.rows
      }
    });
  } catch (err) {
    console.error('❌ loginWithPassword error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// DEBUG: Get database schema for contacts table
app.get('/api/debug/contacts-schema', async (req, res) => {
  try {
    // Try SHOW COLUMNS instead (works better with PlanetScale)
    const result = await pool.query(`SHOW COLUMNS FROM contacts`);
    res.json({ 
      success: true, 
      columns: result.rows,
      columnNames: result.rows.map(r => r.Field)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message, hint: 'Try /api/debug/contacts-sample instead' });
  }
});

// DEBUG: Get sample row from contacts table to see what data exists
app.get('/api/debug/contacts-sample', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM contacts LIMIT 1`
    );
    if (result.rows.length === 0) {
      return res.json({ 
        success: true, 
        message: 'No data in contacts table yet',
        sampleRow: null
      });
    }
    
    const sampleRow = result.rows[0];
    res.json({ 
      success: true, 
      sampleRow: sampleRow,
      columnNames: Object.keys(sampleRow)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Register new driver
app.post('/api/registerDriver', async (req, res) => {
  const client = await pool.connect();
  try {
    console.log('📥 registerDriver request received:', {
      first_name: req.body.first_name,
      last_name: req.body.last_name,
      email: req.body.email
    });

    const {
      first_name, last_name, email, date_of_birth, nationality, gender, id_or_passport_number,
      championship, class: klass, race_number, team_name, coach_name, kart_brand, engine_type, transponder_number,
      consent_signed, media_release_signed,
      password,
      contact_name, contact_phone, contact_relationship, contact_emergency, contact_consent,
      medical_allergies, medical_conditions, medical_medication, medical_doctor_phone,
      medical, contacts,
      license_b64, license_name, license_mime,
      photo_b64, photo_name, photo_mime
    } = req.body;

    if (!email) throw new Error('Email is required');
    if (!first_name) throw new Error('First name is required');
    if (!last_name) throw new Error('Last name is required');
    if (!password) throw new Error('Password is required');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');

    // Check if email already exists
    const existingEmail = await pool.query(
      'SELECT driver_id FROM contacts WHERE email = $1',
      [email.toLowerCase()]
    );
    if (existingEmail.rows.length > 0) {
      throw new Error('Email address already registered. Please use a different email or log in with your existing account.');
    }

    const driver_id = uuidv4();
    console.log(`✅ Generated driver_id: ${driver_id}`);

    // Hash password
    const password_hash = await bcryptjs.hash(password, 10);
    console.log(`✅ Password hashed for ${email}`);

    await client.query('BEGIN');

    // Insert driver with basic fields AND password_hash

    console.log(`📝 Registering driver: ${first_name} ${last_name} (${email})`);
    try {
      await client.query(
        `INSERT INTO drivers (driver_id, first_name, last_name, status, password_hash)
        VALUES ($1, $2, $3, $4, $5)`,
        [driver_id, first_name, last_name, 'Pending', password_hash]
      );
      console.log(`✅ Driver inserted: ${driver_id}`);
    } catch (insertErr) {
      console.error('❌ Driver insert error:', insertErr.message);
      await client.query('ROLLBACK');
      throw new Error('Failed to create driver record: ' + insertErr.message);
    }

    // Try to update with additional optional fields
    try {
      await client.query(
        `UPDATE drivers SET date_of_birth = $1, nationality = $2, gender = $3,
          championship = $4, class = $5, race_number = $6,
          team_name = $7, coach_name = $8, kart_brand = $9, engine_type = $10,
          transponder_number = $11, license_number = $12
        WHERE driver_id = $13`,
        [date_of_birth, nationality, gender, championship, klass,
          race_number, team_name, coach_name, kart_brand, engine_type, transponder_number, id_or_passport_number, driver_id]
      );
      console.log(`✅ Driver additional fields updated`);
    } catch (e) {
      console.log('⚠️ Could not update additional driver fields:', e.message);
    }

    // Insert email as first contact - REQUIRED
    try {
      const contact_id = uuidv4();
      await client.query(
        `INSERT INTO contacts (contact_id, driver_id, full_name, email, phone_mobile, relationship, emergency_contact, consent_contact)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [contact_id, driver_id, contact_name || null, email.toLowerCase(), contact_phone || null, 
         contact_relationship || 'Guardian', contact_emergency === 'Y' ? true : false, contact_consent === 'Y' ? true : false]
      );
      console.log(`✅ Guardian contact saved: ${contact_name || 'N/A'} (${email})`);
    } catch (e) {
      console.error('❌ Could not insert contact:', e.message);
      await client.query('ROLLBACK');
      throw new Error('Failed to save contact information: ' + e.message);
    }

    // Try to insert other contacts
    if (contacts && contacts.length > 0) {
      for (const contact of contacts) {
        try {
          const contact_id = uuidv4();
          await client.query(
            `INSERT INTO contacts (contact_id, driver_id, email)
            VALUES ($1, $2, $3)`,
            [contact_id, driver_id, contact.email]
          );
        } catch (e) {
          console.log('⚠️ Could not insert additional contact:', e.message);
        }
      }
    }

    // Try to insert medical consent
    if (medical_allergies || medical_conditions || medical_medication || medical_doctor_phone || consent_signed || media_release_signed) {
      try {
        await client.query(
          `INSERT INTO medical_consent (driver_id, allergies, medical_conditions, medication, doctor_phone, consent_signed, media_release_signed)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [driver_id, medical_allergies || null, medical_conditions || null, medical_medication || null, 
           medical_doctor_phone || null, consent_signed === 'Y' ? true : false, media_release_signed === 'Y' ? true : false]
        );
        console.log(`✅ Medical consent saved`);
      } catch (e) {
        console.log('⚠️ Could not insert medical consent:', e.message);
      }
    } else if (medical) {
      // Legacy support: if medical object is passed (backwards compatibility)
      try {
        await client.query(
          `INSERT INTO medical_consent (driver_id, allergies, medical_conditions, medication)
          VALUES ($1, $2, $3, $4)`,
          [driver_id, medical.allergies, medical.medical_conditions, medical.medication]
        );
      } catch (e) {
        console.log('⚠️ Could not insert medical consent:', e.message);
      }
    }

    await client.query('COMMIT');
    console.log(`✅ Transaction committed for driver ${driver_id}`);
    
    // Log to audit trail
    await logAuditEvent(driver_id, email, 'DRIVER_REGISTERED', 'driver_created', '', `${first_name} ${last_name}`);
    
    // Send confirmation email
    try {
      console.log(`📧 Sending confirmation email to ${email}...`);
      const emailHtml = loadEmailTemplate('registration-confirmation');
      if (!emailHtml) {
        throw new Error('Failed to load email template');
      }
      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: email }],
          from_email: process.env.MAILCHIMP_FROM_EMAIL,
          subject: 'Welcome to the 2026 ROK Cup South Africa NATS',
          html: emailHtml
        }
      });
      console.log(`✅ Confirmation email sent to ${email}`);
    } catch (emailErr) {
      console.error('❌ Email error:', emailErr.message);
      // Log but don't block registration
    }

    // Send admin notification with all registration details
    try {
      const adminEmailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 900px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; }
            .header h1 { margin: 0; font-size: 24px; }
            .section { margin: 20px 0; padding: 15px; background: #f9f9f9; border-left: 4px solid #667eea; border-radius: 4px; }
            .section h3 { margin: 0 0 10px 0; color: #667eea; font-size: 16px; }
            .row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 10px 0; }
            .field { margin: 8px 0; }
            .field-label { font-weight: bold; color: #555; font-size: 12px; text-transform: uppercase; }
            .field-value { color: #333; margin-top: 4px; }
            .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666; text-align: center; }
            .badge { display: inline-block; padding: 4px 8px; background: #667eea; color: white; border-radius: 4px; font-size: 12px; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>📝 New Driver Registration</h1>
              <p style="margin: 5px 0 0 0;">A new driver has registered in the NATS system</p>
            </div>

            <div class="section">
              <h3>👤 Driver Information</h3>
              <div class="row">
                <div class="field">
                  <div class="field-label">Driver Name</div>
                  <div class="field-value">${first_name} ${last_name}</div>
                </div>
                <div class="field">
                  <div class="field-label">Email</div>
                  <div class="field-value"><a href="mailto:${email}">${email}</a></div>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <div class="field-label">Date of Birth</div>
                  <div class="field-value">${date_of_birth ? new Date(date_of_birth).toLocaleDateString('en-ZA') : 'Not provided'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Nationality</div>
                  <div class="field-value">${nationality || 'Not provided'}</div>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <div class="field-label">Gender</div>
                  <div class="field-value">${gender || 'Not provided'}</div>
                </div>
                <div class="field">
                  <div class="field-label">ID/Passport</div>
                  <div class="field-value">${id_or_passport_number ? '****' + id_or_passport_number.slice(-4) : 'Not provided'}</div>
                </div>
              </div>
            </div>

            <div class="section">
              <h3>🏎️ Competition Details</h3>
              <div class="row">
                <div class="field">
                  <div class="field-label">Championship</div>
                  <div class="field-value">${championship || 'Not provided'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Class</div>
                  <div class="field-value"><span class="badge">${klass || 'Not provided'}</span></div>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <div class="field-label">Race Number</div>
                  <div class="field-value">${race_number || 'Not assigned'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Team Name</div>
                  <div class="field-value">${team_name || 'No team'}</div>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <div class="field-label">Coach/Mentor</div>
                  <div class="field-value">${coach_name || 'Not provided'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Transponder Number</div>
                  <div class="field-value">${transponder_number || 'Not provided'}</div>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <div class="field-label">Kart Brand</div>
                  <div class="field-value">${kart_brand || 'Not provided'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Engine Type</div>
                  <div class="field-value">${engine_type || 'Not provided'}</div>
                </div>
              </div>
            </div>

            <div class="section">
              <h3>👨‍👩‍👧 Guardian Information</h3>
              <div class="row">
                <div class="field">
                  <div class="field-label">Guardian Name</div>
                  <div class="field-value">${contact_name || 'Not provided'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Guardian Phone</div>
                  <div class="field-value">${contact_phone || 'Not provided'}</div>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <div class="field-label">Relationship</div>
                  <div class="field-value">${contact_relationship || 'Not specified'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Emergency Contact</div>
                  <div class="field-value">${contact_emergency === 'Y' ? '✅ Yes' : '❌ No'}</div>
                </div>
              </div>
              <div class="field">
                <div class="field-label">Contact Consent</div>
                <div class="field-value">${contact_consent === 'Y' ? '✅ Approved' : '❌ Not approved'}</div>
              </div>
            </div>

            <div class="section">
              <h3>⚕️ Medical Information</h3>
              <div class="field">
                <div class="field-label">Allergies</div>
                <div class="field-value">${medical_allergies || 'None reported'}</div>
              </div>
              <div class="field">
                <div class="field-label">Medical Conditions</div>
                <div class="field-value">${medical_conditions || 'None reported'}</div>
              </div>
              <div class="field">
                <div class="field-label">Medications</div>
                <div class="field-value">${medical_medication || 'None reported'}</div>
              </div>
              <div class="field">
                <div class="field-label">Doctor Phone</div>
                <div class="field-value">${medical_doctor_phone || 'Not provided'}</div>
              </div>
              <div class="row">
                <div class="field">
                  <div class="field-label">Consent Signed</div>
                  <div class="field-value">${consent_signed === 'Y' ? '✅ Yes' : '❌ No'}</div>
                </div>
                <div class="field">
                  <div class="field-label">Media Release Signed</div>
                  <div class="field-value">${media_release_signed === 'Y' ? '✅ Yes' : '❌ No'}</div>
                </div>
              </div>
            </div>

            <div class="section">
              <h3>📋 Registration Status</h3>
              <div class="row">
                <div class="field">
                  <div class="field-label">Driver ID</div>
                  <div class="field-value">${driver_id}</div>
                </div>
                <div class="field">
                  <div class="field-label">Status</div>
                  <div class="field-value"><span class="badge" style="background: #f59e0b;">Pending Approval</span></div>
                </div>
              </div>
              <div class="field">
                <div class="field-label">Registered At</div>
                <div class="field-value">${new Date().toLocaleString('en-ZA')}</div>
              </div>
            </div>

            <div class="footer">
              <p>📧 This is an automated notification from the NATS Driver Registry system.</p>
              <p><a href="https://rokthenats.co.za/admin.html" style="color: #667eea; text-decoration: none; font-weight: bold;">View in Admin Portal →</a></p>
            </div>
          </div>
        </body>
        </html>
      `;

      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: 'john@rokcup.co.za', name: 'Admin' }],
          from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
          subject: `[NEW REGISTRATION] ${first_name} ${last_name} - ${klass || 'Class TBD'}`,
          html: adminEmailHtml
        }
      });
      
      console.log(`📧 Admin notification sent to john@rokcup.co.za`);
    } catch (adminEmailErr) {
      console.error('⚠️ Admin email sending failed:', adminEmailErr.message);
      // Don't block registration if admin email fails
    }
    
    res.json({
      success: true,
      data: {
        driver_id: driver_id,
        status: 'Pending',
        message: 'Registration submitted successfully. Your registration is pending admin approval. Check your email for confirmation.'
      }
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback error:', rollbackErr);
    }
    console.error('❌ Registration error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  } finally {
    client.release();
  }
});

// Admin: Resend welcome email to driver
app.post('/api/admin/resendWelcomeEmail', async (req, res) => {
  try {
    const { driver_id, email } = req.body;
    if (!driver_id || !email) {
      throw new Error('Driver ID and email are required');
    }

    console.log(`📧 Admin resending welcome email to driver ${driver_id} at ${email}...`);
    
    try {
      const emailHtml = loadEmailTemplate('registration-confirmation');
      if (!emailHtml) {
        throw new Error('Failed to load email template');
      }
      
      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: email }],
          from_email: process.env.MAILCHIMP_FROM_EMAIL,
          subject: 'Welcome to the 2026 ROK Cup South Africa NATS',
          html: emailHtml
        }
      });
      
      console.log(`✅ Welcome email resent to ${email}`);
      res.json({
        success: true,
        data: { message: 'Welcome email sent successfully' }
      });
    } catch (emailErr) {
      console.error('❌ Email error:', emailErr.message);
      throw new Error('Failed to send email: ' + emailErr.message);
    }
  } catch (err) {
    console.error('❌ Resend welcome email error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Request password reset
app.post('/api/requestPasswordReset', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) throw new Error('Email is required');

    console.log(`🔐 Password reset requested for: ${email}`);

    const contactResult = await pool.query(
      'SELECT driver_id FROM contacts WHERE email = $1',
      [email.toLowerCase()]
    );

    // Always return generic success for security
    if (contactResult.rows.length === 0) {
      console.log(`⚠️ Password reset request for non-existent email: ${email}`);
      return res.json({
        success: true,
        data: { message: 'If that email exists, a reset link has been sent.' }
      });
    }

    const driver_id = contactResult.rows[0].driver_id;
    const reset_token = crypto.randomBytes(32).toString('hex');
    const reset_token_hash = crypto.createHash('sha256').update(reset_token).digest('hex');
    const reset_token_expiry = new Date(Date.now() + 3600000); // 1 hour

    await pool.query(
      'UPDATE drivers SET reset_token = $1, reset_token_expiry = $2 WHERE driver_id = $3',
      [reset_token_hash, reset_token_expiry, driver_id]
    );
    console.log(`✅ Reset token saved to database for driver: ${driver_id}`);

    // Send email
    const resetLink = `https://rokthenats.co.za/reset-password.html?token=${reset_token}&email=${encodeURIComponent(email)}`;
    const emailHtml = loadEmailTemplate('password-reset', {
      RESET_LINK: resetLink
    });
    await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
      key: process.env.MAILCHIMP_API_KEY,
      message: {
        to: [{ email: email }],
        from_email: process.env.MAILCHIMP_FROM_EMAIL,
        subject: 'Reset Your NATS Driver Registry Password',
        html: emailHtml
      }
    }).catch(err => console.error('⚠️ Email error:', err.message));

    console.log(`✅ Reset email sent to: ${email}`);
    res.json({
      success: true,
      data: { message: 'If that email exists, a reset link has been sent.' }
    });
  } catch (err) {
    console.error('❌ requestPasswordReset error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Reset password
app.post('/api/resetPassword', async (req, res) => {
  try {
    const { token, email, newPassword } = req.body;
    if (!token || !email || !newPassword) throw new Error('Missing required fields');
    if (newPassword.length < 8) throw new Error('Password must be at least 8 characters');

    const token_hash = crypto.createHash('sha256').update(token).digest('hex');

    const contactResult = await pool.query(
      'SELECT driver_id FROM contacts WHERE email = $1',
      [email.toLowerCase()]
    );

    if (contactResult.rows.length === 0) throw new Error('Email not found');

    const driver_id = contactResult.rows[0].driver_id;
    const driverResult = await pool.query(
      'SELECT reset_token, reset_token_expiry FROM drivers WHERE driver_id = $1',
      [driver_id]
    );

    const driver = driverResult.rows[0];
    if (!driver || driver.reset_token !== token_hash) throw new Error('Invalid reset token');
    if (new Date() > driver.reset_token_expiry) throw new Error('Reset token has expired');

    const password_hash = await bcryptjs.hash(newPassword, 10);

    await pool.query(
      'UPDATE drivers SET password_hash = $1, reset_token = NULL, reset_token_expiry = NULL WHERE driver_id = $2',
      [password_hash, driver_id]
    );

    // Log to audit trail
    await logAuditEvent(driver_id, email, 'PASSWORD_RESET', 'password', 'old_password', 'new_password_set');

    console.log(`✅ Password reset successfully for driver: ${driver_id}`);
    res.json({
      success: true,
      data: { message: 'Password reset successfully. You can now log in with your new password.' }
    });
  } catch (err) {
    console.error('❌ resetPassword error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Store payment
app.post('/api/storePayment', async (req, res) => {
  try {
    const { driver_id, amount, status, reference } = req.body;
    if (!driver_id || !amount) throw new Error('Missing required fields');

    console.log(`💳 Storing payment: driver=${driver_id}, amount=${amount}, status=${status}`);
    
    await pool.query(
      `INSERT INTO payments (driver_id, amount, status, reference, payment_date)
      VALUES ($1, $2, $3, $4, NOW())`,
      [driver_id, amount, status || 'Pending', reference]
    );

    console.log(`✅ Payment recorded successfully: ${reference}`);
    res.json({ success: true, data: { message: 'Payment recorded' } });
  } catch (err) {
    console.error('❌ storePayment error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get payment history
app.post('/api/getPaymentHistory', async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) throw new Error('Driver ID required');

    console.log(`📊 Retrieving payment history for driver: ${driver_id}`);
    
    const result = await pool.query(
      'SELECT * FROM payments WHERE driver_id = $1 ORDER BY created_at DESC',
      [driver_id]
    );

    console.log(`✅ Retrieved ${result.rows.length} payment records for driver ${driver_id}`);
    
    res.json({
      success: true,
      data: { payments: result.rows }
    });
  } catch (err) {
    console.error('❌ getPaymentHistory error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get ALL payments for admin (Payment Log tab)
app.post('/api/getAllPayments', async (req, res) => {
  try {
    console.log(`📊 Admin retrieving all payments`);
    
    // Get all race entries with payment info, joined with driver and event details
    // Email is in contacts table, not drivers table
    const result = await pool.query(`
      SELECT 
        re.entry_id,
        re.event_id,
        re.driver_id,
        re.payment_reference,
        re.payment_status,
        re.entry_status,
        re.amount_paid,
        re.race_class,
        re.entry_items,
        re.team_code,
        re.created_at,
        d.first_name,
        d.last_name,
        c.email,
        e.event_name,
        e.event_date
      FROM race_entries re
      LEFT JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN contacts c ON re.driver_id = c.driver_id
      LEFT JOIN events e ON re.event_id = e.event_id
      WHERE re.payment_reference IS NOT NULL
      ORDER BY re.created_at DESC
      LIMIT 500
    `);
    
    // Get direct payments from payments table (e.g., season packages, direct PayFast payments)
    let directPayments = [];
    try {
      const paymentsResult = await pool.query(`
        SELECT 
          p.payment_id,
          p.driver_id,
          p.merchant_payment_id as payment_reference,
          p.payment_status,
          p.amount_gross,
          p.amount_net,
          p.item_name,
          p.item_description,
          p.created_at,
          p.completed_at,
          d.first_name,
          d.last_name,
          c.email
        FROM payments p
        LEFT JOIN drivers d ON p.driver_id = d.driver_id
        LEFT JOIN contacts c ON p.driver_id = c.driver_id
        ORDER BY p.created_at DESC
        LIMIT 100
      `);
      directPayments = paymentsResult.rows;
    } catch (paymentsErr) {
      console.log('Direct payments query error:', paymentsErr.message);
    }
    
    // Also get pool engine rentals
    let poolRentals = [];
    try {
      const poolResult = await pool.query(`
        SELECT 
          per.rental_id,
          per.driver_id,
          per.championship_class,
          per.rental_type,
          per.amount_paid,
          per.payment_status,
          per.payment_reference,
          per.season_year,
          per.created_at,
          d.first_name,
          d.last_name,
          c.email
        FROM pool_engine_rentals per
        LEFT JOIN drivers d ON per.driver_id = d.driver_id
        LEFT JOIN contacts c ON per.driver_id = c.driver_id
        ORDER BY per.created_at DESC
        LIMIT 100
      `);
      poolRentals = poolResult.rows;
    } catch (poolErr) {
      console.log('Pool engine rentals query error:', poolErr.message);
    }

    console.log(`✅ Retrieved ${result.rows.length} race entries, ${directPayments.length} direct payments, ${poolRentals.length} pool rentals`);
    
    res.json({
      success: true,
      data: { 
        payments: result.rows,
        directPayments: directPayments,
        poolRentals: poolRentals
      }
    });
  } catch (err) {
    console.error('❌ getAllPayments error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Store Race Entry Payment Intent
app.post('/api/storeRaceEntryPayment', async (req, res) => {
  try {
    const { driver_id, race_class, amount, reference, has_engine_rental } = req.body;
    if (!driver_id || !race_class || !amount) throw new Error('Missing required fields');

    console.log(`🏎️ Storing race entry payment: driver=${driver_id}, class=${race_class}, amount=${amount}`);
    
    await pool.query(
      `INSERT INTO payments (driver_id, amount, status, reference, payment_date)
       VALUES ($1, $2, $3, $4, NOW())`,
      [driver_id, amount, 'Pending', reference]
    );

    console.log(`✅ Race entry payment intent stored: ${reference}`);
    res.json({ success: true, data: { message: 'Payment intent stored', reference } });
  } catch (err) {
    console.error('❌ storeRaceEntryPayment error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Register Race Entry (Free - for promo codes)
app.post('/api/registerRaceEntry', async (req, res) => {
  try {
    const { driver_id, race_class, entry_items, total_amount, has_engine_rental, promo_code } = req.body;
    if (!driver_id || !race_class) throw new Error('Missing required fields');

    console.log(`🏎️ Registering free race entry: driver=${driver_id}, class=${race_class}, items=${JSON.stringify(entry_items)}`);

    // Create race entry record
    const race_id = `race_${driver_id}_${Date.now()}`;
    await pool.query(
      `INSERT INTO race_entries (driver_id, race_id, race_class, entry_items, total_amount, payment_status, entry_date)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [driver_id, race_id, race_class, JSON.stringify(entry_items), total_amount || 0, 'Completed']
    );

    // Update driver's next race status to "Registered"
    await pool.query(
      'UPDATE drivers SET next_race_entry_status = $1 WHERE driver_id = $2',
      ['Registered', driver_id]
    );

    // If engine rental was included, update that status too
    if (has_engine_rental) {
      await pool.query(
        'UPDATE drivers SET next_race_engine_rental_status = $1 WHERE driver_id = $2',
        ['Registered', driver_id]
      );
      console.log(`✅ Engine rental status updated for driver ${driver_id}`);
    }

    // Log the action
    await logAuditEvent(driver_id, 'driver', 'RACE_ENTRY_REGISTERED', 'race_class', '', race_class);

    console.log(`✅ Free race entry registered successfully: ${race_id}`);
    res.json({ 
      success: true, 
      data: { 
        message: 'Race entry registered successfully',
        race_id: race_id
      } 
    });
  } catch (err) {
    console.error('❌ registerRaceEntry error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Complete Race Entry After Payment (called after PayFast callback)
app.post('/api/completeRaceEntryPayment', async (req, res) => {
  try {
    const { payment_reference, driver_id, race_class, has_engine_rental } = req.body;
    if (!payment_reference || !driver_id || !race_class) throw new Error('Missing required fields');

    console.log(`✅ Completing race entry payment: payment=${payment_reference}, driver=${driver_id}`);

    // Get payment details
    const paymentResult = await pool.query(
      'SELECT * FROM payments WHERE reference = $1 LIMIT 1',
      [payment_reference]
    );

    if (paymentResult.rows.length === 0) {
      throw new Error('Payment not found');
    }

    const payment = paymentResult.rows[0];

    // Update payment status to Completed
    await pool.query(
      'UPDATE payments SET status = $1 WHERE reference = $2',
      ['Completed', payment_reference]
    );

    // Create race entry record
    const race_id = `race_${driver_id}_${Date.now()}`;
    await pool.query(
      `INSERT INTO race_entries (driver_id, race_id, race_class, total_amount, payment_reference, payment_status, entry_date)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [driver_id, race_id, race_class, payment.amount, payment_reference, 'Completed']
    );

    // Update driver's next race status to "Registered"
    await pool.query(
      'UPDATE drivers SET next_race_entry_status = $1 WHERE driver_id = $2',
      ['Registered', driver_id]
    );

    // If engine rental was included, update that status too
    if (has_engine_rental) {
      await pool.query(
        'UPDATE drivers SET next_race_engine_rental_status = $1 WHERE driver_id = $2',
        ['Registered', driver_id]
      );
      console.log(`✅ Engine rental status updated for driver ${driver_id}`);
    }

    // Log the action
    await logAuditEvent(driver_id, 'payfast', 'RACE_ENTRY_PAYMENT_COMPLETED', 'payment_reference', '', payment_reference);

    console.log(`✅ Race entry payment completed and statuses updated: ${race_id}`);
    res.json({ 
      success: true, 
      data: { 
        message: 'Race entry registered successfully',
        race_id: race_id
      } 
    });
  } catch (err) {
    console.error('❌ completeRaceEntryPayment error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Update Driver Profile
// Contact Admin
app.post('/api/contactAdmin', async (req, res) => {
  try {
    const { driver_id, name, email, registered_email, phone, subject, message } = req.body;
    if (!driver_id || !email || !subject || !message) throw new Error('Missing required fields');

    console.log(`📧 Contact Admin request from: ${email}, Account: ${registered_email}, Subject: ${subject}`);

    // Save message to database
    await pool.query(
      `INSERT INTO admin_messages (driver_id, driver_name, driver_email, registered_email, driver_phone, subject, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [driver_id, name || 'Unknown', email, registered_email || email, phone || '', subject, message]
    );
    console.log(`✅ Message saved to database for driver: ${driver_id}`);

    // Send email notification to admin
    try {
      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MANDRILL_API_KEY,
        message: {
          from_email: 'noreply@rokcup.co.za',
          from_name: 'NATS Driver Registry',
          to: [
            {
              email: 'john@rokcup.co.za',
              name: 'Admin',
              type: 'to'
            }
          ],
          subject: `New Driver Message: ${subject}`,
          html: `
            <h2>New Driver Message</h2>
            <p><strong>From:</strong> ${name} (${email})</p>
            <p><strong>Phone:</strong> ${phone || 'Not provided'}</p>
            <p><strong>Subject:</strong> ${subject}</p>
            <hr />
            <p><strong>Message:</strong></p>
            <p>${message.replace(/\n/g, '<br />')}</p>
            <hr />
            <p><a href="https://rokthenats.co.za/admin.html">View in Admin Panel</a></p>
          `
        }
      });
      console.log(`✅ Admin notification email sent for: ${subject}`);
    } catch (emailErr) {
      console.warn('⚠️ Failed to send email notification:', emailErr.message);
      // Don't fail the request if email fails
    }

    res.json({ success: true, data: { message: 'Your request has been sent to the admin' } });
  } catch (err) {
    console.error('❌ contactAdmin error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get Admin Messages
app.post('/api/getAdminMessages', async (req, res) => {
  try {
    console.log('📨 Retrieving admin messages...');
    const result = await pool.query(
      `SELECT * FROM admin_messages ORDER BY created_at DESC`
    );
    console.log(`✅ Retrieved ${result.rows.length} admin messages`);
    res.json({ success: true, data: { messages: result.rows } });
  } catch (err) {
    console.error('❌ getAdminMessages error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Mark message as read
app.post('/api/markMessageAsRead', async (req, res) => {
  try {
    const { message_id } = req.body;
    if (!message_id) throw new Error('Missing message_id');

    console.log(`✉️ Marking message ${message_id} as read...`);
    await pool.query(
      `UPDATE admin_messages SET read_status = TRUE WHERE id = $1`,
      [message_id]
    );
    console.log(`✅ Message ${message_id} marked as read`);
    res.json({ success: true, data: { message: 'Message marked as read' } });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Submit Race Entry
app.post('/api/submitRaceEntry', async (req, res) => {
  try {
    const { driver_id, race_name, entry_type, notes } = req.body;
    if (!driver_id || !race_name) throw new Error('Missing required fields');

    const race_id = `race_${Date.now()}`;
    await pool.query(
      `INSERT INTO race_entries (driver_id, race_id, race_name, entry_type, notes, entry_date) 
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [driver_id, race_id, race_name, entry_type, notes]
    );

    res.json({ success: true, data: { message: 'Race entry submitted' } });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get Audit Log
// Set Driver Profile
app.post('/api/setDriverPassword', async (req, res) => {
  try {
    const { driver_id, password } = req.body;
    if (!driver_id || !password) throw new Error('Driver ID and password required');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');

    console.log(`🔑 Setting password for driver: ${driver_id}`);
    
    const password_hash = await bcryptjs.hash(password, 10);
    await pool.query(
      'UPDATE drivers SET password_hash = $1 WHERE driver_id = $2',
      [password_hash, driver_id]
    );

    console.log(`✅ Password set successfully for driver: ${driver_id}`);
    res.json({ success: true, data: { message: 'Password set successfully' } });
  } catch (err) {
    console.error('❌ setDriverPassword error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// PayFast ITN webhook
app.post('/api/payfast-itn', async (req, res) => {
  try {
    const { m_payment_id, payment_status, custom_str1, custom_str2, custom_str3 } = req.body;
    const driver_id = custom_str1;
    const race_class = custom_str2;
    const has_engine_rental = custom_str3 === 'YES';
    
    console.log(`📬 PayFast ITN Callback: payment=${m_payment_id}, status=${payment_status}, driver=${driver_id}`);
    
    if (payment_status === 'COMPLETE') {
      try {
        // Update payment status
        await pool.query(
          'UPDATE payments SET status = $1, updated_at = NOW() WHERE reference = $2',
          ['Completed', m_payment_id]
        );
        console.log(`✅ Payment marked complete: ${m_payment_id}`);

        // If this is a race entry payment (has custom_str2), register the race entry
        if (driver_id && race_class) {
          await pool.query(
            'UPDATE drivers SET next_race_entry_status = $1 WHERE driver_id = $2',
            ['Registered', driver_id]
          );
          
          if (has_engine_rental) {
            await pool.query(
              'UPDATE drivers SET next_race_engine_rental_status = $1 WHERE driver_id = $2',
              ['Registered', driver_id]
            );
          }
          
          console.log(`✅ Race entry registered for driver ${driver_id}`);
        }
      } catch (e) {
        console.log('Could not update payment/race entry:', e.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('ITN error:', err);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get All Drivers (Admin)
// Diagnostic endpoint to see actual table schema
// Create test driver for debugging
app.post('/api/create-test-driver', async (req, res) => {
  try {
    const testDriver = {
      first_name: 'Test',
      last_name: 'Driver',
      class: 'OK',
      race_number: '123',
      team_name: 'Test Team',
      coach_name: 'Test Coach',
      kart_brand: 'Test Kart',
      engine_type: 'Test Engine',
      transponder_number: 'TEST-001'
    };

    // Generate a PIN for testing (not hashing since column doesn't exist)
    const pin = '123456';

    let driverId;
    try {
      const result = await pool.query(
        `INSERT INTO drivers (first_name, last_name, class, race_number, team_name, coach_name, kart_brand, engine_type, transponder_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING driver_id`,
        [testDriver.first_name, testDriver.last_name, testDriver.class, testDriver.race_number, 
         testDriver.team_name, testDriver.coach_name, testDriver.kart_brand, testDriver.engine_type,
         testDriver.transponder_number]
      );
      driverId = result.rows[0].driver_id;
      console.log(`✅ Test driver created with ID: ${driverId}`);
    } catch (e) {
      console.log('❌ Full driver insert failed for test driver, trying basic fields:', e.message);
      // Try with minimal fields
      const result = await pool.query(
        `INSERT INTO drivers (first_name, last_name)
         VALUES ($1, $2)
         RETURNING driver_id`,
        [testDriver.first_name, testDriver.last_name]
      );
      driverId = result.rows[0].driver_id;
      console.log(`✅ Test driver created with minimal fields, ID: ${driverId}`);
    }

    // Create test contact with email - try with different column combinations
    try {
      await pool.query(
        `INSERT INTO contacts (driver_id, email, full_name, phone_mobile)
         VALUES ($1, $2, $3, $4)`,
        [driverId, 'test@example.com', 'Test Driver', '555-0000']
      );
      console.log(`✅ Test contact created with email`);
    } catch (e) {
      console.log('❌ Full contact insert failed, trying minimal fields:', e.message);
      try {
        // Try with just driver_id and email
        await pool.query(
          `INSERT INTO contacts (driver_id, email)
           VALUES ($1, $2)`,
          [driverId, 'test@example.com']
        );
        console.log(`✅ Test contact created with minimal fields`);
      } catch (e2) {
        console.log('❌ Could not create contact:', e2.message);
        // Silently fail - contacts table might not exist
      }
    }

    res.json({
      success: true,
      message: 'Test driver created',
      driverId,
      pin
    });
  } catch (err) {
    console.error('❌ create-test-driver error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/check-schema', async (req, res) => {
  try {
    // Check drivers table structure
    const driversResult = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'drivers'
      ORDER BY ordinal_position
    `);
    
    // Get a sample driver to see actual data
    const sampleResult = await pool.query('SELECT * FROM drivers LIMIT 1');
    const countResult = await pool.query('SELECT COUNT(*) as total FROM drivers');
    
    res.json({
      success: true,
      columns: driversResult.rows,
      totalDrivers: countResult.rows[0]?.total || 0,
      sampleDriver: sampleResult.rows[0] || null
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/getAllDrivers', async (req, res) => {
  try {
    const { email, name, status, paid } = req.body;

    console.log('getAllDrivers called with filters:', { email, name, status, paid });

    // Get all drivers excluding soft-deleted ones
    const driverResult = await pool.query('SELECT * FROM drivers WHERE is_deleted = FALSE OR is_deleted IS NULL LIMIT 1000');
    console.log('Found', driverResult.rows.length, 'drivers from database');

    if (driverResult.rows.length === 0) {
      console.log('No drivers in database, returning empty list');
      return res.json({
        success: true,
        data: { drivers: [] }
      });
    }

    // Get the first driver to inspect what columns actually exist
    const sampleDriver = driverResult.rows[0];
    console.log('Sample driver:', JSON.stringify(sampleDriver, null, 2));
    console.log('Sample driver keys:', Object.keys(sampleDriver));

    const driverIds = driverResult.rows.map(d => d.driver_id);
    console.log('Driver IDs:', driverIds);

    // Get all contact information (email, phone, name, relationship, emergency, consent flags)
    let contactMap = {};
    try {
      const contactResult = await pool.query(
        'SELECT * FROM contacts WHERE driver_id = ANY($1)',
        [driverIds]
      );
      console.log('Found', contactResult.rows.length, 'contact records');
      contactResult.rows.forEach(c => {
        // Store first contact (primary) for each driver
        if (!contactMap[c.driver_id]) {
          contactMap[c.driver_id] = c;
        }
      });
    } catch (e) {
      console.log('Contacts query failed:', e.message);
    }

    // Get emails from contacts table (for backwards compatibility)
    let emailMap = {};
    Object.entries(contactMap).forEach(([driverId, contact]) => {
      if (contact && contact.email) {
        emailMap[driverId] = contact.email;
      }
    });

    // Get payment info - check if payments table has data
    let paidSet = new Set();
    try {
      // First check what columns actually exist in payments table
      const paymentResult = await pool.query(
        "SELECT driver_id FROM payments LIMIT 1000"
      );
      console.log('Found', paymentResult.rows.length, 'payment records');
      // Mark drivers that have payment records as "Paid"
      paymentResult.rows.forEach(p => paidSet.add(p.driver_id));
    } catch (e) {
      console.log('Payments table query failed - table may not exist or have different structure:', e.message);
    }

    // Get medical consent data for all drivers
    let medicalMap = {};
    try {
      const medicalResult = await pool.query(
        'SELECT * FROM medical_consent WHERE driver_id = ANY($1)',
        [driverIds]
      );
      console.log('Found', medicalResult.rows.length, 'medical records');
      medicalResult.rows.forEach(m => {
        medicalMap[m.driver_id] = m;
      });
    } catch (e) {
      console.log('Medical consent query failed:', e.message);
    }

    // Build driver list with only data we know exists
    let drivers = driverResult.rows.map(d => {
      const obj = {
        driver_id: d.driver_id,
        first_name: d.first_name || '',
        last_name: d.last_name || '',
        driver_email: emailMap[d.driver_id] || '',
        paid_status: paidSet.has(d.driver_id) ? 'Paid' : 'Unpaid'
      };
      
      // Add contact information if available
      if (contactMap[d.driver_id]) {
        const contact = contactMap[d.driver_id];
        obj.contact_name = contact.full_name || '';
        obj.contact_phone = contact.phone_mobile || '';
        obj.contact_relationship = contact.relationship || '';
        obj.contact_emergency = contact.emergency_contact || false;
        obj.contact_consent = contact.consent_contact || false;
      }
      
      // Add optional fields if they exist in the returned data
      if (d.class !== undefined) obj.class = d.class || '';
      if (d.race_number !== undefined) obj.race_number = d.race_number || '';
      if (d.team_name !== undefined) obj.team_name = d.team_name || '';
      if (d.coach_name !== undefined) obj.coach_name = d.coach_name || '';
      if (d.kart_brand !== undefined) obj.kart_brand = d.kart_brand || '';
      if (d.engine_type !== undefined) obj.engine_type = d.engine_type || '';
      if (d.license_number !== undefined) obj.license_number = d.license_number || '';
      if (d.transponder_number !== undefined) obj.transponder_number = d.transponder_number || '';
      if (d.status !== undefined) obj.status = d.status || 'Pending';
      if (d.approval_status !== undefined) obj.approval_status = d.approval_status || 'Pending';
      if (d.license_document !== undefined) obj.license_document = d.license_document;
      if (d.profile_photo !== undefined) obj.profile_photo = d.profile_photo;
      
      // Add medical data if available
      if (medicalMap[d.driver_id]) {
        const med = medicalMap[d.driver_id];
        obj.medical_allergies = med.allergies || '';
        obj.medical_conditions = med.medical_conditions || '';
        obj.medical_medication = med.medication || '';
        obj.medical_doctor_phone = med.doctor_phone || '';
        obj.medical_consent_signed = med.consent_signed || '';
        obj.medical_consent_date = med.consent_date || '';
        obj.media_release_signed = med.media_release_signed || '';
      }
      
      return obj;
    });

    console.log('Built', drivers.length, 'driver objects');

    // Apply filters
    if (email && email.trim()) {
      drivers = drivers.filter(d => 
        d.driver_email.toLowerCase().includes(email.toLowerCase())
      );
      console.log('After email filter:', drivers.length);
    }

    if (name && name.trim()) {
      const nameLower = name.toLowerCase();
      drivers = drivers.filter(d => {
        const fullName = `${d.first_name} ${d.last_name}`.toLowerCase();
        return fullName.includes(nameLower);
      });
      console.log('After name filter:', drivers.length);
    }

    if (status && status !== '') {
      drivers = drivers.filter(d => d.status === status || d.approval_status === status);
      console.log('After status filter:', drivers.length);
    }

    if (paid && paid !== '') {
      drivers = drivers.filter(d => d.paid_status === paid);
      console.log('After paid filter:', drivers.length);
    }

    console.log('Returning', drivers.length, 'drivers after all filtering');

    res.json({
      success: true,
      data: { drivers }
    });
  } catch (err) {
    console.error('getAllDrivers error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Update Driver (Admin & Driver Portal)
app.post('/api/updateDriver', async (req, res) => {
  try {
    const { 
      driver_id, first_name, last_name, race_number, team_name, coach_name, kart_brand, 
      class: klass, email, status, paid_status, license_number, transponder_number, 
      season_engine_rental, season_entry_status, next_race_entry_status, next_race_engine_rental_status,
      admin_override 
    } = req.body;
    
    console.log('updateDriver request received');
    console.log('driver_id:', driver_id);
    if (admin_override) console.log('Admin override flag set - logging will show ADMIN_OVERRIDE action');
    
    if (!driver_id) throw new Error('Driver ID required');

    // Get old values for audit log
    const oldResult = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    const oldDriver = oldResult.rows[0];
    
    if (!oldDriver) {
      throw new Error('Driver not found');
    }

    // Build UPDATE statement with only the fields we have values for
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (first_name !== undefined && first_name !== null) {
      updates.push(`first_name = $${paramCount++}`);
      values.push(first_name);
    }
    if (last_name !== undefined && last_name !== null) {
      updates.push(`last_name = $${paramCount++}`);
      values.push(last_name);
    }
    if (race_number !== undefined && race_number !== null) {
      updates.push(`race_number = $${paramCount++}`);
      values.push(race_number);
    }
    if (team_name !== undefined && team_name !== null) {
      updates.push(`team_name = $${paramCount++}`);
      values.push(team_name);
    }
    if (coach_name !== undefined && coach_name !== null) {
      updates.push(`coach_name = $${paramCount++}`);
      values.push(coach_name);
    }
    if (kart_brand !== undefined && kart_brand !== null) {
      updates.push(`kart_brand = $${paramCount++}`);
      values.push(kart_brand);
    }
    if (klass !== undefined && klass !== null) {
      updates.push(`class = $${paramCount++}`);
      values.push(klass);
    }
    if (license_number !== undefined && license_number !== null) {
      updates.push(`license_number = $${paramCount++}`);
      values.push(license_number);
    }
    if (transponder_number !== undefined && transponder_number !== null) {
      updates.push(`transponder_number = $${paramCount++}`);
      values.push(transponder_number);
    }
    if (status !== undefined && status !== null) {
      updates.push(`status = $${paramCount++}`);
      values.push(status);
    }
    
    // Payment & Entry Status fields (Admin Override)
    if (season_engine_rental !== undefined && season_engine_rental !== null) {
      updates.push(`season_engine_rental = $${paramCount++}`);
      values.push(season_engine_rental);
    }
    if (season_entry_status !== undefined && season_entry_status !== null) {
      updates.push(`season_entry_status = $${paramCount++}`);
      values.push(season_entry_status);
    }
    if (next_race_entry_status !== undefined && next_race_entry_status !== null) {
      updates.push(`next_race_entry_status = $${paramCount++}`);
      values.push(next_race_entry_status);
    }
    if (next_race_engine_rental_status !== undefined && next_race_engine_rental_status !== null) {
      updates.push(`next_race_engine_rental_status = $${paramCount++}`);
      values.push(next_race_engine_rental_status);
    }

    // Add driver_id as final parameter
    values.push(driver_id);
    
    // Only execute update if there are fields to update
    if (updates.length > 0) {
      const updateQuery = `UPDATE drivers SET ${updates.join(', ')} WHERE driver_id = $${paramCount}`;
      console.log('Executing update query:', updateQuery);
      console.log('With values:', values);
      
      await pool.query(updateQuery, values);
      console.log('Driver updated successfully');
    }

    // Handle paid status - only mark if payments table exists
    if (paid_status === 'Paid') {
      try {
        // Check if driver already has payment record
        const existsResult = await pool.query('SELECT driver_id FROM payments WHERE driver_id = $1 LIMIT 1', [driver_id]);
        if (existsResult.rows.length === 0) {
          // Try to insert payment record
          try {
            await pool.query(
              `INSERT INTO payments (driver_id) VALUES ($1)`,
              [driver_id]
            );
            console.log('Payment record created');
          } catch (e) {
            console.log('Could not insert payment record:', e.message);
          }
        }
      } catch (e) {
        console.log('Payment handling skipped - payments table may not exist:', e.message);
      }
    }

    // Log changes for audit trail
    try {
      const fieldsChanged = [];
      if (oldDriver.first_name !== first_name) fieldsChanged.push({ field: 'first_name', old: oldDriver.first_name, new: first_name });
      if (oldDriver.last_name !== last_name) fieldsChanged.push({ field: 'last_name', old: oldDriver.last_name, new: last_name });
      if (oldDriver.race_number !== race_number) fieldsChanged.push({ field: 'race_number', old: oldDriver.race_number, new: race_number });
      if (oldDriver.team_name !== team_name) fieldsChanged.push({ field: 'team_name', old: oldDriver.team_name, new: team_name });
      if (oldDriver.coach_name !== coach_name) fieldsChanged.push({ field: 'coach_name', old: oldDriver.coach_name, new: coach_name });
      if (oldDriver.kart_brand !== kart_brand) fieldsChanged.push({ field: 'kart_brand', old: oldDriver.kart_brand, new: kart_brand });
      if (oldDriver.class !== klass) fieldsChanged.push({ field: 'class', old: oldDriver.class, new: klass });
      if (oldDriver.status !== status) fieldsChanged.push({ field: 'status', old: oldDriver.status, new: status });
      if (oldDriver.license_number !== license_number) fieldsChanged.push({ field: 'license_number', old: oldDriver.license_number, new: license_number });
      if (oldDriver.transponder_number !== transponder_number) fieldsChanged.push({ field: 'transponder_number', old: oldDriver.transponder_number, new: transponder_number });
      
      // Track payment/entry status changes (Admin Override)
      if (oldDriver.season_engine_rental !== season_engine_rental && season_engine_rental !== undefined) {
        fieldsChanged.push({ field: 'season_engine_rental', old: oldDriver.season_engine_rental, new: season_engine_rental, isAdminOverride: true });
      }
      if (oldDriver.season_entry_status !== season_entry_status && season_entry_status !== undefined) {
        fieldsChanged.push({ field: 'season_entry_status', old: oldDriver.season_entry_status, new: season_entry_status, isAdminOverride: true });
      }
      if (oldDriver.next_race_entry_status !== next_race_entry_status && next_race_entry_status !== undefined) {
        fieldsChanged.push({ field: 'next_race_entry_status', old: oldDriver.next_race_entry_status, new: next_race_entry_status, isAdminOverride: true });
      }
      if (oldDriver.next_race_engine_rental_status !== next_race_engine_rental_status && next_race_engine_rental_status !== undefined) {
        fieldsChanged.push({ field: 'next_race_engine_rental_status', old: oldDriver.next_race_engine_rental_status, new: next_race_engine_rental_status, isAdminOverride: true });
      }

      for (const change of fieldsChanged) {
        // Use TITAN_EDIT if email is 'TITAN', otherwise use ADMIN_OVERRIDE for admin changes, or UPDATE_PROFILE for normal changes
        let action = 'UPDATE_PROFILE';
        if (email === 'TITAN') {
          action = 'TITAN_EDIT';
        } else if (change.isAdminOverride && admin_override) {
          action = 'ADMIN_OVERRIDE';
        }
        await logAuditEvent(driver_id, email || 'admin', action, change.field, String(change.old || ''), String(change.new || ''));
      }
    } catch (auditErr) {
      console.log('Audit logging failed (non-critical):', auditErr.message);
    }

    // Fetch updated driver data from database to confirm save
    const updatedResult = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    const updatedDriver = updatedResult.rows[0];
    
    if (!updatedDriver) {
      throw new Error('Could not verify driver update - driver not found after save');
    }
    
    console.log('Driver updated and verified from database:', driver_id);
    
    // Send admin notification for profile updates
    try {
      if (updates.length > 0) {
        const fieldsUpdated = updates.map(u => u.split(' = ')[0]).join(', ');
        adminNotificationQueue.addNotification({
          action: 'Profile Update',
          subject: `[Profile] ${first_name || oldDriver.first_name} ${last_name || oldDriver.last_name} updated profile`,
          details: {
            driverId: driver_id,
            driverName: `${first_name || oldDriver.first_name} ${last_name || oldDriver.last_name}`,
            class: klass || oldDriver.class,
            fieldsUpdated: fieldsUpdated || 'None',
            adminOverride: admin_override ? 'Yes' : 'No',
            timestamp: new Date().toLocaleString()
          }
        });
      }
    } catch (e) { /* Silent fail */ }
    
    res.json({ 
      success: true, 
      data: { 
        message: 'Profile updated',
        driver: updatedDriver  // Return the verified updated driver data
      } 
    });
  } catch (err) {
    console.error('updateDriver error:', err.message);
    console.error('Full error:', err);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Send Password Reset (Admin)
app.post('/api/sendPasswordReset', async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) throw new Error('Driver ID required');

    const driverResult = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    const driver = driverResult.rows[0];
    if (!driver) throw new Error('Driver not found');

    const contactResult = await pool.query('SELECT email FROM contacts WHERE driver_id = $1 LIMIT 1', [driver_id]);
    const email = contactResult.rows[0]?.email;
    if (!email) throw new Error('Driver email not found');

    const reset_token = crypto.randomBytes(32).toString('hex');
    const reset_token_hash = crypto.createHash('sha256').update(reset_token).digest('hex');
    const reset_token_expiry = new Date(Date.now() + 3600000);

    await pool.query(
      'UPDATE drivers SET reset_token = $1, reset_token_expiry = $2 WHERE driver_id = $3',
      [reset_token_hash, reset_token_expiry, driver_id]
    );

    const resetLink = `https://rokthenats.co.za/reset-password.html?token=${reset_token}&email=${encodeURIComponent(email)}`;
    const emailHtml = loadEmailTemplate('password-reset', {
      RESET_LINK: resetLink
    });
    await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
      key: process.env.MAILCHIMP_API_KEY,
      message: {
        to: [{ email: email }],
        from_email: process.env.MAILCHIMP_FROM_EMAIL,
        subject: 'Reset Your NATS Driver Registry Password',
        html: emailHtml
      }
    }).catch(err => console.error('Email error:', err.message));

    await logAuditEvent(driver_id, 'admin', 'PASSWORD_RESET_SENT', 'password', 'sent', email);

    res.json({ success: true, data: { message: 'Password reset email sent' } });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Download driver file (license or photo)
app.post('/api/downloadDriverFile', async (req, res) => {
  try {
    const { driver_id, file_type } = req.body;
    if (!driver_id || !file_type) throw new Error('Driver ID and file type required');

    const result = await pool.query('SELECT license_document, profile_photo FROM drivers WHERE driver_id = $1', [driver_id]);
    const driver = result.rows[0];
    if (!driver) throw new Error('Driver not found');

    let fileData = null;
    if (file_type === 'license' && driver.license_document) {
      try {
        fileData = JSON.parse(driver.license_document);
      } catch (e) {
        console.log('Could not parse license document:', e.message);
      }
    } else if (file_type === 'photo' && driver.profile_photo) {
      try {
        fileData = JSON.parse(driver.profile_photo);
      } catch (e) {
        console.log('Could not parse profile photo:', e.message);
      }
    }

    if (!fileData || !fileData.b64) throw new Error(`No ${file_type} found for this driver`);

    // Return base64 data so client can display/download
    res.json({
      success: true,
      data: {
        fileName: fileData.name,
        mimeType: fileData.mime,
        b64: fileData.b64
      }
    });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get Database Table Data
app.post('/api/getDatabaseTable', async (req, res) => {
  try {
    const { table, filter = {}, limit = 100 } = req.body;
    if (!table) throw new Error('Missing table name');

    // Whitelist allowed tables to prevent SQL injection
    const allowedTables = ['drivers', 'admin_messages', 'audit_log', 'race_entries', 'rentals'];
    if (!allowedTables.includes(table)) {
      throw new Error('Invalid table name');
    }

    // Get row count
    const countResult = await pool.query(`SELECT COUNT(*) as count FROM ${table}`);
    const rowCount = parseInt(countResult.rows[0].count);

    // Build where clause for filtering
    let whereClause = '';
    let params = [];
    let paramIndex = 1;

    if (filter && Object.keys(filter).length > 0) {
      const conditions = [];
      for (const [key, value] of Object.entries(filter)) {
        if (value && value.trim()) {
          conditions.push(`${key} ILIKE $${paramIndex}`);
          params.push(`%${value}%`);
          paramIndex++;
        }
      }
      if (conditions.length > 0) {
        whereClause = ' WHERE ' + conditions.join(' AND ');
      }
    }

    // Add limit parameter
    params.push(limit);
    const limitParam = `$${paramIndex}`;

    // Determine order by - handle different primary keys
    let orderBy = '';
    if (table === 'drivers') {
      orderBy = ' ORDER BY driver_id DESC';
    } else if (table === 'admin_messages') {
      orderBy = ' ORDER BY created_at DESC';
    } else if (table === 'audit_log') {
      orderBy = ' ORDER BY created_at DESC';
    } else {
      orderBy = ' ORDER BY id DESC';
    }

    // Get data (limit to specified rows for performance)
    const result = await pool.query(
      `SELECT * FROM ${table}${whereClause}${orderBy} LIMIT ${limitParam}`,
      params
    );

    res.json({
      success: true,
      data: {
        rows: result.rows,
        rowCount: rowCount,
        displayCount: result.rows.length,
        table: table
      }
    });
  } catch (err) {
    console.error('getDatabaseTable error:', err);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Soft Delete Driver (Admin)
app.post('/api/admin/deleteDriver', async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) throw new Error('Driver ID required');

    // Check if driver exists
    const checkResult = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    if (checkResult.rows.length === 0) throw new Error('Driver not found');

    const driver = checkResult.rows[0];

    // Soft delete: mark as deleted instead of removing
    await pool.query(
      'UPDATE drivers SET is_deleted = TRUE, deleted_at = NOW() WHERE driver_id = $1',
      [driver_id]
    );

    console.log(`🗑️ Driver soft deleted: ${driver_id} (${driver.first_name} ${driver.last_name})`);

    // Log the deletion to audit trail
    try {
      await logAuditEvent(driver_id, 'admin', 'DRIVER_DELETED', 'status', 'active', 'deleted');
    } catch (auditErr) {
      console.log('Audit logging failed (non-critical):', auditErr.message);
    }

    res.json({
      success: true,
      data: { message: `Driver ${driver.first_name} ${driver.last_name} has been deleted` }
    });
  } catch (err) {
    console.error('❌ deleteDriver error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Restore Deleted Driver (Admin)
app.post('/api/admin/restoreDriver', async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) throw new Error('Driver ID required');

    // Check if driver exists and is deleted
    const checkResult = await pool.query('SELECT * FROM drivers WHERE driver_id = $1 AND is_deleted = TRUE', [driver_id]);
    if (checkResult.rows.length === 0) throw new Error('Deleted driver not found');

    const driver = checkResult.rows[0];

    // Restore the driver
    await pool.query(
      'UPDATE drivers SET is_deleted = FALSE, deleted_at = NULL WHERE driver_id = $1',
      [driver_id]
    );

    console.log(`✅ Driver restored: ${driver_id} (${driver.first_name} ${driver.last_name})`);

    // Log the restoration to audit trail
    try {
      await logAuditEvent(driver_id, 'admin', 'DRIVER_RESTORED', 'status', 'deleted', 'active');
    } catch (auditErr) {
      console.log('Audit logging failed (non-critical):', auditErr.message);
    }

    res.json({
      success: true,
      data: { message: `Driver ${driver.first_name} ${driver.last_name} has been restored` }
    });
  } catch (err) {
    console.error('❌ restoreDriver error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Debug PayFast credentials
app.get('/api/debug/payfast', (req, res) => {
  res.json({
    merchantId: process.env.PAYFAST_MERCHANT_ID || 'NOT SET - using default 18906399',
    merchantKey: process.env.PAYFAST_MERCHANT_KEY ? '***SET (length: ' + process.env.PAYFAST_MERCHANT_KEY.length + ')***' : 'NOT SET - using default fbxpiwtzoh1gg',
    returnUrl: process.env.PAYFAST_RETURN_URL || 'Using default: https://www.rokthenats.co.za/payment-success.html',
    cancelUrl: process.env.PAYFAST_CANCEL_URL || 'Using default: https://www.rokthenats.co.za/payment-cancel.html',
    notifyUrl: process.env.PAYFAST_NOTIFY_URL || 'Using default: https://www.rokthenats.co.za/api/paymentNotify'
  });
});

// Initiate Race Entry Payment via PayFast
app.get('/api/initiateRacePayment', async (req, res) => {
  try {
    const { class: raceClass, amount, email, eventId, driverId, items } = req.query;
    
    if (!raceClass || !amount) {
      throw new Error('Missing class or amount');
    }
    
    if (!eventId || !driverId) {
      throw new Error('Missing event ID or driver ID');
    }
    
    // Parse selected items to know what tickets to generate
    // NOTE: Express already URL-decodes query parameters, so req.query.items is already decoded
    let selectedItems = [];
    try {
      if (items) {
        console.log(`📦 Raw items parameter from Express:`, items);
        selectedItems = JSON.parse(items);  // Just parse, don't decode again!
        console.log(`📦 Parsed selectedItems:`, selectedItems);
      }
    } catch (e) {
      console.error('❌ CRITICAL: Could not parse items parameter:', e.message);
      console.error('❌ Raw items parameter:', items);
      console.error('❌ This will result in NO rental items being recorded!');
      // Still continue - user will at least get race entry, but no rental items
    }

    // Use provided email or fallback to noreply
    const driverEmail = email && email.trim() ? email.trim().toLowerCase() : 'noreply@nats.co.za';
    console.log(`💳 Payment email: ${driverEmail}`);

    // Clean and parse amount - remove R, spaces, convert comma to decimal point
    // South African locale: 2 950,00 needs to become 2950.00
    let cleanAmount = String(amount)
      .replace(/R/g, '')           // Remove R currency symbol
      .replace(/\s/g, '')          // Remove spaces (SA thousand separator)
      .replace(/,/g, '.')          // Convert comma to period (SA decimal separator)
      .trim();
    const numAmount = parseFloat(cleanAmount);
    
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error(`Invalid amount: ${amount} (parsed as ${cleanAmount})`);
    }

    console.log(`💳 Initiating PayFast payment: ${raceClass} - R${numAmount.toFixed(2)} for event ${eventId}`);

    // PayFast Merchant ID and Key (from environment or correct defaults)
    const merchantId = process.env.PAYFAST_MERCHANT_ID || '18906399';
    const merchantKey = process.env.PAYFAST_MERCHANT_KEY || 'fbxpiwtzoh1gg';
    const returnUrl = process.env.PAYFAST_RETURN_URL || 'https://www.rokthenats.co.za/payment-success.html';
    const cancelUrl = process.env.PAYFAST_CANCEL_URL || 'https://www.rokthenats.co.za/payment-cancel.html';
    const notifyUrl = process.env.PAYFAST_NOTIFY_URL || 'https://www.rokthenats.co.za/api/paymentNotify';

    // Generate unique reference that includes event and driver info
    const reference = `RACE-${eventId}-${driverId}-${Date.now()}`;

    // ✅ FIX #1: Create pending race entry BEFORE redirecting to PayFast
    // This allows us to reconcile payments if notification fails
    const race_entry_id = `race_entry_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    // Parse selected items to determine what tickets to generate
    const itemsLower = selectedItems.map(i => (i || '').toLowerCase());
    const hasEngine = itemsLower.some(i => i.includes('engine') || i.includes('rental'));
    const hasTyres = itemsLower.some(i => i.includes('tyre'));
    const hasTransponder = itemsLower.some(i => i.includes('transponder'));
    const hasFuel = itemsLower.some(i => i.includes('fuel'));
    
    // Generate unique ticket references for ALL selected rental items upfront
    const ticketEngineRef = hasEngine ? generateUniqueTicketRef('engine', driverId, eventId) : null;
    const ticketTyresRef = hasTyres ? generateUniqueTicketRef('tyres', driverId, eventId) : null;
    const ticketTransponderRef = hasTransponder ? generateUniqueTicketRef('transponder', driverId, eventId) : null;
    const ticketFuelRef = hasFuel ? generateUniqueTicketRef('fuel', driverId, eventId) : null;
    
    console.log(`🎫 Creating pending entry with items:`);
    console.log(`   - selectedItems array:`, selectedItems);
    console.log(`   - hasEngine: ${hasEngine}, ticketEngineRef: ${ticketEngineRef}`);
    console.log(`   - hasTyres: ${hasTyres}, ticketTyresRef: ${ticketTyresRef}`);
    console.log(`   - hasTransponder: ${hasTransponder}, ticketTransponderRef: ${ticketTransponderRef}`);
    console.log(`   - hasFuel: ${hasFuel}, ticketFuelRef: ${ticketFuelRef}`);
    
    try {
      await pool.query(
        `INSERT INTO race_entries (
          entry_id, event_id, driver_id, payment_reference, 
          payment_status, entry_status, amount_paid, race_class,
          entry_items,
          ticket_engine_ref, ticket_tyres_ref, ticket_transponder_ref, ticket_fuel_ref,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())`,
        [race_entry_id, eventId, driverId, reference, 'Pending', 'pending_payment', numAmount, raceClass,
         JSON.stringify(selectedItems), ticketEngineRef, ticketTyresRef, ticketTransponderRef, ticketFuelRef]
      );
      console.log(`📝 Created pending race entry: ${race_entry_id} with reference ${reference}`);
      
      // ✅ SEND IMMEDIATE CONFIRMATION EMAIL WITH TICKETS
      try {
        // Get driver details
        const driverResult = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driverId]);
        const driver = driverResult.rows[0];
        const driverName = driver ? `${driver.first_name || ''} ${driver.last_name || ''}`.trim() : 'Driver';
        
        // Get event details
        let eventName = 'Race Event';
        let eventDateStr = 'TBA';
        let eventLocation = 'TBA';
        let eventDate = null;
        
        const eventResult = await pool.query('SELECT * FROM events WHERE event_id = $1', [eventId]);
        const eventDetails = eventResult.rows[0];
        if (eventDetails) {
          eventName = eventDetails.event_name || 'Race Event';
          eventDate = eventDetails.event_date;
          eventDateStr = eventDetails.event_date 
            ? new Date(eventDetails.event_date).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
            : 'TBA';
          eventLocation = eventDetails.location || 'TBA';
        }
        
        // Build rental tickets HTML using the beautiful ticket generators
        let rentalTicketsHtml = '';
        if (hasEngine && ticketEngineRef) {
          rentalTicketsHtml += generateEngineRentalTicketHTML({
            reference: ticketEngineRef,
            eventName,
            eventDate,
            eventLocation,
            raceClass,
            driverName
          });
        }
        if (hasTyres && ticketTyresRef) {
          rentalTicketsHtml += generateTyreRentalTicketHTML({
            reference: ticketTyresRef,
            eventName,
            eventDate,
            eventLocation,
            raceClass,
            driverName
          });
        }
        if (hasTransponder && ticketTransponderRef) {
          rentalTicketsHtml += generateTransponderRentalTicketHTML({
            reference: ticketTransponderRef,
            eventName,
            eventDate,
            eventLocation,
            raceClass,
            driverName
          });
        }
        if (hasFuel && ticketFuelRef) {
          rentalTicketsHtml += generateFuelTicketHTML({
            reference: ticketFuelRef,
            eventName,
            eventDate,
            eventLocation,
            raceClass,
            driverName
          });
        }
        
        // Email HTML template
        const emailHtml = `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Race Entry Confirmation — NATS 2026 ROK Cup</title>
            <style>
              body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #333; background: #f5f5f5; margin: 0; padding: 0; }
              .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
              .header { background: white; padding: 20px; text-align: center; border-bottom: 3px solid #22c55e; }
              .header-logo { margin-bottom: 16px; }
              .header-logo img { width: 140px; height: auto; }
              .header h1 { margin: 0; font-size: 24px; font-weight: 700; color: #111827; }
              .content { padding: 30px; }
              .details { background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #22c55e; }
              .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
              .detail-row:last-child { border-bottom: none; }
              .detail-label { font-weight: 600; color: #6b7280; font-size: 13px; }
              .detail-value { color: #111827; font-weight: 500; }
              .amount { font-size: 22px; font-weight: 700; color: #22c55e; }
              .footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px; text-align: center; color: #6b7280; font-size: 12px; }
            </style>
          </head>
          <body style="margin: 0; padding: 20px;">
            <div class="container">
              <div class="header">
                <div class="header-logo">
                  <img src="https://www.dropbox.com/scl/fi/ryhszrvk76kd7yy6y0rtc/ROK-CUP-LOGO-2025.png?rlkey=k9dxlzbh5e9zw58v8t34yjzea&dl=1" alt="ROK Cup South Africa" />
                </div>
                <h1>Race Entry Confirmed</h1>
              </div>
              <div class="content">
                <p style="margin: 0 0 16px 0; font-size: 15px;">Hi ${driverName},</p>
                <p style="margin: 0 0 20px 0; font-size: 15px; color: #374151;">Your race entry has been registered! Payment processing will complete shortly. Thank you for registering with the NATS 2026 ROK Cup!</p>
                
                <div class="details">
                  <div class="detail-row">
                    <span class="detail-label">Entry Reference</span>
                    <span class="detail-value">${reference}</span>
                  </div>
                  <div class="detail-row">
                    <span class="detail-label">Event Name</span>
                    <span class="detail-value">${eventName}</span>
                  </div>
                  <div class="detail-row">
                    <span class="detail-label">Event Date</span>
                    <span class="detail-value">${eventDateStr}</span>
                  </div>
                  <div class="detail-row">
                    <span class="detail-label">Location</span>
                    <span class="detail-value">${eventLocation}</span>
                  </div>
                  <div class="detail-row">
                    <span class="detail-label">Race Class</span>
                    <span class="detail-value">${raceClass}</span>
                  </div>
                  <div class="detail-row">
                    <span class="detail-label">Amount</span>
                    <span class="detail-value amount">R${numAmount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                  <div class="detail-row">
                    <span class="detail-label">Registration Date</span>
                    <span class="detail-value">${new Date().toLocaleDateString('en-ZA')}</span>
                  </div>
                </div>
                
                ${generateRaceTicketHTML({
                  reference,
                  eventName,
                  eventDate,
                  eventLocation,
                  raceClass,
                  driverName,
                  teamCode: null
                })}
                
                ${rentalTicketsHtml}
                
                <p style="margin: 20px 0; font-size: 14px; color: #374151;">Your payment will be processed by PayFast. Once confirmed, your entry status will be updated to "Completed". If you have any questions, please contact us.</p>
                
                <p style="margin: 20px 0 0 0; font-size: 14px;">Best regards,<br><strong style="color: #22c55e;">NATS 2026 ROK Cup Team</strong></p>
              </div>
              <div class="footer">
                <p style="margin: 0; color: #6b7280;">This is an automated confirmation email. Please do not reply to this message.</p>
                <p style="margin: 8px 0 0 0;"><a href="https://rokthenats.co.za/" style="color: #2563eb; text-decoration: none; font-weight: 600;">Visit the NATS Event Hub</a></p>
              </div>
            </div>
          </body>
          </html>
        `;

        // Send to driver
        await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
          key: process.env.MAILCHIMP_API_KEY,
          message: {
            to: [{ email: driverEmail, name: driverName }],
            bcc_address: 'africankartingcup@gmail.com',
            from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
            from_name: 'The ROK Cup',
            subject: `Race Entry Confirmed - ${eventName} (${raceClass})`,
            html: emailHtml
          }
        });
        
        console.log(`📧 IMMEDIATE confirmation email sent to driver: ${driverEmail}`);

        // Send to John (CC)
        await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
          key: process.env.MAILCHIMP_API_KEY,
          message: {
            to: [{ email: 'john@rokcup.co.za', name: 'John' }],
            bcc_address: 'africankartingcup@gmail.com',
            from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
            from_name: 'The ROK Cup',
            subject: `New Entry - ${driverName} (${raceClass})`,
            html: emailHtml
          }
        });
        
        console.log(`📧 IMMEDIATE confirmation email sent to john@rokcup.co.za`);

      } catch (emailErr) {
        console.error('⚠️ IMMEDIATE email sending failed (non-critical):', emailErr.message);
        // Don't fail the payment initiation if email fails
      }
      
    } catch (dbErr) {
      console.error('⚠️ Could not create pending entry (non-fatal):', dbErr.message);
      // Don't fail the payment - just log and continue
    }

    // Build PayFast parameters for the redirect URL
    // These are the parameters that will be sent to PayFast
    const pfDataForPayFast = {
      merchant_id: merchantId,
      merchant_key: merchantKey,
      return_url: returnUrl,
      cancel_url: cancelUrl,
      notify_url: notifyUrl,
      name_first: 'Race',
      name_last: 'Entry',
      email_address: driverEmail,
      amount: numAmount.toFixed(2),
      item_name: `Race Entry - ${raceClass}`,
      item_description: `Race Entry for ${raceClass} Class`,
      reference: reference
    };

    // Build PayFast parameters in EXACT DOCUMENTATION ORDER per PayFast spec
    // This is the official order PayFast requires (NOT alphabetical)
    const pfDataOrdered = [
      ['merchant_id', merchantId],
      ['merchant_key', merchantKey],
      ['return_url', returnUrl],
      ['cancel_url', cancelUrl],
      ['notify_url', notifyUrl],
      ['name_first', 'Race'],
      ['name_last', 'Entry'],
      ['email_address', driverEmail],
      ['amount', numAmount.toFixed(2)],
      ['item_name', `Race Entry - ${raceClass}`],
      ['item_description', `Race Entry for ${raceClass} Class`]
      // NOTE: reference is NOT in PayFast's official signature list, so it's excluded here
    ];

    // Create MD5 signature in EXACT documentation order
    let pfParamString = '';
    
    console.log(`🔐 Building signature in EXACT Documentation Order:`);
    
    for (const [key, value] of pfDataOrdered) {
      if (value !== null && value !== '') {
        // URL encode: spaces become +, use UPPERCASE hex encoding
        const encoded = encodeURIComponent(value).replace(/%20/g, '+');
        pfParamString += `${key}=${encoded}&`;
        console.log(`  ${key}=${encoded}`);
      }
    }
    
    // Append passphrase at the very end (as per PayFast spec)
    const actualPassphrase = 'RokCupZA2024';
    const passphraseEncoded = encodeURIComponent(actualPassphrase).replace(/%20/g, '+');
    pfParamString += `passphrase=${passphraseEncoded}`;
    console.log(`  passphrase=${passphraseEncoded}`);

    console.log(`🔐 Amount to charge: R${numAmount.toFixed(2)}`);
    console.log(`🔐 Full signature string: ${pfParamString}`);

    const signature = crypto
      .createHash('md5')
      .update(pfParamString.trim())  // ✅ TRIM to remove any trailing whitespace
      .digest('hex');

    console.log(`✅ Generated signature: ${signature}`);
    console.log(`💳 Merchant ID: ${merchantId}`);

    // Return HTML form that POSTs to PayFast
    // KEY: Form fields contain RAW (unencoded) values
    // The signature was calculated using ENCODED values, but the form sends RAW values
    const formHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Processing Payment...</title>
        <style>
          body { font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f5f5f5; }
          .container { text-align: center; }
          .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Redirecting to Payment...</h1>
          <div class="spinner"></div>
          <p>Amount: <strong>R${numAmount.toFixed(2)}</strong></p>
          <p>Class: <strong>${raceClass}</strong></p>
          <p>Reference: <strong>${reference}</strong></p>
        </div>
        <form id="paymentForm" method="POST" action="https://www.payfast.co.za/eng/process">
          <!-- RAW (unencoded) form values -->
          <input type="hidden" name="merchant_id" value="${merchantId}">
          <input type="hidden" name="merchant_key" value="${merchantKey}">
          <input type="hidden" name="return_url" value="${returnUrl}">
          <input type="hidden" name="cancel_url" value="${cancelUrl}">
          <input type="hidden" name="notify_url" value="${notifyUrl}">
          <input type="hidden" name="name_first" value="Race">
          <input type="hidden" name="name_last" value="Entry">
          <input type="hidden" name="email_address" value="${driverEmail}">
          <input type="hidden" name="amount" value="${numAmount.toFixed(2)}">
          <input type="hidden" name="item_name" value="Race Entry - ${raceClass}">
          <input type="hidden" name="item_description" value="Race Entry for ${raceClass} Class">
          <input type="hidden" name="reference" value="${reference}">
          <input type="hidden" name="signature" value="${signature}">
        </form>
        <script>
          // Auto-submit form after a short delay
          setTimeout(function() {
            document.getElementById('paymentForm').submit();
          }, 1000);
        </script>
      </body>
      </html>
    `;

    res.send(formHtml);
  } catch (err) {
    console.error('❌ initiateRacePayment error:', err.message);
    res.status(400).send(`<h1>Payment Error</h1><p>${err.message}</p><p><a href="/">Back to Home</a></p>`);
  }
});

// Initiate Pool Engine Rental Payment via PayFast
app.get('/api/initiatePoolEnginePayment', async (req, res) => {
  try {
    const { class: rentalClass, rentalType, amount, email, driverId } = req.query;
    
    if (!rentalClass || !rentalType || !amount) {
      throw new Error('Missing class, rental type, or amount');
    }
    
    if (!driverId) {
      throw new Error('Missing driver ID');
    }

    const driverEmail = email && email.trim() ? email.trim().toLowerCase() : 'noreply@nats.co.za';
    console.log(`💳 Pool Engine Payment email: ${driverEmail}`);

    // Clean and parse amount
    let cleanAmount = String(amount)
      .replace(/R/g, '')
      .replace(/\s/g, '')
      .replace(/,/g, '.')
      .trim();
    const numAmount = parseFloat(cleanAmount);
    
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error(`Invalid amount: ${amount}`);
    }

    console.log(`💳 Initiating PayFast payment: Pool Engine ${rentalType} for ${rentalClass} - R${numAmount.toFixed(2)}`);

    const merchantId = process.env.PAYFAST_MERCHANT_ID || '18906399';
    const merchantKey = process.env.PAYFAST_MERCHANT_KEY || 'fbxpiwtzoh1gg';
    const returnUrl = process.env.PAYFAST_RETURN_URL || 'https://www.rokthenats.co.za/payment-success.html';
    const cancelUrl = process.env.PAYFAST_CANCEL_URL || 'https://www.rokthenats.co.za/payment-cancel.html';
    const notifyUrl = process.env.PAYFAST_NOTIFY_URL || 'https://www.rokthenats.co.za/api/paymentNotify';

    const reference = `POOL-${rentalClass}-${rentalType}-${driverId}-${Date.now()}`;

    const pfDataOrdered = [
      ['merchant_id', merchantId],
      ['merchant_key', merchantKey],
      ['return_url', returnUrl],
      ['cancel_url', cancelUrl],
      ['notify_url', notifyUrl],
      ['name_first', 'Pool Engine'],
      ['name_last', 'Rental'],
      ['email_address', driverEmail],
      ['amount', numAmount.toFixed(2)],
      ['item_name', `Pool Engine Rental - ${rentalClass}`],
      ['item_description', `${rentalType} Pool Engine Rental for ${rentalClass}`]
    ];

    let pfParamString = '';
    
    console.log(`🔐 Building signature for pool engine rental:`);
    
    for (const [key, value] of pfDataOrdered) {
      if (value !== null && value !== '') {
        const encoded = encodeURIComponent(value).replace(/%20/g, '+');
        pfParamString += `${key}=${encoded}&`;
        console.log(`  ${key}=${encoded}`);
      }
    }
    
    const actualPassphrase = 'RokCupZA2024';
    const passphraseEncoded = encodeURIComponent(actualPassphrase).replace(/%20/g, '+');
    pfParamString += `passphrase=${passphraseEncoded}`;
    console.log(`  passphrase=${passphraseEncoded}`);

    const signature = crypto
      .createHash('md5')
      .update(pfParamString.trim())
      .digest('hex');

    console.log(`✅ Generated signature: ${signature}`);

    const formHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Processing Payment...</title>
        <style>
          body { font-family: Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f5f5f5; }
          .container { text-align: center; }
          .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Redirecting to Payment...</h1>
          <div class="spinner"></div>
          <p>Amount: <strong>R${numAmount.toFixed(2)}</strong></p>
          <p>Rental: <strong>${rentalType}</strong></p>
          <p>Class: <strong>${rentalClass}</strong></p>
          <p>Reference: <strong>${reference}</strong></p>
        </div>
        <form id="paymentForm" method="POST" action="https://www.payfast.co.za/eng/process">
          <input type="hidden" name="merchant_id" value="${merchantId}">
          <input type="hidden" name="merchant_key" value="${merchantKey}">
          <input type="hidden" name="return_url" value="${returnUrl}">
          <input type="hidden" name="cancel_url" value="${cancelUrl}">
          <input type="hidden" name="notify_url" value="${notifyUrl}">
          <input type="hidden" name="name_first" value="Pool Engine">
          <input type="hidden" name="name_last" value="Rental">
          <input type="hidden" name="email_address" value="${driverEmail}">
          <input type="hidden" name="amount" value="${numAmount.toFixed(2)}">
          <input type="hidden" name="item_name" value="Pool Engine Rental - ${rentalClass}">
          <input type="hidden" name="item_description" value="${rentalType} Pool Engine Rental for ${rentalClass}">
          <input type="hidden" name="reference" value="${reference}">
          <input type="hidden" name="signature" value="${signature}">
        </form>
        <script>
          setTimeout(function() {
            document.getElementById('paymentForm').submit();
          }, 1000);
        </script>
      </body>
      </html>
    `;

    res.send(formHtml);
  } catch (err) {
    console.error('❌ initiatePoolEnginePayment error:', err.message);
    res.status(400).send(`<h1>Payment Error</h1><p>${err.message}</p><p><a href="/">Back to Home</a></p>`);
  }
});

// Register for free race entry (with team code k0k0r0)
// Create Trello card for new race entry
const createTrelloCard = async (driverName, email, raceClass, teamCode, entryReference, driverId) => {
  try {
    const TRELLO_API_KEY = process.env.TRELLO_API_KEY || '4ca7d039fde110d7a6733fac928a6f0f';
    const TRELLO_TOKEN = process.env.TRELLO_TOKEN || '363e5ac5fe8f9a940a7b6fe08b245afb6cf7066205396fd77145eebed1d1af9f';
    const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID || '696cc6dc4a6f89d0cf0a2b7b';
    
    // First, get the board to find the "New Entries" list
    const boardResponse = await axios.get(
      `https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/lists?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`
    );
    
    const newEntriesList = boardResponse.data.find(list => list.name === 'New Entries');
    if (!newEntriesList) {
      console.warn('⚠️ Trello: "New Entries" list not found');
      return;
    }
    
    // Create card with driver details
    const cardDescription = `
**Driver Information:**
• Name: ${driverName}
• Email: ${email}
• Driver ID: ${driverId}
• Race Class: ${raceClass}
• Team Code: ${teamCode || 'N/A'}
• Entry Reference: ${entryReference}
• Registration Date: ${new Date().toLocaleDateString('en-ZA')}
• Registration Time: ${new Date().toLocaleTimeString('en-ZA')}
    `.trim();
    
    const cardResponse = await axios.post(
      `https://api.trello.com/1/cards?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`,
      {
        idList: newEntriesList.id,
        name: `${driverName} - ${raceClass}`,
        desc: cardDescription,
        due: null
      }
    );
    
    console.log(`✅ Trello card created: ${cardResponse.data.id} for ${driverName}`);
    return cardResponse.data;
  } catch (err) {
    console.error('⚠️ Trello card creation failed (non-critical):', err.message);
  }
};

// Manual Trello card creation for existing entries
app.post('/api/sendEntryToTrello', async (req, res) => {
  try {
    const { entry_id } = req.body;
    
    if (!entry_id) {
      return res.json({ success: false, error: 'Entry ID required' });
    }
    
    // Get entry details
    const result = await pool.query(`
      SELECT re.entry_id, re.driver_id, re.race_class, re.payment_reference, re.team_code,
             d.first_name, d.last_name, c.email,
             CONCAT(d.first_name, ' ', d.last_name) as driver_name
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN contacts c ON d.driver_id = c.driver_id
      WHERE re.entry_id = $1
    `, [entry_id]);
    
    if (result.rows.length === 0) {
      return res.json({ success: false, error: 'Entry not found' });
    }
    
    const entry = result.rows[0];
    
    // Create Trello card
    const trelloCard = await createTrelloCard(
      entry.driver_name,
      entry.email,
      entry.race_class,
      entry.team_code,
      entry.payment_reference,
      entry.driver_id
    );
    
    if (trelloCard) {
      res.json({ success: true, message: 'Entry sent to Trello successfully', cardId: trelloCard.id });
    } else {
      res.json({ success: false, error: 'Failed to create Trello card' });
    }
  } catch (err) {
    console.error('Error sending entry to Trello:', err);
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/registerFreeRaceEntry', async (req, res) => {
  try {
    const { eventId, driverId, raceClass, selectedItems, email, firstName, lastName, teamCode } = req.body;
    
    if (!eventId || !driverId || !email) {
      throw new Error('Missing event ID, driver ID, or email');
    }

    const entry_id = `race_entry_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    // Use TEAM in reference if team code is provided, otherwise FREE
    const referenceType = teamCode ? 'TEAM' : 'FREE';
    const reference = `RACE-${referenceType}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    // Format selected items as JSON (entry_items column expects JSON format)
    const selectedItemsJson = selectedItems ? JSON.stringify(selectedItems) : JSON.stringify([]);
    
    // Generate unique ticket references for purchased items
    const selectedItemsArray = Array.isArray(selectedItems) ? selectedItems : [];
    const ticketEngineRef = selectedItemsArray.some(item => item && item.toLowerCase().includes('engine')) 
      ? generateUniqueTicketRef('engine', driverId, eventId) : null;
    const ticketTyresRef = selectedItemsArray.some(item => item && item.toLowerCase().includes('tyre')) 
      ? generateUniqueTicketRef('tyres', driverId, eventId) : null;
    const ticketTransponderRef = selectedItemsArray.some(item => item && item.toLowerCase().includes('transponder')) 
      ? generateUniqueTicketRef('transponder', driverId, eventId) : null;
    const ticketFuelRef = selectedItemsArray.some(item => item && item.toLowerCase().includes('fuel')) 
      ? generateUniqueTicketRef('fuel', driverId, eventId) : null;
    
    // Check if this is a regional race where season rentals don't apply
    const eventResult = await pool.query(
      `SELECT event_date FROM events WHERE event_id = $1`,
      [eventId]
    );
    const eventDate = eventResult.rows[0]?.event_date ? new Date(eventResult.rows[0].event_date) : null;
    
    // Regional race dates where everyone must rent engines individually (Feb 14, Apr 11, Sep 7)
    const regionalRaceDates = ['2026-02-14', '2026-04-11', '2026-09-07'];
    const isRegionalRace = eventDate && regionalRaceDates.some(dateStr => {
      const regionalDate = new Date(dateStr);
      return eventDate.getFullYear() === regionalDate.getFullYear() &&
             eventDate.getMonth() === regionalDate.getMonth() &&
             eventDate.getDate() === regionalDate.getDate();
    });
    
    // Check if driver has season engine rental from pool engines
    const seasonRentalResult = await pool.query(
      `SELECT COUNT(*) as count FROM pool_engine_rentals 
       WHERE driver_id = $1 AND payment_status = 'Completed' AND season_year = $2
       LIMIT 1`,
      [driverId, new Date().getFullYear()]
    );
    const hasSeasonEngineRental = seasonRentalResult.rows[0]?.count > 0;
    
    // Determine if engine rental is selected
    const engineRentalSelected = selectedItems && selectedItems.some(item => item.toLowerCase().includes('engine') || item.toLowerCase().includes('rental'));
    
    // Determine if engine needs to be charged
    let hasEngineRental = engineRentalSelected;
    
    // If driver has season engine rental AND it's NOT a regional race, they don't need to pay for individual race engine rentals
    if (hasSeasonEngineRental && engineRentalSelected && !isRegionalRace) {
      console.log(`ℹ️ Driver ${driverId} has season engine rental - skipping individual race engine charge`);
      hasEngineRental = false;
    } else if (isRegionalRace && engineRentalSelected) {
      console.log(`ℹ️ Regional race detected (${eventDate.toLocaleDateString()}) - individual engine rental required even with season pass`);
      hasEngineRental = true; // Force charging for regional races
    }
    
    const engineValue = hasEngineRental ? 1 : 0;
    
    // Store the free entry in database with unique ticket references
    await pool.query(
      `INSERT INTO race_entries (entry_id, event_id, driver_id, payment_reference, payment_status, entry_status, amount_paid, race_class, entry_items, team_code, engine, ticket_engine_ref, ticket_tyres_ref, ticket_transponder_ref, ticket_fuel_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())`,
      [entry_id, eventId, driverId, reference, 'Completed', 'confirmed', 0, raceClass, selectedItemsJson, teamCode || null, engineValue, ticketEngineRef, ticketTyresRef, ticketTransponderRef, ticketFuelRef]
    );

    // Update driver's next race status - use engineRentalSelected for status (whether they have an engine), not hasEngineRental (whether they're charged)
    await pool.query(
      `UPDATE drivers 
       SET next_race_entry_status = 'Registered',
           next_race_engine_rental_status = $1
       WHERE driver_id = $2`,
      [engineRentalSelected ? 'Yes' : 'No', driverId]
    );

    // Log to audit trail
    const itemsString = Array.isArray(selectedItems) ? selectedItems.join(', ') : 'None';
    await logAuditEvent(driverId, email, 'RACE_ENTRY_REGISTERED', 'entry_items', '', itemsString);

    console.log(`✅ Free race entry recorded: ${reference} - ${raceClass}`);
    console.log(`✅ Updated driver ${driverId} next_race status - Engine Rental: ${engineRentalSelected ? 'Yes' : 'No'}, Team Code: ${teamCode || 'N/A'}`);

    // Send confirmation emails
    try {
      const driverName = `${firstName || 'Driver'} ${lastName || ''}`.trim();
      
      // Fetch event details
      const eventResult = await pool.query(
        `SELECT event_id, event_name, event_date, location FROM events WHERE event_id = $1`,
        [eventId]
      );
      const eventDetails = eventResult.rows[0];
      const eventName = eventDetails?.event_name || 'Race Event';
      const eventDateStr = eventDetails?.event_date 
        ? new Date(eventDetails.event_date).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
        : 'TBA';
      const eventLocation = eventDetails?.location || 'TBA';
      
      // Parse selected items for ticket display
      const selectedItemsArray = Array.isArray(selectedItems) ? selectedItems : [];
      const hasEngineRentalItem = selectedItemsArray.some(item => item && item.toLowerCase().includes('engine'));
      const hasTyresItem = selectedItemsArray.some(item => item && item.toLowerCase().includes('tyre'));
      const hasTransponderItem = selectedItemsArray.some(item => item && item.toLowerCase().includes('transponder'));
      
      // Build rental ticket HTML using new ticket generators with unique references
      let rentalTicketsHtml = '';
      if (hasEngineRentalItem && ticketEngineRef) {
        rentalTicketsHtml += generateEngineRentalTicketHTML({
          reference: ticketEngineRef,
          eventName,
          eventDate: eventDetails?.event_date,
          eventLocation,
          raceClass,
          driverName
        });
      }
      if (hasTyresItem && ticketTyresRef) {
        rentalTicketsHtml += generateTyreRentalTicketHTML({
          reference: ticketTyresRef,
          eventName,
          eventDate: eventDetails?.event_date,
          eventLocation,
          raceClass,
          driverName
        });
      }
      if (hasTransponderItem && ticketTransponderRef) {
        rentalTicketsHtml += generateTransponderRentalTicketHTML({
          reference: ticketTransponderRef,
          eventName,
          eventDate: eventDetails?.event_date,
          eventLocation,
          raceClass,
          driverName
        });
      }
      
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Race Entry Confirmation — NATS 2026 ROK Cup</title>
          <style>
            body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #333; background: #f5f5f5; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
            .header { background: white; padding: 20px; text-align: center; border-bottom: 3px solid #22c55e; }
            .header-logo { margin-bottom: 16px; }
            .header-logo img { width: 140px; height: auto; }
            .header h1 { margin: 0; font-size: 24px; font-weight: 700; color: #111827; }
            .content { padding: 30px; }
            .details { background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #22c55e; }
            .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
            .detail-row:last-child { border-bottom: none; }
            .detail-label { font-weight: 600; color: #6b7280; font-size: 13px; }
            .detail-value { color: #111827; font-weight: 500; }
            .badge { background: #dcfce7; color: #166534; padding: 6px 12px; border-radius: 4px; font-weight: 700; display: inline-block; font-size: 12px; }
            .ticket { border: 2px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-start; background: white; }
            .ticket-left { flex: 1; }
            .ticket-type { font-size: 13px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
            .ticket-title { font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 12px; }
            .ticket-info { font-size: 12px; color: #374151; line-height: 1.5; }
            .ticket-code { background: #f9fafb; padding: 12px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #111827; letter-spacing: 0.05em; text-align: center; margin-top: 12px; border: 1px solid #e5e7eb; }
            .footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px; text-align: center; color: #6b7280; font-size: 12px; }
          </style>
        </head>
        <body style="margin: 0; padding: 20px;">
          <div class="container">
            <div class="header">
              <div class="header-logo">
                <img src="https://www.dropbox.com/scl/fi/ryhszrvk76kd7yy6y0rtc/ROK-CUP-LOGO-2025.png?rlkey=k9dxlzbh5e9zw58v8t34yjzea&dl=1" alt="ROK Cup South Africa" />
              </div>
              <h1>Race Entry Confirmed</h1>
            </div>
            <div class="content">
              <p style="margin: 0 0 16px 0; font-size: 15px;">Hi ${driverName},</p>
              <p style="margin: 0 0 20px 0; font-size: 15px; color: #374151;">Your race entry has been successfully registered. Thank you for participating in the NATS 2026 ROK Cup!</p>
              
              <div class="details">
                <div class="detail-row">
                  <span class="detail-label">Event Name</span>
                  <span class="detail-value">${eventName}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Event Date</span>
                  <span class="detail-value">${eventDateStr}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Location</span>
                  <span class="detail-value">${eventLocation}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Race Class</span>
                  <span class="detail-value">${raceClass}</span>
                </div>
                ${teamCode ? `<div class="detail-row">
                  <span class="detail-label">Team Code</span>
                  <span class="detail-value">${teamCode}</span>
                </div>` : ''}
                <div class="detail-row">
                  <span class="detail-label">Entry Reference</span>
                  <span class="detail-value">${reference}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Status</span>
                  <span class="badge">Confirmed</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Confirmation Date</span>
                  <span class="detail-value">${new Date().toLocaleDateString('en-ZA')}</span>
                </div>
              </div>
              
              ${generateRaceTicketHTML({
                reference,
                eventName,
                eventDate: eventDetails?.event_date,
                eventLocation,
                raceClass,
                driverName,
                teamCode
              })}
              
              ${rentalTicketsHtml}
              
              <p style="margin: 20px 0; font-size: 14px; color: #374151;">You will receive further instructions about your race entry shortly. Please make sure to check your driver portal regularly for updates and important announcements.</p>
              
              <p style="margin: 20px 0 0 0; font-size: 14px;">Best regards,<br><strong style="color: #22c55e;">NATS 2026 ROK Cup Team</strong></p>
            </div>
            <div class="footer">
              <p style="margin: 0; color: #6b7280;">This is an automated confirmation email. Please do not reply to this message.</p>
              <p style="margin: 8px 0 0 0;"><a href="https://rokthenats.co.za/" style="color: #2563eb; text-decoration: none; font-weight: 600;">Visit the NATS Event Hub</a></p>
            </div>
          </div>
        </body>
        </html>
      `;

      // Send to driver
      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: email, name: driverName }],
          from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
          from_name: 'The ROK Cup',
          subject: `Race Entry Confirmed - ${eventName} (${raceClass})`,
          html: emailHtml
        }
      });
      
      console.log(`📧 Free entry confirmation email sent to driver: ${email}`);

      // Send detailed admin notification to John
      const adminEmailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>New Race Registration — NATS 2026 ROK Cup</title>
          <style>
            body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #333; background: #f5f5f5; margin: 0; padding: 0; }
            .container { max-width: 700px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
            .header { background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); padding: 25px; text-align: center; color: white; }
            .header h1 { margin: 0; font-size: 24px; font-weight: 700; }
            .content { padding: 30px; }
            .alert { background: #dcfce7; border-left: 4px solid #22c55e; padding: 16px; border-radius: 4px; margin-bottom: 24px; }
            .alert-text { color: #166534; font-weight: 600; font-size: 14px; }
            .section { margin-bottom: 24px; }
            .section-title { font-size: 14px; font-weight: 700; color: #111827; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }
            .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
            .detail-item { background: #f9fafb; padding: 12px; border-radius: 6px; }
            .detail-label { font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; margin-bottom: 4px; }
            .detail-value { font-size: 14px; font-weight: 500; color: #111827; }
            .footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px; text-align: center; color: #6b7280; font-size: 12px; }
            .badge { display: inline-block; padding: 6px 12px; border-radius: 4px; font-weight: 700; font-size: 12px; }
            .badge-success { background: #dcfce7; color: #166534; }
          </style>
        </head>
        <body style="margin: 0; padding: 20px;">
          <div class="container">
            <div class="header">
              <h1>📋 New Race Registration</h1>
            </div>
            <div class="content">
              <div class="alert">
                <div class="alert-text">✓ Race entry successfully registered in the system</div>
              </div>
              
              <div class="section">
                <div class="section-title">Registration Details</div>
                <div class="detail-grid">
                  <div class="detail-item">
                    <div class="detail-label">Entry Reference</div>
                    <div class="detail-value"><strong>${reference}</strong></div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Status</div>
                    <div class="detail-value"><span class="badge badge-success">Confirmed</span></div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Registration Date</div>
                    <div class="detail-value">${new Date().toLocaleDateString('en-ZA')}</div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Registration Time</div>
                    <div class="detail-value">${new Date().toLocaleTimeString('en-ZA')}</div>
                  </div>
                </div>
              </div>
              
              <div class="section">
                <div class="section-title">Driver Information</div>
                <div class="detail-grid">
                  <div class="detail-item">
                    <div class="detail-label">Driver Name</div>
                    <div class="detail-value">${driverName}</div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Driver Email</div>
                    <div class="detail-value"><a href="mailto:${email}" style="color: #2563eb; text-decoration: none;">${email}</a></div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Driver ID</div>
                    <div class="detail-value">${driverId}</div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Race Class</div>
                    <div class="detail-value">${raceClass}</div>
                  </div>
                  ${teamCode ? `<div class="detail-item">
                    <div class="detail-label">Team Code</div>
                    <div class="detail-value">${teamCode}</div>
                  </div>` : ''}
                </div>
              </div>
              
              <div class="section">
                <div class="section-title">Entry Details</div>
                <div style="background: #f9fafb; padding: 16px; border-radius: 6px;">
                  <div style="margin-bottom: 12px;">
                    <span style="font-weight: 600; color: #111827;">Selected Items:</span>
                    <div style="margin-top: 8px; color: #374151;">
                      ${selectedItems && selectedItems.length > 0 ? selectedItems.map(item => `<div>• ${item}</div>`).join('') : '<div style="color: #9ca3af; font-style: italic;">No additional items selected</div>'}
                    </div>
                  </div>
                  <div style="border-top: 1px solid #e5e7eb; padding-top: 12px; margin-top: 12px;">
                    <span style="font-weight: 600; color: #111827;">Engine Rental:</span>
                    <div style="color: #374151; margin-top: 4px;">${hasEngineRental ? '✓ Yes' : '✗ No'}</div>
                  </div>
                </div>
              </div>
              
              <div class="section">
                <div class="section-title">Payment Information</div>
                <div class="detail-grid">
                  <div class="detail-item">
                    <div class="detail-label">Amount Paid</div>
                    <div class="detail-value">R0.00</div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Payment Status</div>
                    <div class="detail-value">Completed (Free Entry)</div>
                  </div>
                  <div class="detail-item">
                    <div class="detail-label">Payment Reference</div>
                    <div class="detail-value">${reference}</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="footer">
              <p style="margin: 0;">This is an automated notification from the NATS Race Management System</p>
            </div>
          </div>
        </body>
        </html>
      `;

      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: 'john@rokcup.co.za', name: 'John' }],
          from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
          subject: `[NEW ENTRY] ${driverName} - ${raceClass}`,
          html: adminEmailHtml
        }
      });
      
      console.log(`📧 Admin notification email sent to john@rokcup.co.za`);

      // Create Trello card for the new entry
      await createTrelloCard(driverName, email, raceClass, teamCode, reference, driverId);

    } catch (emailErr) {
      console.error('⚠️ Email sending failed (non-critical):', emailErr.message);
    }

    res.json({ success: true, message: 'Race entry registered successfully', reference });
  } catch (err) {
    console.error('❌ registerFreeRaceEntry error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Handle PayFast Payment Notification (IPN)
app.post('/api/paymentNotify', async (req, res) => {
  try {
    console.log('� ========================================');
    console.log('🔔 PAYFAST WEBHOOK RECEIVED');
    console.log('🔔 ========================================');
    console.log('📨 Full PayFast IPN Body:', JSON.stringify(req.body, null, 2));
    console.log('🕐 Timestamp:', new Date().toISOString());

    const { 
      m_payment_id, 
      pf_payment_id,
      payment_status, 
      item_description, 
      item_name,
      amount_gross,
      reference,
      email_address,
      signature,
      name_first,
      name_last
    } = req.body;

    console.log('🔍 Key Fields:');
    console.log(`   - Payment Reference: ${reference}`);
    console.log(`   - Payment Status: ${payment_status}`);
    console.log(`   - Amount: R${amount_gross}`);
    console.log(`   - Driver: ${name_first} ${name_last}`);
    console.log(`   - Email: ${email_address}`);

    if (!m_payment_id || !payment_status) {
      console.error('❌ Missing payment ID or status!');
      throw new Error('Missing payment ID or status');
    }

    // Verify PayFast signature
    const merchantId = process.env.PAYFAST_MERCHANT_ID || '18906399';
    const merchantKey = process.env.PAYFAST_MERCHANT_KEY || 'fbxpiwtzoh1gg';
    const passphrase = 'RokCupZA2024';

    // Build signature string in PayFast order (excluding signature field itself)
    let pfParamString = '';
    const signatureData = { ...req.body };
    delete signatureData.signature;
    
    // PayFast requires fields in specific order for signature verification
    const signatureFields = [
      'm_payment_id', 'pf_payment_id', 'payment_status', 'item_name', 'item_description',
      'amount_gross', 'amount_fee', 'amount_net', 'custom_int1', 'custom_int2', 'custom_int3',
      'custom_int4', 'custom_int5', 'custom_str1', 'custom_str2', 'custom_str3', 'custom_str4',
      'custom_str5', 'name_first', 'name_last', 'email_address', 'cell_number', 'merchant_id'
    ];

    for (const field of signatureFields) {
      if (signatureData[field]) {
        const encoded = encodeURIComponent(signatureData[field]).replace(/%20/g, '+');
        pfParamString += `${field}=${encoded}&`;
      }
    }
    
    pfParamString += `passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}`;
    
    const calculatedSignature = crypto.createHash('md5').update(pfParamString.trim()).digest('hex');
    
    console.log(`✅ IPN Signature verification: ${calculatedSignature === signature ? 'PASSED' : 'FAILED'}`);
    if (calculatedSignature !== signature) {
      console.warn('⚠️ Signature mismatch - possible tampering');
    }

    // Only process COMPLETE payments
    if (payment_status !== 'COMPLETE') {
      console.log(`⏭️ Payment not complete (status: ${payment_status}), not recording`);
      res.json({ success: true });
      return;
    }

    // Parse reference to extract event_id and driver_id
    // Reference format: RACE-{eventId}-{driverId}-{timestamp}
    // OR: POOL-{rentalClass}-{rentalType}-{driverId}-{timestamp}
    const referenceParts = reference.split('-');
    
    const isPoolEngineRental = reference.startsWith('POOL-');
    let eventId, driverId, rentalClass, rentalType;
    
    if (isPoolEngineRental) {
      // POOL-{rentalClass}-{rentalType}-{driverId}-{timestamp}
      rentalClass = referenceParts[1] || 'UNKNOWN';
      rentalType = referenceParts[2] || 'UNKNOWN';
      driverId = referenceParts[3] || 'unknown';
      
      console.log(`💳 Pool Engine Payment Completed: ${rentalClass} - ${rentalType} for driver ${driverId}`);
      
      // Save pool engine rental
      try {
        const rentalId = `pool_rental_${pf_payment_id}`;
        await pool.query(
          `INSERT INTO pool_engine_rentals (rental_id, driver_id, championship_class, rental_type, amount_paid, payment_status, payment_reference, season_year, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
          [rentalId, driverId, rentalClass, rentalType, amount_gross, 'Completed', m_payment_id, new Date().getFullYear()]
        );
        
        // Update driver's season_engine_rental flag
        await pool.query(
          `UPDATE drivers SET season_engine_rental = 'Y' WHERE driver_id = $1`,
          [driverId]
        );
        
        console.log(`✅ Pool engine rental saved and driver flag updated: ${rentalId}`);
        
        // *** SEND ADMIN NOTIFICATION EMAIL FOR POOL ENGINE PURCHASE ***
        try {
          const driverName = `${name_first || 'Unknown'} ${name_last || 'Driver'}`.trim();
          const adminNotificationHtml = `
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"></head>
            <body style="margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f3f4f6;">
              <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
                <div style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 24px; text-align: center;">
                  <h1 style="color: white; margin: 0; font-size: 20px;">🏎️ POOL ENGINE PURCHASE RECEIVED!</h1>
                </div>
                <div style="padding: 24px;">
                  <p style="margin: 0 0 16px 0; font-size: 16px; color: #111827;"><strong>A driver has purchased a seasonal pool engine rental!</strong></p>
                  
                  <div style="background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; padding: 16px; margin: 16px 0;">
                    <table style="width: 100%; border-collapse: collapse;">
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Driver Name:</td><td style="padding: 8px 0; color: #111827;">${driverName}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Email:</td><td style="padding: 8px 0; color: #111827;">${email_address}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Championship Class:</td><td style="padding: 8px 0; color: #111827; font-weight: 700;">${rentalClass}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Rental Type:</td><td style="padding: 8px 0; color: #111827; font-weight: 700;">${rentalType}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Amount Paid:</td><td style="padding: 8px 0; color: #16a34a; font-weight: 700; font-size: 18px;">R${parseFloat(amount_gross).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Payment Reference:</td><td style="padding: 8px 0; color: #111827; font-family: monospace;">${reference}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">PayFast Transaction:</td><td style="padding: 8px 0; color: #111827; font-family: monospace;">${pf_payment_id}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Season Year:</td><td style="padding: 8px 0; color: #111827;">${new Date().getFullYear()}</td></tr>
                      <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Date/Time:</td><td style="padding: 8px 0; color: #111827;">${new Date().toLocaleString('en-ZA')}</td></tr>
                    </table>
                  </div>
                  
                  <p style="margin: 16px 0 0 0; font-size: 14px; color: #6b7280;">This driver now has seasonal engine access and can enter races without additional engine charges.</p>
                </div>
                <div style="background: #f9fafb; padding: 16px; text-align: center; border-top: 1px solid #e5e7eb;">
                  <p style="margin: 0; font-size: 12px; color: #6b7280;">NATS 2026 ROK Cup - Automated Payment Notification</p>
                </div>
              </div>
            </body>
            </html>
          `;
          
          await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
            key: process.env.MAILCHIMP_API_KEY,
            message: {
              to: [{ email: 'john@rokcup.co.za', name: 'John' }],
              from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
              subject: `🏎️ POOL ENGINE PURCHASE: ${driverName} - ${rentalClass} ${rentalType} - R${amount_gross}`,
              html: adminNotificationHtml
            }
          });
          
          console.log(`📧 Admin notification email sent for pool engine purchase: ${driverName}`);
        } catch (adminEmailErr) {
          console.error('⚠️ Admin notification email failed:', adminEmailErr.message);
        }
        
      } catch (poolErr) {
        console.error('❌ Error saving pool engine rental:', poolErr.message);
      }
    } else {
      // RACE-{eventId}-{driverId}-{timestamp}
      eventId = referenceParts[1] || 'unknown';
      driverId = referenceParts[2] || 'unknown';
    }

    // Extract rental items from item_description to determine what was purchased
    const itemDesc = item_description ? item_description.toLowerCase() : '';
    const hasEngine = itemDesc.includes('engine');
    const hasTyres = itemDesc.includes('tyre');
    const hasTransponder = itemDesc.includes('transponder');
    const hasFuel = itemDesc.includes('fuel');
    
    // Generate ticket references ONLY for items that don't already have them
    // This preserves the original ticket refs from the initial email
    let ticketEngineRef = null;
    let ticketTyresRef = null;
    let ticketTransponderRef = null;
    let ticketFuelRef = null;
    
    // Store payment record using new schema
    const race_entry_id = `race_entry_${pf_payment_id}`;
    if (!isPoolEngineRental) {
      console.log('🔍 Looking for existing pending entry with reference:', reference);
      
      // ✅ FIX #1b: Update pending entry to completed (or insert if webhook came first)
      // First, try to get existing pending entry to preserve race_class and other data
      const existingEntry = await pool.query(
        'SELECT * FROM race_entries WHERE payment_reference = $1',
        [reference]
      );
      
      console.log(`📋 Existing entries found: ${existingEntry.rows.length}`);
      if (existingEntry.rows.length > 0) {
        console.log('   Entry ID:', existingEntry.rows[0].entry_id);
        console.log('   Current Status:', existingEntry.rows[0].payment_status);
        console.log('   Race Class:', existingEntry.rows[0].race_class);
      }
      
      let raceClass = null;
      let entryItems = null;
      
      if (existingEntry.rows.length > 0) {
        raceClass = existingEntry.rows[0].race_class;
        entryItems = existingEntry.rows[0].entry_items;
        // PRESERVE existing ticket references - don't regenerate them!
        ticketEngineRef = existingEntry.rows[0].ticket_engine_ref;
        ticketTyresRef = existingEntry.rows[0].ticket_tyres_ref;
        ticketTransponderRef = existingEntry.rows[0].ticket_transponder_ref;
        ticketFuelRef = existingEntry.rows[0].ticket_fuel_ref;
        console.log(`📝 Found existing pending entry with class: ${raceClass}, items: ${JSON.stringify(entryItems)}, preserving all data`);
      } else {
        // ⚠️ CRITICAL: No pending entry found - this should NOT happen in normal flow
        // This means webhook arrived before pending entry was created, or there was an error
        // Try to infer items from item_description as fallback (unreliable)
        console.warn(`⚠️ WARNING: No pending entry found for reference: ${reference}`);
        console.warn(`⚠️ This indicates the pending entry was not created during payment initiation`);
        
        entryItems = [];
        if (hasEngine) entryItems.push('Engine Rental');
        if (hasTyres) entryItems.push('Tyres (Optional)');
        if (hasTransponder) entryItems.push('Rent Transponder');
        if (hasFuel) entryItems.push('Controlled Fuel');
        
        // Generate new tickets only if no existing entry
        ticketEngineRef = hasEngine ? generateUniqueTicketRef('engine', driverId, eventId) : null;
        ticketTyresRef = hasTyres ? generateUniqueTicketRef('tyres', driverId, eventId) : null;
        ticketTransponderRef = hasTransponder ? generateUniqueTicketRef('transponder', driverId, eventId) : null;
        ticketFuelRef = hasFuel ? generateUniqueTicketRef('fuel', driverId, eventId) : null;
        
        console.warn(`⚠️ Built fallback entry_items from description: ${JSON.stringify(entryItems)}`);
      }
      
      // ON CONFLICT now updates the pending entry we created during initiation
      // First try to update existing pending entry, if not found, insert new
      const updateResult = await pool.query(
        `UPDATE race_entries 
         SET entry_id = $1,
             payment_status = $2, 
             entry_status = $3, 
             amount_paid = $4,
             race_class = $5,
             entry_items = $6,
             ticket_engine_ref = $7, 
             ticket_tyres_ref = $8, 
             ticket_transponder_ref = $9, 
             ticket_fuel_ref = $10,
             updated_at = NOW()
         WHERE payment_reference = $11
         RETURNING *`,
        [race_entry_id, 'Completed', 'confirmed', amount_gross, raceClass, entryItems, 
         ticketEngineRef, ticketTyresRef, ticketTransponderRef, ticketFuelRef, reference]
      );
      
      // If no existing entry found, insert new one
      if (updateResult.rows.length === 0) {
        console.log('⚠️ WARNING: No pending entry found, creating new entry');
        console.log(`   EventId: ${eventId}, DriverId: ${driverId}`);
        
        await pool.query(
          `INSERT INTO race_entries (
            entry_id, event_id, driver_id, payment_reference, payment_status, entry_status, 
            amount_paid, race_class, entry_items, ticket_engine_ref, ticket_tyres_ref, 
            ticket_transponder_ref, ticket_fuel_ref, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())`,
          [race_entry_id, eventId, driverId, reference, 'Completed', 'confirmed', amount_gross, 
           raceClass, entryItems, ticketEngineRef, ticketTyresRef, ticketTransponderRef, ticketFuelRef]
        );
        console.log(`✅ Race entry created (no pending entry found): ${race_entry_id} (Class: ${raceClass})`);
      } else {
        console.log(`✅ Race entry updated from pending to completed: ${race_entry_id} (Class: ${raceClass})`);
        console.log(`   Updated ${updateResult.rows.length} row(s)`);
      }
    }

    console.log('🎉 ========================================');
    console.log(`✅ PAYMENT PROCESSED SUCCESSFULLY`);
    console.log(`   Reference: ${reference}`);
    console.log(`   Status: COMPLETE`);
    console.log(`   Amount: R${amount_gross}`);
    console.log(`   Driver ID: ${driverId}`);
    if (ticketEngineRef) console.log(`   Engine ticket: ${ticketEngineRef}`);
    if (ticketTyresRef) console.log(`   Tyres ticket: ${ticketTyresRef}`);
    if (ticketTransponderRef) console.log(`   Transponder ticket: ${ticketTransponderRef}`);
    if (ticketFuelRef) console.log(`   Fuel ticket: ${ticketFuelRef}`);
    console.log('🎉 ========================================');

    // ⚠️ EMAIL DISABLED FOR RACE ENTRIES - Now sent immediately when payment is initiated
    // This prevents duplicate emails. Pool engine rentals still get emails here.
    // Send confirmation emails (ONLY for pool engine rentals)
    try {
      if (isPoolEngineRental) {
        // Pool engine rental email sending (keep this)
        const driverName = `${name_first || 'Driver'} ${name_last || ''}`.trim();
        
        const emailHtml = `
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"></head>
          <body style="margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f3f4f6;">
            <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
              <div style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 24px; text-align: center;">
                <h1 style="color: white; margin: 0; font-size: 20px;">🏎️ POOL ENGINE PURCHASE CONFIRMED!</h1>
              </div>
              <div style="padding: 24px;">
                <p style="margin: 0 0 16px 0; font-size: 16px; color: #111827;"><strong>Your seasonal pool engine rental is confirmed!</strong></p>
                
                <div style="background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; padding: 16px; margin: 16px 0;">
                  <table style="width: 100%; border-collapse: collapse;">
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Driver Name:</td><td style="padding: 8px 0; color: #111827;">${driverName}</td></tr>
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Email:</td><td style="padding: 8px 0; color: #111827;">${email_address}</td></tr>
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Championship Class:</td><td style="padding: 8px 0; color: #111827; font-weight: 700;">${rentalClass}</td></tr>
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Rental Type:</td><td style="padding: 8px 0; color: #111827; font-weight: 700;">${rentalType}</td></tr>
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Amount Paid:</td><td style="padding: 8px 0; color: #16a34a; font-weight: 700; font-size: 18px;">R${parseFloat(amount_gross).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}</td></tr>
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Payment Reference:</td><td style="padding: 8px 0; color: #111827; font-family: monospace;">${reference}</td></tr>
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">PayFast Transaction:</td><td style="padding: 8px 0; color: #111827; font-family: monospace;">${pf_payment_id}</td></tr>
                    <tr><td style="padding: 8px 0; color: #92400e; font-weight: 600;">Season Year:</td><td style="padding: 8px 0; color: #111827;">${new Date().getFullYear()}</td></tr>
                  </table>
                </div>
                
                <p style="margin: 16px 0 0 0; font-size: 14px; color: #6b7280;">You can now enter races without additional engine charges for the remainder of the season.</p>
              </div>
            </div>
          </body>
          </html>
        `;
        
        // Send to driver
        await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
          key: process.env.MAILCHIMP_API_KEY,
          message: {
            to: [{ email: email_address, name: driverName }],
            bcc_address: 'africankartingcup@gmail.com',
            from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
            subject: `Pool Engine Rental Confirmed - ${rentalClass}`,
            html: emailHtml
          }
        });
        
        console.log(`📧 Pool engine confirmation email sent to driver: ${email_address}`);

        // Send to John (CC)
        await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
          key: process.env.MAILCHIMP_API_KEY,
          message: {
            to: [{ email: 'john@rokcup.co.za', name: 'John' }],
            bcc_address: 'africankartingcup@gmail.com',
            from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
            subject: `Pool Engine Purchase - ${driverName} (${rentalClass})`,
            html: emailHtml
          }
        });
        
        console.log(`📧 Pool engine confirmation email sent to john@rokcup.co.za`);
      } else {
        console.log(`ℹ️ Race entry email SKIPPED - already sent during payment initiation`);
      }
      
    } catch (emailErr) {
      console.error('⚠️ Email sending failed (non-critical):', emailErr.message);
      // Don't fail the IPN response if email fails
    }
    
    // Delete old unused email code below
    /*
      const driverName = `${name_first || 'Driver'} ${name_last || ''}`.trim();
      
      // Fetch event details if not pool engine rental
      let eventName = 'Race Event';
      let eventDateStr = 'TBA';
      let eventLocation = 'TBA';
      let eventDate = null;
      
      if (!isPoolEngineRental && eventId && eventId !== 'unknown') {
        try {
          const eventResult = await pool.query(
            `SELECT event_id, event_name, event_date, location FROM events WHERE event_id = $1`,
            [eventId]
          );
          const eventDetails = eventResult.rows[0];
          if (eventDetails) {
            eventName = eventDetails.event_name || 'Race Event';
            eventDate = eventDetails.event_date;
            eventDateStr = eventDetails.event_date 
              ? new Date(eventDetails.event_date).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
              : 'TBA';
            eventLocation = eventDetails.location || 'TBA';
          }
        } catch (eventErr) {
          console.warn('⚠️ Could not fetch event details:', eventErr.message);
        }
      }
      
      // Build ticket HTML using unique references
      const hasFuel = itemDesc.includes('fuel');
      
      // Initialize rental tickets HTML (empty if no rentals)
      let ticketsHtml = '';
      
      if (hasEngine || hasTyres || hasTransponder || hasFuel) {
        ticketsHtml = '<div style="margin: 30px 0; border-top: 1px solid #e5e7eb; padding-top: 20px;"><div style="font-weight: 700; color: #111827; margin-bottom: 16px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em;">Rental Items</div>';
        
        if (hasEngine && ticketEngineRef) {
          ticketsHtml += `<div style="border: 2px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 16px; border-left: 6px solid #f97316;">
            <div style="font-size: 13px; color: #f97316; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">Engine Rental</div>
            <div style="font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 12px;">Pool Engine Reserved</div>
            <div style="font-size: 12px; color: #374151; line-height: 1.5;">Your competition engine is assigned for this event. Technical inspection required before practice.</div>
            <div style="background: #f9fafb; padding: 12px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #111827; letter-spacing: 0.05em; text-align: center; margin-top: 12px; border: 1px solid #e5e7eb;">${ticketEngineRef}</div>
          </div>`;
        }
        
        if (hasTyres && ticketTyresRef) {
          ticketsHtml += `<div style="border: 2px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 16px; border-left: 6px solid #8b5cf6;">
            <div style="font-size: 13px; color: #8b5cf6; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">Tyre Rental</div>
            <div style="font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 12px;">Complete Tyre Set</div>
            <div style="font-size: 12px; color: #374151; line-height: 1.5;">Tyres included with your entry. Available for collection at race practice day.</div>
            <div style="background: #f9fafb; padding: 12px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #111827; letter-spacing: 0.05em; text-align: center; margin-top: 12px; border: 1px solid #e5e7eb;">${ticketTyresRef}</div>
          </div>`;
        }
        
        if (hasTransponder && ticketTransponderRef) {
          ticketsHtml += `<div style="border: 2px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 16px; border-left: 6px solid #0ea5e9;">
            <div style="font-size: 13px; color: #0ea5e9; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">Transponder Rental</div>
            <div style="font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 12px;">Timing Transponder</div>
            <div style="font-size: 12px; color: #374151; line-height: 1.5;">Transponder issued at race control. Must be installed before technical inspection.</div>
            <div style="background: #f9fafb; padding: 12px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #111827; letter-spacing: 0.05em; text-align: center; margin-top: 12px; border: 1px solid #e5e7eb;">${ticketTransponderRef}</div>
          </div>`;
        }
        
        if (hasFuel && ticketFuelRef) {
          ticketsHtml += `<div style="border: 2px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 16px; border-left: 6px solid #10b981;">
            <div style="font-size: 13px; color: #10b981; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">Fuel Package</div>
            <div style="font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 12px;">Race Fuel Included</div>
            <div style="font-size: 12px; color: #374151; line-height: 1.5;">Pre-measured fuel allocation available at pit area.</div>
            <div style="background: #f9fafb; padding: 12px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #111827; letter-spacing: 0.05em; text-align: center; margin-top: 12px; border: 1px solid #e5e7eb;">${ticketFuelRef}</div>
          </div>`;
        }
        
        ticketsHtml += '</div>';
      }
      
      // Email HTML template
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Payment Confirmation — NATS 2026 ROK Cup</title>
          <style>
            body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #333; background: #f5f5f5; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
            .header { background: white; padding: 20px; text-align: center; border-bottom: 3px solid #22c55e; }
            .header-logo { margin-bottom: 16px; }
            .header-logo img { width: 140px; height: auto; }
            .header h1 { margin: 0; font-size: 24px; font-weight: 700; color: #111827; }
            .content { padding: 30px; }
            .details { background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #22c55e; }
            .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
            .detail-row:last-child { border-bottom: none; }
            .detail-label { font-weight: 600; color: #6b7280; font-size: 13px; }
            .detail-value { color: #111827; font-weight: 500; }
            .amount { font-size: 22px; font-weight: 700; color: #22c55e; }
            .footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px; text-align: center; color: #6b7280; font-size: 12px; }
          </style>
        </head>
        <body style="margin: 0; padding: 20px;">
          <div class="container">
            <div class="header">
              <div class="header-logo">
                <img src="https://www.dropbox.com/scl/fi/ryhszrvk76kd7yy6y0rtc/ROK-CUP-LOGO-2025.png?rlkey=k9dxlzbh5e9zw58v8t34yjzea&dl=1" alt="ROK Cup South Africa" />
              </div>
              <h1>Payment Confirmed</h1>
            </div>
            <div class="content">
              <p style="margin: 0 0 16px 0; font-size: 15px;">Hi ${driverName},</p>
              <p style="margin: 0 0 20px 0; font-size: 15px; color: #374151;">Your race entry payment has been successfully processed. Thank you for registering with the NATS 2026 ROK Cup!</p>
              
              <div class="details">
                <div class="detail-row">
                  <span class="detail-label">Payment Reference</span>
                  <span class="detail-value">${reference}</span>
                </div>
                ${isPoolEngineRental ? `
                <div class="detail-row">
                  <span class="detail-label">Championship Class</span>
                  <span class="detail-value">${rentalClass}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Rental Type</span>
                  <span class="detail-value">${rentalType}</span>
                </div>
                ` : `
                <div class="detail-row">
                  <span class="detail-label">Event Name</span>
                  <span class="detail-value">${eventName}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Event Date</span>
                  <span class="detail-value">${eventDateStr}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Location</span>
                  <span class="detail-value">${eventLocation}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Race Class</span>
                  <span class="detail-value">${raceClass}</span>
                </div>
                `}
                <div class="detail-row">
                  <span class="detail-label">Amount Paid</span>
                  <span class="detail-value amount">R${parseFloat(amount_gross).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Transaction ID</span>
                  <span class="detail-value">${pf_payment_id}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Confirmation Date</span>
                  <span class="detail-value">${new Date().toLocaleDateString('en-ZA')}</span>
                </div>
              </div>
              
              ${isPoolEngineRental ? `
              <div style="margin: 30px 0; border-top: 1px solid #e5e7eb; padding-top: 20px;">
                <div style="font-weight: 700; color: #111827; margin-bottom: 16px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em;">Seasonal Engine Rental</div>
                <div style="border: 2px solid #e5e7eb; border-radius: 8px; padding: 20px; border-left: 6px solid #f97316;">
                  <div style="font-size: 13px; color: #f97316; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">🏎️ Engine Rental Confirmed</div>
                  <div style="font-size: 18px; font-weight: 700; color: #111827; margin-bottom: 12px;">${rentalType} - ${rentalClass} Class</div>
                  <div style="font-size: 12px; color: #374151; line-height: 1.6; margin-bottom: 12px;">Your seasonal engine rental is now active. You can register for races without additional engine rental charges during the ${new Date().getFullYear()} season.</div>
                  <div style="background: #f9fafb; padding: 12px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #111827; letter-spacing: 0.05em; text-align: center; border: 1px solid #e5e7eb;">Season ${new Date().getFullYear()}</div>
                </div>
              </div>
              ` : ticketsHtml}
              
              ${!isPoolEngineRental ? generateRaceTicketHTML({
                reference,
                eventName,
                eventDate,
                eventLocation,
                raceClass,
                driverName,
                teamCode: null
              }) : ''}
              
              <p style="margin: 20px 0; font-size: 14px; color: #374151;">${isPoolEngineRental ? 'You can now enter races without additional engine charges for the remainder of the season. Thank you for your commitment to NATS!' : 'You will receive further instructions about your race entry shortly. If you have any questions, please contact us.'}</p>
              
              <p style="margin: 20px 0 0 0; font-size: 14px;">Best regards,<br><strong style="color: #22c55e;">NATS 2026 ROK Cup Team</strong></p>
            </div>
            <div class="footer">
              <p style="margin: 0; color: #6b7280;">This is an automated confirmation email. Please do not reply to this message.</p>
              <p style="margin: 8px 0 0 0;"><a href="https://rokthenats.co.za/" style="color: #2563eb; text-decoration: none; font-weight: 600;">Visit the NATS Event Hub</a></p>
            </div>
          </div>
        </body>
        </html>
      `;

      // Send to driver
      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: email_address, name: driverName }],
          bcc_address: 'africankartingcup@gmail.com',
          from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
          subject: `Payment Confirmation - ${eventName} (${raceClass})`,
          html: emailHtml
        }
      });
      
      console.log(`📧 Confirmation email sent to driver: ${email_address}`);

      // Send to John (CC)
      await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          to: [{ email: 'john@rokcup.co.za', name: 'John' }],
          bcc_address: 'africankartingcup@gmail.com',
          from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
          subject: `Payment Received - ${driverName} (${raceClass})`,
          html: emailHtml
        }
      });
      
      console.log(`📧 Confirmation email sent to john@rokcup.co.za`);
    */
    // END OLD UNUSED EMAIL CODE - COMMENTED OUT

    res.json({ success: true });
  } catch (err) {
    console.error('❌ paymentNotify error:', err.message);
    
    // ✅ FIX #3: Log failed notifications to file for manual recovery
    const fs = require('fs');
    const path = require('path');
    const logsDir = path.join(__dirname, 'logs');
    const failedNotificationsFile = path.join(logsDir, 'failed_notifications.json');
    
    try {
      // Ensure logs directory exists
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      
      const logEntry = {
        timestamp: new Date().toISOString(),
        error: err.message,
        stack: err.stack,
        payload: req.body,
        headers: req.headers
      };
      
      // Append to file (one JSON object per line for easy parsing)
      fs.appendFileSync(failedNotificationsFile, JSON.stringify(logEntry) + '\n');
      console.log(`📝 Failed notification logged to ${failedNotificationsFile}`);
    } catch (logErr) {
      console.error('⚠️ Could not log failed notification:', logErr.message);
    }
    
    // Still respond 200 to PayFast so they don't keep retrying (they won't anyway)
    res.status(200).json({ success: false, error: err.message });
  }
});

// ✅ FIX #4: Manual Payment Reconciliation Endpoint
// Allows admins to manually process a PayFast payment if notification was missed
app.post('/api/admin/reconcilePayment', async (req, res) => {
  try {
    const { 
      entry_id,
      race_entry_id,
      payment_reference, 
      amount_paid,
      pf_payment_id,
      amount_gross,
      payment_status,
      email_address,
      name_first,
      name_last
    } = req.body;

    // Accept both entry_id and race_entry_id for backwards compatibility
    const entryId = entry_id || race_entry_id;

    // If entry_id is provided, update existing entry
    if (entryId) {
      console.log(`🔄 Reconciling payment for existing entry: ${entryId}`);
      
      if (!payment_reference) {
        throw new Error('Payment reference is required');
      }
      
      // Update the existing entry with payment info - use entry_id (production column name)
      const result = await pool.query(
        `UPDATE race_entries 
         SET payment_reference = $1, 
             payment_status = $2, 
             amount_paid = $3,
             entry_status = COALESCE(entry_status, 'confirmed'),
             updated_at = NOW()
         WHERE entry_id = $4
         RETURNING *`,
        [payment_reference, payment_status || 'Completed', amount_paid || 0, entryId]
      );
      
      if (result.rows.length === 0) {
        throw new Error('Race entry not found');
      }
      
      console.log(`✅ Entry reconciled: ${entryId}`);
      return res.json({ 
        success: true, 
        message: 'Payment reconciled successfully',
        data: result.rows[0]
      });
    }

    // Original logic for creating new entries from payment references
    if (!payment_reference) {
      throw new Error('Payment reference is required');
    }

    console.log(`🔄 Manual reconciliation requested for: ${payment_reference}`);

    // Parse reference to extract info
    const referenceParts = payment_reference.split('-');
    const isPoolEngineRental = payment_reference.startsWith('POOL-');
    
    let eventId, driverId, rentalClass, rentalType;
    
    if (isPoolEngineRental) {
      rentalClass = referenceParts[1] || 'UNKNOWN';
      rentalType = referenceParts[2] || 'UNKNOWN';
      driverId = referenceParts[3] || 'unknown';
      
      // Check if already exists
      const existing = await pool.query(
        'SELECT * FROM pool_engine_rentals WHERE payment_reference = $1',
        [payment_reference]
      );
      
      if (existing.rows.length > 0) {
        return res.json({ 
          success: true, 
          message: 'Payment already reconciled',
          data: existing.rows[0]
        });
      }
      
      // Create pool engine rental
      const rentalId = `pool_rental_${pf_payment_id || Date.now()}`;
      await pool.query(
        `INSERT INTO pool_engine_rentals (
          rental_id, driver_id, championship_class, rental_type, 
          amount_paid, payment_status, payment_reference, season_year, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
        [rentalId, driverId, rentalClass, rentalType, amount_gross, payment_status || 'Completed', payment_reference, new Date().getFullYear()]
      );
      
      await pool.query(
        'UPDATE drivers SET season_engine_rental = $1 WHERE driver_id = $2',
        ['Y', driverId]
      );
      
      console.log(`✅ Pool engine rental reconciled: ${rentalId}`);
      res.json({ success: true, message: 'Pool engine rental reconciled successfully', rental_id: rentalId });
      
    } else {
      // Race entry
      eventId = referenceParts[1] || 'unknown';
      driverId = referenceParts[2] || 'unknown';
      
      // Check if already exists
      const existing = await pool.query(
        'SELECT * FROM race_entries WHERE payment_reference = $1',
        [payment_reference]
      );
      
      if (existing.rows.length > 0) {
        return res.json({ 
          success: true, 
          message: 'Payment already reconciled',
          data: existing.rows[0]
        });
      }
      
      // Create race entry using entry_id as primary key (production column name)
      const entry_id = `race_entry_${pf_payment_id || Date.now()}_manual`;
      await pool.query(
        `INSERT INTO race_entries (
          entry_id, event_id, driver_id, payment_reference, payment_status, 
          entry_status, amount_paid, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
        [entry_id, eventId, driverId, payment_reference, payment_status || 'Completed', 'confirmed', amount_gross]
      );
      
      console.log(`✅ Race entry reconciled: ${entry_id}`);
      res.json({ success: true, message: 'Race entry reconciled successfully', entry_id: entry_id });
    }
  } catch (err) {
    console.error('❌ Error reconciling payment:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Manually add race entry (no payment reference)
app.post('/api/adminAddRaceEntry', async (req, res) => {
  try {
    const {
      event_id,
      driver_id,
      race_class,
      entry_items,
      payment_status,
      entry_status,
      amount_paid,
      send_emails,
      create_trello_card,
      update_engine_status
    } = req.body;

    if (!event_id || !driver_id || !race_class) {
      throw new Error('Missing required fields: event_id, driver_id, race_class');
    }

    // Get driver details
    const driverResult = await pool.query(
      'SELECT d.first_name, d.last_name, c.email, d.transponder_number FROM drivers d LEFT JOIN contacts c ON d.driver_id = c.driver_id WHERE d.driver_id = $1',
      [driver_id]
    );
    
    if (driverResult.rows.length === 0) {
      throw new Error('Driver not found');
    }
    
    const driver = driverResult.rows[0];
    
    // Check for existing entry
    const existingEntry = await pool.query(
      'SELECT * FROM race_entries WHERE driver_id = $1 AND event_id = $2 AND (payment_reference IS NULL OR payment_reference = \'\')',
      [driver_id, event_id]
    );
    
    if (existingEntry.rows.length > 0) {
      return res.json({ success: false, error: 'Driver already has a manual entry for this event' });
    }
    
    // Generate race_entry_id and ticket references (using same format as payment entries)
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const race_entry_id = `race_entry_${timestamp}_${randomSuffix}`;
    
    const hasEngine = entry_items?.some(item => item.toLowerCase().includes('engine'));
    const hasTyres = entry_items?.some(item => item.toLowerCase().includes('tyre'));
    const hasTransponder = entry_items?.some(item => item.toLowerCase().includes('transponder'));
    const hasFuel = entry_items?.some(item => item.toLowerCase().includes('fuel'));
    
    const ticketEngineRef = hasEngine ? generateUniqueTicketRef('engine', driver_id, event_id) : null;
    const ticketTyresRef = hasTyres ? generateUniqueTicketRef('tyres', driver_id, event_id) : null;
    const ticketTransponderRef = hasTransponder ? generateUniqueTicketRef('transponder', driver_id, event_id) : null;
    const ticketFuelRef = hasFuel ? generateUniqueTicketRef('fuel', driver_id, event_id) : null;
    
    // Insert entry
    await pool.query(
      `INSERT INTO race_entries (
        entry_id, event_id, driver_id, 
        race_class, entry_items,
        payment_status, entry_status, amount_paid,
        ticket_engine_ref, ticket_tyres_ref, ticket_transponder_ref, ticket_fuel_ref,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())`,
      [
        race_entry_id,
        event_id,
        driver_id,
        race_class,
        JSON.stringify(entry_items || []),
        payment_status || 'Completed',
        entry_status || 'confirmed',
        amount_paid || 0,
        ticketEngineRef,
        ticketTyresRef,
        ticketTransponderRef,
        ticketFuelRef
      ]
    );
    
    console.log(`✅ Manual entry added: ${race_entry_id} for ${driver.first_name} ${driver.last_name} - ${race_class}`);
    
    // Update engine status if needed
    if (update_engine_status && hasEngine) {
      try {
        await pool.query(
          'UPDATE drivers SET season_engine_rental = $1 WHERE driver_id = $2',
          ['Y', driver_id]
        );
        console.log(`✅ Updated engine status for driver ${driver_id}`);
      } catch (engineErr) {
        console.error('⚠️ Failed to update engine status:', engineErr.message);
      }
    }
    
    // Send emails if requested
    if (send_emails) {
      try {
        const eventResult = await pool.query(
          'SELECT event_name, event_date, location FROM events WHERE event_id = $1',
          [event_id]
        );
        
        const event = eventResult.rows[0] || {};
        const driverName = `${driver.first_name} ${driver.last_name}`.trim();
        
        // Build email with tickets
        const emailResponse = await axios.post(`http://localhost:${process.env.PORT || 3000}/api/sendRaceTicketsEmail`, {
          race_entry_id: race_entry_id
        });
        
        console.log(`✅ Confirmation emails sent for ${driverName}`);
      } catch (emailErr) {
        console.error('⚠️ Failed to send emails (non-critical):', emailErr.message);
      }
    }
    
    // Create Trello card if requested
    if (create_trello_card) {
      try {
        await adminNotificationQueue.addNotification({
          type: 'race_entry_confirmation',
          driver_id: driver_id,
          driver_name: `${driver.first_name} ${driver.last_name}`,
          event_id: event_id,
          race_class: race_class,
          entry_id: race_entry_id
        });
        console.log(`✅ Trello notification queued for ${driver.first_name} ${driver.last_name}`);
      } catch (trelloErr) {
        console.error('⚠️ Failed to queue Trello card (non-critical):', trelloErr.message);
      }
    }
    
    res.json({ 
      success: true, 
      message: 'Entry added successfully',
      entry_id: race_entry_id
    });
    
  } catch (err) {
    console.error('Error adding manual entry:', err);
    res.json({ success: false, error: err.message });
  }
});

// Admin: Send/Resend race entry confirmation email with tickets
app.post('/api/sendRaceTicketsEmail', async (req, res) => {
  try {
    const { race_entry_id } = req.body;

    if (!race_entry_id) {
      throw new Error('Missing race_entry_id');
    }

    // Get entry details with driver and event info
    const entryResult = await pool.query(
      `SELECT 
        re.*,
        d.first_name, d.last_name, c.email as driver_email,
        e.event_name, e.event_date, e.location
       FROM race_entries re
       LEFT JOIN drivers d ON re.driver_id = d.driver_id
       LEFT JOIN contacts c ON re.driver_id = c.driver_id
       LEFT JOIN events e ON re.event_id = e.event_id
       WHERE re.entry_id = $1`,
      [race_entry_id]
    );
    
    if (entryResult.rows.length === 0) {
      throw new Error('Race entry not found');
    }
    
    const entry = entryResult.rows[0];
    const driverName = `${entry.first_name} ${entry.last_name}`.trim();
    const driverEmail = entry.driver_email || entry.email || 'noreply@nats.co.za';
    
    // Parse entry items
    let entryItems = [];
    try {
      entryItems = typeof entry.entry_items === 'string' 
        ? JSON.parse(entry.entry_items) 
        : (Array.isArray(entry.entry_items) ? entry.entry_items : []);
    } catch (e) {
      console.warn('Could not parse entry_items:', e);
    }
    
    // Check both entry_items AND the engine column (for older entries)
    const hasEngineFromItems = entryItems.some(item => item.toLowerCase().includes('engine'));
    const hasEngineFromColumn = entry.engine === 1 || entry.engine === '1' || entry.engine === true;
    const hasEngine = hasEngineFromItems || hasEngineFromColumn;
    
    const hasTyres = entryItems.some(item => item.toLowerCase().includes('tyre'));
    const hasTransponder = entryItems.some(item => item.toLowerCase().includes('transponder'));
    const hasFuel = entryItems.some(item => item.toLowerCase().includes('fuel'));
    
    // Generate ticket references if not present
    if (hasEngine && !entry.ticket_engine_ref) {
      entry.ticket_engine_ref = generateUniqueTicketRef('engine', entry.driver_id, entry.event_id);
      await pool.query('UPDATE race_entries SET ticket_engine_ref = $1 WHERE entry_id = $2', 
        [entry.ticket_engine_ref, race_entry_id]);
    }
    if (hasTyres && !entry.ticket_tyres_ref) {
      entry.ticket_tyres_ref = generateUniqueTicketRef('tyres', entry.driver_id, entry.event_id);
      await pool.query('UPDATE race_entries SET ticket_tyres_ref = $1 WHERE entry_id = $2', 
        [entry.ticket_tyres_ref, race_entry_id]);
    }
    if (hasTransponder && !entry.ticket_transponder_ref) {
      entry.ticket_transponder_ref = generateUniqueTicketRef('transponder', entry.driver_id, entry.event_id);
      await pool.query('UPDATE race_entries SET ticket_transponder_ref = $1 WHERE entry_id = $2', 
        [entry.ticket_transponder_ref, race_entry_id]);
    }
    if (hasFuel && !entry.ticket_fuel_ref) {
      entry.ticket_fuel_ref = generateUniqueTicketRef('fuel', entry.driver_id, entry.event_id);
      await pool.query('UPDATE race_entries SET ticket_fuel_ref = $1 WHERE entry_id = $2', 
        [entry.ticket_fuel_ref, race_entry_id]);
    }
    
    // Build rental tickets HTML using ticket generator functions with barcodes
    let rentalTicketsHtml = '';
    if (hasEngine && entry.ticket_engine_ref) {
      rentalTicketsHtml += generateEngineRentalTicketHTML({
        reference: entry.ticket_engine_ref,
        eventName: entry.event_name,
        eventDate: entry.event_date,
        eventLocation: entry.location,
        raceClass: entry.race_class,
        driverName
      });
    }
    if (hasTyres && entry.ticket_tyres_ref) {
      rentalTicketsHtml += generateTyreRentalTicketHTML({
        reference: entry.ticket_tyres_ref,
        eventName: entry.event_name,
        eventDate: entry.event_date,
        eventLocation: entry.location,
        raceClass: entry.race_class,
        driverName
      });
    }
    if (hasTransponder && entry.ticket_transponder_ref) {
      rentalTicketsHtml += generateTransponderRentalTicketHTML({
        reference: entry.ticket_transponder_ref,
        eventName: entry.event_name,
        eventDate: entry.event_date,
        eventLocation: entry.location,
        raceClass: entry.race_class,
        driverName
      });
    }
    if (hasFuel && entry.ticket_fuel_ref) {
      rentalTicketsHtml += generateFuelTicketHTML({
        reference: entry.ticket_fuel_ref,
        eventName: entry.event_name,
        eventDate: entry.event_date,
        eventLocation: entry.location,
        raceClass: entry.race_class,
        driverName
      });
    }
    
    // Format event details
    const eventName = entry.event_name || 'Race Event';
    const eventDateStr = entry.event_date 
      ? new Date(entry.event_date).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
      : 'TBA';
    const eventLocation = entry.location || 'TBA';
    
    // Email HTML
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Race Entry Confirmation — NATS 2026 ROK Cup</title>
        <style>
          body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #333; background: #f5f5f5; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
          .header { background: white; padding: 20px; text-align: center; border-bottom: 3px solid #22c55e; }
          .header-logo { margin-bottom: 16px; }
          .header-logo img { width: 140px; height: auto; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 700; color: #111827; }
          .content { padding: 30px; }
          .details { background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #22c55e; }
          .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
          .detail-row:last-child { border-bottom: none; }
          .detail-label { font-weight: 600; color: #6b7280; font-size: 13px; }
          .detail-value { color: #111827; font-weight: 500; }
          .amount { font-size: 22px; font-weight: 700; color: #22c55e; }
          .footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px; text-align: center; color: #6b7280; font-size: 12px; }
        </style>
      </head>
      <body style="margin: 0; padding: 20px;">
        <div class="container">
          <div class="header">
            <div class="header-logo">
              <img src="https://www.dropbox.com/scl/fi/ryhszrvk76kd7yy6y0rtc/ROK-CUP-LOGO-2025.png?rlkey=k9dxlzbh5e9zw58v8t34yjzea&dl=1" alt="ROK Cup South Africa" />
            </div>
            <h1>Race Entry Confirmed</h1>
          </div>
          <div class="content">
            <p style="margin: 0 0 16px 0; font-size: 15px;">Hi ${driverName},</p>
            <p style="margin: 0 0 20px 0; font-size: 15px; color: #374151;">Your race entry has been confirmed. Below are your event details and rental item tickets.</p>
            
            <div class="details">
              <div class="detail-row">
                <span class="detail-label">Entry ID</span>
                <span class="detail-value">${race_entry_id}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Event Name</span>
                <span class="detail-value">${eventName}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Event Date</span>
                <span class="detail-value">${eventDateStr}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Location</span>
                <span class="detail-value">${eventLocation}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Race Class</span>
                <span class="detail-value">${entry.race_class}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Payment Status</span>
                <span class="detail-value">${entry.payment_status}</span>
              </div>
            </div>
            
            ${generateRaceTicketHTML({
              reference: entry.payment_reference || race_entry_id,
              eventName,
              eventDate: entry.event_date,
              eventLocation,
              raceClass: entry.race_class,
              driverName,
              teamCode: null
            })}
            
            ${rentalTicketsHtml}
            
            <p style="margin: 20px 0; font-size: 14px; color: #374151;">See you at the track! If you have any questions, please contact us.</p>
            
            <p style="margin: 20px 0 0 0; font-size: 14px;">Best regards,<br><strong style="color: #22c55e;">NATS 2026 ROK Cup Team</strong></p>
          </div>
          <div class="footer">
            <p style="margin: 0; color: #6b7280;">This is an automated confirmation email. Please do not reply to this message.</p>
            <p style="margin: 8px 0 0 0;"><a href="https://rokthenats.co.za/" style="color: #2563eb; text-decoration: none; font-weight: 600;">Visit the NATS Event Hub</a></p>
          </div>
        </div>
      </body>
      </html>
    `;

    // Send email
    await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
      key: process.env.MAILCHIMP_API_KEY,
      message: {
        to: [{ email: driverEmail, name: driverName }],
        bcc_address: 'africankartingcup@gmail.com',
        from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
        from_name: 'The ROK Cup',
        subject: `Race Entry Confirmation - ${eventName} (${entry.race_class})`,
        html: emailHtml
      }
    });
    
    console.log(`📧 Race tickets email sent to: ${driverEmail} for entry ${race_entry_id}`);
    
    res.json({ 
      success: true, 
      message: `Tickets email sent to ${driverEmail}`
    });
    
  } catch (err) {
    console.error('Error sending tickets email:', err);
    res.json({ success: false, error: err.message });
  }
});

// Admin: Update entry items and resend tickets (for fixing old entries)
app.post('/api/updateAndResendTickets', async (req, res) => {
  try {
    const { race_entry_id, entry_items, amount_paid } = req.body;

    if (!race_entry_id || !entry_items) {
      throw new Error('Missing race_entry_id or entry_items');
    }

    // Get entry details
    const entryResult = await pool.query(
      `SELECT 
        re.*,
        d.first_name, d.last_name, c.email as driver_email,
        e.event_name, e.event_date, e.location
       FROM race_entries re
       LEFT JOIN drivers d ON re.driver_id = d.driver_id
       LEFT JOIN contacts c ON re.driver_id = c.driver_id
       LEFT JOIN events e ON re.event_id = e.event_id
       WHERE re.entry_id = $1`,
      [race_entry_id]
    );
    
    if (entryResult.rows.length === 0) {
      throw new Error('Race entry not found');
    }
    
    const entry = entryResult.rows[0];
    const driverName = `${entry.first_name} ${entry.last_name}`.trim();
    const driverEmail = entry.driver_email || entry.email || 'noreply@nats.co.za';
    
    // Determine what items are selected
    const hasEngine = entry_items.some(item => item.toLowerCase().includes('engine'));
    const hasTyres = entry_items.some(item => item.toLowerCase().includes('tyre'));
    const hasTransponder = entry_items.some(item => item.toLowerCase().includes('transponder'));
    const hasFuel = entry_items.some(item => item.toLowerCase().includes('fuel'));
    
    // Generate ticket references for missing items
    let ticketEngineRef = entry.ticket_engine_ref;
    let ticketTyresRef = entry.ticket_tyres_ref;
    let ticketTransponderRef = entry.ticket_transponder_ref;
    let ticketFuelRef = entry.ticket_fuel_ref;
    
    if (hasEngine && !ticketEngineRef) {
      ticketEngineRef = generateUniqueTicketRef('engine', entry.driver_id, entry.event_id);
    }
    if (hasTyres && !ticketTyresRef) {
      ticketTyresRef = generateUniqueTicketRef('tyres', entry.driver_id, entry.event_id);
    }
    if (hasTransponder && !ticketTransponderRef) {
      ticketTransponderRef = generateUniqueTicketRef('transponder', entry.driver_id, entry.event_id);
    }
    if (hasFuel && !ticketFuelRef) {
      ticketFuelRef = generateUniqueTicketRef('fuel', entry.driver_id, entry.event_id);
    }
    
    // Update database with new entry_items, amount, and ticket refs
    await pool.query(
      `UPDATE race_entries 
       SET entry_items = $1,
           amount_paid = $2,
           ticket_engine_ref = $3,
           ticket_tyres_ref = $4,
           ticket_transponder_ref = $5,
           ticket_fuel_ref = $6,
           updated_at = NOW()
       WHERE entry_id = $7`,
      [JSON.stringify(entry_items), amount_paid || entry.amount_paid, 
       ticketEngineRef, ticketTyresRef, ticketTransponderRef, ticketFuelRef, race_entry_id]
    );
    
    console.log(`✅ Updated entry ${race_entry_id} with items:`, entry_items);
    console.log(`   Ticket refs - Engine: ${ticketEngineRef}, Tyres: ${ticketTyresRef}, Transponder: ${ticketTransponderRef}, Fuel: ${ticketFuelRef}`);
    
    // Build rental tickets HTML
    let rentalTicketsHtml = '';
    if (hasEngine && ticketEngineRef) {
      rentalTicketsHtml += generateEngineRentalTicketHTML({
        reference: ticketEngineRef,
        eventName: entry.event_name,
        eventDate: entry.event_date,
        eventLocation: entry.location,
        raceClass: entry.race_class,
        driverName
      });
    }
    if (hasTyres && ticketTyresRef) {
      rentalTicketsHtml += generateTyreRentalTicketHTML({
        reference: ticketTyresRef,
        eventName: entry.event_name,
        eventDate: entry.event_date,
        eventLocation: entry.location,
        raceClass: entry.race_class,
        driverName
      });
    }
    if (hasTransponder && ticketTransponderRef) {
      rentalTicketsHtml += generateTransponderRentalTicketHTML({
        reference: ticketTransponderRef,
        eventName: entry.event_name,
        eventDate: entry.event_date,
        eventLocation: entry.location,
        raceClass: entry.race_class,
        driverName
      });
    }
    if (hasFuel && ticketFuelRef) {
      rentalTicketsHtml += generateFuelTicketHTML({
        reference: ticketFuelRef,
        eventName: entry.event_name,
        eventDate: entry.event_date,
        eventLocation: entry.location,
        raceClass: entry.race_class,
        driverName
      });
    }
    
    // Format event details
    const eventName = entry.event_name || 'Race Event';
    const eventDateStr = entry.event_date 
      ? new Date(entry.event_date).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
      : 'TBA';
    const eventLocation = entry.location || 'TBA';
    
    // Send updated email with all tickets
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Updated Race Entry - NATS 2026 ROK Cup</title>
        <style>
          body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #333; background: #f5f5f5; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.07); }
          .header { background: white; padding: 20px; text-align: center; border-bottom: 3px solid #22c55e; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 700; color: #111827; }
          .content { padding: 30px; }
          .details { background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #22c55e; }
          .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
          .detail-row:last-child { border-bottom: none; }
          .footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px; text-align: center; color: #6b7280; font-size: 12px; }
        </style>
      </head>
      <body style="margin: 0; padding: 20px;">
        <div class="container">
          <div class="header">
            <h1>✅ Updated Race Entry</h1>
          </div>
          <div class="content">
            <p>Hi ${driverName},</p>
            <p>Your race entry has been updated with the following details and tickets:</p>
            
            <div class="details">
              <div class="detail-row">
                <span>Entry ID</span>
                <span>${race_entry_id}</span>
              </div>
              <div class="detail-row">
                <span>Event</span>
                <span>${eventName}</span>
              </div>
              <div class="detail-row">
                <span>Date</span>
                <span>${eventDateStr}</span>
              </div>
              <div class="detail-row">
                <span>Location</span>
                <span>${eventLocation}</span>
              </div>
              <div class="detail-row">
                <span>Class</span>
                <span>${entry.race_class}</span>
              </div>
            </div>
            
            ${rentalTicketsHtml}
            
            <p style="margin-top: 20px; color: #6b7280; font-size: 14px;">See you at the track!</p>
          </div>
          <div class="footer">
            <p style="margin: 0;">NATS 2026 ROK Cup - www.rokthenats.co.za</p>
          </div>
        </div>
      </body>
      </html>
    `;
    
    await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
      key: process.env.MAILCHIMP_API_KEY,
      message: {
        to: [{ email: driverEmail, name: driverName }],
        bcc_address: 'africankartingcup@gmail.com',
        from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@nats.co.za',
        from_name: 'The ROK Cup',
        subject: `Updated Race Entry - ${eventName} (${entry.race_class})`,
        html: emailHtml
      }
    });
    
    console.log(`📧 Updated entry email sent to: ${driverEmail}`);
    
    res.json({ 
      success: true, 
      message: `Entry updated and tickets sent to ${driverEmail}`
    });
    
  } catch (err) {
    console.error('Error updating and resending tickets:', err);
    res.json({ success: false, error: err.message });
  }
});

// Save pool engine rental after payment
app.post('/api/savePoolEngineRental', async (req, res) => {
  try {
    const { driverId, rentalClass, rentalType, amountPaid, paymentReference } = req.body;

    if (!driverId || !rentalClass || !rentalType || !amountPaid) {
      throw new Error('Missing required fields');
    }

    const rentalId = `pool_rental_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const currentYear = new Date().getFullYear();

    await pool.query(
      `INSERT INTO pool_engine_rentals (rental_id, driver_id, championship_class, rental_type, amount_paid, payment_status, payment_reference, season_year, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [rentalId, driverId, rentalClass, rentalType, amountPaid, 'Completed', paymentReference || '', currentYear]
    );

    // Update driver's season_engine_rental flag
    await pool.query(
      `UPDATE drivers SET season_engine_rental = 'Y' WHERE driver_id = $1`,
      [driverId]
    );

    console.log(`✅ Pool engine rental saved: ${rentalId} - ${rentalType} for ${rentalClass}`);
    
    // Send admin notification for engine rental payment
    try {
      const driverInfo = await pool.query('SELECT first_name, last_name FROM drivers WHERE driver_id = $1', [driverId]);
      const driver = driverInfo.rows[0] || {};
      adminNotificationQueue.addNotification({
        action: 'Pool Engine Rental',
        subject: `[Rental] ${driver.first_name} ${driver.last_name} - ${rentalType} (R${parseFloat(amountPaid).toFixed(2)})`,
        details: {
          driverId: driverId,
          driverName: `${driver.first_name} ${driver.last_name}`,
          rentalType: rentalType,
          amount: `R${parseFloat(amountPaid).toFixed(2)}`,
          class: rentalClass,
          season: currentYear,
          paymentReference: paymentReference || 'N/A',
          timestamp: new Date().toLocaleString()
        }
      });
    } catch (e) { /* Silent fail */ }

    res.json({ success: true, data: { rentalId } });
  } catch (err) {
    console.error('❌ savePoolEngineRental error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get driver's pool engine rentals
app.get('/api/getPoolEngineRentals/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;

    if (!driverId) {
      throw new Error('Driver ID required');
    }

    const result = await pool.query(
      `SELECT * FROM pool_engine_rentals WHERE driver_id = $1 ORDER BY created_at DESC`,
      [driverId]
    );

    console.log(`✅ Retrieved ${result.rows.length} pool engine rentals for driver ${driverId}`);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('❌ getPoolEngineRentals error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// =========================================================
// ADMIN: Get ALL pool engine rentals (for admin dashboard)
// =========================================================
app.get('/api/admin/getAllPoolEngineRentals', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        per.*,
        d.first_name,
        d.last_name,
        c.email,
        c.phone
      FROM pool_engine_rentals per
      LEFT JOIN drivers d ON per.driver_id = d.driver_id
      LEFT JOIN contacts c ON per.driver_id = c.driver_id
      ORDER BY per.created_at DESC
    `);

    console.log(`✅ Admin: Retrieved ${result.rows.length} total pool engine rentals`);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('❌ getAllPoolEngineRentals error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get driver's race entries
// Get available events for race entry selection
app.get('/api/getAvailableEvents', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT event_id, event_name, event_date, location, registration_deadline, entry_fee, registration_open
       FROM events
       WHERE registration_deadline >= CURRENT_DATE
       ORDER BY event_date ASC`
    );

    console.log(`✅ Retrieved ${result.rows.length} available events`);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('❌ getAvailableEvents error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get driver's race entries with event details
app.get('/api/getDriverEntries/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    if (!driverId) {
      throw new Error('Driver ID required');
    }

    const result = await pool.query(
      `SELECT r.entry_id, r.event_id, e.event_name, e.event_date, e.location,
              r.payment_status, r.entry_status, r.amount_paid, r.payment_reference,
              r.race_class, r.race_number, r.notes, r.created_at
       FROM race_entries r
       JOIN events e ON r.event_id = e.event_id
       WHERE r.driver_id = $1
       ORDER BY e.event_date DESC`,
      [driverId]
    );

    console.log(`✅ Retrieved ${result.rows.length} race entries for driver ${driverId}`);
    res.json({ success: true, entries: result.rows });
  } catch (err) {
    console.error('❌ getDriverEntries error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Alias for driver events (same as getDriverEntries)
app.get('/api/driver-events/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    if (!driverId) {
      throw new Error('Driver ID required');
    }

    const result = await pool.query(
      `SELECT r.entry_id, r.event_id, e.event_name, e.event_date, e.location,
              r.payment_status, r.entry_status, r.amount_paid, r.payment_reference,
              r.race_class, r.race_number, r.notes, r.created_at
       FROM race_entries r
       JOIN events e ON r.event_id = e.event_id
       WHERE r.driver_id = $1
       ORDER BY e.event_date DESC`,
      [driverId]
    );

    console.log(`✅ Retrieved ${result.rows.length} race entries for driver ${driverId}`);
    res.json({ success: true, events: result.rows });
  } catch (err) {
    console.error('❌ driver-events error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============= DRIVER POINTS & RESULTS ENDPOINTS =============

// Get driver's points history and standings
app.get('/api/driver-points/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    if (!driverId) {
      throw new Error('Driver ID required');
    }

    // Get driver's points records
    const pointsResult = await pool.query(
      `SELECT points_id, season, event, round, class,
              qualifying_points, heat1_points, heat2_points, final_points,
              penalties_points, total_points, position, notes, created_at
       FROM points
       WHERE driver_id = $1
       ORDER BY created_at DESC`,
      [driverId]
    );

    // Calculate season totals by class
    const seasonTotals = await pool.query(
      `SELECT season, class, 
              SUM(total_points) as total_points,
              COUNT(*) as races_completed
       FROM points
       WHERE driver_id = $1
       GROUP BY season, class
       ORDER BY season DESC, class`,
      [driverId]
    );

    // Get driver info for display
    const driverInfo = await pool.query(
      `SELECT first_name, last_name, race_number, class, championship
       FROM drivers
       WHERE driver_id = $1`,
      [driverId]
    );

    console.log(`✅ Retrieved ${pointsResult.rows.length} points records for driver ${driverId}`);
    
    res.json({ 
      success: true, 
      points: pointsResult.rows,
      seasonTotals: seasonTotals.rows,
      driver: driverInfo.rows[0] || {}
    });
  } catch (err) {
    console.error('❌ driver-points error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get championship standings for a specific class/season
app.get('/api/championship-standings/:season/:class', async (req, res) => {
  try {
    const { season, class: raceClass } = req.params;
    
    if (!season || !raceClass) {
      throw new Error('Season and class required');
    }

    // Get standings with driver info
    const result = await pool.query(
      `SELECT d.driver_id, d.first_name, d.last_name, d.race_number, d.team_name,
              SUM(p.total_points) as total_points,
              COUNT(p.points_id) as races_completed,
              MAX(p.position) as best_position
       FROM points p
       JOIN drivers d ON p.driver_id = d.driver_id
       WHERE p.season = $1 AND p.class = $2
       GROUP BY d.driver_id, d.first_name, d.last_name, d.race_number, d.team_name
       ORDER BY total_points DESC, races_completed DESC`,
      [season, raceClass]
    );

    console.log(`✅ Retrieved championship standings: ${season} ${raceClass} - ${result.rows.length} drivers`);
    
    res.json({ 
      success: true, 
      standings: result.rows,
      season,
      class: raceClass
    });
  } catch (err) {
    console.error('❌ championship-standings error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get driver's race results with lap times
app.get('/api/driver-results/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    if (!driverId) {
      throw new Error('Driver ID required');
    }

    // Get race results with event info
    const results = await pool.query(
      `SELECT rr.result_id, rr.event_id, e.event_name, e.event_date,
              rr.session_type, rr.position, rr.best_lap_time, rr.average_lap_time,
              rr.total_laps, rr.gap_to_leader, rr.gap_to_ahead, rr.fastest_lap,
              rr.dnf, rr.dns, rr.dsq, rr.notes
       FROM race_results rr
       JOIN events e ON rr.event_id = e.event_id
       WHERE rr.driver_id = $1
       ORDER BY e.event_date DESC, 
                CASE rr.session_type 
                  WHEN 'qualifying' THEN 1
                  WHEN 'heat1' THEN 2
                  WHEN 'heat2' THEN 3
                  WHEN 'final' THEN 4
                  ELSE 5
                END`,
      [driverId]
    );

    // Get statistics
    const stats = await pool.query(
      `SELECT 
        COUNT(DISTINCT event_id) as events_participated,
        COUNT(CASE WHEN position = 1 THEN 1 END) as wins,
        COUNT(CASE WHEN position <= 3 THEN 1 END) as podiums,
        COUNT(CASE WHEN fastest_lap = true THEN 1 END) as fastest_laps,
        MIN(best_lap_time) as personal_best_lap
       FROM race_results
       WHERE driver_id = $1`,
      [driverId]
    );

    console.log(`✅ Retrieved ${results.rows.length} race results for driver ${driverId}`);
    
    res.json({ 
      success: true, 
      results: results.rows,
      stats: stats.rows[0] || {}
    });
  } catch (err) {
    console.error('❌ driver-results error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============= DRIVER NOTIFICATIONS ENDPOINTS =============

// Get driver's notifications
app.get('/api/notifications/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    const { limit = 50 } = req.query;
    
    if (!driverId) {
      throw new Error('Driver ID required');
    }

    const result = await pool.query(
      `SELECT id, driver_id, event_id, event_name, title, body, url, notification_type, sent_at, created_at
       FROM notification_history
       WHERE driver_id = $1 OR driver_id IS NULL
       ORDER BY sent_at DESC
       LIMIT $2`,
      [driverId, parseInt(limit)]
    );

    console.log(`✅ Retrieved ${result.rows.length} notifications for driver ${driverId}`);
    
    res.json({ 
      success: true, 
      notifications: result.rows
    });
  } catch (err) {
    console.error('❌ notifications error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Mark notification as read (future feature - needs read_status column)
app.post('/api/notifications/:notificationId/read', async (req, res) => {
  try {
    const { notificationId } = req.params;
    
    // For now, just return success - will need to add read_status column later
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) {
    console.error('❌ mark-notification-read error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Send notification (admin use)
app.post('/api/notifications/send', async (req, res) => {
  try {
    const { driverId, eventId, eventName, title, body, url, notificationType } = req.body;
    
    if (!title) {
      throw new Error('Title required');
    }

    const result = await pool.query(
      `INSERT INTO notification_history (driver_id, event_id, event_name, title, body, url, notification_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [driverId || null, eventId || null, eventName || null, title, body || null, url || null, notificationType || 'general']
    );

    console.log(`✅ Notification sent: ${title} to ${driverId || 'all drivers'}`);
    
    res.json({ 
      success: true, 
      notification: result.rows[0]
    });
  } catch (err) {
    console.error('❌ send-notification error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============= DRIVER PROFILE MANAGEMENT ENDPOINTS =============

// Upload driver profile photo
app.post('/api/driver-photo-upload', upload.single('photo'), async (req, res) => {
  try {
    const { driverId } = req.body;
    
    if (!driverId) {
      throw new Error('Driver ID required');
    }
    
    if (!req.file) {
      throw new Error('No photo uploaded');
    }
    
    // Update driver profile with photo path
    const photoPath = `/uploads/${req.file.filename}`;
    
    await pool.query(
      `UPDATE drivers SET profile_photo = $1, updated_at = CURRENT_TIMESTAMP WHERE driver_id = $2`,
      [photoPath, driverId]
    );
    
    console.log(`✅ Profile photo uploaded for driver ${driverId}: ${photoPath}`);
    
    res.json({ 
      success: true, 
      photoPath: photoPath,
      message: 'Photo uploaded successfully'
    });
  } catch (err) {
    console.error('❌ driver-photo-upload error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Medical consent - Update
app.put('/api/medical-consent', async (req, res) => {
  try {
    const {
      driver_id,
      allergies,
      medical_conditions,
      medication,
      consent_signed,
      consent_date
    } = req.body;

    if (!driver_id) {
      return res.status(400).json({ success: false, error: { message: 'Driver ID is required' } });
    }

    // Check if medical record exists
    const checkResult = await pool.query(
      'SELECT driver_id FROM medical_consent WHERE driver_id = $1',
      [driver_id]
    );

    let result;
    if (checkResult.rows.length > 0) {
      // Update existing record (only editable fields)
      result = await pool.query(
        `UPDATE medical_consent 
         SET allergies = $1, 
             medical_conditions = $2, 
             medication = $3, 
             consent_signed = $4, 
             consent_date = $5
         WHERE driver_id = $6
         RETURNING *`,
        [
          allergies || null,
          medical_conditions || null,
          medication || null,
          consent_signed || null,
          consent_date || null,
          driver_id
        ]
      );
    } else {
      // Insert new record (only editable fields - indemnity and media release stay as NULL)
      result = await pool.query(
        `INSERT INTO medical_consent 
         (driver_id, allergies, medical_conditions, medication, consent_signed, consent_date)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          driver_id,
          allergies || null,
          medical_conditions || null,
          medication || null,
          consent_signed || null,
          consent_date || null
        ]
      );
    }

    console.log(`✅ Medical consent updated for driver ${driver_id}`);
    
    // Send admin notification for medical updates
    try {
      const driverInfo = await pool.query('SELECT first_name, last_name, email FROM drivers d LEFT JOIN contacts c ON d.driver_id = c.driver_id WHERE d.driver_id = $1 LIMIT 1', [driver_id]);
      const driver = driverInfo.rows[0] || {};
      adminNotificationQueue.addNotification({
        action: 'Medical & Consent Update',
        subject: `[Medical] ${driver.first_name} ${driver.last_name} updated medical information`,
        details: {
          driverId: driver_id,
          driverName: `${driver.first_name} ${driver.last_name}`,
          email: driver.email,
          allergies: allergies ? 'Updated' : 'Not provided',
          medicalConditions: medical_conditions ? 'Updated' : 'Not provided',
          medication: medication ? 'Updated' : 'Not provided',
          consentSigned: consent_signed,
          timestamp: new Date().toLocaleString()
        }
      });
    } catch (e) { /* Silent fail on notification */ }
    
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('❌ Error updating medical consent:', error);
    res.status(500).json({ success: false, error: { message: error.message } });
  }
});

// Get driver's emergency contacts
app.get('/api/emergency-contacts/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    if (!driverId) {
      throw new Error('Driver ID required');
    }

    const result = await pool.query(
      `SELECT contact_id, full_name, email, phone_mobile, phone_work, relationship
       FROM contacts
       WHERE driver_id = $1 AND emergency_contact = 'Y'
       ORDER BY relationship`,
      [driverId]
    );

    console.log(`✅ Retrieved ${result.rows.length} emergency contacts for driver ${driverId}`);
    
    res.json({ 
      success: true, 
      contacts: result.rows
    });
  } catch (err) {
    console.error('❌ emergency-contacts error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Update emergency contact
app.put('/api/emergency-contacts/:contactId', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { fullName, email, phoneMobile, phoneWork } = req.body;
    
    if (!contactId) {
      throw new Error('Contact ID required');
    }

    const result = await pool.query(
      `UPDATE contacts 
       SET full_name = $1, email = $2, phone_mobile = $3, phone_work = $4, updated_at = CURRENT_TIMESTAMP
       WHERE contact_id = $5
       RETURNING *`,
      [fullName, email, phoneMobile, phoneWork, contactId]
    );

    if (result.rows.length === 0) {
      throw new Error('Contact not found');
    }

    console.log(`✅ Updated emergency contact ${contactId}`);
    
    res.json({ 
      success: true, 
      contact: result.rows[0]
    });
  } catch (err) {
    console.error('❌ update-emergency-contact error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============= ADMIN EVENT MANAGEMENT ENDPOINTS =============

// Get all events with registration counts
app.get('/api/getAllEvents', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.event_id, e.event_name, e.event_date, e.start_date, e.end_date, e.location, e.entry_fee, 
              e.registration_deadline, e.registration_open, e.created_at,
              COUNT(r.entry_id) AS registration_count
       FROM events e
       LEFT JOIN race_entries r ON e.event_id = r.event_id
       GROUP BY e.event_id
       ORDER BY e.event_date DESC`
    );

    console.log(`✅ Retrieved ${result.rows.length} events with registration counts`);
    res.json({ success: true, events: result.rows });
  } catch (err) {
    console.error('❌ getAllEvents error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get single event details
app.get('/api/getEvent/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;

    const result = await pool.query(
      `SELECT * FROM events WHERE event_id = $1`,
      [eventId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    res.json({ success: true, event: result.rows[0] });
  } catch (err) {
    console.error('❌ getEvent error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Create new event
app.post('/api/createEvent', async (req, res) => {
  try {
    const { event_name, event_date, start_date, end_date, location, entry_fee, registration_deadline, registration_open } = req.body;

    if (!event_name || !location || !entry_fee || !registration_deadline) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    // Use start_date as event_date if provided, otherwise use event_date for backwards compatibility
    const mainEventDate = start_date || event_date;
    
    if (!mainEventDate) {
      return res.status(400).json({ success: false, message: 'Event start date is required' });
    }

    const event_id = `event_${Date.now()}`;
    
    // Default registration_open to false if not provided
    const regOpen = registration_open === true || registration_open === 'true' ? true : false;

    const result = await pool.query(
      `INSERT INTO events (event_id, event_name, event_date, start_date, end_date, location, entry_fee, registration_deadline, registration_open)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [event_id, event_name, mainEventDate, start_date, end_date, location, entry_fee, registration_deadline, regOpen]
    );

    console.log(`✅ Event created: ${event_name} (${start_date && end_date ? `${start_date} to ${end_date}` : mainEventDate})`);
    res.json({ success: true, event: result.rows[0] });
  } catch (err) {
    console.error('❌ createEvent error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Update event
app.put('/api/updateEvent/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { event_name, event_date, start_date, end_date, location, entry_fee, registration_deadline, registration_open } = req.body;
    
    // Use start_date as event_date if provided, otherwise use event_date for backwards compatibility
    const mainEventDate = start_date || event_date;
    
    // Convert registration_open to boolean
    const regOpen = registration_open === true || registration_open === 'true' ? true : false;

    const result = await pool.query(
      `UPDATE events 
       SET event_name = $1, event_date = $2, start_date = $3, end_date = $4, location = $5, entry_fee = $6, registration_deadline = $7, registration_open = $8, updated_at = NOW()
       WHERE event_id = $9
       RETURNING *`,
      [event_name, mainEventDate, start_date, end_date, location, entry_fee, registration_deadline, regOpen, eventId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    console.log(`✅ Event updated: ${event_name}`);
    res.json({ success: true, event: result.rows[0] });
  } catch (err) {
    console.error('❌ updateEvent error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Delete event
app.delete('/api/deleteEvent/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;

    // Check if event has registrations
    const checkResult = await pool.query(
      `SELECT COUNT(*) as count FROM race_entries WHERE event_id = $1`,
      [eventId]
    );

    if (checkResult.rows[0].count > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete event with ${checkResult.rows[0].count} registrations` 
      });
    }

    const result = await pool.query(
      `DELETE FROM events WHERE event_id = $1 RETURNING *`,
      [eventId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    console.log(`✅ Event deleted: ${eventId}`);
    res.json({ success: true, message: 'Event deleted successfully' });
  } catch (err) {
    console.error('❌ deleteEvent error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get event registrations with driver details
app.get('/api/getEventRegistrations/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;

    const eventResult = await pool.query(
      `SELECT * FROM events WHERE event_id = $1`,
      [eventId]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    const registrationsResult = await pool.query(
      `SELECT r.entry_id, r.event_id, r.driver_id, r.payment_status, r.entry_status, 
              r.amount_paid, r.created_at,
              d.first_name AS driver_first_name, d.last_name AS driver_last_name, 
              c.email AS driver_email, d.class AS driver_class
       FROM race_entries r
       JOIN drivers d ON r.driver_id = d.driver_id
       LEFT JOIN contacts c ON d.driver_id = c.driver_id AND c.email IS NOT NULL
       WHERE r.event_id = $1
       ORDER BY r.created_at DESC`,
      [eventId]
    );

    console.log(`✅ Retrieved ${registrationsResult.rows.length} registrations for event ${eventId}`);
    res.json({ 
      success: true, 
      event: eventResult.rows[0],
      registrations: registrationsResult.rows 
    });
  } catch (err) {
    console.error('❌ getEventRegistrations error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============= END ADMIN EVENT ENDPOINTS =============


app.post('/api/getDriverRaceEntries', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      throw new Error('Email required');
    }

    const result = await pool.query(
      `SELECT race_id, race_class, payment_status, total_amount, entry_items, entry_date
       FROM race_entries 
       WHERE driver_email = $1
       ORDER BY entry_date DESC`,
      [email.toLowerCase()]
    );

    console.log(`✅ Retrieved ${result.rows.length} race entries for ${email}`);
    res.json({ success: true, entries: result.rows });
  } catch (err) {
    console.error('❌ getDriverRaceEntries error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get Race Entries
app.post('/api/getRaceEntries', async (req, res) => {
  try {
    const { eventId } = req.body;

    // If no eventId provided, return ALL entries (for payment status dashboard)
    let result;
    if (!eventId) {
      result = await pool.query(
        `SELECT 
          r.*,
          r.ticket_engine_ref,
          r.ticket_tyres_ref,
          r.ticket_transponder_ref,
          r.ticket_fuel_ref,
          d.first_name AS driver_first_name,
          d.last_name AS driver_last_name,
          d.race_number,
          d.transponder_number,
          c.email AS driver_email,
          c.phone_mobile AS entrant_phone,
          c.phone_alt AS entrant_cell,
          c.full_name AS entrant_name,
          c.relationship AS entrant_relationship,
          e.event_name
         FROM race_entries r
         LEFT JOIN drivers d ON r.driver_id = d.driver_id
         LEFT JOIN contacts c ON r.driver_id = c.driver_id
         LEFT JOIN events e ON r.event_id = e.event_id
         ORDER BY r.created_at DESC`
      );
    } else {
      result = await pool.query(
        `SELECT 
          r.*,
          r.ticket_engine_ref,
          r.ticket_tyres_ref,
          r.ticket_transponder_ref,
          r.ticket_fuel_ref,
          d.first_name AS driver_first_name,
          d.last_name AS driver_last_name,
          d.race_number,
          d.transponder_number,
          c.email AS driver_email,
          c.phone_mobile AS entrant_phone,
          c.phone_alt AS entrant_cell,
          c.full_name AS entrant_name,
          c.relationship AS entrant_relationship
         FROM race_entries r
         LEFT JOIN drivers d ON r.driver_id = d.driver_id
         LEFT JOIN contacts c ON r.driver_id = c.driver_id
         WHERE r.event_id = $1
         ORDER BY r.created_at DESC`,
        [eventId]
      );
    }

    console.log(`📊 getRaceEntries query result - Found ${result.rows.length} entries`);
    if (result.rows.length > 0) {
      console.log('🔍 First entry columns:', Object.keys(result.rows[0]));
      console.log('🔍 First entry data:', JSON.stringify(result.rows[0], null, 2));
    }

    res.json({
      success: true,
      data: { entries: result.rows }
    });
  } catch (err) {
    console.error('❌ getRaceEntries error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get all race entries (without event filter)
app.get('/api/allRaceEntries', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        r.*,
        r.ticket_engine_ref,
        r.ticket_tyres_ref,
        r.ticket_transponder_ref,
        r.ticket_fuel_ref,
        d.first_name AS driver_first_name,
        d.last_name AS driver_last_name,
        d.race_number,
        d.transponder_number,
        c.email AS driver_email,
        c.phone_mobile AS entrant_phone,
        c.phone_alt AS entrant_cell,
        c.full_name AS entrant_name,
        c.relationship AS entrant_relationship,
        e.event_name
       FROM race_entries r
       LEFT JOIN drivers d ON r.driver_id = d.driver_id
       LEFT JOIN contacts c ON r.driver_id = c.driver_id
       LEFT JOIN events e ON r.event_id = e.event_id
       ORDER BY r.created_at DESC`
    );

    console.log(`📊 allRaceEntries query result - Found ${result.rows.length} entries`);
    
    res.json(result.rows);
  } catch (err) {
    console.error('❌ allRaceEntries error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Confirm Race Entry (Admin)
// Update Race Entry (Admin - Inline Editing)
app.post('/api/updateRaceEntry', async (req, res) => {
  try {
    const { race_entry_id, entry_id, field, value, race_class, race_number, entry_status, payment_status, amount_paid, performed_by } = req.body;

    // Accept either entry_id or race_entry_id
    const entryId = entry_id || race_entry_id;
    
    if (!entryId) {
      throw new Error('Entry ID is required');
    }

    // Check if this is a multi-field update (from Titan Command) or single field update
    const isMultiFieldUpdate = race_class !== undefined || race_number !== undefined || 
                                entry_status !== undefined || payment_status !== undefined || 
                                amount_paid !== undefined;

    if (isMultiFieldUpdate) {
      // Multi-field update from Titan Command
      const updates = [];
      const values = [];
      let paramCount = 1;

      if (race_class !== undefined) {
        updates.push(`race_class = $${paramCount++}`);
        values.push(race_class);
      }
      if (race_number !== undefined) {
        updates.push(`race_number = $${paramCount++}`);
        values.push(race_number);
      }
      if (entry_status !== undefined) {
        updates.push(`entry_status = $${paramCount++}`);
        values.push(entry_status);
      }
      if (payment_status !== undefined) {
        updates.push(`payment_status = $${paramCount++}`);
        values.push(payment_status);
      }
      if (amount_paid !== undefined) {
        updates.push(`amount_paid = $${paramCount++}`);
        values.push(parseFloat(amount_paid));
      }

      if (updates.length === 0) {
        throw new Error('No fields to update');
      }

      updates.push(`updated_at = NOW()`);
      values.push(entryId);

      // Get old values for audit
      const oldResult = await pool.query(
        `SELECT * FROM race_entries WHERE entry_id = $1`,
        [entryId]
      );

      if (oldResult.rows.length === 0) {
        throw new Error('Race entry not found');
      }

      const oldEntry = oldResult.rows[0];

      // Update the entry
      const updateQuery = `UPDATE race_entries SET ${updates.join(', ')} WHERE entry_id = $${paramCount} RETURNING *`;
      const result = await pool.query(updateQuery, values);

      // Log changes to audit
      const loggedBy = performed_by || 'TITAN';
      const action = loggedBy === 'TITAN' ? 'TITAN_EDIT' : 'RACE_ENTRY_UPDATED';
      
      if (race_class !== undefined && oldEntry.race_class !== race_class) {
        await pool.query(
          `INSERT INTO audit_log (driver_id, driver_email, action, field_name, old_value, new_value, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [oldEntry.driver_id, oldEntry.driver_email || loggedBy, action, 'race_class', String(oldEntry.race_class || ''), String(race_class)]
        );
      }
      if (race_number !== undefined && oldEntry.race_number !== race_number) {
        await pool.query(
          `INSERT INTO audit_log (driver_id, driver_email, action, field_name, old_value, new_value, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [oldEntry.driver_id, oldEntry.driver_email || loggedBy, action, 'race_number', String(oldEntry.race_number || ''), String(race_number)]
        );
      }
      if (entry_status !== undefined && oldEntry.entry_status !== entry_status) {
        await pool.query(
          `INSERT INTO audit_log (driver_id, driver_email, action, field_name, old_value, new_value, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [oldEntry.driver_id, oldEntry.driver_email || loggedBy, action, 'entry_status', String(oldEntry.entry_status || ''), String(entry_status)]
        );
      }
      if (payment_status !== undefined && oldEntry.payment_status !== payment_status) {
        await pool.query(
          `INSERT INTO audit_log (driver_id, driver_email, action, field_name, old_value, new_value, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [oldEntry.driver_id, oldEntry.driver_email || loggedBy, action, 'payment_status', String(oldEntry.payment_status || ''), String(payment_status)]
        );
      }
      if (amount_paid !== undefined && parseFloat(oldEntry.amount_paid || 0) !== parseFloat(amount_paid)) {
        await pool.query(
          `INSERT INTO audit_log (driver_id, driver_email, action, field_name, old_value, new_value, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [oldEntry.driver_id, oldEntry.driver_email || loggedBy, action, 'amount_paid', String(oldEntry.amount_paid || 0), String(amount_paid)]
        );
      }

      console.log(`✅ Race entry updated by ${loggedBy}: ${entryId}`);

      return res.json({
        success: true,
        data: { entry: result.rows[0] }
      });
    }

    // Single field update (original behavior)
    if (!field) {
      throw new Error('Field name is required for single field updates');
    }

    // Whitelist allowed fields to update
    const allowedFields = ['amount_paid', 'payment_status', 'entry_status', 'team_code', 'transponder_number', 'engine'];
    if (!allowedFields.includes(field)) {
      throw new Error(`Field '${field}' cannot be updated`);
    }

    // Type coercion for specific fields
    let updateValue = value;
    if (field === 'engine') {
      updateValue = value === true || value === '1' || value === 1 ? 1 : 0;
    } else if (field === 'amount_paid') {
      updateValue = parseFloat(value);
    }

    // Get the old value for audit
    const oldResult = await pool.query(
      `SELECT ${field}, driver_email, driver_id FROM race_entries WHERE entry_id = $1`,
      [entryId]
    );

    if (oldResult.rows.length === 0) {
      throw new Error('Race entry not found');
    }

    const oldValue = oldResult.rows[0][field];
    const driverEmail = oldResult.rows[0].driver_email;
    const driverId = oldResult.rows[0].driver_id;

    // Update the field
    const updateQuery = `UPDATE race_entries SET ${field} = $1, updated_at = NOW() WHERE entry_id = $2 RETURNING *`;
    const result = await pool.query(updateQuery, [updateValue, entryId]);

    if (result.rows.length === 0) {
      throw new Error('Failed to update race entry');
    }

    // Log to audit table
    await pool.query(
      `INSERT INTO audit_log (driver_id, driver_email, action, field_name, old_value, new_value, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [driverId, driverEmail, 'RACE_ENTRY_UPDATED', field, String(oldValue), String(updateValue)]
    );

    console.log(`✅ Race entry updated: ${entryId} - ${field} = ${updateValue}`);

    res.json({
      success: true,
      data: { entry: result.rows[0] }
    });
  } catch (err) {
    console.error('❌ updateRaceEntry error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Unregister Race Entry (Admin - Soft Cancel)
app.post('/api/deleteRaceEntry', async (req, res) => {
  try {
    const { entry_id } = req.body;

    if (!entry_id) {
      throw new Error('Entry ID is required');
    }

    // Get entry details
    const entryResult = await pool.query(
      `SELECT r.driver_id, r.event_id, c.email
       FROM race_entries r
       LEFT JOIN contacts c ON r.driver_id = c.driver_id
       WHERE r.entry_id = $1`,
      [entry_id]
    );

    if (entryResult.rows.length === 0) {
      throw new Error('Entry not found');
    }

    const entry = entryResult.rows[0];

    // Cancel the entry instead of deleting (soft cancel)
    await pool.query(
      `UPDATE race_entries SET entry_status = 'cancelled' WHERE entry_id = $1`,
      [entry_id]
    );

    // Check if driver has any OTHER active entries for this event
    const activeEntriesResult = await pool.query(
      `SELECT COUNT(*) as count FROM race_entries 
       WHERE driver_id = $1 AND event_id = $2 AND entry_status IN ('confirmed', 'pending')`,
      [entry.driver_id, entry.event_id]
    );

    const hasActiveEntries = activeEntriesResult.rows[0]?.count > 0;

    // If no more active entries for this event, update driver status
    if (!hasActiveEntries) {
      await pool.query(
        `UPDATE drivers 
         SET next_race_entry_status = 'Not Registered',
             next_race_engine_rental_status = 'No'
         WHERE driver_id = $1`,
        [entry.driver_id]
      );
      console.log(`✅ Updated driver ${entry.driver_id} - no active race entries remaining`);
    }

    // Log the cancellation
    await logAuditEvent(
      entry.driver_id,
      entry.email || 'unknown',
      'RACE_ENTRY_CANCELLED',
      'entry_id',
      entry_id,
      'cancelled',
      'admin-portal'
    );

    console.log(`✅ Race entry cancelled: ${entry_id} for ${entry.email || entry.driver_id}`);

    res.json({ success: true, message: 'Race entry cancelled successfully' });
  } catch (err) {
    console.error('❌ deleteRaceEntry error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Validate discount code
app.post('/api/validateDiscountCode', async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.json({ success: false, valid: false, message: 'Code is required' });
    }

    const result = await pool.query(
      `SELECT * FROM discount_codes 
       WHERE code = $1 AND is_active = true
       AND (valid_from IS NULL OR valid_from <= NOW())
       AND (valid_until IS NULL OR valid_until >= NOW())
       AND (usage_limit IS NULL OR usage_count < usage_limit)`,
      [code.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.json({ success: false, valid: false, message: 'Invalid or expired code' });
    }

    const discountCode = result.rows[0];
    res.json({ 
      success: true, 
      valid: true,
      code: discountCode
    });
  } catch (err) {
    console.error('❌ validateDiscountCode error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Get all discount codes (admin only)
app.get('/api/getDiscountCodes', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM discount_codes ORDER BY created_at DESC'
    );
    res.json({ success: true, codes: result.rows });
  } catch (err) {
    console.error('❌ getDiscountCodes error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Create discount code (admin only)
app.post('/api/createDiscountCode', async (req, res) => {
  try {
    const { code, description, discount_type, discount_value, usage_limit, valid_from, valid_until, created_by } = req.body;

    if (!code || !discount_type || discount_value === undefined) {
      return res.status(400).json({ success: false, error: { message: 'Missing required fields' } });
    }

    const code_id = `discount_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    await pool.query(
      `INSERT INTO discount_codes (code_id, code, description, discount_type, discount_value, usage_limit, valid_from, valid_until, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
      [code_id, code.toUpperCase(), description, discount_type, discount_value, usage_limit || null, valid_from || null, valid_until || null, created_by || 'admin']
    );

    console.log(`✅ Discount code created: ${code.toUpperCase()} (${discount_type}: ${discount_value})`);
    res.json({ success: true, message: 'Discount code created successfully' });
  } catch (err) {
    console.error('❌ createDiscountCode error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Update discount code (admin only)
app.post('/api/updateDiscountCode', async (req, res) => {
  try {
    const { code_id, code, description, discount_type, discount_value, usage_limit, valid_from, valid_until, is_active } = req.body;

    if (!code_id) {
      return res.status(400).json({ success: false, error: { message: 'Code ID is required' } });
    }

    await pool.query(
      `UPDATE discount_codes 
       SET code = $2, description = $3, discount_type = $4, discount_value = $5, 
           usage_limit = $6, valid_from = $7, valid_until = $8, is_active = $9, updated_at = NOW()
       WHERE code_id = $1`,
      [code_id, code.toUpperCase(), description, discount_type, discount_value, usage_limit || null, valid_from || null, valid_until || null, is_active]
    );

    console.log(`✅ Discount code updated: ${code.toUpperCase()}`);
    res.json({ success: true, message: 'Discount code updated successfully' });
  } catch (err) {
    console.error('❌ updateDiscountCode error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Delete discount code (admin only)
app.post('/api/deleteDiscountCode', async (req, res) => {
  try {
    const { code_id } = req.body;

    if (!code_id) {
      return res.status(400).json({ success: false, error: { message: 'Code ID is required' } });
    }

    await pool.query('DELETE FROM discount_codes WHERE code_id = $1', [code_id]);

    console.log(`✅ Discount code deleted: ${code_id}`);
    res.json({ success: true, message: 'Discount code deleted successfully' });
  } catch (err) {
    console.error('❌ deleteDiscountCode error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// Increment usage count when code is used
app.post('/api/useDiscountCode', async (req, res) => {
  try {
    const { code } = req.body;

    await pool.query(
      'UPDATE discount_codes SET usage_count = usage_count + 1 WHERE code = $1',
      [code.toUpperCase()]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('❌ useDiscountCode error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

app.post('/api/confirmRaceEntry', async (req, res) => {
  try {
    const { race_entry_id, entry_id } = req.body;
    const entryId = race_entry_id || entry_id;

    if (!entryId) {
      throw new Error('Race entry ID is required');
    }

    // Get entry details for audit log
    const entryCheckResult = await pool.query(
      `SELECT driver_id, payment_status FROM race_entries WHERE entry_id = $1`,
      [entryId]
    );

    if (entryCheckResult.rows.length === 0) {
      throw new Error('Race entry not found');
    }

    const entryData = entryCheckResult.rows[0];
    const oldStatus = entryData.payment_status;

    const result = await pool.query(
      `UPDATE race_entries SET payment_status = 'Confirmed', updated_at = NOW() WHERE entry_id = $1 RETURNING *`,
      [entryId]
    );

    // Get driver email for audit log
    const contactResult = await pool.query(
      'SELECT email FROM contacts WHERE driver_id = $1 LIMIT 1',
      [entryData.driver_id]
    );
    const driverEmail = contactResult.rows[0]?.email || 'unknown';

    // Log to audit trail
    await logAuditEvent(entryData.driver_id, driverEmail, 'RACE_ENTRY_CONFIRMED', 'payment_status', oldStatus || 'Pending', 'Confirmed');

    console.log(`✅ Race entry confirmed: ${entryId}`);

    res.json({
      success: true,
      data: { entry: result.rows[0] }
    });
  } catch (err) {
    console.error('❌ confirmRaceEntry error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Mark payment as received (updates payment_status and entry_status)
app.post('/api/markPaymentReceived', async (req, res) => {
  try {
    const { entry_id } = req.body;

    if (!entry_id) {
      throw new Error('Entry ID is required');
    }

    // Get entry details for audit log
    const entryCheckResult = await pool.query(
      `SELECT driver_id, payment_status, entry_status FROM race_entries WHERE entry_id = $1`,
      [entry_id]
    );

    if (entryCheckResult.rows.length === 0) {
      throw new Error('Race entry not found');
    }

    const entryData = entryCheckResult.rows[0];
    const oldPaymentStatus = entryData.payment_status;
    const oldEntryStatus = entryData.entry_status;

    // Update both payment_status and entry_status
    const result = await pool.query(
      `UPDATE race_entries 
       SET payment_status = 'Completed',
           entry_status = 'confirmed',
           updated_at = NOW() 
       WHERE entry_id = $1 
       RETURNING *`,
      [entry_id]
    );

    // Get driver email for audit log
    const contactResult = await pool.query(
      'SELECT email FROM contacts WHERE driver_id = $1 LIMIT 1',
      [entryData.driver_id]
    );
    const driverEmail = contactResult.rows[0]?.email || 'unknown';

    // Log to audit trail
    await logAuditEvent(
      entryData.driver_id, 
      driverEmail, 
      'PAYMENT_MARKED_RECEIVED', 
      'payment_status', 
      `${oldPaymentStatus}/${oldEntryStatus}`, 
      'Completed/confirmed'
    );

    console.log(`✅ Payment marked as received for entry: ${entry_id}`);

    res.json({
      success: true,
      message: 'Payment marked as received and entry confirmed',
      data: { entry: result.rows[0] }
    });
  } catch (err) {
    console.error('❌ markPaymentReceived error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Export Race Entries as CSV (Admin)
app.post('/api/exportRaceEntriesCSV', async (req, res) => {
  try {
    const { race_event } = req.body;

    console.log('📥 Timing sheet export request for event:', race_event);

    if (!race_event) {
      throw new Error('Race event is required');
    }

    // Helper function to escape CSV values
    const escapeCSV = (value) => {
      if (value === null || value === undefined) return '';
      const stringValue = String(value);
      if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }
      return stringValue;
    };

    // Query with JOIN to get driver details
    const result = await pool.query(
      `SELECT 
        r.*,
        d.first_name,
        d.last_name,
        d.transponder_number,
        d.license_number,
        d.kart_brand,
        d.team_name,
        d.nationality,
        d.championship,
        d.race_number as driver_race_number
       FROM race_entries r
       LEFT JOIN drivers d ON r.driver_id = d.driver_id
       WHERE r.event_id = $1 AND r.entry_status != 'cancelled'
       ORDER BY r.race_class, r.race_number`,
      [race_event]
    );

    console.log(`📋 Found ${result.rows.length} entries for timing sheet export`);

    const entries = result.rows;

    if (entries.length === 0) {
      res.json({ success: false, error: { message: 'No entries found' } });
      return;
    }

    // Country code mapping (ISO 3166-1 alpha-3)
    const countryCodeMap = {
      'South Africa': 'RSA',
      'Zimbabwe': 'ZWE',
      'Mozambique': 'MOZ',
      'Namibia': 'NAM',
      'Botswana': 'BWA',
      'Zambia': 'ZMB',
      'United Kingdom': 'GBR',
      'USA': 'USA',
      'United States': 'USA',
      'Australia': 'AUS',
      'New Zealand': 'NZL'
    };

    // Build timing sheet CSV with exact format required
    const headers = ['txp short', 'txpLong', 'Class', 'Race#', 'First Name', 'Last Name', 'License#', 'Chassis', 'Engine', 'Tyres', 'Image', 'Team', 'Country', 'Scoring'];
    
    const rows = entries.map(entry => {
      // Determine engine type based on class
      const raceClass = (entry.race_class || '').toUpperCase();
      const isCadet = raceClass.includes('CADET');
      const engine = isCadet ? 'Tillotson' : 'Vortex';
      
      // Determine tyre brand based on class
      const tyres = isCadet ? 'XXXX' : 'Levanto';
      
      // Create image name (firstname + lastname, no spaces)
      const firstName = entry.first_name || '';
      const lastName = entry.last_name || '';
      const imageName = (firstName + lastName).replace(/\s+/g, '');
      
      // Get country code (default to RSA if not found)
      const countryCode = countryCodeMap[entry.nationality] || 'RSA';
      
      // Determine scoring category based on championship field
      let scoring = '';
      if (entry.championship) {
        const champ = entry.championship.toUpperCase();
        if (champ.includes('NATIONAL') && champ.includes('REGIONAL')) {
          scoring = 'Nat + Reg';
        } else if (champ.includes('NATIONAL')) {
          scoring = 'Nat only';
        } else if (champ.includes('REGIONAL')) {
          scoring = 'Reg only';
        } else {
          scoring = 'Nat only'; // Default
        }
      } else {
        scoring = 'Nat only'; // Default if no championship specified
      }
      
      return [
        '', // txp short - leave blank as requested
        escapeCSV(entry.transponder_number || ''),
        escapeCSV(entry.race_class || ''),
        escapeCSV(entry.race_number || entry.driver_race_number || ''),
        escapeCSV(firstName),
        escapeCSV(lastName),
        escapeCSV(entry.license_number || ''),
        escapeCSV(entry.kart_brand || ''),
        escapeCSV(engine),
        escapeCSV(tyres),
        escapeCSV(imageName),
        escapeCSV(entry.team_name || ''),
        countryCode,
        escapeCSV(scoring)
      ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="timing-sheet-${race_event.replace(/[\/\s]/g, '-')}-${new Date().toISOString().split('T')[0]}.csv"`);

    console.log(`✅ Timing sheet CSV export ready: ${entries.length} entries`);

    res.send(csv);
  } catch (err) {
    console.error('❌ exportRaceEntriesCSV error:', err.message);
    console.error('❌ Stack trace:', err.stack);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Export Drivers as CSV (Admin)
app.post('/api/admin/exportDriversCSV', async (req, res) => {
  try {
    const { includeDeleted = false } = req.body;

    console.log('📊 Exporting drivers to CSV...');

    // Get all drivers (excluding soft-deleted unless requested)
    let driversQuery = 'SELECT * FROM drivers';
    if (!includeDeleted) {
      driversQuery += ' WHERE is_deleted = FALSE OR is_deleted IS NULL';
    }
    driversQuery += ' ORDER BY created_at DESC';

    const driversResult = await pool.query(driversQuery);
    const drivers = driversResult.rows;

    if (drivers.length === 0) {
      throw new Error('No drivers to export');
    }

    console.log(`📋 Found ${drivers.length} drivers to export`);

    // Get driver IDs for contact and medical queries
    const driverIds = drivers.map(d => d.driver_id);

    // Get all contacts
    let contactMap = {};
    try {
      const contactResult = await pool.query(
        'SELECT * FROM contacts WHERE driver_id = ANY($1)',
        [driverIds]
      );
      contactResult.rows.forEach(c => {
        if (!contactMap[c.driver_id]) {
          contactMap[c.driver_id] = c;
        }
      });
    } catch (e) {
      console.log('⚠️ Could not fetch contacts:', e.message);
    }

    // Get all medical info
    let medicalMap = {};
    try {
      const medicalResult = await pool.query(
        'SELECT * FROM medical_consent WHERE driver_id = ANY($1)',
        [driverIds]
      );
      medicalResult.rows.forEach(m => {
        medicalMap[m.driver_id] = m;
      });
    } catch (e) {
      console.log('⚠️ Could not fetch medical info:', e.message);
    }

    // Build CSV content
    const headers = [
      'Driver ID',
      'First Name',
      'Last Name',
      'Email',
      'Phone',
      'Contact Name',
      'Contact Phone',
      'Contact Relationship',
      'Championship',
      'Class',
      'Race Number',
      'Team Name',
      'Coach Name',
      'Kart Brand',
      'Engine Type',
      'Transponder Number',
      'License Number',
      'Status',
      'Medical Allergies',
      'Medical Conditions',
      'Medical Medication',
      'Doctor Phone',
      'Consent Signed',
      'Media Release Signed',
      'Date of Birth',
      'Gender',
      'Nationality',
      'Registration Date',
      'Is Deleted',
      'Deleted Date'
    ];

    // Helper function to escape CSV values
    const escapeCSV = (value) => {
      if (value === null || value === undefined) return '';
      const stringValue = String(value);
      if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }
      return stringValue;
    };

    // Build CSV rows
    const rows = drivers.map(driver => {
      const contact = contactMap[driver.driver_id] || {};
      const medical = medicalMap[driver.driver_id] || {};

      return [
        escapeCSV(driver.driver_id),
        escapeCSV(driver.first_name),
        escapeCSV(driver.last_name),
        escapeCSV(contact.email),
        escapeCSV(contact.phone_mobile),
        escapeCSV(contact.full_name),
        escapeCSV(contact.phone_mobile),
        escapeCSV(contact.relationship),
        escapeCSV(driver.championship),
        escapeCSV(driver.class),
        escapeCSV(driver.race_number),
        escapeCSV(driver.team_name),
        escapeCSV(driver.coach_name),
        escapeCSV(driver.kart_brand),
        escapeCSV(driver.engine_type),
        escapeCSV(driver.transponder_number),
        escapeCSV(driver.license_number),
        escapeCSV(driver.status),
        escapeCSV(medical.allergies),
        escapeCSV(medical.medical_conditions),
        escapeCSV(medical.medication),
        escapeCSV(medical.doctor_phone),
        escapeCSV(medical.consent_signed ? 'Yes' : 'No'),
        escapeCSV(medical.media_release_signed ? 'Yes' : 'No'),
        escapeCSV(driver.date_of_birth),
        escapeCSV(driver.gender),
        escapeCSV(driver.nationality),
        escapeCSV(driver.created_at),
        escapeCSV(driver.is_deleted ? 'Yes' : 'No'),
        escapeCSV(driver.deleted_at)
      ].join(',');
    });

    // Combine headers and rows
    const csv = [headers.join(','), ...rows].join('\n');

    // Set response headers for file download
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="drivers-export-${new Date().toISOString().split('T')[0]}.csv"`);

    console.log(`✅ CSV export ready: ${drivers.length} drivers`);

    res.send(csv);
  } catch (err) {
    console.error('❌ exportDriversCSV error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// ============================================
// OFFICIALS PORTAL ENDPOINTS
// ============================================

// Officials Login
app.post('/api/officialLogin', async (req, res) => {
  try {
    const { official_code, password } = req.body;

    if (!official_code || !password) {
      throw new Error('Official code and password are required');
    }

    // For now, accept any credentials (you can add a real officials table later)
    // In production, you'd check against an officials table in the database
    const isValid = official_code && password && password.length > 0;
    
    if (!isValid) {
      throw new Error('Invalid credentials');
    }

    // Generate a simple token (in production, use JWT)
    const token = Buffer.from(`${official_code}:${Date.now()}`).toString('base64');

    res.json({
      success: true,
      data: {
        token,
        name: official_code
      }
    });
  } catch (err) {
    console.error('❌ officialLogin error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get all upcoming events for race selector
app.get('/api/getUpcomingEvents', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const result = await pool.query(
      `SELECT event_id, event_name, event_date, location
       FROM events 
       WHERE event_date >= CURRENT_DATE
       ORDER BY event_date ASC`
    );

    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    console.error('❌ getUpcomingEvents error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get next race drivers for officials (or specific event if event_id provided)
app.get('/api/getNextRaceDrivers', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { event_id } = req.query;
    let eventResult;

    // If event_id is provided, get that specific event; otherwise get next race
    if (event_id) {
      eventResult = await pool.query(
        `SELECT event_id, event_name, event_date, location 
         FROM events 
         WHERE event_id = $1`,
        [event_id]
      );
    } else {
      eventResult = await pool.query(
        `SELECT event_id, event_name, event_date, location 
         FROM events 
         WHERE event_date >= CURRENT_DATE
         ORDER BY event_date ASC
         LIMIT 1`
      );
    }

    if (eventResult.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          event_name: 'No races found',
          event_date: null,
          drivers: []
        }
      });
    }

    const event = eventResult.rows[0];

    // Get all drivers registered for this race - use same query as admin getRaceEntries
    const driversResult = await pool.query(`
      SELECT 
        re.*,
        d.first_name,
        d.last_name,
        d.class AS driver_class,
        d.race_number,
        d.license_number,
        d.team_name,
        d.kart_brand,
        d.date_of_birth,
        d.season_engine_rental,
        d.transponder_number,
        c.email,
        mc.medical_conditions
      FROM race_entries re
      LEFT JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN contacts c ON re.driver_id = c.driver_id
      LEFT JOIN medical_consent mc ON re.driver_id = mc.driver_id
      WHERE re.event_id = $1
      ORDER BY d.first_name, d.last_name
    `, [event.event_id]);

    res.json({
      success: true,
      data: {
        event_id: event.event_id,
        event_name: event.event_name,
        event_date: event.event_date,
        location: event.location,
        drivers: driversResult.rows
      }
    });
  } catch (err) {
    console.error('❌ getNextRaceDrivers error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Upload event document (race results, incident reports, etc.)
app.post('/api/uploadEventDocument', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { event_id, document_type, file_name, file_content, uploaded_by_official } = req.body;
    
    if (!event_id || !document_type || !file_name || !file_content) {
      throw new Error('Missing required fields: event_id, document_type, file_name, file_content');
    }

    // Validate event exists
    const eventCheck = await pool.query('SELECT event_id FROM events WHERE event_id = $1', [event_id]);
    if (eventCheck.rows.length === 0) {
      throw new Error('Event not found');
    }

    const document_id = uuidv4();
    
    // Decode base64 file content
    const buffer = Buffer.from(file_content, 'base64');
    const file_size = buffer.length;
    
    // Create uploads directory if it doesn't exist
    const uploadDir = path.join(__dirname, 'uploads', 'event-documents', event_id);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Save file locally
    const file_path = path.join(uploadDir, `${document_id}_${file_name}`);
    fs.writeFileSync(file_path, buffer);

    // Save metadata to database
    await pool.query(
      `INSERT INTO event_documents (document_id, event_id, uploaded_by_official, document_type, file_name, file_path, file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [document_id, event_id, uploaded_by_official || 'Unknown', document_type, file_name, file_path, file_size]
    );

    console.log(`📄 Document uploaded: ${file_name} (${file_size} bytes) for event ${event_id}`);

    res.json({
      success: true,
      data: {
        document_id: document_id,
        file_name: file_name,
        file_size: file_size,
        upload_date: new Date().toISOString(),
        message: 'Document uploaded successfully'
      }
    });
  } catch (err) {
    console.error('❌ Document upload error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get event documents
app.get('/api/getEventDocuments', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { event_id } = req.query;
    if (!event_id) {
      throw new Error('event_id required');
    }

    const docsResult = await pool.query(
      `SELECT 
        document_id, 
        event_id, 
        uploaded_by_official, 
        document_type, 
        file_name, 
        file_size,
        upload_date
       FROM event_documents 
       WHERE event_id = $1 
       ORDER BY upload_date DESC`,
      [event_id]
    );

    res.json({
      success: true,
      data: {
        event_id: event_id,
        documents: docsResult.rows || [],
        total: docsResult.rows.length
      }
    });
  } catch (err) {
    console.error('❌ Get documents error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Download event document
app.get('/api/downloadEventDocument/:document_id', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { document_id } = req.params;

    const docResult = await pool.query(
      'SELECT document_id, file_name, file_path FROM event_documents WHERE document_id = $1',
      [document_id]
    );

    if (docResult.rows.length === 0) {
      throw new Error('Document not found');
    }

    const doc = docResult.rows[0];
    
    // Check if file exists
    if (!fs.existsSync(doc.file_path)) {
      throw new Error('File not found on server');
    }

    // Send file
    res.download(doc.file_path, doc.file_name);
    console.log(`📥 Document downloaded: ${doc.file_name}`);
  } catch (err) {
    console.error('❌ Download error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Delete event document
app.post('/api/deleteEventDocument', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { document_id } = req.body;
    if (!document_id) {
      throw new Error('document_id required');
    }

    const docResult = await pool.query(
      'SELECT file_path FROM event_documents WHERE document_id = $1',
      [document_id]
    );

    if (docResult.rows.length === 0) {
      throw new Error('Document not found');
    }

    // Delete file from disk
    const file_path = docResult.rows[0].file_path;
    if (fs.existsSync(file_path)) {
      fs.unlinkSync(file_path);
    }

    // Delete from database
    await pool.query('DELETE FROM event_documents WHERE document_id = $1', [document_id]);

    console.log(`🗑️ Document deleted: ${document_id}`);

    res.json({
      success: true,
      data: { message: 'Document deleted successfully' }
    });
  } catch (err) {
    console.error('❌ Delete error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// MSA License Upload
app.post('/api/uploadMSALicense', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { driver_id, file_name, file_data, file_type } = req.body;

    if (!driver_id || !file_name || !file_data) {
      throw new Error('driver_id, file_name, and file_data required');
    }

    // Create upload directory if it doesn't exist
    const uploadDir = path.join(__dirname, 'uploads', 'msa-licenses');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Decode base64 and save file
    const document_id = require('uuid').v4();
    const buffer = Buffer.from(file_data, 'base64');
    const file_path = path.join(uploadDir, `${document_id}_${file_name}`);
    
    fs.writeFileSync(file_path, buffer);
    const file_size = buffer.length;

    // Delete any existing license for this driver
    const existingResult = await pool.query(
      'SELECT document_id, file_path FROM msa_licenses WHERE driver_id = $1',
      [driver_id]
    );

    if (existingResult.rows.length > 0) {
      const oldDoc = existingResult.rows[0];
      if (fs.existsSync(oldDoc.file_path)) {
        fs.unlinkSync(oldDoc.file_path);
      }
      await pool.query('DELETE FROM msa_licenses WHERE driver_id = $1', [driver_id]);
    }

    // Insert into database
    await pool.query(
      `INSERT INTO msa_licenses (document_id, driver_id, file_name, file_path, file_size, file_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [document_id, driver_id, file_name, file_path, file_size, file_type]
    );

    console.log(`📄 MSA License uploaded for driver ${driver_id}: ${file_name}`);

    res.json({
      success: true,
      data: {
        document_id: document_id,
        file_name: file_name,
        file_size: file_size,
        message: 'MSA License uploaded successfully'
      }
    });
  } catch (err) {
    console.error('❌ MSA upload error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get MSA License
app.get('/api/getMSALicense/:driver_id', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { driver_id } = req.params;

    const result = await pool.query(
      `SELECT document_id, driver_id, file_name, file_size, file_type, upload_date
       FROM msa_licenses 
       WHERE driver_id = $1`,
      [driver_id]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        data: null
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (err) {
    console.error('❌ Get MSA error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Download MSA License
app.get('/api/downloadMSALicense/:document_id', async (req, res) => {
  try {
    const { document_id } = req.params;

    const result = await pool.query(
      'SELECT file_path, file_name FROM msa_licenses WHERE document_id = $1',
      [document_id]
    );

    if (result.rows.length === 0) {
      throw new Error('Document not found');
    }

    const { file_path, file_name } = result.rows[0];

    if (!fs.existsSync(file_path)) {
      throw new Error('File not found on server');
    }

    res.download(file_path, file_name);
  } catch (err) {
    console.error('❌ Download error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Delete MSA License
app.post('/api/deleteMSALicense', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { document_id } = req.body;
    if (!document_id) {
      throw new Error('document_id required');
    }

    const docResult = await pool.query(
      'SELECT file_path FROM msa_licenses WHERE document_id = $1',
      [document_id]
    );

    if (docResult.rows.length === 0) {
      throw new Error('Document not found');
    }

    // Delete file from disk
    const file_path = docResult.rows[0].file_path;
    if (fs.existsSync(file_path)) {
      fs.unlinkSync(file_path);
    }

    // Delete from database
    await pool.query('DELETE FROM msa_licenses WHERE document_id = $1', [document_id]);

    console.log(`🗑️ MSA License deleted: ${document_id}`);

    res.json({
      success: true,
      data: { message: 'MSA License deleted successfully' }
    });
  } catch (err) {
    console.error('❌ MSA Delete error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get all MSA licenses for drivers in a specific event
app.get('/api/getEventDriversMSALicenses/:event_id', async (req, res) => {
  try {
    const { event_id } = req.params;
    if (!event_id) {
      throw new Error('event_id required');
    }

    const result = await pool.query(`
      SELECT 
        ml.document_id,
        ml.driver_id,
        ml.file_name,
        ml.file_size,
        ml.upload_date,
        d.first_name,
        d.last_name,
        d.class
      FROM msa_licenses ml
      JOIN drivers d ON ml.driver_id = d.driver_id
      JOIN race_entries re ON d.driver_id = re.driver_id
      WHERE re.event_id = $1
      AND re.entry_status IN ('confirmed', 'pending')
      ORDER BY d.first_name, d.last_name
    `, [event_id]);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    console.error('❌ Error getting event MSA licenses:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Export officials CSV in multiple formats
app.post('/api/exportOfficialsCSV', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      throw new Error('Unauthorized');
    }

    const { format } = req.body;
    if (!format) {
      throw new Error('Export format is required');
    }

    // Get next race and drivers
    const eventResult = await pool.query(
      `SELECT event_id, event_name, event_date 
       FROM events 
       WHERE event_date >= CURRENT_DATE
       ORDER BY event_date ASC
       LIMIT 1`
    );

    if (eventResult.rows.length === 0) {
      throw new Error('No upcoming races found');
    }

    const event = eventResult.rows[0];

    const driversResult = await pool.query(`
      SELECT DISTINCT
        d.driver_id,
        d.first_name,
        d.last_name,
        c.email,
        c.phone_mobile,
        d.class,
        d.date_of_birth,
        d.season_engine_rental,
        re.entry_id,
        re.engine,
        re.team_code,
        d.transponder_number,
        mc.medical_conditions,
        d.race_number,
        re.race_class,
        re.race_number as entry_race_number,
        d.license_number,
        d.kart_brand,
        d.team_name,
        d.nationality,
        d.championship
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN contacts c ON d.driver_id = c.driver_id
      LEFT JOIN medical_consent mc ON d.driver_id = mc.driver_id
      WHERE re.event_id = $1
      AND re.entry_status IN ('confirmed', 'pending')
      ORDER BY d.class, d.first_name, d.last_name
    `, [event.event_id]);

    const drivers = driversResult.rows;
    let csv = '';

    if (format === 'drivers') {
      // Full driver list
      const headers = ['Driver Name', 'Entrant Name', 'Email', 'Phone', 'Class', 'Transponder', 'Engine Rental', 'DOB'];
      const rows = drivers.map(d => [
        `${d.first_name} ${d.last_name}`,
        d.team_name || '',
        d.email || '',
        d.phone_mobile || '',
        d.class || '',
        d.transponder_number || 'REQUIRED',
        (d.engine === 1 || d.engine === '1' || d.season_engine_rental === 'Y') ? 'Yes' : 'No',
        d.date_of_birth ? new Date(d.date_of_birth).toLocaleDateString('en-ZA') : ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      csv = [headers.join(','), ...rows].join('\n');
    } else if (format === 'signon') {
      // Sign-on sheet format (simplified for printing with signature space)
      const headers = ['#', 'Driver Name', 'Entrant Name', 'Class', 'Race#', 'Transponder', 'Signature'];
      const rows = drivers.map((d, idx) => [
        idx + 1,
        `${d.first_name} ${d.last_name}`,
        d.team_name || '',
        d.class || '',
        d.entry_race_number || d.race_number || '',
        d.transponder_number || '',
        ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
      csv = [headers.join(','), ...rows].join('\n');
    } else if (format === 'timing') {
      // Helper function to escape CSV values
      const escapeCSV = (value) => {
        if (value === null || value === undefined) return '';
        const stringValue = String(value);
        if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
          return `"${stringValue.replace(/"/g, '""')}"`;
        }
        return stringValue;
      };

      // Country code mapping (ISO 3166-1 alpha-3)
      const countryCodeMap = {
        'South Africa': 'RSA',
        'Zimbabwe': 'ZWE',
        'Mozambique': 'MOZ',
        'Namibia': 'NAM',
        'Botswana': 'BWA',
        'Zambia': 'ZMB',
        'United Kingdom': 'GBR',
        'USA': 'USA',
        'United States': 'USA',
        'Australia': 'AUS',
        'New Zealand': 'NZL'
      };

      // Timing system format - full 14 column format
      const headers = ['txp short', 'txpLong', 'Class', 'Race#', 'First Name', 'Last Name', 'License#', 'Chassis', 'Engine', 'Tyres', 'Image', 'Team', 'Country', 'Scoring'];
      const rows = drivers
        .filter(d => d.transponder_number) // Only drivers with transponders
        .map(d => {
          // Determine engine type based on class
          const raceClass = (d.race_class || d.class || '').toUpperCase();
          const isCadet = raceClass.includes('CADET');
          const engine = isCadet ? 'Tillotson' : 'Vortex';
          
          // Determine tyre brand based on class
          const tyres = isCadet ? 'XXXX' : 'Levanto';
          
          // Create image name (firstname + lastname, no spaces)
          const firstName = d.first_name || '';
          const lastName = d.last_name || '';
          const imageName = (firstName + lastName).replace(/\s+/g, '');
          
          // Get country code (default to RSA if not found)
          const countryCode = countryCodeMap[d.nationality] || 'RSA';
          
          // Determine scoring category based on championship field
          let scoring = '';
          if (d.championship) {
            const champ = d.championship.toUpperCase();
            if (champ.includes('NATIONAL') && champ.includes('REGIONAL')) {
              scoring = 'Nat + Reg';
            } else if (champ.includes('NATIONAL')) {
              scoring = 'Nat only';
            } else if (champ.includes('REGIONAL')) {
              scoring = 'Reg only';
            } else {
              scoring = 'Nat only';
            }
          } else {
            scoring = 'Nat only';
          }
          
          return [
            '', // txp short - leave blank
            escapeCSV(d.transponder_number || ''),
            escapeCSV(d.race_class || d.class || ''),
            escapeCSV(d.entry_race_number || d.race_number || ''),
            escapeCSV(firstName),
            escapeCSV(lastName),
            escapeCSV(d.license_number || ''),
            escapeCSV(d.kart_brand || ''),
            escapeCSV(engine),
            escapeCSV(tyres),
            escapeCSV(imageName),
            escapeCSV(d.team_name || ''),
            countryCode,
            escapeCSV(scoring)
          ].join(',');
        });
      csv = [headers.join(','), ...rows].join('\n');
    }

    // Set response headers for file download with event name
    const eventNameSafe = event.event_name.replace(/[^a-zA-Z0-9-]/g, '-').replace(/--+/g, '-');
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = format === 'drivers' ? `${eventNameSafe}-drivers-list-${dateStr}.csv`
                   : format === 'signon' ? `${eventNameSafe}-sign-on-${dateStr}.csv`
                   : `${eventNameSafe}-timing-sheet-${dateStr}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    console.log(`✅ Officials CSV export (${format}): ${drivers.length} drivers`);
    res.send(csv);
  } catch (err) {
    console.error('❌ exportOfficialsCSV error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get audit log entries
app.post('/api/getAuditLog', async (req, res) => {
  try {
    const { driver, action, limit } = req.body;
    let query = `
      SELECT 
        al.*,
        d.first_name as driver_first_name,
        d.last_name as driver_last_name,
        c.email as driver_email
      FROM audit_log al
      LEFT JOIN drivers d ON al.driver_id = d.driver_id
      LEFT JOIN contacts c ON al.driver_id = c.driver_id
      WHERE 1=1
    `;
    
    const params = [];

    if (driver) {
      params.push(`%${driver}%`);
      query += ` AND (d.first_name ILIKE $${params.length} OR d.last_name ILIKE $${params.length} OR c.email ILIKE $${params.length})`;
    }

    if (action) {
      params.push(action);
      query += ` AND al.action = $${params.length}`;
    }

    query += ` ORDER BY al.created_at DESC LIMIT ${limit || 1000}`;

    const result = await pool.query(query, params);

    res.json({
      success: true,
      data: { logs: result.rows }
    });
  } catch (err) {
    console.error('❌ getAuditLog error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Export audit log as CSV
app.post('/api/exportAuditCSV', async (req, res) => {
  try {
    const { driver, action } = req.body;
    let query = `
      SELECT 
        al.*,
        d.first_name as driver_first_name,
        d.last_name as driver_last_name,
        c.email as driver_email
      FROM audit_log al
      LEFT JOIN drivers d ON al.driver_id = d.driver_id
      LEFT JOIN contacts c ON al.driver_id = c.driver_id
      WHERE 1=1
    `;
    
    const params = [];

    if (driver) {
      params.push(`%${driver}%`);
      query += ` AND (d.first_name ILIKE $${params.length} OR d.last_name ILIKE $${params.length} OR c.email ILIKE $${params.length})`;
    }

    if (action) {
      params.push(action);
      query += ` AND al.action = $${params.length}`;
    }

    query += ` ORDER BY al.created_at DESC`;

    const result = await pool.query(query, params);

    // Build CSV
    const headers = ['Timestamp', 'Action', 'Driver Name', 'Email', 'Field', 'Old Value', 'New Value', 'IP Address'];
    const rows = result.rows.map(log => [
      log.created_at ? new Date(log.created_at).toLocaleString('en-ZA') : '',
      log.action || '',
      log.driver_first_name && log.driver_last_name ? `${log.driver_first_name} ${log.driver_last_name}` : 'System',
      log.driver_email || '',
      log.field_name || '',
      log.old_value || '',
      log.new_value || '',
      log.ip_address || ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

    const csv = [headers.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0,10)}.csv"`);

    console.log(`✅ Audit log export: ${result.rows.length} records`);
    res.send(csv);
  } catch (err) {
    console.error('❌ exportAuditCSV error:', err.message);
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// ==================== PUSH NOTIFICATIONS ====================

// Initialize push subscriptions table
const initPushSubscriptionsTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        driver_id INTEGER,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Push subscriptions table initialized');
  } catch (err) {
    console.error('Error creating push_subscriptions table:', err.message);
  }
};
initPushSubscriptionsTable();

// Get VAPID public key
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ 
    success: true, 
    publicKey: process.env.VAPID_PUBLIC_KEY 
  });
});

// Subscribe to push notifications
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { subscription, driverId } = req.body;
    
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ success: false, error: 'Invalid subscription' });
    }

    const keys = subscription.keys || {};
    
    // Upsert subscription
    await pool.query(`
      INSERT INTO push_subscriptions (driver_id, endpoint, p256dh, auth)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (endpoint) 
      DO UPDATE SET driver_id = $1, p256dh = $3, auth = $4, last_used = CURRENT_TIMESTAMP
    `, [driverId || null, subscription.endpoint, keys.p256dh || '', keys.auth || '']);

    res.json({ success: true, message: 'Subscribed to notifications' });
  } catch (err) {
    console.error('Push subscribe error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Unsubscribe from push notifications
app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    
    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
    
    res.json({ success: true, message: 'Unsubscribed from notifications' });
  } catch (err) {
    console.error('Push unsubscribe error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send push notification (admin only)
app.post('/api/push/send', async (req, res) => {
  try {
    const { title, body, url, driverId, raceClass, eventId } = req.body;
    
    if (!title || !body) {
      return res.status(400).json({ success: false, error: 'Title and body required' });
    }

    let targetDriverIds = null;
    
    // If filtering by class, get driver IDs for that class
    if (raceClass && !driverId) {
      const classDrivers = await pool.query(
        'SELECT driver_id FROM drivers WHERE class = $1 AND is_deleted = false',
        [raceClass]
      );
      targetDriverIds = classDrivers.rows.map(r => r.driver_id);
      console.log(`Push targeting class ${raceClass}: ${targetDriverIds.length} drivers`);
    }
    
    // If filtering by event, get driver IDs for that event
    if (eventId && !driverId) {
      let eventQuery = `
        SELECT DISTINCT re.driver_id 
        FROM race_entries re 
        WHERE re.event_id = $1::text 
          AND (re.status IS NULL OR re.status != 'Cancelled')
      `;
      const params = [eventId];
      
      // If also filtering by class within event
      if (raceClass) {
        eventQuery += ' AND (re.race_class = $2 OR re.class = $2)';
        params.push(raceClass);
      }
      
      const eventDrivers = await pool.query(eventQuery, params);
      targetDriverIds = eventDrivers.rows.map(r => r.driver_id);
      console.log(`Push targeting event ${eventId}${raceClass ? ' class ' + raceClass : ''}: ${targetDriverIds.length} drivers`);
    }

    // Get subscriptions
    let query = 'SELECT * FROM push_subscriptions';
    let params = [];
    
    if (driverId) {
      // Single driver
      query += ' WHERE driver_id = $1';
      params = [driverId];
    } else if (targetDriverIds && targetDriverIds.length > 0) {
      // Multiple drivers by class or event
      query += ' WHERE driver_id = ANY($1)';
      params = [targetDriverIds];
    }
    // else: send to all subscriptions
    
    const result = await pool.query(query, params);
    console.log(`Found ${result.rows.length} push subscriptions to notify`);
    
    const payload = JSON.stringify({
      title,
      body,
      url: url || '/driver_portal.html'
    });

    // Determine notification type based on content
    let notificationType = 'general';
    if (eventId) notificationType = 'event';
    else if (title.toLowerCase().includes('registration') || body.toLowerCase().includes('registration')) notificationType = 'registration';
    else if (title.toLowerCase().includes('payment') || body.toLowerCase().includes('payment')) notificationType = 'payment';

    // Get event name if eventId provided
    let eventName = null;
    if (eventId) {
      try {
        const eventResult = await pool.query('SELECT event_name FROM events WHERE event_id = $1', [eventId]);
        if (eventResult.rows.length > 0) {
          eventName = eventResult.rows[0].event_name;
        }
      } catch (e) {
        console.log('Could not get event name:', e.message);
      }
    }

    let successCount = 0;
    let failCount = 0;
    const failedEndpoints = [];
    const notifiedDriverIds = new Set();

    // Send notifications in parallel batches of 10 for efficiency
    const batchSize = 10;
    for (let i = 0; i < result.rows.length; i += batchSize) {
      const batch = result.rows.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (sub) => {
        try {
          await webpush.sendNotification({
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.p256dh,
              auth: sub.auth
            }
          }, payload);
          successCount++;
          
          // Track driver ID for notification history
          if (sub.driver_id) {
            notifiedDriverIds.add(sub.driver_id);
          }
          
          // Update last_used
          await pool.query('UPDATE push_subscriptions SET last_used = CURRENT_TIMESTAMP WHERE id = $1', [sub.id]);
        } catch (err) {
          failCount++;
          if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription expired or invalid - remove it
            failedEndpoints.push(sub.endpoint);
            await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
          }
        }
      }));
    }

    // Record notification history for each driver who received it
    for (const dId of notifiedDriverIds) {
      try {
        await pool.query(
          `INSERT INTO notification_history (driver_id, event_id, event_name, title, body, url, notification_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [dId, eventId || null, eventName, title, body, url || '/driver_portal.html', notificationType]
        );
      } catch (histErr) {
        console.log('Could not save notification history:', histErr.message);
      }
    }

    res.json({ 
      success: true, 
      sent: successCount, 
      failed: failCount,
      removed: failedEndpoints.length
    });
  } catch (err) {
    console.error('Push send error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get push notification stats (admin)
app.get('/api/push/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) as total,
             COUNT(driver_id) as with_driver,
             COUNT(*) - COUNT(driver_id) as anonymous
      FROM push_subscriptions
    `);
    
    res.json({ 
      success: true, 
      subscribedCount: parseInt(result.rows[0].total) || 0,
      totalSent: 0, // We could track this in a separate table
      stats: result.rows[0] 
    });
  } catch (err) {
    console.error('Push stats error:', err.message);
    res.status(500).json({ success: false, subscribedCount: 0, totalSent: 0, error: err.message });
  }
});

// Get all push subscribers list (admin)
app.get('/api/push/subscribers', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ps.id, ps.driver_id, ps.endpoint, ps.created_at, ps.last_used,
             d.first_name, d.last_name, c.email, d.class AS racing_class
      FROM push_subscriptions ps
      LEFT JOIN drivers d ON ps.driver_id = d.driver_id
      LEFT JOIN contacts c ON d.driver_id = c.driver_id
      ORDER BY ps.created_at DESC
    `);
    
    res.json({ 
      success: true, 
      subscribers: result.rows.map(row => ({
        id: row.id,
        driverId: row.driver_id,
        driverName: row.first_name && row.last_name ? `${row.first_name} ${row.last_name}` : (row.driver_id ? 'Unknown Driver' : 'Anonymous'),
        email: row.email || '-',
        racingClass: row.racing_class || '-',
        endpoint: row.endpoint ? row.endpoint.substring(0, 50) + '...' : '-',
        createdAt: row.created_at,
        lastUsed: row.last_used
      }))
    });
  } catch (err) {
    console.error('Push subscribers error:', err.message);
    res.status(500).json({ success: false, error: err.message, subscribers: [] });
  }
});

// Get notification history for a driver
app.get('/api/notifications/history', async (req, res) => {
  try {
    const { driverId, type, eventId } = req.query;
    
    if (!driverId) {
      return res.status(400).json({ success: false, error: 'Driver ID required' });
    }
    
    let query = `
      SELECT id, driver_id, event_id, event_name, title, body, url, notification_type, created_at
      FROM notification_history
      WHERE driver_id = $1
    `;
    const params = [driverId];
    let paramIndex = 2;
    
    if (type) {
      query += ` AND notification_type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }
    
    if (eventId) {
      query += ` AND event_id = $${paramIndex}`;
      params.push(eventId);
      paramIndex++;
    }
    
    query += ' ORDER BY created_at DESC LIMIT 100';
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      notifications: result.rows
    });
  } catch (err) {
    console.error('Notification history error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get public notifications for an event (no auth required)
app.get('/api/notifications/event/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    
    // Get unique notifications sent for this event (deduplicated by title/body)
    const result = await pool.query(`
      SELECT DISTINCT ON (title, body) 
        id, event_id, event_name, title, body, url, notification_type, created_at as sent_at
      FROM notification_history
      WHERE event_id = $1
      ORDER BY title, body, created_at DESC
    `, [eventId]);
    
    res.json({
      success: true,
      notifications: result.rows
    });
  } catch (err) {
    console.error('Event notifications error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve static files from the project root (AFTER all API routes)
app.use(express.static(path.join(__dirname, '.')));

// =========================================================
// EXPRESS ERROR HANDLING MIDDLEWARE - Catch all route errors
// =========================================================
app.use((err, req, res, next) => {
  console.error('❌ Express error:', err.message);
  console.error('Stack:', err.stack);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error', 
    message: err.message 
  });
});

// ============= EVENT DOCUMENTS (Google Drive / JSON Config) =============
// Reads from event-documents.json - no file uploads needed!
app.get('/api/events/:eventId/docs', async (req, res) => {
  try {
    const { eventId } = req.params;
    const fs = require('fs');
    const path = require('path');
    
    // Read the JSON config file
    const configPath = path.join(__dirname, 'event-documents.json');
    
    if (!fs.existsSync(configPath)) {
      return res.json({ success: true, documents: [], message: 'No documents config file found' });
    }
    
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const eventDocs = configData.events?.[eventId];
    
    if (!eventDocs || !eventDocs.documents || eventDocs.documents.length === 0) {
      return res.json({ success: true, documents: [], message: 'No documents for this event' });
    }
    
    // Map documents with icons based on type
    const documents = eventDocs.documents
      .filter(doc => doc.url && doc.url !== 'https://drive.google.com/file/d/YOUR_FILE_ID/view?usp=sharing')
      .map(doc => {
        // Determine icon based on document type
        let icon = '📄';
        const typeLower = (doc.type || '').toLowerCase();
        if (typeLower.includes('regulation') || typeLower.includes('sr')) icon = '📕';
        else if (typeLower.includes('entry') || typeLower.includes('list')) icon = '📋';
        else if (typeLower.includes('time') || typeLower.includes('schedule')) icon = '🕐';
        else if (typeLower.includes('result')) icon = '🏆';
        else if (typeLower.includes('bulletin')) icon = '📢';
        else if (typeLower.includes('notice')) icon = '⚠️';
        else if (typeLower.includes('map')) icon = '🗺️';
        
        // Convert Google Drive view link to direct download/preview link
        let url = doc.url;
        if (url.includes('drive.google.com/file/d/')) {
          // Extract file ID and create preview URL
          const match = url.match(/\/d\/([^\/]+)/);
          if (match) {
            url = `https://drive.google.com/file/d/${match[1]}/preview`;
          }
        }
        
        return {
          display_name: doc.name,
          document_type: doc.type || 'Document',
          file_path: doc.url, // Keep original for download
          preview_url: url,   // For embedded preview
          icon: icon
        };
      })
      .sort((a, b) => {
        // Sort by type priority
        const priority = { 'Supplementary Regulations': 1, 'Entry List': 2, 'Timetable': 3, 'Results': 4, 'Bulletin': 5, 'Notice': 6 };
        const aPri = priority[a.document_type] || 99;
        const bPri = priority[b.document_type] || 99;
        if (aPri !== bPri) return aPri - bPri;
        return a.display_name.localeCompare(b.display_name);
      });
    
    res.json({ success: true, documents, count: documents.length, eventName: eventDocs.name });
    
  } catch (err) {
    console.error('Error reading event documents:', err);
    res.json({ success: true, documents: [], error: err.message });
  }
});

// =============================================
// ENGINE MANAGEMENT API ENDPOINTS
// =============================================

// Lookup ticket barcode and get driver info
app.get('/api/lookupTicket', async (req, res) => {
  try {
    const { barcode } = req.query;
    
    if (!barcode) {
      return res.json({ success: false, error: 'Barcode required' });
    }
    
    const barcodeUpper = barcode.toUpperCase();
    
    // Determine ticket type from barcode prefix
    let ticketColumn = null;
    let ticketType = '';
    
    if (barcodeUpper.startsWith('ENG')) {
      ticketColumn = 'ticket_engine_ref';
      ticketType = 'Engine Rental';
    } else if (barcodeUpper.startsWith('TYR')) {
      ticketColumn = 'ticket_tyres_ref';
      ticketType = 'Tyres';
    } else if (barcodeUpper.startsWith('TX')) {
      ticketColumn = 'ticket_transponder_ref';
      ticketType = 'Transponder';
    } else if (barcodeUpper.startsWith('GAS')) {
      ticketColumn = 'ticket_fuel_ref';
      ticketType = 'Fuel';
    } else {
      return res.json({ success: false, error: 'Invalid barcode format' });
    }
    
    // Find entry with this ticket
    const result = await pool.query(`
      SELECT re.entry_id, re.driver_id, re.race_class, re.engine_serial,
             d.first_name, d.last_name, d.race_number, d.transponder_number
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE re.${ticketColumn} = $1
      ORDER BY re.created_at DESC
      LIMIT 1
    `, [barcodeUpper]);
    
    if (result.rows.length === 0) {
      return res.json({ success: false, error: 'No entry found for this ticket' });
    }
    
    const entry = result.rows[0];
    
    // Log the ticket lookup scan
    await logEquipmentScan({
      scan_type: 'ticket_lookup',
      barcode_scanned: barcodeUpper,
      entry_id: entry.entry_id,
      driver_id: entry.driver_id,
      driver_name: `${entry.first_name} ${entry.last_name}`,
      scanned_by: 'System', // Will be replaced with PIN login in future
      action_result: 'success',
      notes: `Looked up ${ticketType} ticket`,
      race_class: entry.race_class
    });
    
    res.json({
      success: true,
      driver: {
        driver_id: entry.driver_id,
        entry_id: entry.entry_id,
        first_name: entry.first_name,
        last_name: entry.last_name,
        race_class: entry.race_class,
        race_number: entry.race_number,
        transponder_number: entry.transponder_number
      },
      ticket: {
        barcode: barcodeUpper,
        type: ticketType,
        engine_serial: entry.engine_serial
      }
    });
  } catch (err) {
    console.error('Error looking up ticket:', err);
    res.json({ success: false, error: err.message });
  }
});

// Assign engine to driver
app.post('/api/assignEngine', async (req, res) => {
  try {
    const { ticketBarcode, engineSerial, driverId, entryId } = req.body;
    
    if (!ticketBarcode || !engineSerial || !driverId || !entryId) {
      return res.json({ success: false, error: 'Missing required fields' });
    }
    
    // Check if engine is already assigned to someone else
    const existingAssignment = await pool.query(`
      SELECT re.entry_id, d.first_name, d.last_name
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE re.engine_serial = $1 AND re.engine_returned = false
    `, [engineSerial.toUpperCase()]);
    
    if (existingAssignment.rows.length > 0) {
      const existing = existingAssignment.rows[0];
      return res.json({ 
        success: false, 
        error: `Engine ${engineSerial} is already assigned to ${existing.first_name} ${existing.last_name}` 
      });
    }
    
    // Assign engine to this entry
    const assignResult = await pool.query(`
      UPDATE race_entries 
      SET engine_serial = $1, 
          engine_assigned_at = NOW(),
          engine_returned = false,
          updated_at = NOW()
      WHERE entry_id = $2
      RETURNING driver_id, race_class, event_id
    `, [engineSerial.toUpperCase(), entryId]);
    
    // Get driver name for log
    const driverInfo = await pool.query(`
      SELECT first_name, last_name FROM drivers WHERE driver_id = $1
    `, [driverId]);
    
    const driverName = driverInfo.rows[0] ? `${driverInfo.rows[0].first_name} ${driverInfo.rows[0].last_name}` : 'Unknown';
    
    // Log the scan
    await logEquipmentScan({
      scan_type: 'engine_assign',
      barcode_scanned: ticketBarcode,
      entry_id: entryId,
      driver_id: driverId,
      driver_name: driverName,
      equipment_serial: engineSerial.toUpperCase(),
      scanned_by: 'System',
      action_result: 'success',
      notes: `Engine ${engineSerial} assigned`,
      event_id: assignResult.rows[0]?.event_id,
      race_class: assignResult.rows[0]?.race_class
    });
    
    console.log(`✅ Engine ${engineSerial} assigned to driver ${driverId} (Entry: ${entryId})`);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error assigning engine:', err);
    res.json({ success: false, error: err.message });
  }
});

// Return engine
app.post('/api/returnEngine', async (req, res) => {
  try {
    const { engineSerial } = req.body;
    
    if (!engineSerial) {
      return res.json({ success: false, error: 'Engine serial required' });
    }
    
    // Find assignment
    const result = await pool.query(`
      SELECT re.entry_id, d.first_name, d.last_name
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE re.engine_serial = $1 AND re.engine_returned = false
    `, [engineSerial.toUpperCase()]);
    
    if (result.rows.length === 0) {
      return res.json({ success: false, error: 'No active assignment found for this engine' });
    }
    
    // Mark engine as returned
    const returnResult = await pool.query(`
      UPDATE race_entries 
      SET engine_returned = true,
          engine_returned_at = NOW(),
          updated_at = NOW()
      WHERE engine_serial = $1 AND engine_returned = false
      RETURNING entry_id, driver_id, event_id, race_class
    `, [engineSerial.toUpperCase()]);
    
    const driverName = `${result.rows[0].first_name} ${result.rows[0].last_name}`;
    
    // Log the scan
    await logEquipmentScan({
      scan_type: 'engine_return',
      barcode_scanned: engineSerial.toUpperCase(),
      entry_id: returnResult.rows[0]?.entry_id,
      driver_id: returnResult.rows[0]?.driver_id,
      driver_name: driverName,
      equipment_serial: engineSerial.toUpperCase(),
      scanned_by: 'System',
      action_result: 'success',
      notes: `Engine ${engineSerial} returned`,
      event_id: returnResult.rows[0]?.event_id,
      race_class: returnResult.rows[0]?.race_class
    });
    
    console.log(`✅ Engine ${engineSerial} returned from ${driverName}`);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error returning engine:', err);
    res.json({ success: false, error: err.message });
  }
});

// Report engine issue
app.post('/api/reportEngineIssue', async (req, res) => {
  try {
    const { engineSerial, issueDescription } = req.body;
    
    if (!engineSerial || !issueDescription) {
      return res.json({ success: false, error: 'Engine serial and issue description required' });
    }
    
    // Find assignment
    const result = await pool.query(`
      SELECT re.entry_id, re.driver_id, d.first_name, d.last_name
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE re.engine_serial = $1 AND re.engine_returned = false
    `, [engineSerial.toUpperCase()]);
    
    if (result.rows.length === 0) {
      return res.json({ success: false, error: 'No active assignment found for this engine' });
    }
    
    const entry = result.rows[0];
    
    // Mark engine as returned with issue
    await pool.query(`
      UPDATE race_entries 
      SET engine_returned = true,
          engine_returned_at = NOW(),
          engine_issue = $2,
          updated_at = NOW()
      WHERE engine_serial = $1 AND engine_returned = false
    `, [engineSerial.toUpperCase(), issueDescription]);
    
    console.log(`⚠️ Engine ${engineSerial} reported with issue: ${issueDescription}`);
    
    res.json({ 
      success: true,
      driverId: entry.driver_id,
      entryId: entry.entry_id
    });
  } catch (err) {
    console.error('Error reporting engine issue:', err);
    res.json({ success: false, error: err.message });
  }
});

// Assign replacement engine
app.post('/api/assignReplacementEngine', async (req, res) => {
  try {
    const { replacementSerial, returnedSerial, driverId, entryId } = req.body;
    
    if (!replacementSerial || !returnedSerial || !driverId || !entryId) {
      return res.json({ success: false, error: 'Missing required fields' });
    }
    
    // Check if replacement engine is already assigned
    const existingAssignment = await pool.query(`
      SELECT re.entry_id, d.first_name, d.last_name
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE re.engine_serial = $1 AND re.engine_returned = false
    `, [replacementSerial.toUpperCase()]);
    
    if (existingAssignment.rows.length > 0) {
      const existing = existingAssignment.rows[0];
      return res.json({ 
        success: false, 
        error: `Engine ${replacementSerial} is already assigned to ${existing.first_name} ${existing.last_name}` 
      });
    }
    
    // Assign replacement engine
    await pool.query(`
      UPDATE race_entries 
      SET engine_serial = $1, 
          engine_assigned_at = NOW(),
          engine_returned = false,
          replacement_for = $3,
          updated_at = NOW()
      WHERE entry_id = $2
    `, [replacementSerial.toUpperCase(), entryId, returnedSerial.toUpperCase()]);
    
    console.log(`✅ Replacement engine ${replacementSerial} assigned (replaced ${returnedSerial})`);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error assigning replacement engine:', err);
    res.json({ success: false, error: err.message });
  }
});

// Assign transponder
app.post('/api/assignTransponder', async (req, res) => {
  try {
    const { ticketBarcode, transponderSerial, driverId, entryId } = req.body;
    
    if (!ticketBarcode || !transponderSerial || !driverId || !entryId) {
      return res.json({ success: false, error: 'Missing required fields' });
    }
    
    const txResult = await pool.query(`
      UPDATE race_entries 
      SET transponder_serial = $1,
          transponder_assigned_at = NOW(),
          updated_at = NOW()
      WHERE entry_id = $2
      RETURNING driver_id, race_class, event_id
    `, [transponderSerial.toUpperCase(), entryId]);
    
    const driverInfo = await pool.query(`
      SELECT first_name, last_name FROM drivers WHERE driver_id = $1
    `, [driverId]);
    
    const driverName = driverInfo.rows[0] ? `${driverInfo.rows[0].first_name} ${driverInfo.rows[0].last_name}` : 'Unknown';
    
    await logEquipmentScan({
      scan_type: 'transponder_assign',
      barcode_scanned: ticketBarcode,
      entry_id: entryId,
      driver_id: driverId,
      driver_name: driverName,
      equipment_serial: transponderSerial.toUpperCase(),
      scanned_by: 'System',
      action_result: 'success',
      notes: `Transponder ${transponderSerial} assigned`,
      event_id: txResult.rows[0]?.event_id,
      race_class: txResult.rows[0]?.race_class
    });
    
    console.log(`✅ Transponder ${transponderSerial} assigned to driver ${driverId}`);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error assigning transponder:', err);
    res.json({ success: false, error: err.message });
  }
});

// Assign tyres (4 required)
app.post('/api/assignTyres', async (req, res) => {
  try {
    const { ticketBarcode, tyres, driverId, entryId } = req.body;
    
    if (!ticketBarcode || !tyres || !driverId || !entryId) {
      return res.json({ success: false, error: 'Missing required fields' });
    }
    
    const { front_left, front_right, rear_left, rear_right } = tyres;
    
    if (!front_left || !front_right || !rear_left || !rear_right) {
      return res.json({ success: false, error: 'All 4 tyre serials required' });
    }
    
    const tyreResult = await pool.query(`
      UPDATE race_entries 
      SET tyre_front_left = $1,
          tyre_front_right = $2,
          tyre_rear_left = $3,
          tyre_rear_right = $4,
          tyres_registered_at = NOW(),
          updated_at = NOW()
      WHERE entry_id = $5
      RETURNING driver_id, race_class, event_id
    `, [front_left.toUpperCase(), front_right.toUpperCase(), rear_left.toUpperCase(), rear_right.toUpperCase(), entryId]);
    
    const driverInfo = await pool.query(`
      SELECT first_name, last_name FROM drivers WHERE driver_id = $1
    `, [driverId]);
    
    const driverName = driverInfo.rows[0] ? `${driverInfo.rows[0].first_name} ${driverInfo.rows[0].last_name}` : 'Unknown';
    
    await logEquipmentScan({
      scan_type: 'tyres_register',
      barcode_scanned: ticketBarcode,
      entry_id: entryId,
      driver_id: driverId,
      driver_name: driverName,
      equipment_serial: `FL:${front_left} FR:${front_right} RL:${rear_left} RR:${rear_right}`,
      scanned_by: 'System',
      action_result: 'success',
      notes: `4 tyres registered`,
      event_id: tyreResult.rows[0]?.event_id,
      race_class: tyreResult.rows[0]?.race_class
    });
    
    console.log(`✅ Tyres registered for driver ${driverId}: FL:${front_left}, FR:${front_right}, RL:${rear_left}, RR:${rear_right}`);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error assigning tyres:', err);
    res.json({ success: false, error: err.message });
  }
});

// Mark fuel collected
app.post('/api/markFuelCollected', async (req, res) => {
  try {
    const { ticketBarcode, driverId, entryId } = req.body;
    
    if (!ticketBarcode || !driverId || !entryId) {
      return res.json({ success: false, error: 'Missing required fields' });
    }
    
    const fuelResult = await pool.query(`
      UPDATE race_entries 
      SET fuel_collected = true,
          fuel_collected_at = NOW(),
          updated_at = NOW()
      WHERE entry_id = $1
      RETURNING driver_id, race_class, event_id
    `, [entryId]);
    
    const driverInfo = await pool.query(`
      SELECT first_name, last_name FROM drivers WHERE driver_id = $1
    `, [driverId]);
    
    const driverName = driverInfo.rows[0] ? `${driverInfo.rows[0].first_name} ${driverInfo.rows[0].last_name}` : 'Unknown';
    
    await logEquipmentScan({
      scan_type: 'fuel_collect',
      barcode_scanned: ticketBarcode,
      entry_id: entryId,
      driver_id: driverId,
      driver_name: driverName,
      scanned_by: 'System',
      action_result: 'success',
      notes: 'Fuel collected',
      event_id: fuelResult.rows[0]?.event_id,
      race_class: fuelResult.rows[0]?.race_class
    });
    
    console.log(`✅ Fuel marked as collected for driver ${driverId}`);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error marking fuel collected:', err);
    res.json({ success: false, error: err.message });
  }
});

// Titan Terminal Authentication
app.post('/titan/authenticate', (req, res) => {
  const { password } = req.body;
  const TITAN_PASSWORD = 'titan2026'; // Change this to your preferred password
  
  if (password === TITAN_PASSWORD) {
    res.status(200).json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

// Get equipment scan log with limit
app.get('/api/getEquipmentScanLog', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    
    const result = await pool.query(`
      SELECT 
        log_id,
        scan_timestamp,
        scan_type,
        barcode_scanned,
        entry_id,
        driver_id,
        driver_name,
        equipment_serial,
        scanned_by,
        action_result,
        notes,
        event_id,
        race_class
      FROM equipment_scan_log
      ORDER BY scan_timestamp DESC
      LIMIT $1
    `, [limit]);
    
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching equipment scan log:', err);
    res.status(500).json({ error: 'Failed to load scan log' });
  }
});

// Get engine history
app.get('/api/engineHistory', async (req, res) => {
  try {
    const { engineSerial } = req.query;
    
    if (!engineSerial) {
      return res.json({ success: false, error: 'Engine serial required' });
    }
    
    const result = await pool.query(`
      SELECT re.entry_id, re.engine_serial, re.engine_assigned_at, re.engine_returned, 
             re.engine_returned_at, re.engine_issue, re.replacement_for, re.race_class,
             d.first_name, d.last_name,
             CONCAT(d.first_name, ' ', d.last_name) as driver_name
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE re.engine_serial = $1
      ORDER BY re.engine_assigned_at DESC
    `, [engineSerial.toUpperCase()]);
    
    res.json({ 
      success: true, 
      history: result.rows,
      count: result.rows.length 
    });
  } catch (err) {
    console.error('Error getting engine history:', err);
    res.json({ success: false, error: err.message });
  }
});

// Lookup driver by race number for tyre verification
app.get('/api/lookupDriverByNumber', async (req, res) => {
  try {
    const { raceNumber } = req.query;
    
    if (!raceNumber) {
      return res.json({ success: false, error: 'Race number required' });
    }
    
    // Find most recent entry for this driver
    const result = await pool.query(`
      SELECT re.entry_id, re.driver_id, re.race_class,
             re.tyre_front_left, re.tyre_front_right, re.tyre_rear_left, re.tyre_rear_right,
             d.first_name, d.last_name, d.race_number
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE d.race_number = $1
      ORDER BY re.created_at DESC
      LIMIT 1
    `, [raceNumber]);
    
    if (result.rows.length === 0) {
      return res.json({ success: false, error: 'No entry found for this race number' });
    }
    
    const entry = result.rows[0];
    const tyresRegistered = entry.tyre_front_left && entry.tyre_front_right && 
                            entry.tyre_rear_left && entry.tyre_rear_right;
    
    res.json({
      success: true,
      driver: {
        driver_id: entry.driver_id,
        entry_id: entry.entry_id,
        first_name: entry.first_name,
        last_name: entry.last_name,
        race_number: entry.race_number,
        race_class: entry.race_class
      },
      registered_tyres: tyresRegistered,
      tyres: tyresRegistered ? {
        front_left: entry.tyre_front_left,
        front_right: entry.tyre_front_right,
        rear_left: entry.tyre_rear_left,
        rear_right: entry.tyre_rear_right
      } : null
    });
  } catch (err) {
    console.error('Error looking up driver:', err);
    res.json({ success: false, error: err.message });
  }
});

// Equipment tracking - search by driver name or race number
app.get('/api/equipmentTracking', async (req, res) => {
  try {
    const { search } = req.query;
    
    if (!search) {
      return res.json({ success: false, error: 'Search term required' });
    }
    
    const searchTerm = `%${search}%`;
    
    // Search by driver name or race number
    const result = await pool.query(`
      SELECT re.entry_id, re.driver_id, re.race_class, re.created_at,
             re.engine_serial, re.engine_assigned_at, re.engine_returned, 
             re.engine_returned_at, re.engine_issue,
             re.tyre_front_left, re.tyre_front_right, re.tyre_rear_left, re.tyre_rear_right,
             re.tyres_registered_at,
             re.transponder_serial, re.transponder_assigned_at,
             re.fuel_collected, re.fuel_collected_at,
             d.first_name, d.last_name, d.race_number,
             CONCAT(d.first_name, ' ', d.last_name) as driver_name,
             e.event_name
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      LEFT JOIN events e ON re.event_id = e.event_id
      WHERE CONCAT(d.first_name, ' ', d.last_name) ILIKE $1
         OR d.race_number::text = $2
      ORDER BY re.created_at DESC
    `, [searchTerm, search]);
    
    res.json({ 
      success: true, 
      entries: result.rows,
      count: result.rows.length 
    });
  } catch (err) {
    console.error('Error getting equipment tracking:', err);
    res.json({ success: false, error: err.message });
  }
});

// Get equipment grouped by driver for an event
app.get('/api/equipmentByDriver', async (req, res) => {
  try {
    const { event_id } = req.query;
    
    if (!event_id) {
      return res.json({ success: false, error: 'Event ID required' });
    }
    
    const result = await pool.query(`
      SELECT re.entry_id, re.driver_id, re.race_class,
             re.ticket_engine_ref, re.ticket_tyres_ref, re.ticket_transponder_ref, re.ticket_fuel_ref,
             re.engine_serial, re.engine_assigned_at, re.engine_returned, 
             re.tyre_front_left, re.tyre_front_right, re.tyre_rear_left, re.tyre_rear_right,
             re.tyres_registered_at,
             re.transponder_serial, re.transponder_assigned_at,
             re.fuel_collected, re.fuel_collected_at,
             CONCAT(d.first_name, ' ', d.last_name) as driver_name,
             d.race_number
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE re.event_id = $1 AND re.entry_status != 'cancelled'
      ORDER BY d.last_name, d.first_name
    `, [event_id]);
    
    res.json({ 
      success: true, 
      entries: result.rows 
    });
  } catch (err) {
    console.error('Error getting equipment by driver:', err);
    res.json({ success: false, error: err.message });
  }
});

// Get equipment grouped by item type for an event
app.get('/api/equipmentByItem', async (req, res) => {
  try {
    const { event_id } = req.query;
    
    if (!event_id) {
      return res.json({ success: false, error: 'Event ID required' });
    }
    
    // Get engines currently out (not returned)
    const enginesResult = await pool.query(`
      SELECT re.engine_serial, re.engine_assigned_at, re.race_class,
             CONCAT(d.first_name, ' ', d.last_name) as driver_name,
             d.race_number
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE re.event_id = $1 
        AND re.engine_serial IS NOT NULL 
        AND re.engine_returned = false
      ORDER BY re.engine_assigned_at DESC
    `, [event_id]);
    
    // Get transponders currently out
    const transpondersResult = await pool.query(`
      SELECT re.transponder_serial, re.transponder_assigned_at, re.race_class,
             CONCAT(d.first_name, ' ', d.last_name) as driver_name,
             d.race_number
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      WHERE re.event_id = $1 
        AND re.transponder_serial IS NOT NULL
      ORDER BY re.transponder_assigned_at DESC
    `, [event_id]);
    
    res.json({ 
      success: true, 
      equipment: {
        engines: enginesResult.rows,
        transponders: transpondersResult.rows
      }
    });
  } catch (err) {
    console.error('Error getting equipment by item:', err);
    res.json({ success: false, error: err.message });
  }
});

// Handle 404 for API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, error: 'API endpoint not found' });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`✅ NATS Driver Registry server running on port ${PORT}`);
  console.log('🛡️ Global error handlers installed');
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    pool.end().then(() => {
      console.log('Database pool closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    pool.end().then(() => {
      console.log('Database pool closed');
      process.exit(0);
    });
  });
});
