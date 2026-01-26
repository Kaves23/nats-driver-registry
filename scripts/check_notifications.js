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

async function checkNotifications() {
  try {
    const countResult = await pool.query('SELECT COUNT(*) as total FROM notification_history');
    console.log('\n📊 Notification History Summary');
    console.log('================================');
    console.log(`Total notifications in database: ${countResult.rows[0].total}`);
    
    const recentResult = await pool.query('SELECT * FROM notification_history ORDER BY sent_at DESC LIMIT 10');
    
    if (recentResult.rows.length > 0) {
      console.log('\n📬 Most Recent Notifications:');
      console.log('----------------------------');
      recentResult.rows.forEach((n, i) => {
        console.log(`\n${i + 1}. [${n.notification_type}] ${n.title}`);
        console.log(`   To: ${n.driver_id || 'All drivers'}`);
        console.log(`   Event: ${n.event_name || 'N/A'}`);
        console.log(`   Sent: ${n.sent_at}`);
        if (n.body) console.log(`   Body: ${n.body.substring(0, 60)}...`);
      });
    } else {
      console.log('\n❌ No notifications found in database');
      console.log('   Notifications are being saved to the notification_history table');
      console.log('   but no notifications have been sent yet.');
    }
    
    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

checkNotifications();
