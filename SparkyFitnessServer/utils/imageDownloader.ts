import fs from 'fs';
import { promises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { log } from '../config/logging.js';
import {
  createGuardedFetch,
  PUBLIC_ONLY_AI_NETWORK_POLICY,
} from './outboundUrlPolicy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fsp = { promises }.promises; // Import fs.promises as fsp
const baseUploadsDir = process.env.SPARKY_FITNESS_CUSTOM_UPLOADS_DIRECTORY
  ? path.resolve(process.env.SPARKY_FITNESS_CUSTOM_UPLOADS_DIRECTORY)
  : path.join(__dirname, '../uploads');

// Domains that may own a downloaded-image subdirectory under the uploads root.
// Kept as a closed union so a caller can never steer writes outside the base dir.
type ImageDomain =
  'exercises' | 'foods' | 'meals' | 'food_entries' | 'food_entry_meals';

function domainUploadsDir(domain: ImageDomain): string {
  return path.join(baseUploadsDir, domain);
}

// Image URLs are externally sourced; download through the public-host guard and
// accept only raster image types/sizes before writing under the served uploads dir.
const guardedFetch = createGuardedFetch(PUBLIC_ONLY_AI_NETWORK_POLICY);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_REDIRECTS = 5;
const IMAGE_CONTENT_TYPE_EXTENSIONS = new Map<string, readonly string[]>([
  ['image/png', ['.png']],
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/gif', ['.gif']],
  ['image/webp', ['.webp']],
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Enough leading bytes to recognize every allowed type (WebP needs 12).
const MAGIC_SNIFF_BYTES = 12;
const USER_SUPPLIED_TIMEOUT_MS = 15_000;

/**
 * Extra checks for a URL a person (or the assistant on their behalf) typed in,
 * rather than one an exercise/food provider returned.
 * - `timeoutMs` bounds the whole download, redirects and body included.
 * - `verifyMagicBytes` refuses a body whose leading bytes are not the image
 *   type the server declared, so an HTML page labelled image/png is not saved.
 * - `generatedFileName` names the file with a random UUID instead of the
 *   source URL's basename.
 */
interface DownloadImageOptions {
  timeoutMs?: number;
  verifyMagicBytes?: boolean;
  generatedFileName?: boolean;
}

function sniffImageType(head: Buffer): string | null {
  if (
    head.length >= 8 &&
    head
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    head.length >= 3 &&
    head[0] === 0xff &&
    head[1] === 0xd8 &&
    head[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  const ascii = head.subarray(0, 12).toString('latin1');
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) {
    return 'image/gif';
  }
  if (
    head.length >= 12 &&
    ascii.startsWith('RIFF') &&
    ascii.slice(8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function assertMagicBytesMatch(head: Buffer, contentType: string): void {
  const sniffed = sniffImageType(head);
  if (sniffed !== contentType) {
    throw new Error(
      `[imageDownloader] Image content does not match its content-type ${contentType} (detected ${sniffed ?? 'unknown'})`
    );
  }
}

async function fetchImageResponse(
  imageUrl: string,
  signal?: AbortSignal
): Promise<Response> {
  let currentUrl = imageUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    // Each hop goes back through the guarded fetch, so a redirect target is
    // re-checked (scheme, literal address, DNS answer at connect) like the
    // original URL.
    const response = await guardedFetch(
      currentUrl,
      signal ? { signal } : undefined
    );
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) {
      throw new Error(
        `[imageDownloader] Redirect response ${response.status} had no location`
      );
    }
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error(
        `[imageDownloader] Image exceeded the ${MAX_REDIRECTS}-redirect limit`
      );
    }

    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error('[imageDownloader] Image redirect resolution failed');
}

function resolveImageFileName(
  imageUrl: string,
  contentType: string,
  generated = false
): string {
  const allowedExtensions = IMAGE_CONTENT_TYPE_EXTENSIONS.get(contentType);
  if (!allowedExtensions) {
    throw new Error(
      `[imageDownloader] Rejected image with disallowed content-type: ${contentType || '(none)'}`
    );
  }
  if (generated) {
    return `${crypto.randomUUID()}${allowedExtensions[0]}`;
  }

  const sourceName = path.basename(new URL(imageUrl).pathname);
  const sourceExtension = path.extname(sourceName).toLowerCase();
  // Two images on one entity can share a basename while coming from different
  // URLs (…/a/image.jpg and …/b/image.jpg). Without the URL-derived suffix they
  // land on the same path, so the concurrent downloads in localizeImages
  // overwrite each other and both array slots point at one file.
  const urlHash = crypto
    .createHash('md5')
    .update(imageUrl)
    .digest('hex')
    .slice(0, 8);
  const sourceStem =
    path
      .basename(sourceName, path.extname(sourceName))
      .replace(/[^a-zA-Z0-9_-]/g, '_') || 'image';

  if (sourceName && allowedExtensions.includes(sourceExtension)) {
    return `${sourceStem}_${urlHash}${sourceExtension}`;
  }

  return `${sourceStem}_${urlHash}${allowedExtensions[0]}`;
}

/**
 * Ensures the upload directory exists.
 */
async function ensureUploadsDir(domain: ImageDomain) {
  try {
    await fsp.mkdir(domainUploadsDir(domain), { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      'error',
      `[imageDownloader] Error ensuring uploads directory exists: ${message}`
    );
    throw error;
  }
}

/**
 * Downloads an image from a URL and saves it locally.
 * @param imageUrl - The URL of the image to download.
 * @param entityId - The ID of the owning entity, used for creating a subdirectory.
 * @param domain - Which uploads subdirectory the image belongs to.
 * @param options - Stricter checks for user-supplied URLs.
 * @returns The web-accessible path to the downloaded image.
 */
async function downloadImage(
  imageUrl: string,
  entityId: string,
  domain: ImageDomain = 'exercises',
  options: DownloadImageOptions = {}
): Promise<string> {
  await ensureUploadsDir(domain);

  try {
    const signal = options.timeoutMs
      ? AbortSignal.timeout(options.timeoutMs)
      : undefined;
    const response = await fetchImageResponse(imageUrl, signal);
    if (!response.ok) {
      throw new Error(
        `[imageDownloader] Upstream returned status ${response.status}`
      );
    }

    const contentType = (response.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const imageFileName = resolveImageFileName(
      imageUrl,
      contentType,
      options.generatedFileName
    );
    const entityUploadDir = path.join(domainUploadsDir(domain), entityId);
    const localImagePath = path.join(entityUploadDir, imageFileName);

    await fsp.mkdir(entityUploadDir, { recursive: true });

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      throw new Error(
        `[imageDownloader] Image exceeds maximum size of ${MAX_IMAGE_BYTES} bytes`
      );
    }

    if (!response.body) {
      throw new Error('[imageDownloader] Response had no body');
    }

    let downloaded = 0;
    const source = Readable.fromWeb(
      response.body as unknown as NodeReadableStream
    );

    async function* enforceSizeLimit(chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        downloaded += chunk.length;
        if (downloaded > MAX_IMAGE_BYTES) {
          throw new Error(
            `[imageDownloader] Image exceeds maximum size of ${MAX_IMAGE_BYTES} bytes`
          );
        }
        yield chunk;
      }
    }

    // Holds back the first bytes until they are checked, so nothing that
    // fails the sniff is ever written.
    async function* enforceMagicBytes(chunks: AsyncIterable<Buffer>) {
      let head: Buffer[] = [];
      let headLength = 0;
      let checked = false;
      for await (const chunk of chunks) {
        if (checked) {
          yield chunk;
          continue;
        }
        head.push(chunk);
        headLength += chunk.length;
        if (headLength >= MAGIC_SNIFF_BYTES) {
          const buffered = Buffer.concat(head);
          assertMagicBytesMatch(buffered, contentType);
          checked = true;
          head = [];
          yield buffered;
        }
      }
      if (!checked) {
        const buffered = Buffer.concat(head);
        assertMagicBytesMatch(buffered, contentType);
        yield buffered;
      }
    }

    try {
      if (options.verifyMagicBytes) {
        await pipeline(
          source,
          enforceSizeLimit,
          enforceMagicBytes,
          fs.createWriteStream(localImagePath)
        );
      } else {
        await pipeline(
          source,
          enforceSizeLimit,
          fs.createWriteStream(localImagePath)
        );
      }
    } catch (streamError) {
      await fsp.unlink(localImagePath).catch(() => {});
      throw streamError;
    }

    return `/uploads/${domain}/${entityId}/${imageFileName}`; // Return web-accessible path
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      'error',
      `[imageDownloader] Error downloading image ${imageUrl}: ${message}`
    );
    throw error;
  }
}
/**
 * Downloads an image from a URL a person supplied: public hosts only (checked
 * at every redirect and pinned at connect), a 15 s overall timeout, the 10 MB
 * cap, an allowed raster content-type whose leading bytes agree, and a random
 * file name.
 */
function downloadUserSuppliedImage(
  imageUrl: string,
  entityId: string,
  domain: ImageDomain
): Promise<string> {
  return downloadImage(imageUrl, entityId, domain, {
    timeoutMs: USER_SUPPLIED_TIMEOUT_MS,
    verifyMagicBytes: true,
    generatedFileName: true,
  });
}

export { downloadImage, downloadUserSuppliedImage };
export type { ImageDomain };
export default {
  downloadImage,
  downloadUserSuppliedImage,
};
