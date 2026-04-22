# The `/api/server-providers` 401 — a middleware & cookie story

This doc walks through the 401 you hit on `/api/server-providers` while picking a provider, what the middleware was actually doing, and why clearing browser cookies fixed it. Use it as a reference whenever you see "the app can't fetch keys / providers / settings."

---

## 1. What Next.js middleware actually is

`middleware.ts` at the project root is a special file Next.js runs **before every matching request reaches its route**. It executes in the **Edge runtime** (V8 isolate, no Node APIs — hence `crypto.subtle` / Web Crypto instead of `node:crypto`).

Our matcher at `middleware.ts:75-77`:

```ts
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/).*)'],
};
```

Translation: "run on everything except static assets." That means **every API call and every page render** passes through this file first. If middleware returns a 401, the route handler never runs.

---

## 2. The access-code gate (why this middleware exists)

When you set `ACCESS_CODE` in Railway, the app becomes private. The gate works in three pieces:

### a) Verify the code → set a signed cookie
`app/api/access-code/verify/route.ts:53-61`

```ts
const token = createAccessToken(accessCode);   // "timestamp.hmacSignature"
cookieStore.set('openmaic_access', token, {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 60 * 60 * 24 * 7,                    // 7 days
  secure: process.env.NODE_ENV === 'production',
});
```

The token is **not** the access code. It's `timestamp.HMAC-SHA256(timestamp, ACCESS_CODE)`. That's important:

- The browser can see the cookie value, but can't forge a new one (needs the HMAC key = `ACCESS_CODE`).
- `httpOnly: true` means JavaScript can't read it — only the server sees it.

### b) On every request, middleware verifies the cookie
`middleware.ts:44-69`

```ts
export async function middleware(request: NextRequest) {
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) return NextResponse.next();        // gate disabled

  const { pathname } = request.nextUrl;

  // Whitelist
  if (pathname.startsWith('/api/access-code/') || pathname === '/api/health') {
    return NextResponse.next();
  }

  const cookie = request.cookies.get('openmaic_access');
  if (cookie?.value && (await verifyToken(cookie.value, accessCode))) {
    return NextResponse.next();                       // authenticated ✓
  }

  // Unauthenticated requests:
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Access code required' }, { status: 401 });
  }
  return NextResponse.next();                         // page → frontend shows modal
}
```

Two asymmetric outcomes for an unauthenticated client:

| Request type | What the middleware does |
|---|---|
| `/api/*` | **Returns 401 immediately** — route handler never runs |
| Page (e.g. `/`) | Lets it through so the frontend can render the access-code modal |

This is why you saw the landing page render normally but API calls failed: **the page was served, the API calls weren't.**

### c) HMAC verification in the Edge runtime
`middleware.ts:16-42` uses `crypto.subtle.importKey` + `crypto.subtle.sign`. Standard `node:crypto` isn't available in Edge — so we use the browser-style Web Crypto API. The signature is byte-compared in constant-length fashion:

```ts
let mismatch = 0;
for (let i = 0; i < signature.length; i++) {
  mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
}
return mismatch === 0;
```

If `ACCESS_CODE` changes, **every old cookie becomes invalid** — because HMAC(timestamp, oldCode) ≠ HMAC(timestamp, newCode).

---

## 3. Why "API keys not loading" was really an auth problem

The app loads server-side API keys into the browser via this fetch at `lib/store/settings.ts:909`:

```ts
const res = await fetch('/api/server-providers');
if (!res.ok) return;                                  // ← silent on failure
```

And it fires on mount via `components/server-providers-init.tsx:10-18`:

```tsx
export function ServerProvidersInit() {
  const fetchServerProviders = useSettingsStore((s) => s.fetchServerProviders);
  useEffect(() => { fetchServerProviders(); }, [fetchServerProviders]);
  return null;
}
```

Notice two design choices that together caused confusion:

1. **It fires unconditionally on mount** — before the user has entered an access code.
2. **It fails silently** (`if (!res.ok) return;`) — no toast, no retry.

On a fresh browser with a stale/missing cookie:

```
t=0ms    Browser loads /                → page HTML returned
t=50ms   React hydrates, ServerProvidersInit runs
t=60ms   GET /api/server-providers       → middleware sees no valid cookie
t=70ms   ← 401 Unauthorized              ← this is what you saw in the log
t=100ms  Access-code modal appears
t=5s     User types code → cookie set
t=∞      Server-providers fetch is never retried
```

From the user's POV: "I entered the code, but provider config isn't loading." The 401 in the network tab is the fingerprint.

---

## 4. Why clearing cookies fixed it

This is the non-obvious part. You had a cookie in your browser from an **earlier session** — probably from:

- A previous Railway deploy where `ACCESS_CODE` was a different value, or
- Local dev without `ACCESS_CODE` set, or
- A previous build before the rebrand.

That cookie's HMAC was computed with a *different* key. When middleware ran `verifyToken(oldCookie, currentAccessCode)`:

```
HMAC(timestamp, OLD_ACCESS_CODE) !== HMAC(timestamp, NEW_ACCESS_CODE)
                                     → verification fails
                                     → 401
```

The frontend *thought* you were authenticated (cookie exists in the jar, so no modal shown), but the server *rejected* the cookie silently on every API call. That's the worst kind of bug: the UI gives no indication the cookie is stale.

Clearing browser cookies wiped the bad cookie → frontend detected "no cookie" → showed the modal → you entered the code → fresh cookie with the correct HMAC → 200 on every API call.

---

## 5. Mental model to keep

Three variables must agree for a request to succeed:

```
┌─────────────────────┐     ┌────────────────────┐     ┌────────────────┐
│  ACCESS_CODE        │ ──▶ │  cookie's HMAC key │ ──▶ │  cookie valid  │
│  (Railway env var)  │     │  (baked at login)  │     │  → 200         │
└─────────────────────┘     └────────────────────┘     └────────────────┘
```

If the server's `ACCESS_CODE` changes, every existing cookie is instantly dead. The symptom is always the same:

- Pages render fine (middleware lets them through).
- API calls return 401.
- The user has no idea why.

**Debugging checklist when you see this pattern:**

1. DevTools → Application → Cookies → does `openmaic_access` exist for this domain?
2. Did `ACCESS_CODE` change in Railway recently? (If yes → cookie is stale → clear it.)
3. Is the page HTTPS? (`secure: true` cookies won't be sent over HTTP.)
4. Is the fetch cross-origin? (Would need `credentials: 'include'`; ours is same-origin so it's fine.)

---

## 6. Possible improvements (not done — reference only)

Three ways this could be made more robust in the future:

1. **Retry after auth** — have `ServerProvidersInit` re-run after the access-code modal succeeds. Kills the first-load race.
2. **Expose a "cookie invalid" signal** — middleware could return a distinct 401 body the frontend recognizes and prompt the user to re-authenticate, instead of silently rejecting.
3. **Clear stale cookie proactively** — when middleware rejects a cookie as invalid, it could also set `Set-Cookie: openmaic_access=; Max-Age=0` so the next request starts clean.

None of these were implemented because clearing cookies is a one-time fix per `ACCESS_CODE` rotation, and rotations are rare.

---

## Quick reference: file map

| File | Role |
|---|---|
| `middleware.ts` | Gate on every request; verifies HMAC cookie |
| `app/api/access-code/verify/route.ts` | Validates the code; issues the signed cookie |
| `app/api/access-code/status/route.ts` | Reports whether the cookie is currently valid |
| `components/access-code-modal.tsx` | UI that prompts for the code |
| `components/server-providers-init.tsx` | Fires the first `/api/server-providers` fetch on mount |
| `lib/store/settings.ts` (`fetchServerProviders`) | Actual HTTP call + store merge |
| `lib/server/provider-config.ts` | Reads `process.env.*_API_KEY` into the server config |
