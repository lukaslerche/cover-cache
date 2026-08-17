/**
 * Cover providers. Each takes an ISBN and returns image bytes, or null.
 *
 * Providers do not know what a placeholder is: they answer "here is an image" or
 * "nothing". Judging whether an image is a real cover belongs to the caller, the only
 * place that can see one image served for many different ISBNs.
 */
import { createHash } from 'node:crypto';
import { toIsbn10 } from './isbn.ts';

export type Image = { bytes: Buffer; contentType: string; source: string };

const UA = 'cover-cache (+https://api.ub.tu-dortmund.de)';

export const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');

async function getImage(url: string, source: string): Promise<Image | null> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return null;

  // Syndetics answers "no large image" with an HTML page rather than a status code.
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) return null;

  // Amazon answers unknown ISBNs with a 43-byte GIF, Syndetics with an 86-byte 1x1.
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length <= 100) return null;

  return { bytes, contentType, source };
}

/** Google Books. Best resolution of the four; weakest on German material. */
export async function google(isbn: string): Promise<Image | null> {
  const res = await fetch(`https://books.google.com/books?bibkeys=${isbn}&jscmd=viewapi`, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return null;

  // Response is `var _GBSBookInfo = {...};` — a fixed prefix around plain JSON.
  const body = await res.text();
  let info: Record<string, { thumbnail_url?: string }>;
  try {
    info = JSON.parse(body.replace(/^\s*var\s+_GBSBookInfo\s*=\s*/, '').replace(/;\s*$/, ''));
  } catch {
    return null;
  }

  const thumb = Object.values(info)[0]?.thumbnail_url;
  if (!thumb) return null;

  // Advertised thumbnail is tiny (zoom=5) with a page-curl graphic; zoom=3 is ~575x865.
  return getImage(thumb.replace(/zoom=\d+/, 'zoom=3').replace(/&edge=curl/, ''), 'gb');
}

/** Amazon. Carries most of the coverage, but the endpoint is undocumented. */
export async function amazon(isbn: string): Promise<Image | null> {
  const isbn10 = toIsbn10(isbn);
  if (!isbn10) return null;

  // The code before .jpg picks the size: LZZZZZZZ is ~304x500, MZZZZZZZZZ only ~97x160.
  return getImage(`https://images-na.ssl-images-amazon.com/images/P/${isbn10}.01.LZZZZZZZ.jpg`, 'aws');
}

/** Elisa (hbz). Small images, but the only source for a slice of German titles. */
export async function elisa(isbn: string): Promise<Image | null> {
  return getImage(`https://elisa.hbz-nrw.de/api/products/${isbn}/cover`, 'elisa');
}

/**
 * Syndetics (Bowker/ProQuest), the source behind Alma's cover images. `lc` is the largest size.
 */
export async function syndetics(isbn: string): Promise<Image | null> {
  return getImage(`https://syndetics.com/index.php?client=nextgen&isbn=${isbn}/lc.jpg`, 'syndetics');
}

export const ALL = { google, amazon, syndetics, elisa } as const;
export type ProviderName = keyof typeof ALL;
