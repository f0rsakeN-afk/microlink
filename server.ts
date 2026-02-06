#!/usr/bin/env bun

import puppeteer, { Browser, Page } from "puppeteer";
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import { existsSync, mkdirSync, statSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { isUrlSafe, validateScreenshotParams } from "./security";

const CONFIG = {
  PORT: parseInt(process.env.PORT || "3000"),
  HOST: process.env.HOST || "0.0.0.0",
  IMAGES_DIR: process.env.IMAGES_DIR || "./images",
  ENABLE_RATE_LIMIT: process.env.ENABLE_RATE_LIMIT !== "false",
  MAX_REQUESTS_PER_IP: parseInt(process.env.MAX_REQUESTS_PER_IP || "100"),
  WEBP_QUALITY: parseInt(process.env.WEBP_QUALITY || "80"),
  SCREENSHOT_TIMEOUT: parseInt(process.env.SCREENSHOT_TIMEOUT || "30000"),
  S3_ENABLED: process.env.S3_ENABLED === "true",
  S3_BUCKET: process.env.S3_BUCKET || "",
  S3_REGION: process.env.S3_REGION || "auto",
  S3_ENDPOINT: process.env.S3_ENDPOINT || "",
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY || "",
  S3_SECRET_KEY: process.env.S3_SECRET_KEY || "",
  S3_PUBLIC_URL: process.env.S3_PUBLIC_URL || "",
  AUTO_CLEANUP_ENABLED: process.env.AUTO_CLEANUP_ENABLED === "true",
  MAX_STORAGE_GB: parseInt(process.env.MAX_STORAGE_GB || "10"),
  MAX_FILE_AGE_DAYS: parseInt(process.env.MAX_FILE_AGE_DAYS || "7"),
};

if (!existsSync(CONFIG.IMAGES_DIR)) {
  mkdirSync(CONFIG.IMAGES_DIR, { recursive: true });
}

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const stats = {
  totalRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  errors: 0,
  uploadedToS3: 0,
};

let s3Client: S3Client | null = null;
if (CONFIG.S3_ENABLED) {
  s3Client = new S3Client({
    region: CONFIG.S3_REGION,
    endpoint: CONFIG.S3_ENDPOINT,
    credentials: {
      accessKeyId: CONFIG.S3_ACCESS_KEY,
      secretAccessKey: CONFIG.S3_SECRET_KEY,
    },
  });
}

function checkRateLimit(ip: string): boolean {
  if (!CONFIG.ENABLE_RATE_LIMIT) return true;

  const now = Date.now();
  const limit = rateLimitMap.get(ip);

  if (!limit || now > limit.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 3600000 });
    return true;
  }

  if (limit.count >= CONFIG.MAX_REQUESTS_PER_IP) return false;

  limit.count++;
  return true;
}

function getImageFilename(
  url: string,
  width: number,
  height: number,
  dark: boolean,
  format: string,
  fullPage: boolean,
): string {
  const hash = createHash("md5")
    .update(`${url}:${width}:${height}:${dark}:${format}:${fullPage}`)
    .digest("hex");
  return `${hash}.${format}`;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const startTime = Date.now();
let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-blink-features=AutomationControlled",
      ],
    });
  }
  return browser;
}

interface PageMetadata {
  title: string;
  description: string | null;
  ogImage: string | null;
  favicon: string | null;
  url: string;
}

interface ScreenshotRequestBody {
  url?: string;
  width?: string | number;
  height?: string | number;
  dark?: boolean | string;
  quality?: string | number;
  format?: string;
  outputFormat?: string;
  fullPage?: boolean | string;
  delay?: string | number;
  waitFor?: string;
  userAgent?: string;
  cache?: string;
  uploadToS3?: boolean;
  metadata?: boolean;
  crop?: { x: number; y: number; width: number; height: number };
}

interface BatchRequestBody {
  urls?: string[];
}

async function extractMetadata(page: Page): Promise<PageMetadata> {
  return await page.evaluate(() => {
    const getMetaContent = (name: string) => {
      const meta = document.querySelector(
        `meta[name="${name}"], meta[property="${name}"]`,
      );
      return meta?.getAttribute("content") || null;
    };

    return {
      title: document.title,
      description:
        getMetaContent("description") || getMetaContent("og:description"),
      ogImage: getMetaContent("og:image"),
      favicon:
        document.querySelector('link[rel="icon"]')?.getAttribute("href") ||
        null,
      url: window.location.href,
    };
  });
}

async function captureScreenshot(
  url: string,
  width: number,
  height: number,
  dark: boolean,
  fullPage: boolean,
  delay: number,
  waitFor?: string,
  userAgent?: string,
): Promise<{ buffer: Buffer; metadata: PageMetadata }> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width, height });

    if (userAgent) {
      await page.setUserAgent(userAgent);
    }

    if (dark) {
      await page.emulateMediaFeatures([
        { name: "prefers-color-scheme", value: "dark" },
      ]);
    }

    await page.setExtraHTTPHeaders({
      "X-Requested-With": "Screenshot-API",
      "Accept-Language": "en-US,en;q=0.9",
    });

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const requestUrl = request.url();
      const resourceType = request.resourceType();

      if (resourceType === "font" || resourceType === "media") {
        request.abort();
      } else if (
        requestUrl.includes("ads") ||
        requestUrl.includes("analytics")
      ) {
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: CONFIG.SCREENSHOT_TIMEOUT,
    });

    if (waitFor) {
      try {
        await page.waitForSelector(waitFor, { timeout: 10000 });
      } catch {
        // Continue if selector not found
      }
    }

    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const metadata = await extractMetadata(page);

    const screenshot = await page.screenshot({
      type: "png",
      fullPage: fullPage,
    });

    return { buffer: screenshot as Buffer, metadata };
  } finally {
    await page.close();
  }
}

async function processImage(
  buffer: Buffer,
  format: string,
  quality: number,
  crop?: { x: number; y: number; width: number; height: number },
): Promise<{ buffer: Buffer; size: number }> {
  let processor = sharp(buffer);

  if (crop) {
    processor = processor.extract({
      left: crop.x,
      top: crop.y,
      width: crop.width,
      height: crop.height,
    });
  }

  let processed: Buffer;
  if (format === "webp") {
    processed = await processor.webp({ quality, effort: 6 }).toBuffer();
  } else if (format === "jpeg" || format === "jpg") {
    processed = await processor.jpeg({ quality }).toBuffer();
  } else {
    processed = await processor.png({ quality }).toBuffer();
  }

  return { buffer: processed, size: processed.length };
}

async function uploadToS3(
  buffer: Buffer,
  filename: string,
  contentType: string,
): Promise<string> {
  if (!s3Client || !CONFIG.S3_ENABLED) {
    throw new Error("S3 not configured");
  }

  await s3Client.send(
    new PutObjectCommand({
      Bucket: CONFIG.S3_BUCKET,
      Key: filename,
      Body: new Uint8Array(buffer),
      ContentType: contentType,
    }),
  );

  stats.uploadedToS3++;

  return CONFIG.S3_PUBLIC_URL
    ? `${CONFIG.S3_PUBLIC_URL}/${filename}`
    : filename;
}

function getImageCount(): number {
  try {
    return readdirSync(CONFIG.IMAGES_DIR).filter((f) =>
      f.match(/\.(webp|png|jpe?g)$/),
    ).length;
  } catch {
    return 0;
  }
}

function getStorageSize(): number {
  try {
    let total = 0;
    const files = readdirSync(CONFIG.IMAGES_DIR);
    for (const file of files) {
      const stat = statSync(join(CONFIG.IMAGES_DIR, file));
      total += stat.size;
    }
    return total;
  } catch {
    return 0;
  }
}

async function cleanupOldFiles(): Promise<{
  deleted: number;
  freedMB: number;
}> {
  try {
    const files = readdirSync(CONFIG.IMAGES_DIR)
      .map((f) => {
        const path = join(CONFIG.IMAGES_DIR, f);
        const stat = statSync(path);
        return { path, mtime: stat.mtime.getTime(), size: stat.size };
      })
      .sort((a, b) => a.mtime - b.mtime);

    const now = Date.now();
    const maxAge = CONFIG.MAX_FILE_AGE_DAYS * 24 * 60 * 60 * 1000;
    const maxSize = CONFIG.MAX_STORAGE_GB * 1024 * 1024 * 1024;

    let currentSize = files.reduce((sum, f) => sum + f.size, 0);
    let deleted = 0;
    let freed = 0;

    for (const file of files) {
      const age = now - file.mtime;
      const shouldDelete = age > maxAge || currentSize > maxSize;

      if (shouldDelete) {
        unlinkSync(file.path);
        deleted++;
        freed += file.size;
        currentSize -= file.size;
      }
    }

    return { deleted, freedMB: freed / (1024 * 1024) };
  } catch {
    return { deleted: 0, freedMB: 0 };
  }
}

setInterval(async () => {
  if (CONFIG.AUTO_CLEANUP_ENABLED) {
    await cleanupOldFiles();
  }
}, 3600000);

const server = Bun.serve({
  port: CONFIG.PORT,
  hostname: CONFIG.HOST,
  development: false,
  idleTimeout: 255,

  async fetch(req) {
    const url = new URL(req.url);
    const ip = server.requestIP(req)?.address || "unknown";

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/") {
      return Response.json(
        {
          name: "Screenshot API",
          version: "2.0.0",
          features: [
            "Multiple formats (webp, png, jpeg)",
            "Full page screenshots",
            "Wait/Delay support",
            "Metadata extraction",
            "Batch processing",
            "Cache control",
            "S3/R2 upload",
            "Auto cleanup",
            "Usage stats",
          ],
          endpoints: {
            screenshot: "GET/POST /api/screenshot",
            batch: "POST /api/batch",
            images: "GET /images/<filename>",
            stats: "GET /stats",
            health: "GET /health",
          },
        },
        { headers: CORS_HEADERS },
      );
    }

    if (url.pathname === "/health") {
      const imageCount = getImageCount();
      const storageSize = getStorageSize();
      return Response.json(
        {
          status: "ok",
          uptime: Math.floor((Date.now() - startTime) / 1000),
          images: imageCount,
          storageMB: (storageSize / (1024 * 1024)).toFixed(2),
          browser: browser ? "connected" : "not started",
          s3Enabled: CONFIG.S3_ENABLED,
        },
        { headers: CORS_HEADERS },
      );
    }

    if (url.pathname === "/stats") {
      const storageSize = getStorageSize();
      const cacheHitRate =
        stats.totalRequests > 0
          ? ((stats.cacheHits / stats.totalRequests) * 100).toFixed(2)
          : "0";

      return Response.json(
        {
          totalRequests: stats.totalRequests,
          cacheHits: stats.cacheHits,
          cacheMisses: stats.cacheMisses,
          cacheHitRate: `${cacheHitRate}%`,
          errors: stats.errors,
          uploadedToS3: stats.uploadedToS3,
          storageMB: (storageSize / (1024 * 1024)).toFixed(2),
          totalImages: getImageCount(),
        },
        { headers: CORS_HEADERS },
      );
    }

    if (url.pathname === "/api/screenshot") {
      const requestStart = Date.now();
      stats.totalRequests++;

      try {
        if (!checkRateLimit(ip)) {
          return Response.json(
            {
              error: "Rate limit exceeded",
              message: `Maximum ${CONFIG.MAX_REQUESTS_PER_IP} requests per hour`,
            },
            { status: 429, headers: CORS_HEADERS },
          );
        }

        let targetUrl: string | null;
        let width: number;
        let height: number;
        let dark: boolean;
        let quality: number;
        let format: string;
        let outputFormat: string;
        let fullPage: boolean;
        let delay: number;
        let waitFor: string | undefined;
        let userAgent: string | undefined;
        let cacheControl: string;
        let uploadToCloud: boolean;
        let extractMeta: boolean;
        let crop:
          | { x: number; y: number; width: number; height: number }
          | undefined;

        if (req.method === "POST") {
          const body = (await req.json()) as ScreenshotRequestBody;
          targetUrl = body.url || null;
          width = Math.min(
            Math.max(parseInt(String(body.width || "1200")), 320),
            3840,
          );
          height = Math.min(
            Math.max(parseInt(String(body.height || "630")), 240),
            2160,
          );
          dark = body.dark === true || body.dark === "true";
          quality = Math.min(
            Math.max(parseInt(String(body.quality || "80")), 1),
            100,
          );
          format = body.format || "webp";
          outputFormat = body.outputFormat || "json";
          fullPage = body.fullPage === true || body.fullPage === "true";
          delay = Math.min(parseInt(String(body.delay || "0")), 10000);
          waitFor = body.waitFor;
          userAgent = body.userAgent;
          cacheControl = body.cache || "default";
          uploadToCloud = body.uploadToS3 === true;
          extractMeta = body.metadata !== false;
          crop = body.crop;
        } else {
          targetUrl = url.searchParams.get("url");
          width = Math.min(
            Math.max(parseInt(url.searchParams.get("width") || "1200"), 320),
            3840,
          );
          height = Math.min(
            Math.max(parseInt(url.searchParams.get("height") || "630"), 240),
            2160,
          );
          dark = url.searchParams.get("dark") === "true";
          quality = Math.min(
            Math.max(parseInt(url.searchParams.get("quality") || "80"), 1),
            100,
          );
          format = url.searchParams.get("format") || "webp";
          outputFormat = url.searchParams.get("output") || "image";
          fullPage = url.searchParams.get("fullPage") === "true";
          delay = Math.min(
            parseInt(url.searchParams.get("delay") || "0"),
            10000,
          );
          waitFor = url.searchParams.get("waitFor") || undefined;
          userAgent = url.searchParams.get("userAgent") || undefined;
          cacheControl = url.searchParams.get("cache") || "default";
          uploadToCloud = url.searchParams.get("uploadToS3") === "true";
          extractMeta = url.searchParams.get("metadata") !== "false";
          crop = undefined;
        }

        if (!["webp", "png", "jpeg", "jpg"].includes(format)) {
          format = "webp";
        }

        if (!targetUrl) {
          return Response.json(
            {
              error: "Missing URL parameter",
              message: "Please provide a 'url' parameter",
            },
            { status: 400, headers: CORS_HEADERS },
          );
        }

        const urlCheck = isUrlSafe(targetUrl);
        if (!urlCheck.safe) {
          return Response.json(
            {
              error: "Blocked URL",
              message: urlCheck.reason || "URL is not allowed",
            },
            { status: 403, headers: CORS_HEADERS },
          );
        }

        const paramsCheck = validateScreenshotParams({
          width,
          height,
          delay,
          quality,
          format,
        });
        if (!paramsCheck.valid) {
          return Response.json(
            {
              error: "Invalid parameters",
              message: paramsCheck.reason || "Invalid parameters",
            },
            { status: 400, headers: CORS_HEADERS },
          );
        }

        const filename = getImageFilename(
          targetUrl,
          width,
          height,
          dark,
          format,
          fullPage,
        );
        const filepath = join(CONFIG.IMAGES_DIR, filename);

        const shouldUseCache = cacheControl !== "refresh";
        const cached = shouldUseCache && existsSync(filepath);

        if (cacheControl === "only" && !cached) {
          return Response.json(
            { error: "Not cached", message: "Screenshot not in cache" },
            { status: 404, headers: CORS_HEADERS },
          );
        }

        let imageBuffer: Buffer;
        let fileSize: number;
        let metadata: any = null;
        let s3Url: string | undefined;

        if (cached) {
          stats.cacheHits++;
          imageBuffer = Buffer.from(await Bun.file(filepath).arrayBuffer());
          fileSize = imageBuffer.length;
        } else {
          stats.cacheMisses++;

          const result = await captureScreenshot(
            targetUrl,
            width,
            height,
            dark,
            fullPage,
            delay,
            waitFor,
            userAgent,
          );
          const processed = await processImage(
            result.buffer,
            format,
            quality,
            crop,
          );

          imageBuffer = processed.buffer;
          fileSize = processed.size;
          metadata = extractMeta ? result.metadata : null;

          await Bun.write(filepath, imageBuffer);

          if (uploadToCloud && CONFIG.S3_ENABLED) {
            s3Url = await uploadToS3(imageBuffer, filename, `image/${format}`);
          }
        }

        const responseTime = Date.now() - requestStart;

        if (outputFormat === "json") {
          return Response.json(
            {
              success: true,
              url: targetUrl,
              filename,
              localPath: `/images/${filename}`,
              s3Url,
              width,
              height,
              format,
              fullPage,
              dark,
              quality,
              size: fileSize,
              sizeKB: (fileSize / 1024).toFixed(2),
              cached,
              responseTime,
              metadata,
            },
            { headers: CORS_HEADERS },
          );
        }

        const contentType =
          format === "webp"
            ? "image/webp"
            : format === "png"
              ? "image/png"
              : "image/jpeg";

        return new Response(new Uint8Array(imageBuffer), {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=86400",
            "X-Cached": cached ? "true" : "false",
            "X-Response-Time": `${responseTime}ms`,
            ...CORS_HEADERS,
          },
        });
      } catch (error) {
        stats.errors++;
        return Response.json(
          {
            error: "Screenshot failed",
            message: error instanceof Error ? error.message : "Unknown error",
          },
          { status: 500, headers: CORS_HEADERS },
        );
      }
    }

    if (url.pathname === "/api/batch") {
      if (req.method !== "POST") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: CORS_HEADERS },
        );
      }

      try {
        const body = (await req.json()) as BatchRequestBody;
        const urls = body.urls || [];

        if (!Array.isArray(urls) || urls.length === 0) {
          return Response.json(
            { error: "Invalid request", message: "Provide an array of URLs" },
            { status: 400, headers: CORS_HEADERS },
          );
        }

        if (urls.length > 10) {
          return Response.json(
            { error: "Too many URLs", message: "Maximum 10 URLs per batch" },
            { status: 400, headers: CORS_HEADERS },
          );
        }

        for (const testUrl of urls) {
          const urlCheck = isUrlSafe(testUrl);
          if (!urlCheck.safe) {
            return Response.json(
              {
                error: "Blocked URL in batch",
                message: `${testUrl}: ${urlCheck.reason}`,
              },
              { status: 403, headers: CORS_HEADERS },
            );
          }
        }

        const results = await Promise.allSettled(
          urls.map(async (targetUrl: string) => {
            const filename = getImageFilename(
              targetUrl,
              1200,
              630,
              false,
              "webp",
              false,
            );
            const filepath = join(CONFIG.IMAGES_DIR, filename);

            if (existsSync(filepath)) {
              return {
                url: targetUrl,
                filename,
                cached: true,
                localPath: `/images/${filename}`,
              };
            }

            const result = await captureScreenshot(
              targetUrl,
              1200,
              630,
              false,
              false,
              0,
            );
            const processed = await processImage(result.buffer, "webp", 80);

            await Bun.write(filepath, processed.buffer);

            return {
              url: targetUrl,
              filename,
              cached: false,
              size: processed.size,
              localPath: `/images/${filename}`,
              metadata: result.metadata,
            };
          }),
        );

        return Response.json(
          {
            success: true,
            total: urls.length,
            results: results.map((r, i) => {
              if (r.status === "fulfilled") {
                return { success: true, ...r.value };
              } else {
                return {
                  success: false,
                  url: urls[i],
                  error: r.reason?.message || "Failed",
                };
              }
            }),
          },
          { headers: CORS_HEADERS },
        );
      } catch (error) {
        return Response.json(
          {
            error: "Batch processing failed",
            message: error instanceof Error ? error.message : "Unknown error",
          },
          { status: 500, headers: CORS_HEADERS },
        );
      }
    }

    if (url.pathname.startsWith("/images/")) {
      const filename = url.pathname.replace("/images/", "");
      const filepath = join(CONFIG.IMAGES_DIR, filename);

      if (existsSync(filepath)) {
        const file = Bun.file(filepath);
        const ext = filename.split(".").pop();
        const contentType =
          ext === "webp"
            ? "image/webp"
            : ext === "png"
              ? "image/png"
              : "image/jpeg";

        return new Response(file, {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000",
            ...CORS_HEADERS,
          },
        });
      }

      return Response.json(
        { error: "Image not found" },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    return Response.json(
      { error: "Not Found" },
      { status: 404, headers: CORS_HEADERS },
    );
  },

  error(error) {
    return Response.json(
      { error: "Internal Server Error", message: error.message },
      { status: 500 },
    );
  },
});

process.on("SIGINT", async () => {
  if (browser) await browser.close();
  process.exit(0);
});

console.log(`
  http://${CONFIG.HOST}:${CONFIG.PORT}

Features:
  Multiple formats (webp, png, jpeg)
  Full page screenshots
  Wait/Delay support
  Metadata extraction
  Batch processing (up to 10 URLs)
  Cache control (default, refresh, only)
  S3/R2 upload ${CONFIG.S3_ENABLED ? "ENABLED" : "❌"}
  Auto cleanup ${CONFIG.AUTO_CLEANUP_ENABLED ? "ENABLED" : "❌"}
  Usage stats

Storage: ${CONFIG.IMAGES_DIR}
Limits: ${CONFIG.MAX_REQUESTS_PER_IP} req/hour per IP

Endpoints:
  GET/POST /api/screenshot  → Generate screenshot
  POST     /api/batch       → Batch processing (10 URLs max)
  GET      /images/:file    → Serve image
  GET      /stats           → Usage statistics
  GET      /health          → Health check
`);
