# Testing Environment Setup Guide

**Created:** January 10, 2026  
**Purpose:** Setting up a development/staging environment for v2 development  
**Scope:** Isolates new development from live production site

---

## 1. OVERVIEW

This guide sets up a complete isolated testing environment so you can develop v2 features without affecting the live rokthenats.co.za site.

### What You'll Have
```
Production (Live)         Development (Testing)
═══════════════════════   ═════════════════════
Domain: rokthenats.co.za  Domain: staging.rokthenats.co.za
DB: nats-driver-registry  DB: nats-driver-registry-dev
Branch: main              Branch: develop/v2-dev
Status: Live users        Status: Test users only
```

---

## 2. STEP 1: CREATE DEVELOPMENT DATABASE

### 2.1 Create New PlanetScale Database

1. **Login to PlanetScale** → https://app.planetscale.com
2. **Create new database:**
   - Click "Create a new database"
   - Name: `nats-driver-registry-dev`
   - Region: Same as production
   - Click "Create database"

3. **Copy connection credentials:**
   - Click your new database
   - Click "Connect"
   - Copy:
     - Host
     - Username
     - Password

### 2.2 Initialize Dev Database Schema

Run these SQL queries in PlanetScale console to create tables:

```sql
-- Create drivers table
CREATE TABLE drivers (
  driver_id VARCHAR(36) PRIMARY KEY,
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255) NOT NULL,
  date_of_birth DATE,
  nationality VARCHAR(100),
  gender VARCHAR(50),
  championship VARCHAR(100),
  class VARCHAR(100),
  race_number VARCHAR(50),
  team_name VARCHAR(255),
  coach_name VARCHAR(255),
  kart_brand VARCHAR(100),
  engine_type VARCHAR(100),
  transponder_number VARCHAR(100),
  license_number VARCHAR(100),
  password_hash VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'Pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_email (email)
);

-- Create contacts table
CREATE TABLE contacts (
  contact_id VARCHAR(36) PRIMARY KEY,
  driver_id VARCHAR(36) NOT NULL,
  full_name VARCHAR(255),
  email VARCHAR(255),
  phone_mobile VARCHAR(20),
  phone_alt VARCHAR(20),
  relationship VARCHAR(100),
  emergency_contact BOOLEAN DEFAULT FALSE,
  consent_contact BOOLEAN DEFAULT FALSE,
  billing_contact BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (driver_id) REFERENCES drivers(driver_id),
  INDEX idx_driver_id (driver_id)
);

-- Create medical_consent table
CREATE TABLE medical_consent (
  id VARCHAR(36) PRIMARY KEY,
  driver_id VARCHAR(36) NOT NULL,
  allergies TEXT,
  medical_conditions TEXT,
  medication TEXT,
  doctor_phone VARCHAR(20),
  consent_signed BOOLEAN DEFAULT FALSE,
  consent_date DATETIME,
  media_release_signed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (driver_id) REFERENCES drivers(driver_id),
  INDEX idx_driver_id (driver_id)
);

-- Create documents table
CREATE TABLE documents (
  document_id VARCHAR(36) PRIMARY KEY,
  driver_id VARCHAR(36) NOT NULL,
  license_document LONGBLOB,
  profile_photo LONGBLOB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (driver_id) REFERENCES drivers(driver_id),
  INDEX idx_driver_id (driver_id)
);

-- Create payments table
CREATE TABLE payments (
  payment_id VARCHAR(36) PRIMARY KEY,
  driver_id VARCHAR(36) NOT NULL,
  amount DECIMAL(10,2),
  status VARCHAR(50),
  payment_date DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (driver_id) REFERENCES drivers(driver_id),
  INDEX idx_driver_id (driver_id)
);

-- Create admin_messages table
CREATE TABLE admin_messages (
  message_id VARCHAR(36) PRIMARY KEY,
  driver_id VARCHAR(36),
  subject VARCHAR(255),
  message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create audit_log table
CREATE TABLE audit_log (
  log_id VARCHAR(36) PRIMARY KEY,
  action VARCHAR(100),
  details JSON,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 3. STEP 2: GIT BRANCHING SETUP

### 3.1 Create Development Branches

```bash
# Clone repo (if not already done)
git clone https://github.com/Kaves23/nats-driver-registry.git
cd nats-driver-registry

# Create and checkout develop branch
git checkout -b develop
git push origin develop

# Create v2 development branch
git checkout -b v2-dev
git push origin v2-dev

# Stay on v2-dev for your work
git checkout v2-dev
```

### 3.2 Branch Strategy

```
main (production)
  ├─ v2-dev (your development)
  │   ├─ feature/redesign
  │   ├─ feature/dashboard
  │   └─ feature/reports
  │
  └─ develop (staging/testing)
      └─ (merged from features when ready)
```

---

## 4. STEP 3: ENVIRONMENT CONFIGURATION

### 4.1 Update .env File

```env
# ===== PRODUCTION =====
DB_HOST=prod.xxx.psdb.cloud
DB_PORT=3306
DB_DATABASE=nats-driver-registry
DB_USERNAME=prod_username
DB_PASSWORD=prod_password

# ===== DEVELOPMENT =====
DB_DEV_HOST=dev.xxx.psdb.cloud
DB_DEV_PORT=3306
DB_DEV_DATABASE=nats-driver-registry-dev
DB_DEV_USERNAME=dev_username
DB_DEV_PASSWORD=dev_password

# ===== SERVER =====
PORT=3000
NODE_ENV=production    # Change to 'development' for local testing

# ===== EMAIL =====
MAILCHIMP_API_KEY=your_key
MAILCHIMP_LIST_ID=your_list
MAILCHIMP_FROM_EMAIL=noreply@rokthenats.co.za

# ===== ADMIN =====
ADMIN_PASSWORD=natsadmin2026

# ===== JWT =====
JWT_SECRET=your_secret_key
JWT_EXPIRY=7d
```

### 4.2 Update server.js to Support Both Databases

Add this near the top of `server.js`:

```javascript
// Database configuration based on environment
const useDevDb = process.env.NODE_ENV === 'development';

const dbConfig = useDevDb ? {
  host: process.env.DB_DEV_HOST,
  port: process.env.DB_DEV_PORT || 3306,
  database: process.env.DB_DEV_DATABASE,
  user: process.env.DB_DEV_USERNAME,
  password: process.env.DB_DEV_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
} : {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

console.log(`🔗 Connected to ${useDevDb ? 'DEVELOPMENT' : 'PRODUCTION'} database: ${dbConfig.database}`);
```

---

## 5. STEP 4: LOCAL DEVELOPMENT

### 5.1 Run Development Server Locally

```bash
# Install dependencies (if not already done)
npm install

# Start in development mode (uses dev database)
NODE_ENV=development npm start

# Server runs at http://localhost:3000
# Uses: nats-driver-registry-dev database
```

### 5.2 Test Locally

- Registration: http://localhost:3000/driver_portal.html
- Admin Portal: http://localhost:3000/admin.html
- Login: http://localhost:3000/index.html

---

## 6. STEP 5: STAGING/TESTING DEPLOYMENT

### 6.1 Option A: Railway (Recommended - Free Tier Available)

1. **Create Railway account** → https://railway.app
2. **Connect GitHub repo**
3. **Create new project:**
   - Select "Deploy from GitHub"
   - Choose `nats-driver-registry` repository
   - Select `develop` branch
4. **Configure environment:**
   - Add all environment variables from `.env`
   - Set `NODE_ENV=development` (or staging)
   - Point to dev database credentials
5. **Deploy:**
   - Railway auto-deploys on push to `develop`
   - Get URL: `https://your-railway-url.railway.app`
6. **Add domain:**
   - Add CNAME: `staging.rokthenats.co.za` → Railway URL

### 6.2 Option B: Vercel

1. **Create Vercel account** → https://vercel.com
2. **Import GitHub repo**
3. **Select `develop` branch**
4. **Configure environment variables**
5. **Deploy** → Gets URL like `nats-staging.vercel.app`

### 6.3 Option C: Local Testing Only (No Public URL)

```bash
# Just run locally for development
NODE_ENV=development npm start

# Only you can access on http://localhost:3000
# Good for initial development
```

---

## 7. STEP 6: GITHUB ACTIONS (AUTOMATED TESTING)

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Staging

on:
  push:
    branches: [develop]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      
      - name: Deploy to Railway
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
        run: |
          npx @railway/cli deploy --service nats-dev
```

---

## 8. TESTING WORKFLOW

### 8.1 Development Cycle

```
1. Start work on v2-dev branch
   git checkout v2-dev
   git pull origin v2-dev

2. Create feature branch
   git checkout -b feature/my-feature

3. Make changes and commit
   git add .
   git commit -m "feat: my feature"

4. Push feature branch
   git push origin feature/my-feature

5. Test locally
   NODE_ENV=development npm start
   # Test at http://localhost:3000

6. When ready, merge to develop for staging
   git checkout develop
   git merge feature/my-feature
   git push origin develop
   # Auto-deploys to staging.rokthenats.co.za

7. When tested and ready for production
   git checkout main
   git merge develop
   git push origin main
   # Deploys to rokthenats.co.za (production)
```

### 8.2 Testing Checklist

- [ ] Registration form works
- [ ] All fields save to dev database
- [ ] Admin portal displays data
- [ ] Email notifications send
- [ ] Login functionality works
- [ ] Password reset works
- [ ] No console errors
- [ ] No database errors in logs

---

## 9. DATA MANAGEMENT

### 9.1 Copy Production Data to Dev (Optional)

If you need real test data:

```bash
# Export from production
mysqldump -h <prod_host> -u <prod_user> -p<prod_pass> \
  nats-driver-registry > backup.sql

# Import to development
mysql -h <dev_host> -u <dev_user> -p<dev_pass> \
  nats-driver-registry-dev < backup.sql
```

### 9.2 Reset Dev Database

```sql
-- Delete all data safely
DELETE FROM documents;
DELETE FROM medical_consent;
DELETE FROM payments;
DELETE FROM contacts;
DELETE FROM drivers;
DELETE FROM audit_log;
DELETE FROM admin_messages;
```

---

## 10. MONITORING & LOGGING

### 10.1 View Logs

**Railway:**
```
Dashboard → Your Project → Logs
```

**Local:**
```bash
NODE_ENV=development npm start
# Logs print to console
```

### 10.2 Test API Endpoints

```bash
# Test registration
curl -X POST http://localhost:3000/api/registerDriver \
  -H "Content-Type: application/json" \
  -d '{"first_name":"Test","last_name":"User",...}'

# View debug info
curl http://localhost:3000/api/debug/contacts-sample
```

---

## 11. BRANCH PROTECTION RULES

Set up on GitHub to prevent accidents:

1. Go to **Settings** → **Branches**
2. Add rule for `main`:
   - ✅ Require pull request reviews (1)
   - ✅ Require status checks to pass
   - ✅ Dismiss stale reviews
   - ✅ Require branches to be up to date

3. Add rule for `develop`:
   - ✅ Require pull request reviews (1)

---

## 12. DEPLOYMENT CHECKLIST

### Before merging to `develop` (staging)
- [ ] Code tested locally
- [ ] No console errors
- [ ] No database errors
- [ ] All new features working
- [ ] Backward compatible (no breaking changes yet)

### Before merging to `main` (production)
- [ ] Tested on staging for 24+ hours
- [ ] No reported issues
- [ ] Documentation updated
- [ ] Database migrations run
- [ ] Backup taken (PlanetScale does this auto)

---

## 13. QUICK COMMANDS REFERENCE

```bash
# Development setup
NODE_ENV=development npm start

# Push to staging
git checkout develop
git merge feature/your-feature
git push origin develop

# Push to production
git checkout main
git merge develop
git push origin main

# Check current branch
git branch

# View commit history
git log --oneline -10

# Undo last commit (keep changes)
git reset --soft HEAD~1

# Undo last push (dangerous - use carefully)
git reset --hard origin/main
```

---

## 14. TROUBLESHOOTING

### Issue: "Cannot connect to dev database"
```
Solution: Check .env file has correct DB_DEV_* credentials
  - Verify credentials in PlanetScale
  - Ensure host/username/password match exactly
```

### Issue: "Deploying but staging not updating"
```
Solution: Check branch selection
  - Verify you pushed to 'develop' branch
  - Check Railway/Vercel is watching 'develop'
  - Manually trigger redeploy
```

### Issue: "Production database being modified during dev"
```
Solution: Ensure NODE_ENV=development is set
  - Check: console.log shows "DEVELOPMENT database"
  - Verify .env has DB_DEV_* variables
```

### Issue: "Git merge conflicts"
```
Solution:
  1. git status  (see conflicts)
  2. Fix conflicts in editor
  3. git add .
  4. git commit -m "resolve conflicts"
  5. git push
```

---

## 15. NEXT STEPS

1. **Complete steps 1-4** first (Database + GitHub + .env)
2. **Choose deployment option** (Railway/Vercel/Local)
3. **Start development** on v2-dev branch
4. **Test locally** with NODE_ENV=development
5. **Push to develop** when ready for staging tests
6. **Merge to main** when production-ready

---

## 16. USEFUL LINKS

- **PlanetScale**: https://app.planetscale.com
- **GitHub**: https://github.com/Kaves23/nats-driver-registry
- **Railway**: https://railway.app
- **Vercel**: https://vercel.com
- **Node.js Docs**: https://nodejs.org/docs

---

**Version:** 1.0  
**Last Updated:** January 10, 2026  
**Questions?** Check logs or contact development team
