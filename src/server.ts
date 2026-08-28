/**
 * cover-cache: GET /cover?isbn=… always answers with an image — a real cover when a
 * provider has one, a 1x1 transparent PNG when none does — so a catalogue can place the
 * tag unconditionally.
 */
import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { Store, type Cover } from './store.ts';
import { normalise } from './isbn.ts';
import { ALL, md5, type Image, type ProviderName } from './providers.ts';

const PORT = Number(process.env.PORT ?? 9228);
const IMAGE_DIR = process.env.IMAGE_DIR ?? './images';
const DB_PATH = process.env.DB_PATH ?? join(IMAGE_DIR, 'covers.db');
// google for resolution, amazon for German coverage, syndetics for the English tail, elisa for the German remainder.
const ORDER = (process.env.PROVIDERS ?? 'google,amazon,syndetics,elisa').split(',') as ProviderName[];

const MISS_TTL_DAYS = 30;
/** How long a request waits for a first-time fetch before falling back to the placeholder. */
const FIRST_REQUEST_WAIT_MS = 1500;
/** Distinct ISBNs that must share one image before it is judged a placeholder. */
const PLACEHOLDER_THRESHOLD = 4;
const CANARY_ISBNS = ['9780415480635', '9783110748529', '9781350185241'];

/** Shared secret for POST /upload. Unset refuses every upload. */
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN;
/** Only what EXT in store.ts can name, so the stored file and the type served always agree. */
const UPLOAD_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif']);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** 1x1 fully transparent PNG (RGBA 0,0,0,0) — the answer when there is no cover. */
const NONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
  'base64',
);

const store = new Store(IMAGE_DIR, DB_PATH, MISS_TTL_DAYS);
const inFlight = new Map<string, Promise<Cover | null>>();

/** Ask each provider in turn; first real cover wins. Deduplicated per ISBN. */
function fetchCover(isbn: string): Promise<Cover | null> {
  const running = inFlight.get(isbn);
  if (running) return running;

  const job = (async () => {
    for (const name of ORDER) {
      const img: Image | null = await ALL[name]?.(isbn).catch((err) => {
        console.warn(`${name} failed for ${isbn}: ${err.message}`);
        return null;
      }) ?? null;
      if (!img) continue;

      // Some providers answer "no cover" with a graphic that passes every check — Google
      // does. One image across many unrelated ISBNs is the only reliable tell.
      const hash = md5(img.bytes);
      if (store.isPlaceholder(hash)) continue;

      const seen = store.countHash(hash, isbn) + 1;
      if (seen >= PLACEHOLDER_THRESHOLD) {
        const dropped = store.markPlaceholder(hash, img.source, seen);
        console.warn(
          `${img.source}: image ${hash.slice(0, 8)}… seen for ${seen} ISBNs — treating as a placeholder` +
            (dropped ? `, dropped ${dropped} cached entries` : ''),
        );
        continue;
      }

      // A curated cover may have landed while the providers were being asked; it wins.
      return store.curated(isbn) ?? store.record(isbn, { ...img, hash });
    }
    const curated = store.curated(isbn);
    if (curated) return curated;
    store.record(isbn, null);
    return null;
  })().finally(() => inFlight.delete(isbn));

  inFlight.set(isbn, job);
  return job;
}

const app = new Hono();

app.use('*', async (c, next) => {
  await next();
  c.header('Access-Control-Allow-Origin', c.req.header('Origin') ?? '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  c.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
});

app.options('*', (c) => c.body(null, 204));

function sendCover(c: Context, cover: Cover) {
  const etag = store.etag(cover.file);
  if (c.req.header('if-none-match') === etag) return c.body(null, 304);

  c.header('Content-Type', cover.type);
  c.header('Cache-Control', 'public, max-age=86400');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('ETag', etag);
  return c.body(readFileSync(store.path(cover.file)));
}

function sendPlaceholder(c: Context) {
  c.header('Content-Type', 'image/png');
  c.header('X-Content-Type-Options', 'nosniff');
  // Short, so a client that asked before the cover arrived picks it up on the next view.
  c.header('Cache-Control', 'public, max-age=60');
  return c.body(NONE_PNG);
}

app.get('/cover', async (c) => {
  const raw = c.req.query('isbn');
  if (!raw) return c.text('ISBN is empty!', 400);

  const isbns = raw.split(',').map(normalise).filter((i): i is string => i !== null);
  if (isbns.length === 0) return sendPlaceholder(c);

  const pending: Promise<Cover | null>[] = [];
  for (const isbn of isbns) {
    const found = store.lookup(isbn);
    if (found.status === 'hit') return sendCover(c, found.cover);
    if (found.status === 'unknown') pending.push(fetchCover(isbn));
  }

  // Providers usually answer inside a second, so a short wait means the first viewer
  // normally gets the real cover. First to arrive wins; a slow ISBN holds up nothing.
  if (pending.length > 0) {
    const anyCover = Promise.any(pending.map((p) => p.then((cover) => cover ?? Promise.reject()))).catch(() => null);
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), FIRST_REQUEST_WAIT_MS));
    const cover = await Promise.race([anyCover, timeout]);
    if (cover) return sendCover(c, cover);
  }

  return sendPlaceholder(c);
});

app.get('/health', (c) => c.json({ status: 'ok', providers: ORDER, ...store.stats() }));

/**
 * Provider liveness check.
 */
app.get('/canary', async (c) => {
  const results: Record<string, Record<string, string>> = {};
  let ok = 0;

  for (const isbn of CANARY_ISBNS) {
    const perProvider: Record<string, string> = {};
    for (const name of ORDER) {
      const img = await ALL[name]?.(isbn).catch(() => null);
      perProvider[name] = img ? `${img.bytes.length}B ${md5(img.bytes).slice(0, 8)}` : 'none';
    }
    if (Object.values(perProvider).some((v) => v !== 'none')) ok++;
    results[isbn] = perProvider;
  }

  const rate = ok / CANARY_ISBNS.length;
  return c.json({ healthy: rate >= 0.8, rate, checked: CANARY_ISBNS.length, results }, rate >= 0.8 ? 200 : 503);
});

/** Constant-time compare, so a wrong key leaks nothing through response timing. */
function keyOk(given: string | undefined): boolean {
  if (!UPLOAD_TOKEN || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(UPLOAD_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Curated covers outrank every provider and are permanent. */
app.post('/upload', async (c) => {
  if (!UPLOAD_TOKEN) return c.text('Upload is not configured!', 503);
  if (!keyOk(c.req.header('x-api-key'))) return c.text('Invalid API key!', 401);

  const raw = c.req.query('isbn');
  if (!raw) return c.text('ISBN is empty!', 400);

  const isbn = normalise(raw);
  if (!isbn) return c.text('ISBN is invalid!', 400);

  const contentType = (c.req.header('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!UPLOAD_TYPES.has(contentType)) return c.text('Image must be JPEG, PNG or GIF!', 415);

  // Content-Length is a claim the client can lie about, so the body is measured again below.
  if (Number(c.req.header('content-length')) > MAX_UPLOAD_BYTES) return c.text('Image is too large!', 413);

  const bytes = Buffer.from(await c.req.arrayBuffer());
  if (bytes.length === 0) return c.text('Image body is empty!', 400);
  if (bytes.length > MAX_UPLOAD_BYTES) return c.text('Image is too large!', 413);

  store.record(isbn, { bytes, contentType, source: 'upload', hash: md5(bytes) });
  return c.body(null, 201);
});

console.log(`providers: ${ORDER.join(' → ')} | placeholders known: ${store.stats().placeholders.length}`);
if (!UPLOAD_TOKEN) console.warn('UPLOAD_TOKEN is not set — POST /upload refuses every request.');
serve({ fetch: app.fetch, port: PORT }, (info) => console.log(`cover-cache listening on :${info.port}`));
