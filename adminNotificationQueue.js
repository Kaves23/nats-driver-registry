// Admin Notification Queue System with Rate Limiting
// Prevents email flooding and site crashes

class AdminNotificationQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.lastSent = 0;
    this.minDelay = 5000; // Minimum 5 seconds between emails
    this.maxQueueSize = 100; // Maximum queue size
    this.batchInterval = 30000; // Batch notifications every 30 seconds
    this.batchedNotifications = [];
    this.batchTimer = null;
  }

  // Add notification to queue
  addNotification(notification) {
    // Prevent queue overflow
    if (this.queue.length >= this.maxQueueSize) {
      console.warn('⚠️ Admin notification queue full, dropping oldest notification');
      this.queue.shift();
    }

    this.queue.push({
      ...notification,
      timestamp: new Date(),
      id: Date.now() + Math.random()
    });

    // Start processing if not already running
    if (!this.processing) {
      this.processQueue();
    }
  }

  // Add to batch (for high-frequency actions)
  addToBatch(notification) {
    this.batchedNotifications.push({
      ...notification,
      timestamp: new Date()
    });

    // Reset batch timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    // Send batched notifications after interval
    this.batchTimer = setTimeout(() => {
      this.sendBatchedNotifications();
    }, this.batchInterval);
  }

  // Send batched notifications as one email
  async sendBatchedNotifications() {
    if (this.batchedNotifications.length === 0) return;

    const batch = [...this.batchedNotifications];
    this.batchedNotifications = [];

    // Group by action type
    const grouped = {};
    batch.forEach(notif => {
      const key = notif.action;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(notif);
    });

    // Create summary email
    const summary = Object.entries(grouped).map(([action, notifs]) => {
      return `${action}: ${notifs.length} times`;
    }).join('\n');

    this.addNotification({
      action: 'Batch Summary',
      subject: `[BATCH] ${batch.length} User Actions (${Object.keys(grouped).join(', ')})`,
      details: {
        totalActions: batch.length,
        timeRange: `${batch[0].timestamp.toLocaleTimeString()} - ${batch[batch.length - 1].timestamp.toLocaleTimeString()}`,
        summary: summary,
        actions: batch.map(n => `${n.timestamp.toLocaleTimeString()} - ${n.action} - ${n.userEmail || 'Unknown'}`).join('\n')
      }
    });
  }

  // Process queue with rate limiting
  async processQueue() {
    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      const timeSinceLastSent = now - this.lastSent;

      // Rate limit: wait if too soon since last email
      if (timeSinceLastSent < this.minDelay) {
        await this.sleep(this.minDelay - timeSinceLastSent);
      }

      const notification = this.queue.shift();
      
      try {
        await this.sendEmail(notification);
        this.lastSent = Date.now();
      } catch (error) {
        console.error('❌ Failed to send admin notification:', error.message);
        // Don't retry, just log and continue
      }
    }

    this.processing = false;
  }

  // Send email using Mailchimp/Mandrill
  async sendEmail(notification) {
    const axios = require('axios');
    
    if (!process.env.MAILCHIMP_API_KEY) {
      console.warn('⚠️ MAILCHIMP_API_KEY not set, skipping admin notification');
      return;
    }

    const emailBody = this.formatEmailBody(notification);
    
    try {
      const response = await axios.post('https://mandrillapp.com/api/1.0/messages/send.json', {
        key: process.env.MAILCHIMP_API_KEY,
        message: {
          from_email: process.env.MAILCHIMP_FROM_EMAIL || 'noreply@rokcup.co.za',
          from_name: process.env.MAILCHIMP_FROM_NAME || 'ROK Cup SA System',
          to: [{ email: 'win@rokthenats.co.za', type: 'to' }],
          subject: notification.subject,
          html: emailBody,
          text: this.stripHtml(emailBody)
        }
      });

      console.log(`✅ Admin notification sent: ${notification.subject}`);
      return response.data;
    } catch (error) {
      console.error('❌ Mailchimp error:', error.message);
      throw error;
    }
  }

  // Format email body with HTML
  formatEmailBody(notification) {
    const details = notification.details || {};
    const detailsHtml = Object.entries(details).map(([key, value]) => {
      return `<tr><td style="padding: 8px; border: 1px solid #e5e7eb; font-weight: 600;">${key}</td><td style="padding: 8px; border: 1px solid #e5e7eb;">${this.formatValue(value)}</td></tr>`;
    }).join('');

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Admin Notification</title>
      </head>
      <body style="font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; color: #1f2937; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); padding: 20px; border-radius: 8px 8px 0 0; color: white;">
          <h1 style="margin: 0; font-size: 24px; font-weight: 800;">🔔 ${notification.action}</h1>
          <p style="margin: 8px 0 0 0; opacity: 0.9;">${notification.timestamp.toLocaleString()}</p>
        </div>
        <div style="background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
          <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
            ${detailsHtml}
          </table>
          ${notification.notes ? `<div style="margin-top: 16px; padding: 12px; background: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 4px;"><strong>Note:</strong> ${notification.notes}</div>` : ''}
        </div>
        <div style="text-align: center; padding: 16px; color: #6b7280; font-size: 12px;">
          <p>ROK Cup SA Driver Registry System</p>
          <p>Automated notification - do not reply</p>
        </div>
      </body>
      </html>
    `;
  }

  formatValue(value) {
    if (typeof value === 'object' && value !== null) {
      return `<pre style="margin: 0; white-space: pre-wrap; font-size: 12px;">${JSON.stringify(value, null, 2)}</pre>`;
    }
    return String(value).replace(/\n/g, '<br>');
  }

  stripHtml(html) {
    return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
module.exports = new AdminNotificationQueue();
