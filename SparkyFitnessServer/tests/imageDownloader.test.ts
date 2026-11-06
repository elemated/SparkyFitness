import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';

vi.mock('../config/logging.js', () => ({ log: vi.fn() }));
// The guarded dispatcher resolves names through this at connect time; the
// user-supplied-URL tests below feed it private answers so no request leaves.
vi.mock('node:dns/promises', () => {
  const lookup = vi.fn();
  return { default: { lookup }, lookup };
});

// Point downloads at a scratch dir before the module reads the env at import,
// then restore it so this value doesn't leak into other test files' fresh
// imageDownloader instances in the same worker.
const TMP_UPLOADS = path.join(os.tmpdir(), `sparky-imgdl-test-${process.pid}`);
const priorUploadsDir = process.env.SPARKY_FITNESS_CUSTOM_UPLOADS_DIRECTORY;
process.env.SPARKY_FITNESS_CUSTOM_UPLOADS_DIRECTORY = TMP_UPLOADS;

const { downloadImage, downloadUserSuppliedImage } =
  await import('../utils/imageDownloader.js');
const { isOutboundUrlBlockedError } =
  await import('../utils/outboundUrlPolicy.js');
const dns = (await import('node:dns/promises')).default;

if (priorUploadsDir === undefined) {
  delete process.env.SPARKY_FITNESS_CUSTOM_UPLOADS_DIRECTORY;
} else {
  process.env.SPARKY_FITNESS_CUSTOM_UPLOADS_DIRECTORY = priorUploadsDir;
}

const MB = 1024 * 1024;
const realFetch = globalThis.fetch;

function imageResponse(
  body: BodyInit,
  headers: Record<string, string>
): Response {
  return new Response(body, { status: 200, headers });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  await fsp.rm(TMP_UPLOADS, { recursive: true, force: true });
});

describe('imageDownloader - downloadImage', () => {
  it('downloads a valid image and returns the web path', async () => {
    const bytes = Buffer.from('fake-png-bytes');
    globalThis.fetch = vi.fn().mockResolvedValue(
      imageResponse(bytes, {
        'content-type': 'image/png',
        'content-length': String(bytes.length),
      })
    );

    const result = await downloadImage(
      'https://cdn.example.com/good.png',
      'ex-ok'
    );

    // The stem keeps the source name; the suffix is derived from the full URL
    // so two same-named images on one entity can't overwrite each other.
    expect(result).toMatch(
      /^\/uploads\/exercises\/ex-ok\/good_[0-9a-f]{8}\.png$/
    );
    const written = await fsp.readFile(
      path.join(TMP_UPLOADS, 'exercises', 'ex-ok', path.basename(result))
    );
    expect(written.toString()).toBe('fake-png-bytes');
  });

  it('writes under the requested domain subdirectory', async () => {
    const bytes = Buffer.from('fake-food-bytes');
    globalThis.fetch = vi.fn().mockResolvedValue(
      imageResponse(bytes, {
        'content-type': 'image/png',
        'content-length': String(bytes.length),
      })
    );

    const result = await downloadImage(
      'https://cdn.example.com/product.png',
      'food-1',
      'foods'
    );

    expect(result).toMatch(
      /^\/uploads\/foods\/food-1\/product_[0-9a-f]{8}\.png$/
    );
    const written = await fsp.readFile(
      path.join(TMP_UPLOADS, 'foods', 'food-1', path.basename(result))
    );
    expect(written.toString()).toBe('fake-food-bytes');
  });

  it('keeps two same-named images on one entity in separate files', async () => {
    const bytes = Buffer.from('first-bytes');
    globalThis.fetch = vi.fn().mockResolvedValue(
      imageResponse(bytes, {
        'content-type': 'image/png',
        'content-length': String(bytes.length),
      })
    );
    const first = await downloadImage(
      'https://cdn-a.example.com/a/image.png',
      'ex-collide'
    );

    const otherBytes = Buffer.from('second-bytes');
    globalThis.fetch = vi.fn().mockResolvedValue(
      imageResponse(otherBytes, {
        'content-type': 'image/png',
        'content-length': String(otherBytes.length),
      })
    );
    const second = await downloadImage(
      'https://cdn-b.example.com/b/image.png',
      'ex-collide'
    );

    // Same basename, same entity, different URLs — previously both wrote to
    // image.png and the first download was lost.
    expect(first).not.toBe(second);
    const firstBody = await fsp.readFile(
      path.join(TMP_UPLOADS, 'exercises', 'ex-collide', path.basename(first))
    );
    expect(firstBody.toString()).toBe('first-bytes');
  });

  it('rejects a private/link-local host before making a request (SSRF)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    await expect(
      downloadImage('http://169.254.169.254/latest/meta.png', 'ex-ssrf')
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a loopback host before making a request (SSRF)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    await expect(
      downloadImage('http://localhost/internal.png', 'ex-loopback')
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('derives a safe extension for an extensionless image URL', async () => {
    const bytes = Buffer.from('fake-png-bytes');
    globalThis.fetch = vi.fn().mockResolvedValue(
      imageResponse(bytes, {
        'content-type': 'image/png',
        'content-length': String(bytes.length),
      })
    );

    const result = await downloadImage(
      'https://cdn.example.com/image?id=123',
      'ex-no-ext'
    );

    expect(result).toMatch(
      /^\/uploads\/exercises\/ex-no-ext\/image_[0-9a-f]{8}\.png$/
    );
    expect(
      fs.existsSync(
        path.join(TMP_UPLOADS, 'exercises', 'ex-no-ext', path.basename(result))
      )
    ).toBe(true);
  });

  it('replaces a misleading extension with one matching the response type', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        imageResponse('fake-png-bytes', { 'content-type': 'image/png' })
      );

    const result = await downloadImage(
      'https://cdn.example.com/evil.html',
      'ex-safe-ext'
    );

    expect(result).toMatch(
      /^\/uploads\/exercises\/ex-safe-ext\/evil_[0-9a-f]{8}\.png$/
    );
  });

  it('follows redirects through the guarded fetch path', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: '/images/final.png' },
        })
      )
      .mockResolvedValueOnce(
        imageResponse('redirected-png', { 'content-type': 'image/png' })
      );

    const result = await downloadImage(
      'https://cdn.example.com/start.png',
      'ex-redirect'
    );

    expect(result).toMatch(
      /^\/uploads\/exercises\/ex-redirect\/start_[0-9a-f]{8}\.png$/
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      'https://cdn.example.com/images/final.png',
      expect.any(Object)
    );
  });

  it('blocks a redirect to a private host', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/internal.png' },
      })
    );

    await expect(
      downloadImage('https://cdn.example.com/start.png', 'ex-redirect-ssrf')
    ).rejects.toThrow();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-image content-type', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        imageResponse('<html>phishing</html>', { 'content-type': 'text/html' })
      );

    await expect(
      downloadImage('https://cdn.example.com/x.png', 'ex-ct')
    ).rejects.toThrow(/disallowed content-type/);
    expect(
      fs.existsSync(path.join(TMP_UPLOADS, 'exercises', 'ex-ct', 'x.png'))
    ).toBe(false);
  });

  it('rejects an image exceeding the size cap via declared content-length', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      imageResponse('tiny', {
        'content-type': 'image/png',
        'content-length': String(20 * MB),
      })
    );

    await expect(
      downloadImage('https://cdn.example.com/big.png', 'ex-declared')
    ).rejects.toThrow(/exceeds maximum size/);
  });

  it('rejects and cleans up an image that streams past the size cap without a declared length', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(6 * MB));
        controller.enqueue(new Uint8Array(6 * MB));
        controller.close();
      },
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        imageResponse(stream, { 'content-type': 'image/png' })
      );

    await expect(
      downloadImage('https://cdn.example.com/streambig.png', 'ex-streamed')
    ).rejects.toThrow(/exceeds maximum size/);
    expect(
      fs.existsSync(
        path.join(TMP_UPLOADS, 'exercises', 'ex-streamed', 'streambig.png')
      )
    ).toBe(false);
  });
});

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('rest-of-png'),
]);
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('rest-of-jpeg'),
]);

async function filesIn(entityId: string): Promise<string[]> {
  return fsp
    .readdir(path.join(TMP_UPLOADS, 'exercises', entityId))
    .catch(() => []);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the download to fail');
}

describe('imageDownloader - downloadUserSuppliedImage', () => {
  it('saves a real PNG under a generated name', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        imageResponse(PNG_BYTES, { 'content-type': 'image/png' })
      );

    const result = await downloadUserSuppliedImage(
      'https://cdn.example.com/My%20Photo.png',
      'ux-ok',
      'exercises'
    );

    expect(result).toMatch(/^\/uploads\/exercises\/ux-ok\/[0-9a-f-]{36}\.png$/);
    const written = await fsp.readFile(
      path.join(TMP_UPLOADS, 'exercises', 'ux-ok', path.basename(result))
    );
    expect(written.equals(PNG_BYTES)).toBe(true);
  });

  it('passes an abort signal so the download is time-limited', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        imageResponse(PNG_BYTES, { 'content-type': 'image/png' })
      );

    await downloadUserSuppliedImage(
      'https://cdn.example.com/a.png',
      'ux-signal',
      'exercises'
    );

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('manual');
  });

  it('rejects HTML served as image/png (magic bytes) and writes nothing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      imageResponse('<html><script>alert(1)</script></html>', {
        'content-type': 'image/png',
      })
    );

    await expect(
      downloadUserSuppliedImage(
        'https://cdn.example.com/fake.png',
        'ux-magic',
        'exercises'
      )
    ).rejects.toThrow(/does not match its content-type/);
    expect(await filesIn('ux-magic')).toEqual([]);
  });

  it('rejects a JPEG body labelled as PNG', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        imageResponse(JPEG_BYTES, { 'content-type': 'image/png' })
      );

    await expect(
      downloadUserSuppliedImage(
        'https://cdn.example.com/x.png',
        'ux-mismatch',
        'exercises'
      )
    ).rejects.toThrow(/detected image\/jpeg/);
    expect(await filesIn('ux-mismatch')).toEqual([]);
  });

  it('rejects an empty body', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(imageResponse('', { 'content-type': 'image/png' }));

    await expect(
      downloadUserSuppliedImage(
        'https://cdn.example.com/empty.png',
        'ux-empty',
        'exercises'
      )
    ).rejects.toThrow(/does not match its content-type/);
  });

  it('rejects a non-image content-type', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        imageResponse(PNG_BYTES, { 'content-type': 'image/svg+xml' })
      );

    await expect(
      downloadUserSuppliedImage(
        'https://cdn.example.com/x.svg',
        'ux-svg',
        'exercises'
      )
    ).rejects.toThrow(/disallowed content-type/);
  });

  it('rejects an oversize image streamed without a declared length', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(PNG_BYTES));
        controller.enqueue(new Uint8Array(11 * MB));
        controller.close();
      },
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        imageResponse(stream, { 'content-type': 'image/png' })
      );

    await expect(
      downloadUserSuppliedImage(
        'https://cdn.example.com/huge.png',
        'ux-huge',
        'exercises'
      )
    ).rejects.toThrow(/exceeds maximum size/);
    expect(await filesIn('ux-huge')).toEqual([]);
  });

  it.each([
    'http://127.0.0.1/a.png',
    'http://localhost/a.png',
    'http://10.0.0.8/a.png',
    'http://192.168.1.1/a.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/a.png',
    'http://[fd00:ec2::254]/a.png',
    'http://[::ffff:127.0.0.1]/a.png',
    'file:///etc/passwd',
    'ftp://cdn.example.com/a.png',
    'https://user:pass@cdn.example.com/a.png',
  ])('refuses %s before any request', async (url) => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    await expect(
      downloadUserSuppliedImage(url, 'ux-ssrf', 'exercises')
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['http://127.0.0.1/internal.png'],
    ['http://169.254.169.254/latest/meta-data/'],
    ['http://localhost:8080/admin'],
    ['file:///etc/passwd'],
  ])('refuses a redirect to %s without following it', async (location) => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location } })
      );

    await expect(
      downloadUserSuppliedImage(
        'https://cdn.example.com/start.png',
        'ux-redirect',
        'exercises'
      )
    ).rejects.toThrow();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('stops after the redirect cap', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/again.png' },
        })
    );

    await expect(
      downloadUserSuppliedImage(
        'https://cdn.example.com/loop.png',
        'ux-loop',
        'exercises'
      )
    ).rejects.toThrow(/redirect limit/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(6);
  });

  // These use the real fetch and guarded dispatcher: the name check happens
  // when the connection is opened, against the DNS answer.
  it.each([
    [[{ address: '10.1.2.3', family: 4 }]],
    [[{ address: '169.254.169.254', family: 4 }]],
    [[{ address: '::1', family: 6 }]],
    // One private answer is enough to refuse, even beside a public one.
    [
      [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    ],
  ])(
    'refuses a hostname whose DNS answer is private (%j)',
    async (addresses) => {
      vi.mocked(dns.lookup).mockResolvedValue(addresses as never);

      const error = await rejection(
        downloadUserSuppliedImage(
          'http://rebind.example.test/a.png',
          'ux-dns',
          'exercises'
        )
      );

      expect(isOutboundUrlBlockedError(error)).toBe(true);
      expect(dns.lookup).toHaveBeenCalledWith(
        'rebind.example.test',
        expect.objectContaining({ all: true })
      );
      expect(await filesIn('ux-dns')).toEqual([]);
    }
  );
});
