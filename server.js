require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcryptjs = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const path = require('path');

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, '.')));

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

// Initialize audit log table if it doesn't exist
const initAuditTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        driver_id VARCHAR(255),
        driver_email VARCHAR(255),
        action VARCHAR(255),
        field_name VARCHAR(255),
        old_value TEXT,
        new_value TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ip_address VARCHAR(50)
      )
    `);
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

initAuditTable();
initMessagesTable();

// Log audit event
const logAuditEvent = async (driver_id, driver_email, action, field_name, old_value, new_value, ip_address = 'unknown') => {
  try {
    await pool.query(
      `INSERT INTO audit_log (driver_id, driver_email, action, field_name, old_value, new_value, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [driver_id, driver_email, action, field_name, old_value, new_value, ip_address]
    );
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
};

// Health check
app.get('/api/ping', (req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
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
    const { driver_id, pin } = req.body;
    if (!driver_id || !pin) throw new Error('Missing required fields');

    const result = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    const driver = result.rows[0];
    if (!driver) throw new Error('Driver not found');

    const pinMatch = await bcryptjs.compare(pin, driver.pin_hash || '');
    if (!pinMatch) throw new Error('Invalid PIN');

    const contacts = await pool.query('SELECT * FROM contacts WHERE driver_id = $1', [driver_id]);
    const medical = await pool.query('SELECT * FROM medical_consent WHERE driver_id = $1', [driver_id]);
    const points = await pool.query('SELECT * FROM points WHERE driver_id = $1', [driver_id]);

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

    const pinMatch = await bcryptjs.compare(pin, driver.pin_hash || '');
    if (!pinMatch) throw new Error('Invalid PIN');

    const contacts = await pool.query('SELECT * FROM contacts WHERE driver_id = $1', [driver_id]);
    const medical = await pool.query('SELECT * FROM medical_consent WHERE driver_id = $1', [driver_id]);
    const points = await pool.query('SELECT * FROM points WHERE driver_id = $1', [driver_id]);

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
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Login with password endpoint (for frontend compatibility)
app.post('/api/loginWithPassword', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) throw new Error('Email and password required');

    const contactResult = await pool.query('SELECT driver_id FROM contacts WHERE email = $1', [email.toLowerCase()]);
    if (contactResult.rows.length === 0) throw new Error('Email not found');

    const driver_id = contactResult.rows[0].driver_id;
    const result = await pool.query('SELECT * FROM drivers WHERE driver_id = $1', [driver_id]);
    const driver = result.rows[0];
    if (!driver) throw new Error('Driver not found');

    const passwordMatch = await bcryptjs.compare(password, driver.password_hash || '');
    if (!passwordMatch) throw new Error('Invalid password');

    const contacts = await pool.query('SELECT * FROM contacts WHERE driver_id = $1', [driver_id]);
    const medical = await pool.query('SELECT * FROM medical_consent WHERE driver_id = $1', [driver_id]);
    const points = await pool.query('SELECT * FROM points WHERE driver_id = $1', [driver_id]);

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
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Register new driver
app.post('/api/registerDriver', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      first_name, last_name, date_of_birth, nationality, gender, id_or_passport_number,
      championship, class: klass, race_number, team_name, coach_name, kart_brand, engine_type, transponder_number,
      consent_signed, media_release_signed,
      medical, contacts,
      license_b64, license_name, license_mime,
      photo_b64, photo_name, photo_mime
    } = req.body;

    const driver_id = uuidv4();
    const pin = Math.floor(100000 + Math.random() * 900000).toString();

    await client.query('BEGIN');

    // Insert driver with just basic fields that definitely exist
    await client.query(
      `INSERT INTO drivers (driver_id, first_name, last_name, status)
      VALUES ($1, $2, $3, $4)`,
      [driver_id, first_name, last_name, 'Pending']
    );

    // Try to update with additional optional fields
    try {
      await client.query(
        `UPDATE drivers SET date_of_birth = $1, nationality = $2, gender = $3,
          id_or_passport_number = $4, championship = $5, class = $6, race_number = $7,
          team_name = $8, coach_name = $9, kart_brand = $10, engine_type = $11,
          transponder_number = $12
        WHERE driver_id = $13`,
        [date_of_birth, nationality, gender, id_or_passport_number, championship, klass,
          race_number, team_name, coach_name, kart_brand, engine_type, transponder_number, driver_id]
      );
    } catch (e) {
      console.log('Could not update additional driver fields:', e.message);
    }

    // Try to insert contacts
    if (contacts && contacts.length > 0) {
      for (const contact of contacts) {
        try {
          await client.query(
            `INSERT INTO contacts (driver_id, email)
            VALUES ($1, $2)`,
            [driver_id, contact.email]
          );
        } catch (e) {
          console.log('Could not insert contact:', e.message);
        }
      }
    }

    // Try to insert medical consent
    if (medical) {
      try {
        await client.query(
          `INSERT INTO medical_consent (driver_id, allergies, medical_conditions, medication)
          VALUES ($1, $2, $3, $4)`,
          [driver_id, medical.allergies, medical.medical_conditions, medical.medication]
        );
      } catch (e) {
        console.log('Could not insert medical consent:', e.message);
      }
    }

    await client.query('COMMIT');
    
    res.json({
      success: true,
      data: {
        driver_id: driver_id,
        pin: pin,
        status: 'Pending',
        message: 'Registration submitted. Your registration is pending admin approval.'
      }
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback error:', rollbackErr);
    }
    res.status(400).json({ success: false, error: { message: err.message } });
  } finally {
    client.release();
  }
});

// Request password reset
app.post('/api/requestPasswordReset', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) throw new Error('Email is required');

    const contactResult = await pool.query(
      'SELECT driver_id FROM contacts WHERE email = $1',
      [email.toLowerCase()]
    );

    // Always return generic success for security
    if (contactResult.rows.length === 0) {
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

    // Send email
    const resetLink = `https://rokthenats.co.za/reset-password.html?token=${reset_token}&email=${encodeURIComponent(email)}`;
    await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
      key: process.env.MAILCHIMP_API_KEY,
      message: {
        to: [{ email: email }],
        from_email: process.env.MAILCHIMP_FROM_EMAIL,
        subject: 'Reset Your NATS Driver Registry Password',
        html: `<p>Click the link below to reset your password:</p><p><a href="${resetLink}">Reset Password</a></p><p>This link expires in 1 hour.</p>`
      }
    }).catch(err => console.error('Email error:', err.message));

    res.json({
      success: true,
      data: { message: 'If that email exists, a reset link has been sent.' }
    });
  } catch (err) {
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

    res.json({
      success: true,
      data: { message: 'Password reset successfully. You can now log in with your new password.' }
    });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Store payment
app.post('/api/storePayment', async (req, res) => {
  try {
    const { driver_id, amount, status, reference } = req.body;
    if (!driver_id || !amount) throw new Error('Missing required fields');

    await pool.query(
      `INSERT INTO payments (driver_id, amount, status, reference, payment_date)
      VALUES ($1, $2, $3, $4, NOW())`,
      [driver_id, amount, status || 'Pending', reference]
    );

    res.json({ success: true, data: { message: 'Payment recorded' } });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get payment history
app.post('/api/getPaymentHistory', async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) throw new Error('Driver ID required');

    const result = await pool.query(
      'SELECT * FROM payments WHERE driver_id = $1 ORDER BY payment_date DESC',
      [driver_id]
    );

    res.json({
      success: true,
      data: { payments: result.rows }
    });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Update Driver Profile
// Contact Admin
app.post('/api/contactAdmin', async (req, res) => {
  try {
    const { driver_id, name, email, registered_email, phone, subject, message } = req.body;
    if (!driver_id || !email || !subject || !message) throw new Error('Missing required fields');

    console.log('📧 Contact Admin request from:', email, 'Account:', registered_email, 'Subject:', subject);

    // Save message to database
    await pool.query(
      `INSERT INTO admin_messages (driver_id, driver_name, driver_email, registered_email, driver_phone, subject, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [driver_id, name || 'Unknown', email, registered_email || email, phone || '', subject, message]
    );

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
            <p><a href="http://localhost:3000/admin.html">View in Admin Panel</a></p>
          `
        }
      });
    } catch (emailErr) {
      console.warn('Failed to send email notification:', emailErr.message);
      // Don't fail the request if email fails
    }

    res.json({ success: true, data: { message: 'Your request has been sent to the admin' } });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Get Admin Messages
app.post('/api/getAdminMessages', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM admin_messages ORDER BY created_at DESC`
    );
    res.json({ success: true, data: { messages: result.rows } });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Mark message as read
app.post('/api/markMessageAsRead', async (req, res) => {
  try {
    const { message_id } = req.body;
    if (!message_id) throw new Error('Missing message_id');

    await pool.query(
      `UPDATE admin_messages SET read_status = TRUE WHERE id = $1`,
      [message_id]
    );
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
app.post('/api/getAuditLog', async (req, res) => {
  try {
    const { driver_id, limit = 100, offset = 0 } = req.body;
    
    let query = 'SELECT * FROM audit_log';
    let params = [];
    
    if (driver_id) {
      query += ' WHERE driver_id = $1';
      params.push(driver_id);
      query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);
    } else {
      query += ' ORDER BY timestamp DESC LIMIT $1 OFFSET $2';
      params.push(limit, offset);
    }

    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      data: {
        logs: result.rows,
        total: result.rows.length
      }
    });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// Set Driver Profile
app.post('/api/setDriverPassword', async (req, res) => {
  try {
    const { driver_id, password } = req.body;
    if (!driver_id || !password) throw new Error('Driver ID and password required');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');

    const password_hash = await bcryptjs.hash(password, 10);
    await pool.query(
      'UPDATE drivers SET password_hash = $1 WHERE driver_id = $2',
      [password_hash, driver_id]
    );

    res.json({ success: true, data: { message: 'Password set successfully' } });
  } catch (err) {
    res.status(400).json({ success: false, error: { message: err.message } });
  }
});

// PayFast ITN webhook
app.post('/api/payfast-itn', async (req, res) => {
  try {
    const { m_payment_id, payment_status, custom_str1 } = req.body;
    // Update payment record if it exists - don't assume column names
    if (payment_status === 'COMPLETE') {
      try {
        // Try to update a generic column that might track payment completion
        await pool.query(
          'UPDATE payments SET updated_at = NOW() WHERE reference = $1',
          [m_payment_id]
        );
      } catch (e) {
        console.log('Could not update payment status:', e.message);
        // Silently fail - payments table might have different schema
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

    // Hash a simple PIN for testing
    const pin = '123456';
    const pin_hash = await bcryptjs.hash(pin, 10);

    let driverId;
    try {
      const result = await pool.query(
        `INSERT INTO drivers (first_name, last_name, class, race_number, team_name, coach_name, kart_brand, engine_type, transponder_number, pin_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING driver_id`,
        [testDriver.first_name, testDriver.last_name, testDriver.class, testDriver.race_number, 
         testDriver.team_name, testDriver.coach_name, testDriver.kart_brand, testDriver.engine_type,
         testDriver.transponder_number, pin_hash]
      );
      driverId = result.rows[0].driver_id;
    } catch (e) {
      console.log('Full driver insert failed for test driver, trying basic fields:', e.message);
      // Try with minimal fields
      const result = await pool.query(
        `INSERT INTO drivers (first_name, last_name, pin_hash)
         VALUES ($1, $2, $3)
         RETURNING driver_id`,
        [testDriver.first_name, testDriver.last_name, pin_hash]
      );
      driverId = result.rows[0].driver_id;
    }

    console.log('Created test driver with ID:', driverId);

    // Create test contact with email - try with different column combinations
    try {
      await pool.query(
        `INSERT INTO contacts (driver_id, email, full_name, phone_mobile)
         VALUES ($1, $2, $3, $4)`,
        [driverId, 'test@example.com', 'Test Driver', '555-0000']
      );
    } catch (e) {
      console.log('Full contact insert failed, trying minimal fields:', e.message);
      try {
        // Try with just driver_id and email
        await pool.query(
          `INSERT INTO contacts (driver_id, email)
           VALUES ($1, $2)`,
          [driverId, 'test@example.com']
        );
      } catch (e2) {
        console.log('Could not create contact:', e2.message);
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
    console.error('create-test-driver error:', err.message);
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

    // Just get all drivers - let database return what it has
    const driverResult = await pool.query('SELECT * FROM drivers LIMIT 1000');
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

    // Get emails from contacts table
    let emailMap = {};
    try {
      const contactResult = await pool.query(
        'SELECT driver_id, email FROM contacts WHERE driver_id = ANY($1)',
        [driverIds]
      );
      console.log('Found', contactResult.rows.length, 'contact emails');
      contactResult.rows.forEach(c => {
        if (!emailMap[c.driver_id]) {
          emailMap[c.driver_id] = c.email;
        }
      });
      console.log('Email map:', emailMap);
    } catch (e) {
      console.log('Contacts query failed:', e.message);
    }

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

    // Build driver list with only data we know exists
    let drivers = driverResult.rows.map(d => {
      const obj = {
        driver_id: d.driver_id,
        first_name: d.first_name || '',
        last_name: d.last_name || '',
        driver_email: emailMap[d.driver_id] || '',
        paid_status: paidSet.has(d.driver_id) ? 'Paid' : 'Unpaid'
      };
      
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
      paid_engine_fee, next_race_entry_status, next_race_engine_rental_status 
    } = req.body;
    
    console.log('updateDriver request received');
    console.log('driver_id:', driver_id);
    
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

      for (const change of fieldsChanged) {
        await logAuditEvent(driver_id, email || 'system', 'UPDATE_PROFILE', change.field, String(change.old || ''), String(change.new || ''));
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
    await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
      key: process.env.MAILCHIMP_API_KEY,
      message: {
        to: [{ email: email }],
        from_email: process.env.MAILCHIMP_FROM_EMAIL,
        subject: 'Reset Your NATS Driver Registry Password',
        html: `<p>Your admin has requested a password reset. Click the link below:</p><p><a href="${resetLink}">Reset Password</a></p><p>This link expires in 1 hour.</p>`
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
      orderBy = ' ORDER BY timestamp DESC';
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

// Serve static files from the project root (AFTER all API routes)
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NATS Driver Registry server running on port ${PORT}`);
});

