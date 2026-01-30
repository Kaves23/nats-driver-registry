# Live Deployment Reminder - ROK Logo

## When Pushing to Live Server

### ROK Logo Setup
The admin portal PDF export now uses a locally hosted logo instead of external URL to avoid CORS issues.

**Required Actions:**
1. Upload the logo file to the live server:
   - Source: `d:\LIVENATSSITE\images\rok-logo.png`
   - Destination: `[live-server-path]/images/rok-logo.png`

2. Ensure the images directory exists on live server:
   ```bash
   mkdir -p images
   ```

3. Verify the logo file is accessible via:
   ```
   https://[your-live-domain]/images/rok-logo.png
   ```

**Code is Already Configured:**
- Server.js already has static file serving: `app.use('/images', express.static(path.join(__dirname, 'images')))`
- Admin.html already references local path: `img.src = '/images/rok-logo.png'`

**No code changes needed** - just copy the image file to the live server!

---

**Date Created:** January 30, 2026
**Related Files:** 
- server.js (lines 57-59)
- admin.html (lines 3485-3515)
- images/rok-logo.png
