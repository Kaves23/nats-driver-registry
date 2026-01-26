// Test Admin Notification System
// This script verifies that the admin notification queue is working correctly

const adminNotificationQueue = require('./adminNotificationQueue');

console.log('🧪 Testing Admin Notification System\n');

// Test 1: Single immediate notification
console.log('Test 1: Single immediate notification');
adminNotificationQueue.addNotification({
  action: 'Test Action',
  subject: '[TEST] Single immediate notification',
  details: {
    testId: 1,
    message: 'This is a test notification',
    timestamp: new Date().toLocaleString()
  }
});
console.log('✅ Immediate notification queued\n');

// Test 2: Multiple batched notifications (simulating rapid logins)
console.log('Test 2: Multiple batched notifications (simulating rapid logins)');
for (let i = 1; i <= 5; i++) {
  adminNotificationQueue.addToBatch({
    action: 'Login',
    subject: `[Login] Test User ${i}`,
    details: {
      userId: `test-${i}`,
      userName: `Test User ${i}`,
      timestamp: new Date().toLocaleString()
    }
  });
  console.log(`  • Batched login notification ${i}`);
}
console.log('✅ 5 login notifications batched\n');

// Test 3: Mixed notifications (immediate and batched)
console.log('Test 3: Mixed notifications (immediate and batched)');
adminNotificationQueue.addNotification({
  action: 'Profile Update',
  subject: '[Profile] Test User updated profile',
  details: {
    userId: 'test-123',
    userName: 'Test User',
    fieldsUpdated: 'first_name, last_name, email',
    timestamp: new Date().toLocaleString()
  }
});
console.log('  • Immediate profile update queued');

adminNotificationQueue.addToBatch({
  action: 'Page View',
  subject: '[Activity] Page view',
  details: {
    page: 'Driver Portal',
    timestamp: new Date().toLocaleString()
  }
});
console.log('  • Batched page view added\n');

console.log('📊 Queue Status:');
console.log(`  • Notifications in queue: ${adminNotificationQueue.queue.length}`);
console.log(`  • Batch size: ${adminNotificationQueue.batchedNotifications.length}`);
console.log(`  • Last email sent: ${adminNotificationQueue.lastSent ? new Date(adminNotificationQueue.lastSent).toLocaleString() : 'Never'}`);

console.log('\n⏳ Notifications will be sent according to rate limits:');
console.log('  • Minimum 5 seconds between emails');
console.log('  • Batched notifications sent every 30 seconds');
console.log('  • Check Mailchimp logs for delivery confirmation');

console.log('\n💡 To test in production:');
console.log('  1. Login to driver portal (batched notification)');
console.log('  2. Update profile (immediate notification)');
console.log('  3. Make pool engine rental payment (immediate notification)');
console.log('  4. Update medical information (immediate notification)');
console.log('\n✅ Test script complete - queue is running');
