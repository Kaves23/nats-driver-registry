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

async function addDummyPointsData() {
  try {
    console.log('🔍 Finding driver win@rokthenats.co.za...');
    
    // Find the driver via contacts table (email is stored there)
    const contactResult = await pool.query(
      `SELECT driver_id FROM contacts WHERE email = $1`,
      ['win@rokthenats.co.za']
    );
    
    if (contactResult.rows.length === 0) {
      console.error('❌ Email not found in contacts: win@rokthenats.co.za');
      process.exit(1);
    }
    
    const driverId = contactResult.rows[0].driver_id;
    
    // Get driver details
    const driverResult = await pool.query(
      `SELECT driver_id, first_name, last_name, class, championship 
       FROM drivers 
       WHERE driver_id = $1`,
      [driverId]
    );
    
    if (driverResult.rows.length === 0) {
      console.error('❌ Driver not found with email win@rokthenats.co.za');
      process.exit(1);
    }
    
    const driver = driverResult.rows[0];
    console.log(`✅ Found driver: ${driver.first_name} ${driver.last_name} (${driver.driver_id})`);
    console.log(`   Class: ${driver.class}, Championship: ${driver.championship}`);
    
    // Check if data already exists
    const existingData = await pool.query(
      `SELECT * FROM points WHERE driver_id = $1 AND event = 'Killarney Round 1'`,
      [driver.driver_id]
    );
    
    if (existingData.rows.length > 0) {
      console.log('\n⚠️  Dummy data already exists! Updating instead...');
      
      await pool.query(
        `UPDATE points 
         SET qualifying_points = $1,
             heat1_points = $2,
             heat2_points = $3,
             final_points = $4,
             penalties_points = $5,
             total_points = $6,
             position = $7
         WHERE driver_id = $8 AND event = 'Killarney Round 1'`,
        [8, 7, 9, 10, 0, 34, '2nd', driver.driver_id]
      );
      
      console.log('✅ Updated existing dummy data');
    } else {
      // Get the max points_id to generate next ID (since SERIAL might not be working)
      const maxIdResult = await pool.query('SELECT MAX(points_id) as max_id FROM points');
      const nextId = (maxIdResult.rows[0].max_id || 0) + 1;
      
      // Insert dummy points data for February 14, 2026 race
      console.log('\n➕ Adding dummy points data for Killarney Round 1 (Feb 14, 2026)...');
      
      const dummyData = {
        points_id: nextId,
        driver_id: driver.driver_id,
        season: '2026',
        event: 'Killarney Round 1',
        round: 1,
        class: driver.class || 'MINI ROK',
        qualifying_points: 8,  // Top qualifying performance
        heat1_points: 7,        // Good heat results
        heat2_points: 9,
        final_points: 10,       // Strong final
        penalties_points: 0,    // No penalties
        total_points: 34,       // Sum of all points
        position: '2nd',        // Second place finish
        notes: 'Strong debut race! Excellent final performance.'
      };
      
      await pool.query(
        `INSERT INTO points 
         (points_id, driver_id, season, event, round, class, qualifying_points, 
          heat1_points, heat2_points, final_points, penalties_points, 
          total_points, position, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          dummyData.points_id,
          dummyData.driver_id,
          dummyData.season,
          dummyData.event,
          dummyData.round,
          dummyData.class,
          dummyData.qualifying_points,
          dummyData.heat1_points,
          dummyData.heat2_points,
          dummyData.final_points,
          dummyData.penalties_points,
          dummyData.total_points,
          dummyData.position,
          dummyData.notes
        ]
      );
      
      console.log('✅ Successfully added dummy points data!');
    }
    
    // Verify the data
    console.log('\n📋 Verifying data...');
    const verifyResult = await pool.query(
      `SELECT * FROM points WHERE driver_id = $1 ORDER BY created_at DESC`,
      [driver.driver_id]
    );
    
    console.log(`✅ Total points records for driver: ${verifyResult.rows.length}`);
    if (verifyResult.rows.length > 0) {
      console.log('\nLatest record:');
      console.log(`   Event: ${verifyResult.rows[0].event}`);
      console.log(`   Total Points: ${verifyResult.rows[0].total_points}`);
      console.log(`   Position: ${verifyResult.rows[0].position}`);
      console.log(`   Breakdown: Q:${verifyResult.rows[0].qualifying_points} H1:${verifyResult.rows[0].heat1_points} H2:${verifyResult.rows[0].heat2_points} F:${verifyResult.rows[0].final_points}`);
    }
    
    console.log('\n🎉 Done! You can now view the charts at:');
    console.log('   http://localhost:3000/driver_portal.html');
    console.log('   (Login with win@rokthenats.co.za and go to Points tab → Analytics view)');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
}

addDummyPointsData();
