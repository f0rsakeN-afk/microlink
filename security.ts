export function isUrlSafe(urlString: string): {
  safe: boolean;
  reason?: string;
} {
  try {
    const url = new URL(urlString);

    if (!["http:", "https:"].includes(url.protocol)) {
      return { safe: false, reason: "Only HTTP and HTTPS protocols allowed" };
    }

    const hostname = url.hostname.toLowerCase();

    const blockedPatterns = [
      /^localhost$/i,
      /^127\./,
      /^0\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^::1$/,
      /^fc00:/,
      /^fe80:/,
      /^metadata\.google\.internal$/i,
      /^169\.254\.169\.254$/,
    ];

    for (const pattern of blockedPatterns) {
      if (pattern.test(hostname)) {
        return {
          safe: false,
          reason:
            "Access to private networks and cloud metadata endpoints is blocked",
        };
      }
    }

    const blockedPorts = [
      22, 23, 25, 110, 143, 445, 1433, 3306, 3389, 5432, 6379, 27017,
    ];
    if (url.port && blockedPorts.includes(parseInt(url.port))) {
      return { safe: false, reason: "Access to sensitive ports is blocked" };
    }

    if (url.username || url.password) {
      return { safe: false, reason: "URLs with credentials are not allowed" };
    }

    const suspiciousPatterns = [
      /javascript:/i,
      /data:/i,
      /vbscript:/i,
      /file:/i,
      /about:/i,
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(urlString)) {
        return { safe: false, reason: "Suspicious URL scheme detected" };
      }
    }

    const pathSegments = url.pathname.split("/");
    for (const segment of pathSegments) {
      if (
        segment.includes("..") ||
        segment.includes("%2e%2e") ||
        segment.includes("%252e")
      ) {
        return { safe: false, reason: "Path traversal detected" };
      }
    }

    if (url.hostname.length > 253 || urlString.length > 2048) {
      return { safe: false, reason: "URL too long" };
    }

    return { safe: true };
  } catch (error) {
    return { safe: false, reason: "Invalid URL format" };
  }
}

export function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function isWithinRateLimit(
  rateLimitMap: Map<string, { count: number; resetAt: number }>,
  ip: string,
  maxRequests: number,
  enabled: boolean,
): boolean {
  if (!enabled) return true;

  const now = Date.now();
  const limit = rateLimitMap.get(ip);

  if (!limit || now > limit.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 3600000 });
    return true;
  }

  if (limit.count >= maxRequests) return false;

  limit.count++;
  return true;
}

export function validateScreenshotParams(params: {
  width?: number;
  height?: number;
  delay?: number;
  quality?: number;
  format?: string;
}): { valid: boolean; reason?: string } {
  if (params.width && (params.width < 320 || params.width > 3840)) {
    return { valid: false, reason: "Width must be between 320 and 3840" };
  }

  if (params.height && (params.height < 240 || params.height > 2160)) {
    return { valid: false, reason: "Height must be between 240 and 2160" };
  }

  if (params.delay && (params.delay < 0 || params.delay > 10000)) {
    return { valid: false, reason: "Delay must be between 0 and 10000ms" };
  }

  if (params.quality && (params.quality < 1 || params.quality > 100)) {
    return { valid: false, reason: "Quality must be between 1 and 100" };
  }

  if (
    params.format &&
    !["webp", "png", "jpeg", "jpg"].includes(params.format)
  ) {
    return { valid: false, reason: "Format must be webp, png, or jpeg" };
  }

  return { valid: true };
}
