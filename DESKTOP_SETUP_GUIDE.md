# NATS Driver Registry - Desktop Setup Guide

**Date Created:** January 11, 2026  
**Purpose:** Quick reference to set up your entire development environment  
**Save Location:** Obsidian Vault

---

## QUICK START (When You Restart)

1. **Open VS Code** → File → Open Folder → `D:\LIVENATSSITE`
2. **Open Terminal** in VS Code → `npm start`
3. **Open these 5 browser tabs:**
   - GitHub (nats-driver-registry)
   - Mail Cube (email)
   - Mailchimp Mandrill
   - Render Dashboard
   - Audit Log

---

## 1. VS CODE SETUP

### 1.1 Open the Project

```
1. Launch VS Code
2. File → Open Folder
3. Navigate to: D:\LIVENATSSITE
4. Click "Select Folder"
5. Wait for extensions to load
```

### 1.2 Key VS Code Extensions (Should Be Installed)
- REST Client (optional, for testing API)
- GitLens (for git history)
- Prettier (code formatter)
- ES Lint (code quality)

### 1.3 Start Development Server

```bash
# In VS Code Terminal (Ctrl + `)
npm start

# Output should show:
# ✅ NATS Driver Registry server running on port 3000
# 🔗 Connected to PRODUCTION database: nats-driver-registry
```

**Access Points:**
- Driver Portal: `http://localhost:3000/driver_portal.html`
- Driver Login: `http://localhost:3000/index.html`
- Admin Portal: `http://localhost:3000/admin.html` (password: natsadmin2026)

---

## 2. EMAIL CONFIGURATION

### 2.1 Mail Cube (Email Account Access)

**What is it:** Control panel for win@rokthenats.co.za email address

**How to Access:**
1. Go to: `cPanel` (your hosting control panel)
2. Find: "Email Accounts" or "Mail Accounts"
3. Look for: `win@rokthenats.co.za`
4. Settings: IMAP/SMTP configuration

**Why You Need It:**
- View incoming registration confirmations
- Monitor outgoing emails from system
- Check bounced emails
- Manage email filters

### 2.2 Check Email Sending

```
Mail Cube → win@rokthenats.co.za → Email Log
```

Look for:
- ✅ Registration confirmation emails
- ✅ Password reset emails
- ✅ Admin notifications

---

## 3. MAILCHIMP MANDRILL

### 3.1 What is Mandrill?

Mailchimp's email API for automated registration emails.

### 3.2 Access Mandrill

1. **Login to Mailchimp:** https://mailchimp.com
2. **Find Mandrill:**
   - Account → Integrations → Mandrill
   - OR direct: https://mandrillapp.com
3. **Verify API Key** in `.env`:
   ```
   MAILCHIMP_API_KEY=your_key_here
   ```

### 3.3 Monitor Email Sending

**Dashboard shows:**
- Emails sent (daily count)
- Bounce rate
- Opens/clicks
- Recent activity log

**Test Email:**
```
In VS Code:
POST http://localhost:3000/api/sendTestEmail
{
  "email": "test@example.com",
  "subject": "Test Email",
  "message": "This is a test"
}
```

### 3.4 Configuration

Your `.env` has:
```
MAILCHIMP_API_KEY=xxx
MAILCHIMP_LIST_ID=xxx
MAILCHIMP_FROM_EMAIL=noreply@rokthenats.co.za
```

---

## 4. GITHUB

### 4.1 GitHub Repository

**URL:** https://github.com/Kaves23/nats-driver-registry

### 4.2 Key Branches

```
main
  ↓ (production code)
  
develop  
  ↓ (staging/testing)
  
v2-dev
  ↓ (your v2 development)
```

### 4.3 Daily Workflow

```bash
# Check current branch
git branch

# Pull latest changes
git pull origin main

# Create feature branch
git checkout -b feature/your-feature

# Make changes, commit, and push
git add .
git commit -m "feat: description"
git push origin feature/your-feature

# When ready for staging
git checkout develop
git merge feature/your-feature
git push origin develop
```

### 4.4 Important Commits to Know

- **Latest:** `d84b9d1` - Final backup before v2 dev
- **Schema Fix:** `2ccae83` - Correct database column names
- **Admin Table:** `d2f7401` - Color-coded classes

### 4.5 GitHub Desktop (Optional)

If you prefer GUI over terminal:
```
1. Download: GitHub Desktop
2. File → Clone Repository
3. Paste: https://github.com/Kaves23/nats-driver-registry.git
4. Clone to: D:\LIVENATSSITE (or wherever)
```

---

## 5. RENDER.COM (DATABASE & BACKEND)

### 5.1 What is Render?

Cloud hosting platform running your Node.js backend and hosting your database.

### 5.2 Access Render Dashboard

1. **Login:** https://render.com
2. **Select Service:** `nats-driver-registry`
3. **Dashboard shows:**
   - Deploy status
   - Live logs
   - Environment variables
   - Service URL

### 5.3 Current Service Details

| Property | Value |
|----------|-------|
| **Service Name** | nats-driver-registry |
| **Service Type** | Web Service (Node.js) |
| **Branch** | main |
| **URL** | https://nats-driver-registry.onrender.com |
| **Database** | PlanetScale MySQL |
| **Port** | 3000 |
| **Auto-deploy** | On push to main |

### 5.4 Monitor Service

**Check if live:**
```
https://nats-driver-registry.onrender.com
(Should see no error)
```

**View logs:**
```
Render Dashboard → Logs tab
Shows: API requests, database connections, errors
```

### 5.5 Environment Variables (Render)

These are set in Render dashboard:
```
DB_HOST=xxx.psdb.cloud
DB_DATABASE=nats-driver-registry
DB_USERNAME=xxx
DB_PASSWORD=xxx
MAILCHIMP_API_KEY=xxx
ADMIN_PASSWORD=natsadmin2026
JWT_SECRET=xxx
```

**⚠️ IMPORTANT:** Never commit these to GitHub!

### 5.6 Deployment

**Auto-deploy when:**
```
You push to 'main' branch
  ↓
GitHub sees change
  ↓
Triggers Render rebuild
  ↓
Service restarts with new code
  ↓
URL updated (~2-5 minutes)
```

**Manual redeploy:**
```
Render Dashboard → Redeploy → Clear cache
```

---

## 6. AUDIT LOG (Backend Monitoring)

### 6.1 What is Audit Log?

Real-time view of backend activity - registrations, logins, errors, database queries.

### 6.2 Access Audit Log

**URL:** https://nats-driver-registry.onrender.com/admin_audit_log.html

**What you see:**
- All registration attempts
- Login attempts
- Password resets
- Admin actions
- Database errors
- Email sending events
- Timestamps for everything

### 6.3 Reading the Log

Example entries:
```
[10:23:45] ✅ Driver registration: john@example.com → driver_id:abc123
[10:24:12] 🔒 Login attempt: sarah@example.com → SUCCESS
[10:25:03] ❌ Email send failed: bounce detected
[10:25:45] 🔧 Database query: SELECT * FROM drivers (2.34ms)
```

### 6.4 Troubleshooting with Audit Log

**Registration not working?**
- Check audit log for error messages
- Look for failed contact insert
- See exact database error

**Email not sending?**
- Check audit log for mail service entries
- See if Mandrill API responded
- Check bounce status

**Admin portal slow?**
- Check query times in log
- Look for slow database calls
- Count active connections

---

## 7. DATABASE (PLANETSCALE)

### 7.1 What is PlanetScale?

MySQL database hosting platform.

### 7.2 Access PlanetScale

1. **Login:** https://app.planetscale.com
2. **Select Database:** `nats-driver-registry`
3. **View Tables:**
   - drivers (core driver info)
   - contacts (guardian/entrant info)
   - medical_consent (health data)
   - documents (photos/licenses)
   - payments (payment tracking)
   - admin_messages (message history)
   - audit_log (activity log)

### 7.3 Browse Data

```
PlanetScale → nats-driver-registry → Browser
```

Query a single driver:
```sql
SELECT * FROM drivers WHERE email = 'test@example.com' LIMIT 1;
```

Check contact data:
```sql
SELECT d.first_name, d.last_name, c.full_name, c.phone_mobile
FROM drivers d
LEFT JOIN contacts c ON d.driver_id = c.driver_id
LIMIT 10;
```

### 7.4 Backups

**Automatic:**
- PlanetScale backs up automatically
- Restore available in dashboard
- Free tier: Last 7 days
- Paid tier: Last 30 days

**Manual export:**
```
PlanetScale → Backups → Create backup
```

---

## 8. QUICK REFERENCE CHECKLIST

### Morning Startup
- [ ] Open VS Code → D:\LIVENATSSITE
- [ ] Run `npm start` in terminal
- [ ] Open GitHub tab
- [ ] Open Render dashboard
- [ ] Open Audit log URL
- [ ] Check Mail Cube for errors
- [ ] Check Mailchimp Mandrill stats

### Before Shutdown
- [ ] Commit all changes: `git add . && git commit -m "..."`
- [ ] Push to branch: `git push origin branch-name`
- [ ] Verify Render deployment successful
- [ ] Check audit log for errors
- [ ] Stop server: Ctrl+C in terminal
- [ ] Close VS Code

### During Development
- [ ] Write code in VS Code
- [ ] Test locally: localhost:3000
- [ ] Check browser console for errors
- [ ] Monitor audit log for issues
- [ ] Commit frequently
- [ ] Push to develop for staging tests

---

## 9. IMPORTANT URLs & LOGINS

### Development (Local)
| Service | URL | Notes |
|---------|-----|-------|
| Driver Portal | http://localhost:3000/driver_portal.html | Registration |
| Driver Login | http://localhost:3000/index.html | Existing drivers |
| Admin Portal | http://localhost:3000/admin.html | Admin pass: natsadmin2026 |

### Production (Live)
| Service | URL | Notes |
|---------|-----|-------|
| Main Site | https://rokthenats.co.za | Live site |
| API | https://nats-driver-registry.onrender.com/api | REST endpoints |
| Audit Log | https://nats-driver-registry.onrender.com/admin_audit_log.html | Activity log |

### Services
| Service | URL | Purpose |
|---------|-----|---------|
| GitHub | https://github.com/Kaves23/nats-driver-registry | Code repo |
| Render | https://render.com | Backend hosting |
| PlanetScale | https://app.planetscale.com | Database |
| Mailchimp | https://mailchimp.com | Email service |
| Mandrill | https://mandrillapp.com | Email API |
| cPanel | Your host cPanel | Mail Cube access |

---

## 10. TROUBLESHOOTING

### "npm start doesn't work"
```
Solution:
1. Ensure Node.js 18+ installed
2. cd D:\LIVENATSSITE
3. npm install (reinstall packages)
4. npm start
```

### "Server runs but site not loading"
```
Solution:
1. Check port 3000 is free: netstat -an | findstr 3000
2. Check browser: http://localhost:3000
3. Check VS Code terminal for errors
4. Restart: Ctrl+C then npm start
```

### "Database connection error"
```
Solution:
1. Check .env file exists
2. Verify DB credentials in .env
3. Check PlanetScale shows database active
4. Verify internet connection
5. Check Render service status
```

### "Email not sending"
```
Solution:
1. Check Mandrill dashboard
2. Verify MAILCHIMP_API_KEY in .env
3. Check Mail Cube for bounces
4. Test with test email via API
5. Check audit log for errors
```

### "Git push fails"
```
Solution:
1. git status (see what changed)
2. git add . (stage changes)
3. git commit -m "message" (commit)
4. git pull origin main (merge if needed)
5. git push origin main (push)
```

---

## 11. PERFORMANCE TIPS

### Optimize Development
```
✅ Use VS Code extensions for linting
✅ Use REST client for API testing
✅ Monitor audit log for slow queries
✅ Check browser DevTools for JS errors
✅ Use Git branches for features
✅ Commit small, focused changes
```

### Monitor Production
```
✅ Check Render logs daily
✅ Monitor audit log for errors
✅ Check Mail Cube for bounces
✅ Monitor Mandrill stats
✅ Check GitHub for deploy status
```

---

## 12. FILE STRUCTURE (Quick Reference)

```
D:\LIVENATSSITE\
├── server.js                    (Backend API)
├── driver_portal.html           (Registration form)
├── index.html                   (Login portal)
├── admin.html                   (Admin dashboard)
├── css/
│   └── main.css                (Global styles)
├── .env                         (Environment variables - DON'T COMMIT)
├── package.json                 (Dependencies)
├── .gitignore                   (Git ignore rules)
├── README.md                    (Project info)
├── SYSTEM_ARCHITECTURE.md       (Architecture doc)
├── TESTING_ENVIRONMENT_SETUP.md (V2 setup guide)
└── .git/                        (Git history)
```

---

## 13. BEFORE YOU SHUTDOWN

**Always do this:**
1. Save all files (Ctrl+S in VS Code)
2. Commit changes: `git add . && git commit -m "description"`
3. Push to GitHub: `git push origin branch-name`
4. Stop server: Ctrl+C
5. Close VS Code
6. Close all browser tabs (or bookmark them)

**Verify:**
- ✅ All changes committed
- ✅ GitHub shows latest commit
- ✅ Render shows "Deploy successful"
- ✅ Audit log shows no errors

---

## 14. WHEN YOU START UP AGAIN

**Step 1: Open everything**
```
✅ VS Code (D:\LIVENATSSITE)
✅ GitHub tab (bookmark it!)
✅ Render dashboard
✅ Audit log URL
✅ Mail Cube/cPanel
✅ Mailchimp Mandrill
```

**Step 2: Start server**
```bash
npm start
# Should see: "Server running on port 3000"
```

**Step 3: Test locally**
```
http://localhost:3000/admin.html
(should load without errors)
```

**Step 4: Check production**
```
https://nats-driver-registry.onrender.com
(should be live and working)
```

**Step 5: Start coding!**
```bash
git checkout -b feature/your-feature
# Make changes
# Commit and push
```

---

## 15. EMERGENCY CONTACTS

If something breaks:

1. **Check Audit Log First** → https://nats-driver-registry.onrender.com/admin_audit_log.html
2. **Check Render Logs** → https://render.com (select service, view logs)
3. **Check GitHub Status** → Recent commits
4. **Check PlanetScale** → Database status
5. **Check Email Logs** → Mail Cube in cPanel

---

## 16. HELPFUL COMMANDS

```bash
# Git
git status                  # See what changed
git log --oneline -5        # See recent commits
git branch                  # See all branches
git checkout main           # Switch to main
git pull origin main        # Get latest code

# Node.js
npm start                   # Start server
npm install                 # Install packages
npm test                    # Run tests (if configured)

# System
cd D:\LIVENATSSITE          # Navigate to project
cls                         # Clear terminal
```

---

## 17. BACKUP LOCATIONS

Your code is backed up in:
- **GitHub:** https://github.com/Kaves23/nats-driver-registry
- **PlanetScale:** Automatic database backups
- **Render:** Deployment history
- **Local Machine:** D:\LIVENATSSITE (your source)

**Last backup commit:** `d84b9d1` (Jan 11, 2026)

---

## 18. NEXT STEPS FOR V2 DEVELOPMENT

When you're ready to start v2:

1. **Create dev database** (follow TESTING_ENVIRONMENT_SETUP.md)
2. **Create v2-dev branch**: `git checkout -b v2-dev`
3. **Switch to dev database** in `.env`
4. **Start with fresh install**: `npm install`
5. **Test locally**: `npm start` with NODE_ENV=development
6. **Document changes** in README.md

---

**Last Updated:** January 11, 2026  
**Bookmark this document in Obsidian!**  
**Questions? Check the other .md docs in the repo.**

