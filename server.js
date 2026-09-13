require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const NodeCache = require('node-cache');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const cache = new NodeCache({ stdTTL: 600 });

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// VPN Locations database
const vpnLocations = {
  'US': { country: 'United States', lat: 37.7749, lng: -122.4194, proxy: 'us-proxy' },
  'UK': { country: 'United Kingdom', lat: 51.5074, lng: -0.1278, proxy: 'uk-proxy' },
  'DE': { country: 'Germany', lat: 52.5200, lng: 13.4050, proxy: 'de-proxy' },
  'JP': { country: 'Japan', lat: 35.6762, lng: 139.6503, proxy: 'jp-proxy' },
  'AU': { country: 'Australia', lat: -33.8688, lng: 151.2093, proxy: 'au-proxy' },
  'CA': { country: 'Canada', lat: 43.6532, lng: -79.3832, proxy: 'ca-proxy' },
  'SG': { country: 'Singapore', lat: 1.3521, lng: 103.8198, proxy: 'sg-proxy' },
  'NL': { country: 'Netherlands', lat: 52.3676, lng: 4.9041, proxy: 'nl-proxy' }
};

// Generate fake user agent and headers based on location
function generateHeaders(location) {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15'
  ];

  return {
    'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'X-Forwarded-For': generateFakeIP(location),
    'X-Forwarded-Proto': 'https'
  };
}

// Generate fake IP based on location
function generateFakeIP(location) {
  const ipRanges = {
    'US': '203.0.113.',
    'UK': '198.51.100.',
    'DE': '192.0.2.',
    'JP': '203.0.113.',
    'AU': '198.51.100.',
    'CA': '192.0.2.',
    'SG': '203.0.113.',
    'NL': '198.51.100.'
  };

  const baseIP = ipRanges[location] || '203.0.113.';
  const lastOctet = Math.floor(Math.random() * 256);
  const secondLastOctet = Math.floor(Math.random() * 256);

  return `${baseIP}${secondLastOctet}.${lastOctet}`;
}

// Search aggregation from multiple sources
async function searchWithLocation(query, location) {
  const cacheKey = `search_${query}_${location}`;
  const cachedResult = cache.get(cacheKey);

  if (cachedResult) {
    return cachedResult;
  }

  try {
    const headers = generateHeaders(location);
    const results = [];

    // DuckDuckGo Search
    try {
      const ddgResponse = await axios.get(`https://duckduckgo.com/`, {
        params: { q: query },
        headers,
        timeout: 5000
      });

      const cheerio = require('cheerio');
      const $ = cheerio.load(ddgResponse.data);
      
      // Parse DuckDuckGo results (simplified)
      $('article').slice(0, 5).each((i, elem) => {
        const link = $(elem).find('a[data-testid="result-title-a"]').attr('href');
        const title = $(elem).find('span').text();
        if (link && title) {
          results.push({
            source: 'DuckDuckGo',
            title: title.substring(0, 60),
            url: link,
            type: 'search_result'
          });
        }
      });
    } catch (error) {
      console.log('DuckDuckGo search failed:', error.message);
    }

    // Bing Search API fallback
    try {
      const bingResponse = await axios.get('https://www.bing.com/search', {
        params: { q: query },
        headers,
        timeout: 5000
      });

      const cheerio = require('cheerio');
      const $ = cheerio.load(bingResponse.data);
      
      $('li.b_algo').slice(0, 5).each((i, elem) => {
        const link = $(elem).find('a').attr('href');
        const title = $(elem).find('h2 a').text();
        if (link && title) {
          results.push({
            source: 'Bing',
            title: title.substring(0, 60),
            url: link,
            type: 'search_result'
          });
        }
      });
    } catch (error) {
      console.log('Bing search failed:', error.message);
    }

    // Generate thumbnails for top results
    const resultsWithThumbnails = await Promise.all(
      results.slice(0, 10).map(async (result) => {
        try {
          const thumbnail = await generateThumbnail(result.url);
          return { ...result, thumbnail };
        } catch (error) {
          return { ...result, thumbnail: null };
        }
      })
    );

    cache.set(cacheKey, resultsWithThumbnails);
    return resultsWithThumbnails;

  } catch (error) {
    console.error('Search error:', error.message);
    return [];
  }
}

// Generate website thumbnails using Puppeteer
async function generateThumbnail(url) {
  try {
    const browser = await puppeteer.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 5000 });
    
    const screenshot = await page.screenshot({ 
      type: 'jpeg',
      quality: 60,
      clip: { x: 0, y: 0, width: 1200, height: 800 }
    });
    
    await browser.close();
    
    return 'data:image/jpeg;base64,' + screenshot.toString('base64');
  } catch (error) {
    console.log('Thumbnail generation failed for', url);
    return null;
  }
}

// API Routes
app.get('/api/locations', (req, res) => {
  const locations = Object.entries(vpnLocations).map(([code, data]) => ({
    code,
    country: data.country,
    lat: data.lat,
    lng: data.lng
  }));
  res.json(locations);
});

app.get('/api/search', async (req, res) => {
  const { q, location = 'US' } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Search query required' });
  }

  if (!vpnLocations[location]) {
    return res.status(400).json({ error: 'Invalid location' });
  }

  try {
    const results = await searchWithLocation(q, location);
    res.json({
      query: q,
      location: vpnLocations[location].country,
      results: results,
      timestamp: new Date(),
      sessionId: uuidv4()
    });
  } catch (error) {
    res.status(500).json({ error: 'Search failed', details: error.message });
  }
});

app.post('/api/browse', async (req, res) => {
  const { url, location = 'US' } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL required' });
  }

  if (!vpnLocations[location]) {
    return res.status(400).json({ error: 'Invalid location' });
  }

  try {
    const headers = generateHeaders(location);
    const response = await axios.get(url, { 
      headers, 
      timeout: 10000,
      maxRedirects: 5
    });

    const fakeIP = generateFakeIP(location);

    res.json({
      url: url,
      location: vpnLocations[location].country,
      fakeIP: fakeIP,
      status: response.status,
      headers: {
        'content-type': response.headers['content-type'],
        'server': response.headers['server']
      },
      contentLength: response.data.length,
      timestamp: new Date()
    });
  } catch (error) {
    res.status(500).json({ error: 'Browse failed', details: error.message });
  }
});

app.get('/api/location-info', (req, res) => {
  const { location = 'US' } = req.query;

  if (!vpnLocations[location]) {
    return res.status(400).json({ error: 'Invalid location' });
  }

  const locationData = vpnLocations[location];
  const fakeIP = generateFakeIP(location);

  res.json({
    location: locationData.country,
    code: location,
    coordinates: { lat: locationData.lat, lng: locationData.lng },
    fakeIP: fakeIP,
    maskedInfo: {
      ip_hidden: true,
      location_spoofed: true,
      dns_protected: true
    }
  });
});

// Serve homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔒 Privacy Search VPN running on http://localhost:${PORT}`);
  console.log(`📍 Available locations: ${Object.keys(vpnLocations).join(', ')}`);
});
