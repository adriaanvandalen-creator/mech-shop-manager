const express = require('express');
const router = express.Router();
const { injectShop } = require('../middleware/auth');

router.use(injectShop);

// Proxy to Google Vision API — keeps API key server-side
router.post('/scan', async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'No image provided' });

  const apiKey = process.env.GOOGLE_VISION_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Vision API not configured' });

  try {
    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: image },
            features: [{ type: 'TEXT_DETECTION', maxResults: 1 }]
          }]
        })
      }
    );
    const data = await response.json();
    const text = data.responses?.[0]?.fullTextAnnotation?.text || '';
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
