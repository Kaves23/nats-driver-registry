/**
 * Test Script: Timing CSV Export
 * Tests the export timing CSV functionality locally before deploying to live
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

async function testTimingCSVExport() {
  console.log('🧪 Testing Timing CSV Export...\n');

  try {
    // 1. Get next event
    console.log('1️⃣ Fetching next event...');
    const eventResult = await pool.query(
      `SELECT event_id, event_name, event_date 
       FROM events 
       WHERE event_date >= CURRENT_DATE
       ORDER BY event_date ASC
       LIMIT 1`
    );

    if (eventResult.rows.length === 0) {
      console.log('❌ No upcoming races found');
      return;
    }

    const event = eventResult.rows[0];
    console.log(`✅ Event found: ${event.event_name} (ID: ${event.event_id}) on ${event.event_date}`);

    // 2. Get driver data
    console.log('\n2️⃣ Fetching race entries...');
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
        d.championship,
        e.event_name,
        e.event_date,
        re.entry_status,
        re.payment_status
      FROM race_entries re
      JOIN drivers d ON re.driver_id = d.driver_id
      JOIN events e ON re.event_id = e.event_id
      LEFT JOIN contacts c ON d.driver_id = c.driver_id
      LEFT JOIN medical_consent mc ON d.driver_id = mc.driver_id
      WHERE re.event_id = $1
      AND re.entry_status IN ('confirmed', 'pending', 'pending_payment')
      ORDER BY d.class, d.first_name, d.last_name
    `, [event.event_id]);

    const drivers = driversResult.rows;
    console.log(`✅ Found ${drivers.length} race entries`);

    // 3. Test CSV generation for timing format
    console.log('\n3️⃣ Generating timing CSV...');
    
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
    
    const rows = drivers.map(d => {
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
    
    const csv = [headers.join(','), ...rows].join('\n');
    
    console.log('\n✅ CSV Generated Successfully!');
    console.log(`   Rows: ${rows.length}`);
    console.log(`   Size: ${csv.length} characters`);
    
    console.log('\n📋 Preview (first 3 rows):');
    console.log('━'.repeat(80));
    const previewLines = csv.split('\n').slice(0, 4);
    previewLines.forEach((line, i) => {
      if (i === 0) {
        console.log('HEADERS:', line);
      } else {
        console.log(`ROW ${i}:   `, line);
      }
    });
    console.log('━'.repeat(80));
    
    // 4. Check for common issues
    console.log('\n4️⃣ Checking for common issues...');
    
    let issuesFound = false;
    
    // Check for missing transponders
    const missingTransponders = drivers.filter(d => !d.transponder_number);
    if (missingTransponders.length > 0) {
      console.log(`⚠️  ${missingTransponders.length} drivers missing transponders (txpLong will be blank):`);
      missingTransponders.slice(0, 5).forEach(d => {
        console.log(`   - ${d.first_name} ${d.last_name} (${d.race_class || d.class})`);
      });
      if (missingTransponders.length > 5) {
        console.log(`   ... and ${missingTransponders.length - 5} more`);
      }
      issuesFound = true;
    }
    
    // Check for missing race numbers
    const missingRaceNumbers = drivers.filter(d => !d.entry_race_number && !d.race_number);
    if (missingRaceNumbers.length > 0) {
      console.log(`⚠️  ${missingRaceNumbers.length} drivers missing race numbers:`);
      missingRaceNumbers.slice(0, 3).forEach(d => {
        console.log(`   - ${d.first_name} ${d.last_name} (${d.race_class || d.class})`);
      });
      issuesFound = true;
    }
    
    // Check for unknown nationalities
    const unknownNationalities = drivers
      .filter(d => d.nationality && !countryCodeMap[d.nationality])
      .map(d => d.nationality);
    const uniqueUnknown = [...new Set(unknownNationalities)];
    if (uniqueUnknown.length > 0) {
      console.log(`⚠️  Unknown nationality codes (will use RSA as default):`);
      uniqueUnknown.forEach(nat => {
        console.log(`   - "${nat}"`);
      });
      issuesFound = true;
    }
    
    if (!issuesFound) {
      console.log('✅ No issues found!');
    }
    
    console.log('\n✅ Test completed successfully!');
    
  } catch (err) {
    console.error('\n❌ Test failed with error:');
    console.error('   Error:', err.message);
    console.error('   Stack:', err.stack);
  } finally {
    await pool.end();
  }
}

// Run the test
testTimingCSVExport();
