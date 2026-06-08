import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import ws from "ws";
import * as schema from "@shared/schema";
import { logger, errorContext } from './logger';

// Configure neon to use websockets
neonConfig.webSocketConstructor = ws;

// Add detailed startup logging
logger.info('db.init.start');

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Create connection pool with error handling
export const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000 // 5 second timeout
});

// Pool emits 'error' for *idle* client failures (network blip, server
// dropping an idle TCP connection, Neon scaling its compute down, etc).
// These are recoverable: the pg Pool will discard the broken client and
// hand out a fresh one on the next acquire. The previous policy of
// process.exit(-1) on every idle-client error converted a benign
// reconnect into a hard process termination — in containerized envs
// that means an availability outage on every routine network blip.
// Log loudly for ops visibility but stay alive; if the underlying DB is
// truly gone, individual route handlers will surface that as 5xx and
// the orchestrator's healthcheck can decide to recycle us.
pool.on('error', (err: Error) => {
  logger.error('db.pool.idle_client_error', errorContext(err));
});

// Initialize Drizzle with the pool
export const db = drizzle(pool, { schema });

// Export sql for query building
export { sql };

// Add connection verification
pool.connect()
  .then(client => {
    logger.info('db.connect.ok');
    client.release();
  })
  .catch(err => {
    logger.error('db.connect.failed', errorContext(err));
    process.exit(-1);
  });

// Restricted Postgres role used by the MCP run_read_query tool. The role
// is granted SELECT only on the explicit business-table allow-list and
// has no privileges on application user/session tables or the system
// catalogs. The MCP tool issues `SET LOCAL ROLE` to switch into it
// inside its read-only transaction, so a parser/keyword bypass still
// hits a hard permission error from Postgres.
export const MCP_READ_ROLE = 'mcp_read_only';
const MCP_READ_TABLES = [
  'orders',
  'order_line_items',
  'transactions',
  'gift_cards',
  'refunds',
  'intercard_revenue',
  'payout_fee_entries',
];

let ensureMcpReadRolePromise: Promise<void> | null = null;
/**
 * Provision the restricted Postgres role used by the MCP run_read_query
 * tool. Idempotent: a successful call is cached so subsequent invocations
 * are free, and a failed call is not cached so the next caller can retry.
 *
 * Deployment note: this function expects to be run by a Postgres user
 * that can CREATE ROLE and GRANT SELECT on the business tables. On
 * managed Postgres providers without that privilege, this function will
 * throw, and run_read_query will fail closed (refuse to execute) until
 * the role is provisioned out-of-band by an operator. Pre-provisioning
 * via migration/infra is recommended for production.
 */
export function ensureMcpReadRole(): Promise<void> {
  if (ensureMcpReadRolePromise) return ensureMcpReadRolePromise;
  ensureMcpReadRolePromise = (async () => {
    const client = await pool.connect();
    try {
      // Create the role if it doesn't already exist. NOLOGIN keeps it
      // strictly a permission bucket — nobody can connect as it directly.
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MCP_READ_ROLE}') THEN
            CREATE ROLE ${MCP_READ_ROLE} NOLOGIN NOINHERIT;
          END IF;
        END$$;
      `);
      // Membership is required for SET ROLE to succeed.
      await client.query(`GRANT ${MCP_READ_ROLE} TO CURRENT_USER`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${MCP_READ_ROLE}`);
      // Grant SELECT on the explicit allow-list, table by table so a
      // missing table fails loudly rather than silently widening access.
      for (const table of MCP_READ_TABLES) {
        await client.query(
          `GRANT SELECT ON public.${table} TO ${MCP_READ_ROLE}`
        );
      }
      // Attempt to revoke PUBLIC's default grants on the sensitive
      // catalog views and information_schema. These statements succeed
      // on self-hosted Postgres (where the application role owns the
      // catalogs) and silently no-op on managed providers like Neon
      // where PUBLIC's grants are owned by a platform superuser. On
      // those providers the operator must run
      // `scripts/setup-mcp-readonly-role.sql` once via a privileged
      // connection to complete the lockdown — the app cannot do it
      // itself. `scripts/verify-mcp-hardening.ts` will fail loudly
      // until that step is done.
      const publicRevokes = [
        `REVOKE SELECT ON pg_catalog.pg_user FROM PUBLIC`,
        `REVOKE SELECT ON pg_catalog.pg_shadow FROM PUBLIC`,
        `REVOKE SELECT ON pg_catalog.pg_stat_activity FROM PUBLIC`,
        `REVOKE SELECT ON pg_catalog.pg_settings FROM PUBLIC`,
        `REVOKE SELECT ON pg_catalog.pg_authid FROM PUBLIC`,
        `REVOKE USAGE ON SCHEMA information_schema FROM PUBLIC`,
        `REVOKE SELECT ON ALL TABLES IN SCHEMA information_schema FROM PUBLIC`,
      ];
      await Promise.all(publicRevokes.map(stmt => client.query(stmt).catch(() => {
        // Ignore — on managed Postgres without superuser this
        // cannot succeed; the operator script handles it instead.
      })));
      // Defense-in-depth: revoke any direct grants that may have been
      // attached to the role for these surfaces. NOINHERIT means the
      // role cannot use grants made to its members either, but this
      // keeps the role's own ACL clean.
      const roleRevokes = [
        `REVOKE ALL ON SCHEMA pg_catalog FROM ${MCP_READ_ROLE}`,
        `REVOKE ALL ON SCHEMA information_schema FROM ${MCP_READ_ROLE}`,
        `REVOKE ALL ON ALL TABLES IN SCHEMA information_schema FROM ${MCP_READ_ROLE}`,
      ];
      await Promise.all(roleRevokes.map(stmt => client.query(stmt).catch(() => {
        // Idempotent across providers with varying grant defaults.
      })));
      logger.info('db.mcp_read_role.ready', { count: MCP_READ_TABLES.length });
    } finally {
      client.release();
    }
  })().catch((err) => {
    // Reset so a future call can retry — but rethrow now so the caller
    // fails closed instead of silently running as the privileged role.
    ensureMcpReadRolePromise = null;
    throw err;
  });
  return ensureMcpReadRolePromise;
}