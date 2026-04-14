import pg from "pg";

const { Pool } = pg;

export function createDbPool() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  return new Pool({
    connectionString: databaseUrl
  });
}

export async function ensureSchema(pool) {
  await pool.query(`
    create table if not exists kv (
      key text primary key,
      value jsonb not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists audit_log (
      id bigserial primary key,
      ts timestamptz not null default now(),
      source text not null,
      kind text not null,
      payload jsonb not null
    );
  `);
}

export async function kvGet(pool, key) {
  const result = await pool.query("select value from kv where key = $1", [key]);
  return result.rowCount ? result.rows[0].value : null;
}

export async function kvSet(pool, key, value) {
  await pool.query(
    `
      insert into kv (key, value) values ($1, $2)
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `,
    [key, value]
  );
}

export async function auditLog(pool, { source, kind, payload }) {
  await pool.query("insert into audit_log (source, kind, payload) values ($1, $2, $3)", [
    source,
    kind,
    payload
  ]);
}
