# Operating a FONDACO book

A book is a small service: one Node process, one SQLite file, no keys. It never holds funds or signs anything. It
collects signed offers, checks them against the chain, and serves them. Anyone can run one; the app lets every user
choose which book to read (Impostazioni).

The stack (`deploy/`), tested end to end by `docker-smoke` (`packages/book-server/test/docker-smoke.mjs`):

| Service | Image | Role |
|---|---|---|
| `book` | `ghcr.io/arabafenice599rae/fondaco-book:<git tag>`, e.g. `:v0.1.0` (published by the CI only when a `v*` tag on a commit of `main` is pushed; tag and digest in the run summary and in REPORT.md) | the book server, user `node`, data in the `book-data` volume, no published port |
| `caddy` | `caddy:2.10.2-alpine@sha256:4c6e…530d` | TLS (automatic certificates), reverse proxy, `/stream` not buffered |
| `backup` | same image as `book` | an hourly consistent snapshot of SQLite, gzipped, uploaded to S3-compatible storage (SigV4), 168 copies kept |

Logs: every service uses the `json-file` driver with rotation (10 MB × 5). The book writes JSON, one object per line.

## 1. First start

```bash
cp deploy/.env.example deploy/.env          # DOMAIN, BOOK_VERSION, S3_* (credentials limited to the backup bucket)
cp deploy/book.example.json deploy/book.json
# edit book.json: chains.<id>.swap (SwapERC20 address), rpc (primary + reserve), startBlock (deploy block), tokens
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d
curl -s https://$DOMAIN/health        # {"ok":true}
curl -s https://$DOMAIN/config | jq . # contract, fee, markets
```

DNS for `DOMAIN` must point at the host before the start: Caddy obtains the certificate on the first request.

## 2. Configuration that matters

Full reference: [`CONFIG.md`](CONFIG.md), generated from the schema. The start fails on unknown keys and wrong values,
listing all of them.

- **RPC with a reserve.** Set `chains.<id>.rpc` to a list, for example `["https://primary…", "https://reserve…"]`. The book
  falls back to the next endpoint when one fails. Use endpoints that serve `eth_getLogs` over the ranges you index.
  - If a provider caps log ranges, set `logSignerChunk` to 200 (see CONFIG.md); the book already falls back automatically,
    and records it in logs and metrics.
  - Keep the endpoints' keys out of the repository: `book.json` is git-ignored.
- **`trustProxy`: 1 behind Caddy**, as in `book.example.json`, and 0 if the book is reached directly. The rate limiter and the
  SSE limits are per client: with the wrong value either every user shares the proxy's address, or a client can forge
  `X-Forwarded-For`.
- **`host`** must be `0.0.0.0` in the container: Caddy reaches it on the internal network, and no port is published.
- **`maxStalenessMs`** (default 120 s) is fail-closed: when the chain cannot be read for that long, `/book` and `/books`
  answer `503 stale`, and the app blocks trading with "Dati non aggiornati". Do not raise it to hide RPC trouble; fix the RPC.
- **`reorgDepth`** (default 64 = Ethereum finality). On a chain with slower finality, raise it to that chain's finality depth.
- **Metrics** are off by default. To enable them, set `metrics.enabled`, then either an allow-list (`metrics.allow`) or
  `metrics.token`; never expose them publicly.

## 3. Backups and restore

The `backup` service runs `node scripts/backup.mjs loop`:
- it takes a snapshot every `BACKUP_EVERY_SEC` with `VACUUM INTO`, which is safe while the book writes;
- it runs `PRAGMA integrity_check` on the snapshot;
- it gzips it and uploads `book/book-<timestamp>.sqlite.gz`;
- it keeps the last `BACKUP_KEEP` copies.

On-demand commands:
```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env exec backup node scripts/backup.mjs once   # a backup now
docker compose -f deploy/compose.yaml --env-file deploy/.env exec backup node scripts/backup.mjs list   # what is stored
```

**Restore**: stop the book, write the database from the backup, start again.
```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env stop book
docker compose -f deploy/compose.yaml --env-file deploy/.env run --rm --entrypoint sh backup -c \
  'mv /data/book.sqlite /data/book.sqlite.old; rm -f /data/book.sqlite-wal /data/book.sqlite-shm;
   node scripts/backup.mjs restore latest /data/book.sqlite'     # or a key from `list`
docker compose -f deploy/compose.yaml --env-file deploy/.env start book
```

The book re-reads the chain from its last indexed block, so whatever happened after the snapshot is caught up: fills,
cancels, fee changes. Offers *submitted* after the snapshot are lost, so their makers must post them again. A
database too old to be resumed is simply rebuilt from `startBlock`: it holds no state that the chain cannot rebuild,
except those offers.

## 4. Upgrade

```bash
# deploy/.env: BOOK_VERSION=<git tag of the release, e.g. v0.2.0>   (images are immutable; the run summary lists the digest)
docker compose -f deploy/compose.yaml --env-file deploy/.env pull book backup
docker compose -f deploy/compose.yaml --env-file deploy/.env exec backup node scripts/backup.mjs once   # a fresh backup first
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d book backup
```

- **Database migrations** are versioned and applied at start. A database newer than the code is refused, so a downgrade
  needs the backup taken before the upgrade.
- **Pinning the image:** `BOOK_IMAGE=ghcr.io/…/fondaco-book@sha256:<digest>` with `BOOK_VERSION` empty would not work
  with the `image:` line as written. To run by digest, put the full reference with the digest in `BOOK_IMAGE` and edit the
  `image:` lines.

## 5. When the contract owner changes the fee

`SetProtocolFee` on-chain is seen at the next indexing round:
- every live offer signed with the old fee becomes `invalid_fee` and leaves the book;
- `/config` shows the new `protocolFee`, and the SSE stream sends `fee` and `governance` events;
- the app shows "Parametri del contratto modificati" and puts the affected offers in "Da rifirmare".

Nothing is to be done on the book. Makers re-sign with the same nonce: the book replaces the `invalid_fee` order, so at
most one of the two can ever fill (D-48). If the fee goes back to the old value, the offers that were never re-signed
become live again on their own.

If `protocolFeeLight ≠ protocolFee` (`SetProtocolFeeLight`), the book keeps working; the app shows the governance banner.
FONDACO never uses `swapLight`.

## 6. Deep reorg (beyond `reorgDepth`)

The book rolls back the last `reorgDepth` blocks by itself (fills, cancels, statuses; test `reorg`). A deeper reorg is
not corrected automatically (documented, test `reorg` R4). The symptoms are fills or cancels that do not exist on the
canonical chain, or orders marked filled that are still open.

Procedure:
1. Stop the book: `docker compose … stop book`.
2. Restore the last backup taken **before** the fork point (`backup.mjs list`, timestamps).
3. Start the book again; it re-indexes from that point on the canonical chain.

If no backup is old enough, rebuild from `startBlock`: start with an empty volume. Makers' open offers must then be
posted again.

Afterwards, review `reorgDepth` for that chain.

## 7. Running your own book

Nothing in the app is bound to the official book: users change the URL in Impostazioni, and the e2e tests run two books
side by side. To run one:

1. **Same contract, your own whitelist.** Use the SwapERC20 address of the chain (the one the app is configured with,
   otherwise the app blocks trading as "La bacheca usa un altro contratto"). Use `startBlock` = the contract's deploy block.
   Choose the tokens you list: the app shows only the pairs whose tokens are also in its own configuration.
2. **Deploy** as in §1, on your own domain.
3. **Tell your users** the URL. In the app: Impostazioni → Bacheca delle offerte → your URL → Salva, and "Ripristina"
   goes back to the default. The app verifies every offer against the chain before execution, so a book can hide or
   delay offers but cannot change their terms or move funds.

## 8. Checklist after any change

- `curl https://$DOMAIN/health` returns `{"ok":true}`.
- `/config` shows the expected contract and fee for each chain.
- `/book` returns **no** 503.
- `backup.mjs list` shows a copy younger than one hour.
- `docker compose logs --since 10m book` shows no `"level":"error"` lines.
