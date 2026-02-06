# Screenshot API v2.0

Self-hosted screenshot service with advanced features. No third-party APIs, unlimited requests.

## Features

- 🎨 **Multiple formats** - WebP, PNG, JPEG
- 📄 **Full page screenshots** - Capture entire scrollable page
- ⏱️ **Wait/Delay support** - Wait for JavaScript to load
- 📊 **Metadata extraction** - Get title, description, og:image
- 🔄 **Batch processing** - Process up to 10 URLs at once
- 💾 **Cache control** - Force refresh or cache-only mode
- ☁️ **S3/R2 upload** - Optional cloud storage
- 🧹 **Auto cleanup** - Delete old files automatically
- 📈 **Usage stats** - Track requests and cache hits
- 🏎️ **Smart cropping** - Auto or manual crop support

## Quick Start

```bash
bun install
bun dev
```

Visit: http://localhost:3000

## API Endpoints

### 1. Screenshot (GET/POST)

`GET/POST /api/screenshot`

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | required | Website URL |
| `width` | number | 1200 | Width (320-3840) |
| `height` | number | 630 | Height (240-2160) |
| `format` | string | webp | Image format: webp, png, jpeg |
| `quality` | number | 80 | Quality 1-100 |
| `fullPage` | boolean | false | Capture full scrollable page |
| `dark` | boolean | false | Dark mode |
| `delay` | number | 0 | Delay in ms (max 10000) |
| `waitFor` | string | - | CSS selector to wait for |
| `userAgent` | string | - | Custom user agent |
| `cache` | string | default | Cache control: default, refresh, only |
| `uploadToS3` | boolean | false | Upload to S3/R2 |
| `metadata` | boolean | true | Extract page metadata |
| `output` | string | image | Response: image or json |

**Examples:**

```bash
# Basic screenshot
curl "http://localhost:3000/api/screenshot?url=https://example.com"

# Full page with metadata (JSON)
curl "http://localhost:3000/api/screenshot?url=https://example.com&fullPage=true&output=json"

# Wait for selector + delay
curl "http://localhost:3000/api/screenshot?url=https://example.com&waitFor=.content&delay=2000"

# POST request
curl -X POST http://localhost:3000/api/screenshot \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "width": 1920,
    "height": 1080,
    "format": "png",
    "fullPage": true,
    "metadata": true
  }'
```

**JSON Response:**

```json
{
  "success": true,
  "url": "https://example.com",
  "filename": "abc123.webp",
  "localPath": "/images/abc123.webp",
  "s3Url": "https://cdn.example.com/abc123.webp",
  "width": 1200,
  "height": 630,
  "format": "webp",
  "size": 21000,
  "sizeKB": "20.51",
  "cached": false,
  "responseTime": 3500,
  "metadata": {
    "title": "Example Domain",
    "description": "This domain is for use in illustrative examples...",
    "ogImage": "https://example.com/image.png",
    "url": "https://example.com/"
  }
}
```

### 2. Batch Processing

`POST /api/batch`

Process multiple URLs at once (max 10).

```bash
curl -X POST http://localhost:3000/api/batch \
  -H "Content-Type: application/json" \
  -d '{
    "urls": [
      "https://example.com",
      "https://github.com",
      "https://stackoverflow.com"
    ]
  }'
```

**Response:**

```json
{
  "success": true,
  "total": 3,
  "results": [
    {
      "success": true,
      "url": "https://example.com",
      "filename": "abc123.webp",
      "localPath": "/images/abc123.webp",
      "cached": false,
      "metadata": {...}
    },
    ...
  ]
}
```

### 3. Usage Stats

`GET /stats`

```json
{
  "totalRequests": 1247,
  "cacheHits": 892,
  "cacheMisses": 355,
  "cacheHitRate": "71.53%",
  "errors": 3,
  "uploadedToS3": 45,
  "storageMB": "234.56",
  "totalImages": 128
}
```

### 4. Health Check

`GET /health`

```json
{
  "status": "ok",
  "uptime": 86400,
  "images": 128,
  "storageMB": "234.56",
  "browser": "connected",
  "s3Enabled": true
}
```

### 5. Serve Images

`GET /images/:filename`

Direct access to cached images.

## Configuration

Create `.env` file:

```bash
# Server
PORT=3000
HOST=0.0.0.0
IMAGES_DIR=./images

# Quality & Performance
WEBP_QUALITY=80
MAX_REQUESTS_PER_IP=100
SCREENSHOT_TIMEOUT=30000

# S3/R2 Upload (Optional)
S3_ENABLED=false
S3_BUCKET=screenshots
S3_REGION=auto
S3_ENDPOINT=https://your-account.r2.cloudflarestorage.com
S3_ACCESS_KEY=your_key
S3_SECRET_KEY=your_secret
S3_PUBLIC_URL=https://your-cdn.com

# Auto Cleanup
AUTO_CLEANUP_ENABLED=false
MAX_STORAGE_GB=10
MAX_FILE_AGE_DAYS=7
```

## SSD Storage

Point to your SSD for high-performance storage:

```bash
# Mount SSD
IMAGES_DIR=/mnt/ssd/screenshots

# Or symlink
ln -s /mnt/ssd/screenshots ./images
```

## S3/R2 Setup (Cloudflare R2 Example)

```bash
# 1. Create R2 bucket in Cloudflare dashboard
# 2. Get API credentials
# 3. Configure .env:

S3_ENABLED=true
S3_BUCKET=screenshots
S3_REGION=auto
S3_ENDPOINT=https://abc123.r2.cloudflarestorage.com
S3_ACCESS_KEY=your_access_key_id
S3_SECRET_KEY=your_secret_access_key
S3_PUBLIC_URL=https://screenshots.yourdomain.com

# 4. Enable in API call:
# ?uploadToS3=true
```

## Cache Control

```bash
# Default - use cache if available
?cache=default

# Force refresh (bypass cache)
?cache=refresh

# Only return if cached (404 if not)
?cache=only
```

## Auto Cleanup

Automatically delete old files:

```bash
AUTO_CLEANUP_ENABLED=true
MAX_STORAGE_GB=10           # Delete oldest when storage exceeds 10GB
MAX_FILE_AGE_DAYS=7         # Delete files older than 7 days
```

Runs every hour automatically.

## Deployment

### Docker

```bash
docker build -t screenshot-api .
docker run -p 3000:3000 \
  -v $(pwd)/images:/app/images \
  -e S3_ENABLED=true \
  -e S3_BUCKET=screenshots \
  screenshot-api
```

### PM2

```bash
bun add -g pm2
pm2 start server.ts --name screenshot-api --interpreter bun
pm2 save
pm2 startup
```

### VPS

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Clone and run
git clone <your-repo>
cd screenshot-api
bun install
IMAGES_DIR=/mnt/ssd/screenshots bun start
```

## Advanced Examples

### Full Page Dark Mode Screenshot

```bash
curl "http://localhost:3000/api/screenshot?url=https://github.com&fullPage=true&dark=true&format=png&output=json"
```

### Wait for Content to Load

```bash
curl "http://localhost:3000/api/screenshot?url=https://example.com&waitFor=.main-content&delay=3000"
```

### Batch with Metadata

```bash
curl -X POST http://localhost:3000/api/batch \
  -H "Content-Type: application/json" \
  -d '{
    "urls": [
      "https://example.com",
      "https://github.com"
    ]
  }' | jq '.results[].metadata'
```

### Upload to S3

```bash
curl "http://localhost:3000/api/screenshot?url=https://example.com&uploadToS3=true&output=json" | jq '.s3Url'
```

## Security

The API includes comprehensive security measures:

### URL Validation
- ✅ Only HTTP/HTTPS protocols allowed
- ✅ Blocks localhost and private IP ranges (127.0.0.1, 192.168.x.x, 10.x.x.x, etc.)
- ✅ Blocks cloud metadata endpoints (169.254.169.254, metadata.google.internal)
- ✅ Blocks sensitive ports (SSH, MySQL, PostgreSQL, Redis, etc.)
- ✅ Blocks credentials in URLs
- ✅ Prevents path traversal attacks
- ✅ Blocks suspicious schemes (javascript:, data:, file:, etc.)

### Resource Protection
- ✅ Rate limiting (100 requests/hour per IP by default)
- ✅ Request timeout (255 seconds max)
- ✅ Parameter validation (width, height, quality ranges)
- ✅ File size limits
- ✅ Request interception (blocks ads, analytics, unnecessary fonts)

### Browser Security
- ✅ Sandboxed Chromium
- ✅ No file system access from pages
- ✅ Isolated browser context per request
- ✅ Automatic cleanup after each screenshot

### Example Blocked URLs
```
❌ http://localhost:3000
❌ http://127.0.0.1
❌ http://192.168.1.1
❌ http://169.254.169.254/metadata
❌ http://site.com:3306
❌ javascript:alert(1)
❌ file:///etc/passwd
```

## Tech Stack

- **Puppeteer** - Headless Chrome
- **Sharp** - Image processing
- **Bun** - JavaScript runtime
- **AWS SDK** - S3/R2 uploads

## License

MIT
