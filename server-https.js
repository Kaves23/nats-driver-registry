// HTTPS Server for Camera Access on Mobile
// This creates a self-signed certificate for local HTTPS testing

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Check if certificate exists, if not create it
const certPath = path.join(__dirname, 'localhost.pem');
const keyPath = path.join(__dirname, 'localhost-key.pem');

if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    console.log('📜 Creating self-signed certificate...');
    try {
        // Install mkcert if not installed (Windows)
        // For manual install: choco install mkcert
        console.log('⚠️  Please install mkcert first:');
        console.log('   Run: choco install mkcert');
        console.log('   Or download from: https://github.com/FiloSottile/mkcert/releases');
        console.log('\n   Then run: mkcert -install');
        console.log('   Then run: mkcert localhost 192.168.1.* 127.0.0.1 ::1');
        process.exit(1);
    } catch (err) {
        console.error('❌ Could not create certificate:', err.message);
        process.exit(1);
    }
}

// Load the existing Express app
const app = require('./server');

// Create HTTPS server
const httpsOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
};

const server = https.createServer(httpsOptions, app);

const PORT = 3443;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🔒 HTTPS Server running on https://localhost:${PORT}`);
    console.log(`📱 Access from phone: https://[YOUR-IP]:${PORT}`);
    console.log('⚠️  You may need to accept the security warning on your phone');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down HTTPS server...');
    server.close(() => {
        console.log('✅ HTTPS server closed');
        process.exit(0);
    });
});
