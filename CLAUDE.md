<!-- GSD:project-start source:PROJECT.md -->
## Project

**Drive Inventory Manager**

A personal web app that uses a Google Drive folder tree as its inventory database. Inside a root `Inventory/` folder, each sub-folder is a category, each category holds item folders, and each item folder holds a `details.json` (dimensions, weight, image links) plus the item's images. From the web page the owner can browse, add, update, and remove categories, items, details, and images, and export the inventory as a Meesho-compatible CSV for marketplace listing.

**Core Value:** Add or edit an item (dimensions, weight, multiple images) from the browser and have it land correctly in the Drive folder structure — Drive stays the single source of truth.

### Constraints

- **Architecture**: Static client-only site; browser talks to Google Drive API directly via Google OAuth — no backend, free static hosting (Vercel / Netlify / GitHub Pages)
- **Users**: Single user (owner's Google account)
- **Scale**: 2,000+ items — avoid per-item API calls on load; respect Drive API rate limits
- **Safety**: Deletes go to Drive trash, never permanent
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack
### Core Framework
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Vite | ^8.3 | Build/dev server | De facto SPA build tool; static `dist/` output, zero config for TS+React | HIGH (version), HIGH (choice) |
| React | ^19.3 | UI | Most boring/documented choice; gallery reorder, forms, virtualised lists all have mature options. Preact 11 / Svelte 5 would also work; no strong reason to deviate | HIGH |
| TypeScript | ^5.x or ^7.0 | Types | npm `latest` is 7.0.2 (new native compiler); Vite/React tooling targets it, but pin whatever `npm create vite` scaffolds to avoid toolchain surprises | MEDIUM |
| Routing | none (hash state) | Navigation | 3-4 screens; a `location.hash` listener beats a router dep and works on any static host without rewrite rules | HIGH |
### Auth: Google Identity Services (GIS) token model
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `https://accounts.google.com/gsi/client` script | n/a (CDN) | `google.accounts.oauth2.initTokenClient` | Only supported browser-only flow. Implicit/gapi.auth2 is dead (shut down 2023). Returns ~1h access token, **no refresh token**. | HIGH |
| `@types/google.accounts` | 0.0.18 (dev) | Types for GIS | Typings only | HIGH |
### Drive API access
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Plain `fetch` against `https://www.googleapis.com/drive/v3` | stdlib | All metadata calls | Drive v3 is simple REST+JSON with CORS enabled. Skip `gapi.client` (extra 100KB+ loader, discovery-doc fetch, aging). ~60-line wrapper: Bearer header, 401 -> refresh+retry once, 429/5xx -> exponential backoff w/ jitter | HIGH |
| `@types/gapi.client.drive-v3` | — | Don't install | Only useful with gapi; hand-write the ~5 Drive types you use (`DriveFile`, `Details`) | HIGH |
- **Always pass `fields=`** (e.g. `files(id,name,parents,mimeType,modifiedTime,appProperties,thumbnailLink),nextPageToken`) and `pageSize=1000`.
- **Full index build = a few flat `files.list` calls, not a tree crawl.** One query `trashed=false` (with the `drive` scope) returns all files with `parents`; reconstruct the tree client-side. 2,000 items x ~4 files = ~10 pages. Avoids N per-folder calls.
- **Incremental sync: `changes.getStartPageToken` + `changes.list`** (store token in IndexedDB). This handles hand-edits in Drive far better than relying only on `_index.json`.
- Trash, not delete: `PATCH files/{id}` with `{trashed:true}`. Rename/move: `PATCH` with `name` / `addParents`+`removeParents`.
- Sharing: `POST files/{id}/permissions` `{role:'reader',type:'anyone'}`. (Consider sharing only image files, never folders.)
- Reading `details.json`: `files.get?alt=media`. For 2,000 items do NOT fetch each on load; cache their parsed content in the index and refetch only on `modifiedTime` change.
- Image display: `thumbnailLink` (append `=s220`) for grid. It can be auth-sensitive/short-lived; fall back to `files.get?alt=media` -> blob URL. (MEDIUM)
- Meesho public image URL: `https://drive.google.com/uc?export=view&id=<id>` or `https://lh3.googleusercontent.com/d/<id>`; behaviour changes over time, **validate in the CSV-export phase** (LOW).
### Uploads
| Technology | Purpose | Why | Confidence |
|------------|---------|-----|------------|
| `uploadType=multipart` via `fetch` + `FormData`/hand-built `Blob` body | Images <= 5 MB, and `details.json` | Single request, creates file + metadata (`parents`) atomically | HIGH |
| `uploadType=resumable` via `XMLHttpRequest` | Images > 5 MB or when progress bars wanted | `fetch` has no upload progress; XHR `upload.onprogress` does. Init POST returns session URI in `Location`; PUT bytes to it | HIGH |
| Client-side downscale (`createImageBitmap` + `OffscreenCanvas`/canvas -> JPEG) | Optional | Phone photos are 3-10MB; downscaling to ~2000px makes everything multipart. Marketplace-friendly too. Defer unless needed | MEDIUM |
### Client-side cache
| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| IndexedDB via `idb` | ^8.0.4 | Index of categories/items + changes page token + parsed details | `idb` is a ~1KB promise wrapper; raw IndexedDB is verbose enough that the dep is justified. Skip Dexie/RxDB. Store: `items` (keyed by folder id), `meta` (change token, root id). Optionally mirror to Drive `_index.json` as per PROJECT.md for cross-device cold start | HIGH |
| In-memory filter (`Array.filter` + lowercase `includes`) | stdlib | Search by name / category | 2,000 rows; no search lib needed | HIGH |
| List virtualisation | optional: `@tanstack/react-virtual` | Only if grid of 2,000 thumbs janks | Prefer `loading="lazy"` + pagination (render 100 at a time) first | MEDIUM |
### CSV
| Technology | Purpose | Why |
|------------|---------|-----|
| Hand-written (~10 lines) RFC 4180 escaper + `Blob` + `<a download>` | Meesho export | Quote fields containing `, " \n`, double the quotes, CRLF line endings, prepend `\uFEFF` BOM so Excel reads UTF-8. No PapaParse needed for write-only. (HIGH) Meesho column order must come from the actual template (dev input, not researchable here). |
### Infrastructure / Hosting
| Technology | Purpose | Why | Confidence |
|------------|---------|-----|------------|
| Vercel, Netlify, or GitHub Pages | Static host | All free and fine; need a stable HTTPS origin to register as an "Authorized JavaScript origin" (plus `http://localhost:5173` for dev). Pick Vercel/Netlify if you want preview URLs (each preview origin must be registered, so usually just use prod + localhost). GitHub Pages is fine if using hash routing (already planned). Note: a custom/stable domain avoids origin changes invalidating the OAuth client. | HIGH |
## OAuth scope decision (most consequential choice)
| Scope | Classification | Sees hand-made folders? | Verdict |
|-------|----------------|-------------------------|---------|
| `drive.file` | Non-sensitive (no verification review needed for public release) | **No**: only files the app created or the user opened via Google Picker | Breaks the "edit by hand in Drive" requirement |
| `drive` | **Restricted** | Yes, everything | **Recommended for this app** |
| `drive.readonly` | Restricted | read only | Not enough |
### Consent-screen / verification for a single user (MEDIUM, verify at https://support.google.com/cloud/answer/13463073 and the OAuth app verification docs)
- Restricted scopes in a **public** app require verification plus an annual third-party security assessment (CASA). Not realistic for a personal tool; **don't publish it**.
- Use a Google Cloud project with **User type External**, **Publishing status: Testing**, add your own account as a **test user** (limit 100). No verification needed.
- Testing mode caveats: (1) refresh tokens expire after 7 days. Irrelevant for GIS token model since it issues no refresh tokens; you just re-prompt silently/with a click. (2) Consent screen shows "Google hasn't verified this app" warning; click Advanced -> continue once. (3) Consent may need re-granting periodically; the user-gesture popup flow handles it.
- If the owner has Google Workspace: set User type **Internal** instead, no test-user list, no warning, no 7-day issue. Check this first (user email is on appgambit.com, so likely Workspace; confirm the Drive being used is that account).
- Alternative "In production, unverified" status: allowed but with 100 user cap and the unverified warning; Testing is the simpler choice. Google may also tie unverified-app behaviour to token lifetime; check current docs.
- Enable "Google Drive API" in the project; create an OAuth **Web client ID** (no secret needed or used). The client ID is public, ship it in the bundle via `VITE_GOOGLE_CLIENT_ID`.
## Alternatives Considered
| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Drive client | fetch | gapi.client | Heavy, discovery-doc-based, adds nothing for ~8 endpoints |
| Auth | GIS token model | Auth-code flow w/ backend | Violates no-backend constraint |
| Auth | GIS token model | Firebase Auth / Google Sign-In + Drive | Adds a service; Firebase sign-in doesn't give Drive scopes cleanly |
| Scope | drive | drive.file + Picker | Can't see hand-created tree (see above) |
| Framework | React | Svelte 5 / Preact 11 | Fine alternatives; React chosen for familiarity/ecosystem only |
| Cache | idb | Dexie, localStorage | localStorage is ~5MB sync and blocks; Dexie is overkill |
| CSV | hand-rolled | papaparse | Write-only, tiny |
| State | `useState` + one context/`useSyncExternalStore` store | Redux/Zustand/TanStack Query | Cache lives in IndexedDB; extra layer not needed. Zustand is acceptable if state sharing gets painful |
| Styling | plain CSS / CSS modules | Tailwind, component kits | Minimal brief; optional |
## Installation
# no gapi, no router, no CSV lib, no state lib
## Verified versions (npm, 2026-10-21)
## Sources
- npm registry (live query) for versions: HIGH
- Google Identity Services token model, Drive v3 REST, upload types, scope classification, testing-mode token expiry: training knowledge, MEDIUM; confirm at developers.google.com/identity/oauth2/web/guides/use-token-model, developers.google.com/drive/api/guides/about-auth, developers.google.com/drive/api/guides/manage-uploads, developers.google.com/drive/api/guides/manage-changes
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
