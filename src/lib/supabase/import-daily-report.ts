import { Pool } from "pg";

/** Schema for weekly Hubstaff CSV imports (separate from `public`). Expose this schema in Supabase → Settings → API → Exposed schemas. */
export const HUBSTAFF_HOURS_SCHEMA = "hubstaff_hours";

const SCHEMA_RE = /^[a-z][a-z0-9_]{0,62}$/;
const TABLE_NAME_RE = /^dr_[a-z0-9_]{1,58}$/;

/**
 * Builds a stable Postgres table name from the uploaded filename, e.g.
 * `simple-biz_daily_report_2026-03-22_to_2026-03-28.csv` →
 * `dr_simple_biz_daily_report_2026_03_22_to_2026_03_28`
 */
export function deriveTableNameFromFilename(fileName: string): string {
  const base = fileName.replace(/\.[^/.]+$/i, "");
  const sanitized = base
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  const prefixed = `dr_${sanitized || "import"}`;
  let out = prefixed.length > 63 ? prefixed.slice(0, 63).replace(/_+$/, "") : prefixed;
  if (out.replace(/^dr_/, "").length < 1) out = "dr_import";
  return out;
}

function assertSafeTableName(name: string): void {
  if (!TABLE_NAME_RE.test(name)) {
    throw new Error(`Invalid derived table name: ${name}`);
  }
}

function assertSafeSchema(name: string): void {
  if (!SCHEMA_RE.test(name)) {
    throw new Error(`Invalid schema name: ${name}`);
  }
}

function pgQuoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

/**
 * Creates (or replaces) a table in schema `hubstaff_hours` and inserts all data rows.
 * Requires direct Postgres access (Supabase → Database → connection string).
 */
export async function importDailyReportToPostgres(args: {
  fileName: string;
  header: string[];
  dataRows: string[][];
}): Promise<{ schema: string; tableName: string; rowCount: number }> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Add your Supabase Postgres connection string (Settings → Database) to .env — server only, never expose to the client.",
    );
  }

  if (args.header.length === 0) {
    throw new Error("CSV has no header row.");
  }

  const tableName = deriveTableNameFromFilename(args.fileName);
  assertSafeTableName(tableName);
  assertSafeSchema(HUBSTAFF_HOURS_SCHEMA);

  const schemaIdent = pgQuoteIdent(HUBSTAFF_HOURS_SCHEMA);
  const tableIdent = pgQuoteIdent(tableName);
  const qualifiedTable = `${schemaIdent}.${tableIdent}`;

  const colIdents = args.header.map(pgQuoteIdent);
  const colList = colIdents.join(", ");

  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaIdent}`);
    await client.query(
      `GRANT USAGE ON SCHEMA ${schemaIdent} TO anon, authenticated`,
    );
    await client.query(`DROP TABLE IF EXISTS ${qualifiedTable} CASCADE`);

    const colDefs = colIdents.map((c) => `${c} text`).join(", ");
    await client.query(
      `CREATE TABLE ${qualifiedTable} (id bigserial primary key, ${colDefs})`,
    );

    const batchSize = 50;
    for (let start = 0; start < args.dataRows.length; start += batchSize) {
      const batch = args.dataRows.slice(start, start + batchSize);
      const valueGroups: string[] = [];
      const params: unknown[] = [];
      let p = 1;

      for (const row of batch) {
        const placeholders: string[] = [];
        for (let c = 0; c < args.header.length; c++) {
          placeholders.push(`$${p++}`);
          params.push(row[c] ?? "");
        }
        valueGroups.push(`(${placeholders.join(", ")})`);
      }

      if (valueGroups.length === 0) continue;

      const sql = `INSERT INTO ${qualifiedTable} (${colList}) VALUES ${valueGroups.join(", ")}`;
      await client.query(sql, params);
    }

    await client.query(
      `GRANT SELECT ON TABLE ${qualifiedTable} TO anon, authenticated`,
    );
    await client.query(
      `GRANT USAGE, SELECT ON SEQUENCE ${schemaIdent}.${tableName}_id_seq TO anon, authenticated`,
    );

    await client.query("COMMIT");

    return { schema: HUBSTAFF_HOURS_SCHEMA, tableName, rowCount: args.dataRows.length };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}
