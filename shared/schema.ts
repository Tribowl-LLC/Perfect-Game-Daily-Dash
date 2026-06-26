import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  real,
  jsonb,
  foreignKey,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Define possible date ranges for filtering
export const dateRangeSchema = z.enum([
  "today",
  "yesterday",
  "last7days",
  "last30days",
  "thisMonth",
  "lastMonth",
  "yearToDate",
  "custom",
]);

export type DateRange = z.infer<typeof dateRangeSchema>;

// Transaction status types
export const transactionStatusSchema = z.enum([
  "completed",
  "refunded",
  "failed",
  "pending",
]);

export type TransactionStatus = z.infer<typeof transactionStatusSchema>;

// Transaction categories — now a free-form string so any Square catalog category is accepted
export const categorySchema = z.string();

export type Category = z.infer<typeof categorySchema>;

// Order status types
export const orderStatusSchema = z.enum([
  "OPEN",
  "COMPLETED",
  "CANCELED",
  "DRAFT",
  "PENDING"
]);

export type OrderStatus = z.infer<typeof orderStatusSchema>;

// Orders table
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  squareId: text("square_id").notNull().unique(),
  status: text("status").notNull(),
  totalMoney: real("total_money").notNull(),
  totalTax: real("total_tax").notNull(),
  totalDiscount: real("total_discount").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  transactionId: integer("transaction_id").references(() => transactions.id),
  source: text("source").notNull(),
  squareData: jsonb("square_data"),
});

export const insertOrderSchema = createInsertSchema(orders).omit({
  id: true,
});

export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof orders.$inferSelect;

// Order line items
export const orderLineItems = pgTable("order_line_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id, {
    onDelete: "cascade"
  }),
  name: text("name").notNull(),
  quantity: real("quantity").notNull(),
  basePriceMoney: real("base_price_money").notNull(),
  totalMoney: real("total_money").notNull(),
  category: text("category"),
  productId: text("product_id"),
  isGiftCard: boolean("is_gift_card"),
  squareData: jsonb("square_data"),
});

export const insertOrderLineItemSchema = createInsertSchema(orderLineItems).omit({
  id: true,
});

export type InsertOrderLineItem = z.infer<typeof insertOrderLineItemSchema>;
export type OrderLineItem = typeof orderLineItems.$inferSelect;

// Order modifiers
export const orderModifiers = pgTable("order_modifiers", {
  id: serial("id").primaryKey(),
  lineItemId: integer("line_item_id").notNull().references(() => orderLineItems.id, {
    onDelete: "cascade"
  }),
  name: text("name").notNull(),
  basePriceMoney: real("base_price_money"),
  totalPriceMoney: real("total_price_money"),
  squareData: jsonb("square_data"),
});

export const insertOrderModifierSchema = createInsertSchema(orderModifiers).omit({
  id: true,
});

export type InsertOrderModifier = z.infer<typeof insertOrderModifierSchema>;
export type OrderModifier = typeof orderModifiers.$inferSelect;

// Order discounts
export const orderDiscounts = pgTable("order_discounts", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id, {
    onDelete: "cascade"
  }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  percentage: real("percentage"),
  amountMoney: real("amount_money"),
  appliedMoney: real("applied_money").notNull(),
  scope: text("scope").notNull(),
  squareData: jsonb("square_data"),
});

export const insertOrderDiscountSchema = createInsertSchema(orderDiscounts).omit({
  id: true,
});

export type InsertOrderDiscount = z.infer<typeof insertOrderDiscountSchema>;
export type OrderDiscount = typeof orderDiscounts.$inferSelect;

// Main transactions table
export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  squareId: text("square_id").notNull().unique(),
  amount: real("amount").notNull(),
  categoryId: text("category_id").notNull(),
  status: text("status").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  squareData: jsonb("square_data"),
});

export const insertTransactionSchema = createInsertSchema(transactions).omit({
  id: true,
});

export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactions.$inferSelect;

// Gift card table
export const giftCards = pgTable("gift_cards", {
  id: serial("id").primaryKey(),
  squareId: text("square_id").notNull().unique(),
  amount: real("amount").notNull(),
  redeemedAmount: real("redeemed_amount").default(0).notNull(),
  activationAmount: real("activation_amount"), // Original amount when activated
  isActive: boolean("is_active").default(true).notNull(),
  purchaseDate: timestamp("purchase_date", { withTimezone: true }).notNull(),
  squareData: jsonb("square_data"),
  gan: text("gan"), // Gift Card Account Number for matching with orders
  activationPaymentId: integer("activation_payment_id"), // FK to payments.id (exists in DB, payments table not in Drizzle schema)
  activationOrderId: integer("activation_order_id").references(() => orders.id), // Link to order when activated
  activationSquareOrderId: text("activation_square_order_id"), // Original Square order ID for matching
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertGiftCardSchema = createInsertSchema(giftCards).omit({
  id: true,
});

export type InsertGiftCard = z.infer<typeof insertGiftCardSchema>;
export type GiftCard = typeof giftCards.$inferSelect;

// Refunds table — tracks Square PaymentRefund objects
export const refunds = pgTable("refunds", {
  id: serial("id").primaryKey(),
  squareRefundId: text("square_refund_id").notNull().unique(),
  squarePaymentId: text("square_payment_id").notNull(),
  amount: real("amount").notNull(),
  status: text("status").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  squareData: jsonb("square_data"),
});

export const insertRefundSchema = createInsertSchema(refunds).omit({
  id: true,
});

export type InsertRefund = z.infer<typeof insertRefundSchema>;
export type Refund = typeof refunds.$inferSelect;

// Gift card redemptions table
export const giftCardRedemptions = pgTable("gift_card_redemptions", {
  id: serial("id").primaryKey(),
  giftCardId: integer("gift_card_id").notNull().references(() => giftCards.id),
  amount: real("amount").notNull(),
  transactionId: integer("transaction_id").notNull().references(() => transactions.id),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
});

export const insertGiftCardRedemptionSchema = createInsertSchema(
  giftCardRedemptions,
).omit({
  id: true,
});

export type InsertGiftCardRedemption = z.infer<typeof insertGiftCardRedemptionSchema>;
export type GiftCardRedemption = typeof giftCardRedemptions.$inferSelect;

// Payout fee entries — tracks per-transaction fee data from Square Payouts API
export const payoutFeeEntries = pgTable("payout_fee_entries", {
  id: serial("id").primaryKey(),
  payoutId: text("payout_id").notNull(),
  entryId: text("entry_id").notNull().unique(),
  type: text("type").notNull(),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  grossAmount: real("gross_amount").notNull(),
  feeAmount: real("fee_amount").notNull(),
  netAmount: real("net_amount").notNull(),
  paymentId: text("payment_id"),
});

export const insertPayoutFeeEntrySchema = createInsertSchema(payoutFeeEntries).omit({
  id: true,
});

export type InsertPayoutFeeEntry = z.infer<typeof insertPayoutFeeEntrySchema>;
export type PayoutFeeEntry = typeof payoutFeeEntries.$inferSelect;

// Intercard revenue records — stores synced revenue data from Intercard API
export const intercardRevenue = pgTable("intercard_revenue", {
  id: serial("id").primaryKey(),
  date: text("date").notNull(),
  locationId: text("location_id").notNull(),
  deviceType: text("device_type").notNull(),
  deviceName: text("device_name").notNull(),
  cashRevenue: real("cash_revenue").notNull().default(0),
  creditCardRevenue: real("credit_card_revenue").notNull().default(0),
  cashRefunds: real("cash_refunds").notNull().default(0),
  creditRefunds: real("credit_refunds").notNull().default(0),
  otherPayment: real("other_payment").notNull().default(0),
  customerCardUse: real("customer_card_use").notNull().default(0),
  revenue: real("revenue").notNull().default(0),
  syncedAt: timestamp("synced_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertIntercardRevenueSchema = createInsertSchema(intercardRevenue).omit({
  id: true,
});

export type InsertIntercardRevenue = z.infer<typeof insertIntercardRevenueSchema>;
export type IntercardRevenue = typeof intercardRevenue.$inferSelect;

// Keep the users table for authentication
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    username: text("username").notNull().unique(),
    password: text("password").notNull(),
    role: text("role").default("user").notNull(),
    // Account-recovery email. Nullable so existing accounts created before
    // the email-verified reset flow are not retroactively required to have
    // one — but if it's null, the password reset flow has nothing to send to
    // and silently no-ops for that account.
    email: text("email"),
    // Per-account lockout state. failedLoginCount counts consecutive failed
    // password attempts; it is reset to 0 on a successful login. lockedUntil,
    // when set to a future timestamp, blocks login attempts for the account
    // regardless of source IP (see authService.loginUser).
    failedLoginCount: integer("failed_login_count").default(0).notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    // True when the account's stored password predates the current
    // strong-password policy (12+ chars, letter + digit) and the user
    // must rotate it before the client unlocks the rest of the app.
    // Cleared on successful password reset. New accounts created after
    // the policy went live default to false because their password was
    // validated against strongPasswordSchema at creation time.
    mustRotatePassword: boolean("must_rotate_password").default(false).notNull(),
    // TOTP second factor (Task #56). The base32 secret is encrypted with
    // AES-256-GCM at rest using TOTP_ENCRYPTION_KEY (see
    // server/services/totpCrypto.ts) — the format on disk is
    // "v1:<iv-hex>:<ciphertext-hex>:<authTag-hex>" so a future key
    // rotation can recognise the version. totpEnabled flips to true only
    // after the user has verified their first 6-digit code; until then
    // the secret is stored but ignored at login. totpRecoveryCodes is an
    // array of argon2id hashes (legacy bcrypt still accepted on verify)
    // — each one-time recovery code is consumed
    // by removing its hash from the array. Non-admin accounts may also
    // enrol but only admin login currently requires the second factor.
    totpSecretEncrypted: text("totp_secret_encrypted"),
    totpEnabled: boolean("totp_enabled").default(false).notNull(),
    totpRecoveryCodes: text("totp_recovery_codes").array(),
    // Stamped on every successful TOTP/recovery-code verification (login
    // and re-enroll). Surfaced in the admin Security overview (Task #100)
    // so operators can spot stale enrolments — an "Enabled but never
    // used in 90 days" admin is a red flag.
    totpLastUsedAt: timestamp("totp_last_used_at", { withTimezone: true }),
  },
  (table) => ({
    // Case-insensitive uniqueness on the recovery email so two accounts
    // can't share `Foo@x.com` vs `foo@x.com` and the password-reset email
    // lookup is unambiguous. Partial (WHERE email IS NOT NULL) so legacy
    // accounts without an email don't collide with each other.
    emailLowerUnique: uniqueIndex("uniq_users_email_lower")
      .on(sql`LOWER(${table.email})`)
      .where(sql`${table.email} IS NOT NULL`),
  }),
);

// Password reset tokens. Only the SHA-256 hash of the token is stored —
// the raw token is delivered exactly once via the recovery email and is
// never persisted. A token is invalid if it doesn't match a row, has
// already been used (used_at IS NOT NULL), or has expired (expires_at
// is in the past).
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, {
      onDelete: 'cascade',
    }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    // Postgres does not auto-index the referencing side of a foreign key.
    // The token-cleanup queries (delete-by-user, list-active-by-user) rely
    // on this index to avoid sequential scans.
    userIdIdx: index("idx_password_reset_tokens_user_id").on(table.userId),
  }),
);

export const insertPasswordResetTokenSchema = createInsertSchema(
  passwordResetTokens,
).omit({ id: true });

export type InsertPasswordResetToken = z.infer<typeof insertPasswordResetTokenSchema>;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;

// Self-service recovery-email verification tokens (Task #98). When an
// authenticated user proposes a new recovery email for their own
// account, we email a one-time link to that proposed address; the
// email is only attached to the user record once the link is clicked
// (proving the user controls the inbox). Schema mirrors
// password_reset_tokens — only the SHA-256 hash of the raw token is
// persisted, the raw token is delivered exactly once via email and
// never stored.
export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, {
      onDelete: 'cascade',
    }),
    // The proposed email address the user wants to attach. Held here
    // (not on `users`) so the user's existing recovery email keeps
    // working until the new one is verified.
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    userIdIdx: index("idx_email_verification_tokens_user_id").on(table.userId),
  }),
);

export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
  role: true,
});

// Strong password policy applied to anything that *creates or changes* a
// password (registration, admin-create, password reset). The login schema
// stays permissive so existing accounts with shorter passwords can still
// sign in and rotate their password later.
//
// Policy: 12-128 chars, must contain at least one letter and at least one
// digit. Intentionally simple; we do not require symbols or mixed case.
export const strongPasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((p) => /[A-Za-z]/.test(p), {
    message: 'Password must contain at least one letter',
  })
  .refine((p) => /[0-9]/.test(p), {
    message: 'Password must contain at least one digit',
  });

// Username allow-list applied at *account creation* time. The regex
// constrains the charset so usernames are safe to interpolate into
// outbound email bodies, log lines, and any future surface that
// renders them. Login deliberately keeps the looser min(3)/max(50)
// (no regex) so legacy accounts created before this rule can still
// sign in.
const USERNAME_AT_CREATE = z
  .string()
  .min(3, 'Username must be at least 3 characters')
  .max(50, 'Username must be at most 50 characters')
  .regex(
    /^[A-Za-z0-9._-]+$/,
    'Username may only contain letters, digits, dots, underscores, and hyphens',
  );

// Public self-registration: role is never accepted from the request.
export const selfRegisterSchema = z.object({
  username: USERNAME_AT_CREATE,
  password: strongPasswordSchema,
});

// Admin-create: an authenticated admin may choose the new user's role
// and (optionally) the recovery email address that the password-reset
// flow will deliver one-time links to. Email is optional so the existing
// admin-create UI keeps working unchanged, but accounts created without
// an email cannot recover their password until one is added (see
// adminUpdateUserEmailSchema below).
export const adminCreateUserSchema = z.object({
  username: USERNAME_AT_CREATE,
  password: strongPasswordSchema,
  role: z.enum(['user', 'admin']).default('user'),
  email: z.string().trim().email().max(254).optional(),
});

// Admin-only: set or update the recovery email on an existing account.
// Accepts an empty string to clear the email (which disables password
// recovery for that account).
export const adminUpdateUserEmailSchema = z.object({
  email: z
    .string()
    .trim()
    .max(254)
    .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
      message: 'Must be a valid email address or empty to clear',
    }),
});

export type AdminUpdateUserEmailInput = z.infer<typeof adminUpdateUserEmailSchema>;

// Self-service recovery-email proposal (Task #98). A signed-in user
// proposes a new recovery email for their own account; the address is
// only attached after they click the verification link delivered to
// it. Empty string is intentionally NOT accepted here — clearing your
// own recovery email would lock you out of the reset flow without an
// admin's help, which is exactly the dead-end we're trying to remove.
export const selfProposeRecoveryEmailSchema = z.object({
  email: z
    .string()
    .trim()
    .min(3, 'Email is required')
    .max(254, 'Email is too long')
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Must be a valid email address'),
});

export type SelfProposeRecoveryEmailInput = z.infer<
  typeof selfProposeRecoveryEmailSchema
>;

// Confirmation step of the recovery-email flow: the raw token from
// the verification link.
export const confirmRecoveryEmailSchema = z.object({
  token: z.string().min(1).max(256),
});

export type ConfirmRecoveryEmailInput = z.infer<
  typeof confirmRecoveryEmailSchema
>;

export type InsertUser = z.infer<typeof insertUserSchema>;
export type SelfRegisterInput = z.infer<typeof selfRegisterSchema>;
export type AdminCreateUserInput = z.infer<typeof adminCreateUserSchema>;
export type User = typeof users.$inferSelect;

// Sync state table to track Square data synchronization progress
export const syncState = pgTable("sync_state", {
  id: serial("id").primaryKey(),
  syncType: text("sync_type").notNull(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull(),
  currentPage: integer("current_page").default(1),
  totalPages: integer("total_pages").default(0),
  processedCount: integer("processed_count").default(0),
  totalCount: integer("total_count").default(0),
  cursor: text("cursor").default(""),
  isComplete: boolean("is_complete").default(false),
  status: text("status").default("pending"),
  errorMessage: text("error_message"),
  lastCheckpoint: jsonb("last_checkpoint"),
});

export const insertSyncStateSchema = createInsertSchema(syncState).omit({
  id: true,
});

export type InsertSyncState = z.infer<typeof insertSyncStateSchema>;
export type SyncState = typeof syncState.$inferSelect;

// Square catalog categories cache — stores real category names from Square's Catalog API.
// `parentCategoryId` mirrors Square's category hierarchy: a NULL parent means the row IS
// itself a top-level rollup (e.g. "Food", "Beverage"); a non-null parent points to the
// rollup this category belongs to (e.g. Pizza → Food). The Items-by-category dashboard
// tab uses this to drive the rollup dropdowns without any hand-maintained mapping.
export const squareCategories = pgTable("square_categories", {
  id: serial("id").primaryKey(),
  squareCategoryId: text("square_category_id").notNull().unique(),
  name: text("name").notNull(),
  parentCategoryId: text("parent_category_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertSquareCategorySchema = createInsertSchema(squareCategories).omit({
  id: true,
});

export type InsertSquareCategory = z.infer<typeof insertSquareCategorySchema>;
export type SquareCategory = typeof squareCategories.$inferSelect;

// Square catalog items cache — maps catalog object IDs to their category.
// `isArchived` captures Square's `is_deleted` / archived flag so the items dashboard
// can hide retired SKUs without losing the historical sales data they generated.
export const squareCatalogItems = pgTable("square_catalog_items", {
  id: serial("id").primaryKey(),
  squareCatalogObjectId: text("square_catalog_object_id").notNull().unique(),
  categoryId: text("category_id"),
  categoryName: text("category_name"),
  itemName: text("item_name"),
  // Current Square catalog price in the smallest currency unit (cents),
  // nullable for variable-price / parent-ITEM rows. Used alongside name +
  // category to merge the intentional online/POS duplicate items Square
  // stores with no shared SKU — see itemsService.getRankedItems.
  priceAmount: integer("price_amount"),
  isArchived: boolean("is_archived").default(false).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertSquareCatalogItemSchema = createInsertSchema(squareCatalogItems).omit({
  id: true,
});

export type InsertSquareCatalogItem = z.infer<typeof insertSquareCatalogItemSchema>;
export type SquareCatalogItem = typeof squareCatalogItems.$inferSelect;

// ---------------------------------------------------------------------------
// Items-by-category performance dashboard (Task #188)
// ---------------------------------------------------------------------------
export const itemMetricSchema = z.enum(["revenue", "units", "transactions"]);
export type ItemMetric = z.infer<typeof itemMetricSchema>;

// One node in the category-tree response. Children are direct sub-categories;
// leaves have an empty children array. The UI treats any node with children as
// a rollup (offers "All <name>" + a dropdown of its children).
export interface CategoryTreeNode {
  squareCategoryId: string;
  name: string;
  children: CategoryTreeNode[];
}

// One row in the ranked-items response. `categoryName` is the item's specific
// (leaf) Square category, useful when the caller is looking at a rollup view.
export interface RankedItem {
  catalogObjectId: string;
  itemName: string;
  categoryId: string | null;
  categoryName: string | null;
  revenue: number;
  units: number;
  transactions: number;
  shareOfCategory: number;
  shareOfTotal: number;
  sourceBreakdown: ItemSourceBreakdown[];
}

export interface ItemSourceBreakdown {
  source: string;
  revenue: number;
  units: number;
  transactions: number;
}

// Audit log of every MCP `run_read_query` invocation (success or failure).
// Persisted so admins can review who ran what query without needing shell
// access to the host. Pruned to ~90 days by a periodic job; see
// `pruneMcpQueryAudit` in `server/pgStorage.ts`.
export const mcpQueryAudit = pgTable("mcp_query_audit", {
  id: serial("id").primaryKey(),
  adminUserId: integer("admin_user_id"),
  ip: text("ip"),
  query: text("query").notNull(),
  rowCount: integer("row_count"),
  error: text("error"),
  durationMs: integer("duration_ms").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export const insertMcpQueryAuditSchema = createInsertSchema(mcpQueryAudit).omit({
  id: true,
  createdAt: true,
});

export type InsertMcpQueryAudit = z.infer<typeof insertMcpQueryAuditSchema>;
export type McpQueryAudit = typeof mcpQueryAudit.$inferSelect;

// Audit log of every historical/backfill sync trigger. Records who started
// the run (or null for system/scheduler-triggered runs), what parameters
// they passed, when it ran, and how it ended. Surfaces who is responsible
// for runaway syncs that would otherwise saturate the shared Square API.
export const syncAudit = pgTable("sync_audit", {
  id: serial("id").primaryKey(),
  syncType: text("sync_type").notNull(),
  action: text("action").notNull(),
  actorUserId: integer("actor_user_id"),
  actorIp: text("actor_ip"),
  params: jsonb("params").$type<Record<string, unknown>>(),
  status: text("status").notNull().default("started"),
  errorMessage: text("error_message"),
  result: jsonb("result").$type<Record<string, unknown>>(),
  pagesUsed: integer("pages_used").default(0).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const insertSyncAuditSchema = createInsertSchema(syncAudit).omit({
  id: true,
  startedAt: true,
});

export type InsertSyncAudit = z.infer<typeof insertSyncAuditSchema>;
export type SyncAudit = typeof syncAudit.$inferSelect;

// Audit log of admin security actions (Task #100). Anything one admin
// does that affects another account's authentication posture (toggling
// the require-2FA-for-admins setting, disabling another admin's TOTP)
// is recorded here so a compromised admin can be reconstructed after
// the fact. Action is a free-form short string ("require_admin_2fa.set",
// "user.totp_disabled_by_admin"); metadata captures the before/after
// state in JSON so the UI doesn't need a parallel column for every
// action variant.
export const securityAuditLog = pgTable("security_audit_log", {
  id: serial("id").primaryKey(),
  actorUserId: integer("actor_user_id"),
  actorIp: text("actor_ip"),
  action: text("action").notNull(),
  targetUserId: integer("target_user_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export const insertSecurityAuditLogSchema = createInsertSchema(securityAuditLog).omit({
  id: true,
  createdAt: true,
});

export type InsertSecurityAuditLog = z.infer<typeof insertSecurityAuditLogSchema>;
export type SecurityAuditLog = typeof securityAuditLog.$inferSelect;

// Per-UTC-day Square page-fetch budget shared across every backfill /
// historical sync run. A single compromised admin can no longer hammer
// Square indefinitely — once the daily cap is hit the sync loop pauses
// cleanly until the next UTC day.
export const syncDailyBudget = pgTable("sync_daily_budget", {
  day: text("day").primaryKey(),
  pagesUsed: integer("pages_used").default(0).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type SyncDailyBudget = typeof syncDailyBudget.$inferSelect;

// Generic per-deployment runtime settings persisted as JSON. Values
// here are read by services on demand so admins can tune them from
// the UI without redeploying. Today this is just the Square 429
// alerter thresholds; new keys can be added without schema churn.
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type AppSetting = typeof appSettings.$inferSelect;

// Tunable thresholds for the Square HTTP 429 in-process alerter
// (server/services/squareRateLimitAlert.ts). The webhook URL itself
// is intentionally NOT exposed here — it's a credential and stays in
// the deployment env. These bounds keep silly inputs (e.g. a 1ms
// window) from disabling the alerter entirely.
export const squareRateLimitAlertSettingsSchema = z.object({
  threshold: z.number().int().min(1).max(1000),
  windowMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000),
  cooldownMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000),
});

export type SquareRateLimitAlertSettings = z.infer<
  typeof squareRateLimitAlertSettingsSchema
>;

export const SQUARE_RATE_LIMIT_ALERT_SETTING_KEY = 'square_rate_limit_alert' as const;

// Toggle: when enabled, every admin account must have TOTP enrolled. The
// login flow lets admins authenticate with a password as usual but the
// frontend gates the rest of the app behind enrollment, and the
// /api/auth/me payload exposes a `mustEnrollTotp: true` flag for the
// router to act on. Defaults to disabled so the feature is opt-in.
export const requireAdminTwoFactorSettingsSchema = z.object({
  enabled: z.boolean(),
});

export type RequireAdminTwoFactorSettings = z.infer<
  typeof requireAdminTwoFactorSettingsSchema
>;

export const REQUIRE_ADMIN_2FA_SETTING_KEY = 'require_admin_2fa' as const;

// Typed registry of every persisted app_settings key -> its zod schema.
// This is the single source of truth for what shape each setting key
// stores, and powers the typed `getAppSetting` / `setAppSetting`
// accessors on the storage layer so callers cannot accidentally store
// the wrong shape under a key, or read a key without validating.
//
// To add a new setting: add its key constant + schema above, then
// register both here. The storage methods will pick up the new
// key/value type automatically.
export const appSettingsRegistry = {
  [SQUARE_RATE_LIMIT_ALERT_SETTING_KEY]: squareRateLimitAlertSettingsSchema,
  [REQUIRE_ADMIN_2FA_SETTING_KEY]: requireAdminTwoFactorSettingsSchema,
} as const;

export type AppSettingsRegistry = typeof appSettingsRegistry;
export type AppSettingKey = keyof AppSettingsRegistry;
export type AppSettingValue<K extends AppSettingKey> = z.infer<
  AppSettingsRegistry[K]
>;

// Add Order Summary type for dashboard
export interface OrderSummary {
  totalOrders: number;
  totalRevenue: number;
  averageOrderValue: number;
  itemsSold: number;
  topSellingItems: Array<{
    name: string;
    quantity: number;
    revenue: number;
  }>;
  discountTotal: number;
  taxTotal: number;
}

export interface DailySummary {
  totalRevenue: number;
  grossPayments: number;
  refunds: number;
  returns: number;
  giftCardRedemptions: number;
  depositClearings: number;
  partywirksDeposits: number;
  tripleseatDeposits: number;
  revenueChange: number;
  totalOrders: number;
  ordersChange: number;
  averageOrder: number;
  averageOrderChange: number;
  giftCardSales: number;
  giftCardSalesChange: number;
  date: string;
}

export interface CategoryRevenue {
  category: string;
  amount: number;
  color: string;
}

export interface HourlyRevenue {
  hour: string;
  amount: number;
}

export interface GiftCardSummary {
  soldCount: number;
  soldAmount: number;
  redeemedCount: number;
  redeemedAmount: number;
  averageValue: number;
  outstandingBalance: number;
  webResAdvDeposits: number;
}

export interface ProcessingFeeBreakdown {
  initialFees: number;
  reimbursements: number;
  thirdPartyFees: number;
  netFees: number;
}

export interface GcRedemptionBreakdown {
  bowlingDepositRedemptions: number;
  laserTagDepositRedemptions: number;
  giftCardRedemptions: number;
}

export interface DetailedTransactionBreakdown {
  partywirks: number;
  bowlingWebResDeposits: number;
  laserTagWebResDeposits: number;
  tripleseat: number;
  tips: number;
  serviceCharges: number;
  autoGratuity: number;
  taxes: number;
  refunds: number;
  returns: number;
  discountsAndComps: number;
  depositClearings: number;
  giftCardSales: number;
  giftCardRedemptions: number;
  gcRedemptionBreakdown: GcRedemptionBreakdown;
  processingFees: ProcessingFeeBreakdown;
  intercardRevenue: number;
  intercardCashRevenue: number;
  intercardCreditRevenue: number;
  squareIntercardKioskCash: number;
  totalTransactions: number;
}
