# Google sign-in (`/login` → Google → `/login`)

The front door. `app/login/page.tsx` signs a person in with Google through next-auth v4 (JWT
sessions, `src/lib/auth/auth-options.ts`), resolves their roles, plays the intro video and hands them
to their dashboard. The super-admin form on the same page is a separate path (`pre-release-security-readiness.md`).

**First doc of its own: 2026-10-09** (session `f62e3c73`, Open item 448), written when every Safari
and iPhone sign-in was found ending on next-auth's "Server error" page. Fixed the same day.
**Committed, NOT pushed** (Kane pushes).

## The flow

1. **Click "Continue with Google"** → `signIn('google', { callbackUrl: '/login' })`, called **once**.
   next-auth fetches `/api/auth/providers` and `/api/auth/csrf`, then POSTs
   `/api/auth/signin/google`. That POST mints the `next-auth.state` and PKCE cookies and returns
   Google's authorization URL, and next-auth sets `window.location.href` to it.
2. **Google** (`hd=simple.biz`) → `/api/auth/callback/google`. The `signIn` callback rejects
   non-Workspace accounts and next-auth checks the state and PKCE cookies against what Google sent back.
3. **Back on `/login`, signed in.** The page fetches `/api/employee-roles`, picks the destination
   (everyone lands on `/employee`; see `../reference/system-architecture.md` § Application Shell & Routing), and plays
   `/login.mp4` over a full-screen veil. The navigation waits until both the destination and the
   video are ready, capped at 9 s.
4. **Hand-off**: `router.replace(destination)`. The per-person sign-in song starts here
   (`login-carla-song.md`).

## The click

- **`signIn('google')` is called exactly once per page, never with `redirect: false`, and the
  login page opens no popup.** next-auth v4's client `signIn()` *always* navigates for an OAuth
  provider. `redirect: false` is honoured only for credentials and email providers
  (`node_modules/next-auth/react/index.js:258-265`, `if (redirect || !isSupportingReturn)`), and
  the call returns `undefined`. Pinned by `src/lib/auth/google-sign-in-once.test.ts`. The test also
  fails if a next-auth upgrade changes that line, so the rule gets revisited instead of silently
  outliving its reason.
- **A ref swallows a second click** (`googleSignInStartedRef`). A double-click would otherwise start
  the same two-call race described below. A `pageshow` with `persisted` re-arms it, because Back from
  Google restores the page from the back/forward cache with the ref still set.
- **The intro on return has no user gesture.** The page loaded fresh from Google's redirect, so the
  browser refuses `play()` with sound. The page retries muted and shows *Tap for sound*. This is
  what every browser actually got before 2026-10-09 too, because the "play with sound inside the
  popup's gesture" path never ran (below).

## What went wrong in Safari (2026-10-09)

Until 2026-10-09 the click ran a popup design: `await signIn('google', { redirect: false })`, then
`window.open(url)`, with a redirect fallback when the URL was missing or the popup was blocked.
`signIn` navigated the tab and returned `undefined` instead, so the fallback fired a **second**
`signIn('google')` every time, while the first navigation to Google was still in flight. The popup,
the `/auth-callback` `postMessage` hand-off and the "sound inside the gesture" start never ran in
any browser.

- **Chrome** keeps the old page's fetches running until the new page commits. The tab reached Google
  from the first call; the second call's POST was cut off when Google's page arrived. It worked,
  by timing.
- **Safari / WebKit** (and so **every browser on an iPhone**) cancels in-flight fetches as soon as
  a navigation starts. The second call's `GET /api/auth/providers` failed with *Load request
  cancelled*. next-auth answers a failed providers fetch with
  `window.location.href = '/api/auth/error'`, and that navigation replaced the one to Google. The
  person saw next-auth's built-in page: *"Server error — There is a problem with the server
  configuration."*

**Measured**, Playwright WebKit 26.5 against production, 3 of 3 clicks: providers → csrf → signin
POST answered → second providers fetch cancelled → `/api/auth/_log` cancelled →
`NAV /api/auth/error`, never reaching Google. Chromium against production, 2 of 2: reached Google.
After the fix, against the local dev server: WebKit 3 of 3 and Chromium 3 of 3 reach Google's
sign-in with one signin POST, and the state cookie in the jar belongs to the URL the tab committed
to. A WebKit double-click sends one POST (2 of 2).

**Reproducing.** Playwright's WebKit build runs on Windows: `playwright-core` 1.62's
`install webkit` (revision 2336). The default CDN crawled at ~15 KB/s on 2026-10-09; the zip from
`https://cdn.playwright.dev/builds/webkit/2336/webkit-win64.zip`, fetched in parallel ranges, took
two minutes. Unzip it into `%LOCALAPPDATA%\ms-playwright\webkit-2336`. A signed-out `/login` and the
Google click touch no database: the signin POST only mints cookies.

## `/auth-callback`

Nothing in the app sends a sign-in there since 2026-10-09. The page stays: an old link or an
in-flight sign-in that was started before the deploy lands there, finds no `window.opener`, and
replaces itself with `/login`. It stays public (`route-authorization.md`) and stays allowed on the
scoreboard host (`accounting-scoreboard.md` § Its own domain).

## Known gaps (Open item 448)

- **A deep link does not survive a fresh Google sign-in.** `system-architecture.md:148` says a safe
  `?callbackUrl=` wins over the default landing. The page does honour it, but the query string is
  gone by the time the person returns, because Google returns them to bare `/login`. Only the popup
  design kept the page and its query string in place, and it never ran. Carrying `callbackUrl`
  through Google would make the **OW-29 open redirect** (`//evil.example` passes the check at
  `page.tsx`'s `safeCallback`) reachable on every sign-in. Close OW-29 first, then carry it.
- **WebKit fetches `/login.mp4` even with `preload="none"`**, before sign-in. `proxy.ts`'s matcher
  does not exempt `.mp4`, so a signed-out request is redirected to `/login`. It is harmless today,
  because the video is played only after sign-in, on a fresh page that fetches it again.
- **Safari below 16.4 is not supported at all.** Next 16 builds for `safari 16.4`
  (`node_modules/next/dist/shared/lib/modern-browserslist-target.js`), and the App Router runtime
  uses class static blocks, a syntax error before 16.4. Tailwind v4 has the same floor. An iPhone
  stuck on iOS 15 (6s, 7, SE 1) gets a page that renders but never responds.
