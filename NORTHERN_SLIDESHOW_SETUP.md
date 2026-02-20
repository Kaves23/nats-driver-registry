# 🎬 Northern Regions Event Slideshow - Setup Guide

## ✅ What Was Added

A beautiful, auto-playing photo slideshow that appears **above the main title** on Northern Regions Crown event pages.

### Features:
- 📸 **Ken Burns effect** - Subtle zoom animation
- ⏱️ **Auto-play** - Changes every 5 seconds
- 🎮 **Manual controls** - Arrow buttons & navigation dots
- 🖱️ **Pause on hover** - Stops when you mouse over
- 📱 **Fully responsive** - Works on mobile
- 🎯 **Smart display** - Only shows on Northern Regions pages

## 🚀 Quick Start (3 Steps!)

### Step 1: Add Your Photos
Put your event photos in: `/images/northern-regions/`

**For quick testing:** Name them `photo1.jpg`, `photo2.jpg`, `photo3.jpg`, `photo4.jpg`

### Step 2: Update Photo List (Optional)
Open `/index.html` and find this section (around line 8145):

```javascript
const slideshowPhotos = [
  {
    url: 'images/northern-regions/photo1.jpg',
    caption: 'Redstar Raceway Action'
  },
  {
    url: 'images/northern-regions/photo2.jpg',
    caption: 'Podium celebrations'
  }
  // Add more photos...
];
```

Replace with your actual photo filenames and captions!

### Step 3: Test It!
1. Navigate to a Northern Regions Crown event
2. The slideshow appears automatically above the title
3. Use arrows or dots to navigate
4. Hover to pause auto-play

## 📸 Photo Recommendations

**Ideal specs:**
- **Format:** JPG or PNG
- **Size:** 1920x1080 pixels (16:9 ratio)
- **File size:** Under 2MB each
- **Orientation:** Landscape

**Photo ideas:**
- Race start/action shots
- Podium celebrations  
- Track overview
- Kart close-ups during racing
- Pit lane activity
- Spectator crowds
- Victory moments

## 🎨 Customization

### Change Slide Duration
In `/index.html` (around line 8147):
```javascript
const SLIDESHOW_DURATION = 5000; // 5 seconds per slide
```

Change to:
- `3000` for faster (3 seconds)
- `7000` for slower (7 seconds)

### Remove Captions
Just leave the caption field empty:
```javascript
{
  url: 'images/northern-regions/photo1.jpg',
  caption: '' // No caption!
}
```

### Change Height
In `/index.html` CSS section (around line 4308):
```css
.event-slideshow {
  height: 400px; /* Change this value */
}
```

Mobile version (line 4472):
```css
@media (max-width: 768px) {
  .event-slideshow {
    height: 300px; /* Mobile height */
  }
}
```

## 📁 File Structure

```
LIVENATSSITE/
├── index.html (updated with slideshow code)
└── images/
    └── northern-regions/
        ├── README.md (detailed instructions)
        ├── photo1.jpg (your photos here)
        ├── photo2.jpg
        ├── photo3.jpg
        └── photo4.jpg
```

## 💡 Pro Tips

1. **Test locally first** - Make sure all photos load before deploying
2. **Optimize images** - Use tools like TinyPNG to compress photos
3. **Consistent style** - Use photos with similar color tones
4. **Action shots** - Dynamic racing photos work best
5. **Variety** - Mix close-ups and wide shots

## 🎯 Example Configuration

Here's a real-world example:

```javascript
const slideshowPhotos = [
  {
    url: 'images/northern-regions/redstar-start-line.jpg',
    caption: 'Race Start - Redstar Raceway 2026'
  },
  {
    url: 'images/northern-regions/corner-action.jpg',
    caption: 'Intense wheel-to-wheel battle'
  },
  {
    url: 'images/northern-regions/podium-feb-14.jpg',
    caption: 'Winners Podium - Northern Crown Round 1'
  },
  {
    url: 'images/northern-regions/vkc-aerial.jpg',
    caption: 'VKC Circuit from above'
  },
  {
    url: 'images/northern-regions/pit-lane-prep.jpg',
    caption: 'Teams preparing in pit lane'
  },
  {
    url: 'images/northern-regions/trophy-presentation.jpg',
    caption: 'Northern Crown Championship Trophy'
  }
];
```

## 🔧 Troubleshooting

**Slideshow not showing?**
- Check you're on a Northern Regions Crown event page
- Verify photos are in `/images/northern-regions/`
- Check browser console for errors (F12)

**Photos not loading?**
- Verify filenames match exactly (case-sensitive!)
- Check file extensions (.jpg not .JPG)
- Ensure photos are actually in the folder

**Slideshow too fast/slow?**
- Adjust `SLIDESHOW_DURATION` value in JavaScript

**Want to disable auto-play?**
- Comment out the `startSlideshow()` call

## 📊 Technical Details

- **CSS:** Lines 4298-4500 in index.html
- **HTML:** Lines 4533-4559 in index.html  
- **JavaScript:** Lines 8133-8267 in index.html

## 🌟 What It Looks Like

When viewing a Northern Regions Crown event:
1. Page loads
2. Slideshow fades in above the title
3. First photo displays with Ken Burns zoom effect
4. After 5 seconds, smoothly transitions to next photo
5. Captions fade in at the bottom
6. Navigation dots highlight current photo
7. Hover to pause, click arrows or dots to navigate

---

**Ready to add your photos?** Just drop them in `/images/northern-regions/` and update the `slideshowPhotos` array! 🏁
