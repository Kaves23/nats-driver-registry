const sharp = require('sharp');
const path = require('path');

const sizes = [72, 192, 512];
const inputFile = path.join(__dirname, 'icons', 'rok-logo-original.png');

async function createIcons() {
  console.log('Creating PWA icons from ROK Cup logo...');
  
  for (const size of sizes) {
    const outputFile = path.join(__dirname, 'icons', `icon-${size}.png`);
    
    // Create a square icon with the logo centered on white background
    // First create a white square, then composite the logo on top
    const logoBuffer = await sharp(inputFile)
      .resize(Math.round(size * 0.8), Math.round(size * 0.8), {
        fit: 'inside'
      })
      .toBuffer();
    
    // Create white background and composite logo centered
    await sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    })
    .composite([{
      input: logoBuffer,
      gravity: 'center'
    }])
    .flatten({ background: { r: 255, g: 255, b: 255 } }) // Ensure no transparency
    .png()
    .toFile(outputFile);
    
    console.log(`✅ Created icon-${size}.png`);
  }
  
  console.log('\nAll icons created successfully!');
}

createIcons().catch(err => {
  console.error('Error creating icons:', err);
  process.exit(1);
});
