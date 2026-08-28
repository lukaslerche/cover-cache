# cover-cache

An HTTP service that returns a book cover image for an ISBN, caching what it finds so each
cover is fetched upstream only once.

```
GET /cover?isbn=9780415480635
```

It always answers with an image — the cover if any provider has one, a 1×1 transparent PNG
if none does — so a catalogue can place an `<img>` tag unconditionally. Cover files and the
SQLite index share one directory, so the whole state of the service is one volume.

## Requirements

**Node 24 or newer.** The TypeScript sources run directly, with no build step, and the index uses the built-in `node:sqlite`.

Dependencies are managed with **pnpm** — the version is pinned in `packageManager`.

## Running it

```bash
pnpm install
pnpm start

curl -o cover.jpg 'http://localhost:9228/cover?isbn=9780415480635'
```

Optionally create a .env file with a an `UPLOAD_TOKEN` to enable uploading.

### Docker

The image is published to `ghcr.io/lukaslerche/cover-cache`.

```bash
# deploy
docker compose pull && docker compose up -d

# publish a new image (after: docker login ghcr.io)
docker build -t ghcr.io/lukaslerche/cover-cache:latest -t ghcr.io/lukaslerche/cover-cache:1.1.0 .
docker push ghcr.io/lukaslerche/cover-cache

# publish with builx
docker buildx build --platform linux/amd64,linux/arm64 \
  --tag ghcr.io/lukaslerche/cover-cache:latest \
  --tag ghcr.io/lukaslerche/cover-cache:1.1.0 \
  --push .
```

## Endpoints

| endpoint | what it does |
| --- | --- |
| `GET /cover?isbn=…` | The cover, or a 1×1 transparent PNG. Accepts comma-separated ISBNs and returns the first that has a cover. Sends `ETag`, so repeat views revalidate with a 304. |
| `GET /health` | Cache statistics: totals, hits per source, placeholders learned. Instant, touches nothing external. |
| `GET /canary` | Fetches known-good ISBNs from every provider; **503** if fewer than 80% come back. Slow, calls third parties. |
| `POST /upload?isbn=…` | Store a **curated cover**, replacing whatever is cached. Requires `X-API-Key`; body is the image, `Content-Type` one of `image/jpeg`, `image/png`, `image/gif`, at most 5 MB. **201** on success, **401** on a bad key, **415** on any other type, **413** over the limit, **503** if `UPLOAD_TOKEN` is unset. |

```bash
curl -X POST -H "X-API-Key: $UPLOAD_TOKEN" -H 'Content-Type: image/jpeg' \
  --data-binary @cover.jpg 'http://localhost:9228/upload?isbn=9780415480635'
```

A curated cover outranks every provider and is permanent: providers are not consulted for
that ISBN again, and the placeholder sweep never removes it. Correct a mistake by uploading
a better image.

Point the uptime monitor at `/canary`. A cover source rots quietly and the service keeps answering `200` with placeholders, which `/health`
cannot see.

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `PORT` | `9228` | listen port |
| `IMAGE_DIR` | `./images` | where cover files are written |
| `DB_PATH` | `<IMAGE_DIR>/covers.db` | SQLite index; defaults inside the image directory |
| `PROVIDERS` | `google,amazon,syndetics,elisa` | which sources to try, in order |
| `UPLOAD_TOKEN` | *(unset)* | shared secret for `POST /upload`, sent as `X-API-Key`. Unset means uploads are refused. |

The miss TTL, first-request wait, placeholder threshold and canary ISBNs are constants in
`src/server.ts`.

## Providers

Tried in order; the first real cover wins. Google for resolution, Amazon for German
coverage, Syndetics for the English tail, Elisa for the German remainder.

| provider | notes |
| --- | --- |
| **Google Books** | Best resolution (`zoom=3`, ~575×865). Weakest on German material. |
| **Amazon** | Broadest coverage (`LZZZZZZZ`, ~304×500). Undocumented endpoint — see Known gaps. |
| **Syndetics** (Bowker/ProQuest) | The English tail: 42% on a 124-ISBN K10plus sample, but 97% on English 2023 material against 18–28% on the German strata. Largest size ~266×400. |
| **Elisa** (hbz) | Small images, but the only source for a slice of German titles. |

## Placeholders

Providers do not reliably signal "no cover" with a status code; several return a graphic
instead, which passes every size and content-type check. Cached, it shows forever.

These are caught by content, not configuration. Every stored image is indexed by md5, and
once **4 distinct ISBNs** share the same bytes it is recorded as a placeholder, everything
cached under it is dropped, and those ISBNs refetch from the remaining providers. Learned
hashes survive restarts and appear in `/health`. Four rather than two, because a hardback
and a paperback of the same title routinely share a cover.

Curated covers sit outside this entirely: they are neither counted towards the threshold
nor dropped when one trips.
