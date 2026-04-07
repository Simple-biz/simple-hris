import { Pool } from "pg";

const SAFE_TABLE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

export function isSafeTableName(name: string): boolean {
  return SAFE_TABLE.test(name);
}

/**
 * Lists `public` base tables (for merging into employee profiles).
 * Requires `DATABASE_URL` (Supabase Postgres connection string). Server-only.
 */
export async function listPublicTableNames(): Promise<string[] | null> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return null;

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const r = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    return r.rows
      .map((row) => row.table_name)
      .filter((name) => isSafeTableName(name));
  } catch {
    return null;
  } finally {
    await pool.end().catch(() => {});
  }
}
