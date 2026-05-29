<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Simple HRIS

A payroll-focused Human Resource Information System for a Philippines-based outsourcing company. Its primary job is the **"Friday Path"** -- the weekly payroll cycle that takes a Hubstaff hours export, applies per-department bonus rules, validates against a master employee list, and produces a final payout ledger.

Full architecture, data flow, and design decisions live in [`docs/reference/system-architecture.md`](docs/reference/system-architecture.md).

---

## Tech Stack

| | Layer | Technology |
|---|---|---|
| ![Next.js](https://img.shields.io/badge/Next.js-16-000000?style=flat&logo=nextdotjs&logoColor=white) | Framework | Next.js 16 (App Router) -- API routes + RSC shell |
| ![React](https://img.shields.io/badge/React-19-61DAFB?style=flat&logo=react&logoColor=black) | UI Runtime | React 19 (`"use client"` SPA inside the Next shell) |
| ![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat&logo=typescript&logoColor=white) | Language | TypeScript 5.8 (`strict: false`) |
| ![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-06B6D4?style=flat&logo=tailwindcss&logoColor=white) | Styling | Tailwind CSS v4 |
| ![shadcn/ui](https://img.shields.io/badge/shadcn/ui-base--nova-000000?style=flat&logo=shadcnui&logoColor=white) | Primitives | shadcn on `@base-ui/react` |
| ![Framer Motion](https://img.shields.io/badge/Framer_Motion-12-0055FF?style=flat&logo=framer&logoColor=white) | Animations | `motion/react` (Framer Motion 12) |
| ![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3FCF8E?style=flat&logo=supabase&logoColor=white) | Database | Supabase (Postgres) via `@supabase/supabase-js` |
| ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-pg_Pool-4169E1?style=flat&logo=postgresql&logoColor=white) | Direct SQL | `pg` Pool (table discovery, daily report import) |
| ![NextAuth.js](https://img.shields.io/badge/NextAuth.js-Google_SSO-000000?style=flat&logo=auth0&logoColor=white) | Auth | NextAuth (Google Workspace SSO) + JWT |
| ![Lucide](https://img.shields.io/badge/Lucide-Icons-F56565?style=flat&logo=lucide&logoColor=white) | Icons | `lucide-react` |
| ![Sonner](https://img.shields.io/badge/Sonner-Toasts-000000?style=flat) | Toasts | `sonner` |
| ![Vercel](https://img.shields.io/badge/Vercel-Hosting-000000?style=flat&logo=vercel&logoColor=white) | Hosting | Vercel (region pinned to `sin1`) |
| ![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat&logo=nodedotjs&logoColor=white) | Runtime | Node.js 20 or newer |

---

## Run Locally (Next.js)

> This repo is a standard **Next.js** project. Ignore any "AI Studio" framing -- everything below runs against a local Next.js dev server.

### 1. Prerequisites

- ![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat&logo=nodedotjs&logoColor=white) **Node.js 20+** and npm
- ![Supabase](https://img.shields.io/badge/Supabase-Project-3FCF8E?style=flat&logo=supabase&logoColor=white) A **Supabase project** (URL, anon key, service-role key)
- ![Google](https://img.shields.io/badge/Google-OAuth_Client-4285F4?style=flat&logo=google&logoColor=white) A **Google OAuth client** with `http://localhost:3000/api/auth/callback/google` registered as a redirect URI (only required if you want to sign in)

### 2. Install dependencies

```bash
npm install
```

`postinstall` will run `patch-package` to apply the `next-themes` SSR hydration patch in `patches/`.

### 3. Configure environment

Copy `.env.example` to `.env.local`, then fill in the values:

```bash
cp .env.example .env.local
```

Required:

```
# Supabase (Dashboard -> Project Settings -> API)
NEXT_PUBLIC_SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="YOUR_ANON_KEY"
SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY"

# Table names (defaults match the seed scripts in references/)
NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE="global_master_list"
NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE="employee_hourly_rates"
NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE="hubstaff_hours"

# Google SSO (NextAuth)
GOOGLE_CLIENT_ID="YOUR_CLIENT_ID.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="GOCSPX-YOUR_CLIENT_SECRET"
NEXTAUTH_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
NEXTAUTH_URL="http://localhost:3000"
```

Optional but recommended:

```
# Direct Postgres URL (Dashboard -> Settings -> Database)
# Enables daily report import + all-public-tables profile merge
DATABASE_URL="postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres"
```

> The legacy `GEMINI_API_KEY` and `APP_URL` keys in `.env.example` are AI Studio leftovers. The app does **not** require them to run locally.

### 4. Seed the database (first-time only)

Apply the SQL files in [`references/`](references/) against your Supabase project (SQL editor or `psql`). At minimum:

- `references/supabase_global_master_list.sql`
- `references/supabase_employee_hourly_rates.sql`
- `references/supabase_hubstaff_hours.sql`

Check `references/` for the rest (audit log, disbursement records, rate history, etc.).

### 5. Start the dev server

```bash
npm run dev
```

The app boots at **http://localhost:3000**. The default route resolves to the Accounting dashboard once you sign in.

Other useful scripts:

```bash
npm run dev:3001    # alternate port
npm run build       # production build
npm run start       # serve the production build on :3000
npm run lint        # tsc --noEmit (type-check only)
```

### 6. Sign in

Visit `http://localhost:3000/login` and sign in with Google. SSO is restricted to the company Workspace domain via `src/lib/auth/auth-options.ts`; for solo local dev, either grant yourself a role in the `employee_roles` table or use the legacy email + password path (see [`docs/reference/system-architecture.md`](docs/reference/system-architecture.md#key-architectural-decisions), decision 10).

---

## Project Layout

```
simple-hris/
  app/                Next.js App Router shell + API routes
  src/                All UI logic ("use client" SPA inside the shell)
  components/ui/      shadcn primitives (do not edit directly)
  references/         SQL seed + migration scripts
  patches/            next-themes SSR hydration patch
  scripts/            Dev diagnostics (check-supabase.mjs, etc.)
  docs/               Architecture, features, audits, meeting notes
```

See [`docs/reference/system-architecture.md`](docs/reference/system-architecture.md) for the full breakdown of each dashboard, the Supabase client strategy, design tokens, and architectural decisions.

---

## Deploying to Vercel

This repo is deployed on Vercel. One detail worth knowing if you fork:

- **Region matters.** `vercel.json` pins serverless functions to `sin1` (Singapore) because the Supabase project lives there. Leaving the default `iad1` (US-East) adds a cross-region round-trip to every API call and visibly freezes the payroll wizard. Keep the `regions` setting if you stay on a Singapore-region Supabase project.

---

## Further Reading

- [`docs/reference/system-architecture.md`](docs/reference/system-architecture.md) -- stack, repo layout, design system, key decisions
- [`docs/reference/api-reference.md`](docs/reference/api-reference.md) -- every API route handler
- [`docs/reference/components.md`](docs/reference/components.md) -- per-dashboard component map
- [`docs/reference/data-sources.md`](docs/reference/data-sources.md) -- Supabase tables and how they're populated
- [`docs/reference/business-logic.md`](docs/reference/business-logic.md) -- payroll, bonuses, PAB rules
