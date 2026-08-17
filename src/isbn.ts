/**
 * ISBN validation. Catalogue data is messier than the standard: separators vary, and the
 * field sometimes carries a classification notation instead of an ISBN.
 */
export function normalise(raw: string): string | null {
  const isbn = raw.trim();
  // RVK is a classification notation, not an identifier any provider can answer.
  if (!isbn || isbn.toUpperCase().startsWith('RVK')) return null;

  const clean = isbn.replace(/[-\s]/g, '').toUpperCase();
  if (clean.length === 10) return /^[0-9]{9}[0-9X]$/.test(clean) ? clean : null;
  if (clean.length === 13) return /^[0-9]{13}$/.test(clean) ? clean : null;
  return null;
}

/** Amazon's image endpoint is keyed by ISBN-10. */
export function toIsbn10(isbn: string): string | null {
  if (isbn.length === 10) return isbn;
  if (!isbn.startsWith('978')) return null; // 979- prefixes have no ISBN-10 form

  const body = isbn.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(body[i]) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  return body + (check === 10 ? 'X' : String(check));
}
