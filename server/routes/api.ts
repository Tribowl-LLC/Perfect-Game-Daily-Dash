/**
 * API Routes
 * 
 * Defines all the API endpoints for the application using
 * the service layer for business logic.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { dashboardService } from '../services/dashboardService';
import { itemsService } from '../services/itemsService';
import { itemMetricSchema } from '../../shared/schema';
import { pgStorage } from '../pgStorage';
import { giftCardService } from '../services/giftCardService';
import { syncService } from '../services/syncService';
import {
  tryAcquireSyncLock,
  recordAuditStart,
  recordAuditFinish,
  getDailyBudgetStatus,
} from '../services/syncLocks';
import { paymentService } from '../services/paymentService';
import { DateRange, dateRangeSchema, appSettingsRegistry, AppSettingKey } from '../../shared/schema';
import { broadcast } from '../ws';
import { requireAuth, requireAdmin } from '../middleware/auth';
import {
  syncLimiter,
  summaryLimiter,
  categoryRevenueLimiter,
  itemsCategoriesLimiter,
  itemsRankedLimiter,
  hourlyRevenueLimiter,
  giftCardSummaryLimiter,
  detailedTransactionsLimiter,
  syncProgressLimiter,
  syncStatusLimiter,
  analyzeGiftCardsLimiter,
  fixGiftCardsLimiter,
  fixGiftCardSingleLimiter,
  healthLimiter,
} from '../middleware/rateLimiter';
import { toSafeErrorResponse } from '../errors';
import { logger, errorContext } from '../logger';

/**
 * RFC 4180-compliant CSV cell escape with CSV-injection mitigation.
 *
 * Two things going on:
 *   1. Standard quoting: wrap the value in double quotes and double
 *      any embedded quote when it contains a comma, quote, or
 *      newline character — the three things that would otherwise let
 *      a malicious or accidental payload break out of its column.
 *   2. CSV formula injection guard (OWASP): if the value begins with
 *      `=`, `+`, `-`, `@`, TAB, or CR, prefix it with a single quote
 *      so Excel / Google Sheets won't evaluate the cell as a formula
 *      when an unsuspecting operator opens the export. The audit
 *      table contains attacker-influenceable fields (usernames,
 *      error messages, params payloads) so this is not theoretical.
 *
 * Empty / null / undefined values render as the empty string (no
 * quotes), which Excel and Google Sheets both round-trip cleanly.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  if (s === '') return '';
  // CSV injection guard. Prefix a single-quote so spreadsheet apps
  // treat the cell as text instead of a formula.
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Stable column ordering for the sync_audit CSV export (Task #117).
 * The set matches what the task description requires (actor, IP,
 * sync type, action, status, params, started/completed timestamps,
 * pages used) plus `id`, `errorMessage`, and `result` because they're
 * already present in the in-app browser and are obvious things to
 * want when reviewing an incident offline.
 */
const SYNC_AUDIT_CSV_HEADER = [
  'id',
  'syncType',
  'action',
  'actorUsername',
  'actorUserId',
  'actorIp',
  'status',
  'pagesUsed',
  'startedAt',
  'completedAt',
  'params',
  'result',
  'errorMessage',
] as const;

interface SyncAuditCsvRow {
  id: number;
  syncType: string;
  action: string;
  actorUsername: string | null;
  actorUserId: number | null;
  actorIp: string | null;
  status: string;
  pagesUsed: number;
  startedAt: Date;
  completedAt: Date | null;
  params: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
}

/**
 * Render a list of sync_audit rows as an RFC 4180 CSV string. Uses
 * `\r\n` line endings so Excel on Windows opens the file without
 * needing the user to pick an encoding, and prefixes a UTF-8 BOM so
 * Excel honours unicode in actor usernames / error messages.
 *
 * `params` and `result` are JSON-stringified into a single cell each
 * — they're free-shape blobs, not tabular data, and exploding them
 * across columns would mean the column set changes per row.
 */
export function renderSyncAuditCsv(entries: SyncAuditCsvRow[]): string {
  const lines: string[] = [];
  lines.push(SYNC_AUDIT_CSV_HEADER.join(','));
  for (const e of entries) {
    lines.push([
      csvCell(e.id),
      csvCell(e.syncType),
      csvCell(e.action),
      csvCell(e.actorUsername),
      csvCell(e.actorUserId),
      csvCell(e.actorIp),
      csvCell(e.status),
      csvCell(e.pagesUsed),
      csvCell(e.startedAt.toISOString()),
      csvCell(e.completedAt ? e.completedAt.toISOString() : null),
      csvCell(e.params ? JSON.stringify(e.params) : null),
      csvCell(e.result ? JSON.stringify(e.result) : null),
      csvCell(e.errorMessage),
    ].join(','));
  }
  // UTF-8 BOM (\uFEFF) + CRLF line endings = "Excel-friendly" CSV.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/**
 * Router-level error middleware. Exported so that `server/routes.ts` can
 * attach it AFTER it has finished mounting its own backfill routes onto
 * the apiRouter — Express only invokes error middleware that was
 * registered after the route that called `next(err)`.
 */
export function attachApiErrorMiddleware(router: Router) {
  router.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error('api.error', { path: req.path, method: req.method, ...errorContext(err) });
    if (!res.headersSent) {
      const { status, body } = toSafeErrorResponse(err);
      res.status(status).json(body);
    }
  });
}

export function createApiRouter(): Router {
  const router = Router();
  
  // Per-request access logs are emitted by the structured request logger
  // in server/index.ts (allow-listed fields only). Don't double-log here.

  // /health is reachable without auth (allow-listed below). Pin a tight
  // dedicated bucket so it can't be used as an unauthenticated firehose
  // for log noise or to drain the global apiLimiter budget that the rest
  // of /api shares.
  router.get('/health', healthLimiter, (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });


  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health') {
      return next();
    }
    requireAuth(req, res, next);
  });
  
  /**
   * Extract date range parameters from the request
   */
  function extractDateRange(req: Request): {
    dateRange: DateRange;
    startDate?: Date;
    endDate?: Date;
  } {
    // Parse date range type
    const dateRangeParam = req.query.dateRange as string;
    let dateRange: DateRange;
    
    try {
      dateRange = dateRangeSchema.parse(dateRangeParam);
    } catch (error) {
      dateRange = 'today';
    }
    
    // For custom date ranges, parse start and end dates
    let startDate: Date | undefined;
    let endDate: Date | undefined;
    
    if (dateRange === 'custom') {
      if (req.query.startDate && typeof req.query.startDate === 'string') {
        try {
          startDate = new Date(req.query.startDate);
        } catch {
          logger.warn('api.invalid_start_date');
        }
      }

      if (req.query.endDate && typeof req.query.endDate === 'string') {
        try {
          endDate = new Date(req.query.endDate);
        } catch {
          logger.warn('api.invalid_end_date');
        }
      }
    }
    
    return { dateRange, startDate, endDate };
  }
  
  // The router-level error middleware is attached at the bottom of
  // createApiRouter (see attachApiErrorMiddleware) so it can actually
  // catch next(err) from the routes registered below.
  
  /**
   * Dashboard Summary API
   * GET /api/summary
   */
  router.get('/summary', summaryLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const summary = await dashboardService.getDailySummary(dateRange, startDate, endDate);
      res.json(summary);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Transactions API
   * GET /api/transactions
   * Returns completed transactions in the requested date range.
   */
  const transactionsHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const txns = await pgStorage.getTransactions(dateRange, startDate, endDate, 'completed');
      res.json(txns);
    } catch (error) {
      next(error);
    }
  };
  router.get('/transactions', transactionsHandler);

  /**
   * Category Revenue API
   * GET /api/category-revenue
   * GET /api/revenue-by-category (legacy alias)
   */
  const categoryRevenueHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const categoryRevenue = await dashboardService.getCategoryRevenue(dateRange, startDate, endDate);
      res.json(categoryRevenue);
    } catch (error) {
      next(error);
    }
  };
  router.get('/category-revenue', categoryRevenueLimiter, categoryRevenueHandler);
  router.get('/revenue-by-category', categoryRevenueLimiter, categoryRevenueHandler);

  /**
   * Items by Category — category tree (Task #188)
   * GET /api/items/categories
   * Returns Square's category hierarchy as a forest of top-level rollups.
   */
  router.get('/items/categories', itemsCategoriesLimiter, async (
    _req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const tree = await itemsService.getCategoryTree();
      res.json(tree);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Items by Category — ranked items (Task #188)
   * GET /api/items/ranked?categoryId=...&metric=revenue|units|transactions&dateRange=...
   * Returns every non-archived item under the given category (or its
   * descendants) ranked by the requested metric. Items with zero sales
   * are included with metric=0.
   */
  router.get('/items/ranked', itemsRankedLimiter, async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId : '';
      if (!categoryId) {
        res.status(400).json({ error: 'categoryId is required' });
        return;
      }
      let metric: ReturnType<typeof itemMetricSchema.parse>;
      try {
        metric = itemMetricSchema.parse(req.query.metric ?? 'revenue');
      } catch {
        res.status(400).json({ error: 'metric must be revenue, units, or transactions' });
        return;
      }
      const items = await itemsService.getRankedItems(
        categoryId,
        metric,
        dateRange,
        startDate,
        endDate,
      );
      res.json(items);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Revenue totals per top-level rollup category
   * GET /api/items/category-totals?dateRange=...
   */
  router.get('/items/category-totals', itemsCategoriesLimiter, async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const totals = await itemsService.getCategoryRevenueTotals(dateRange, startDate, endDate);
      res.json(totals);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Hourly Revenue API
   * GET /api/hourly-revenue
   */
  router.get('/hourly-revenue', hourlyRevenueLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const hourlyRevenue = await dashboardService.getHourlyRevenue(dateRange, startDate, endDate);
      res.json(hourlyRevenue);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Gift Card Summary API
   * GET /api/gift-card-summary
   */
  router.get('/gift-card-summary', giftCardSummaryLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const giftCardSummary = await dashboardService.getGiftCardSummary(dateRange, startDate, endDate);
      res.json(giftCardSummary);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Detailed Transactions API
   * GET /api/detailed-transactions
   */
  router.get('/detailed-transactions', detailedTransactionsLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateRange, startDate, endDate } = extractDateRange(req);
      const detailedTransactions = await dashboardService.getDetailedTransactionBreakdown(
        dateRange, 
        startDate, 
        endDate
      );
      res.json(detailedTransactions);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Sync Progress API
   * GET /api/sync-progress
   */
  router.get('/sync-progress', syncProgressLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const progress = await syncService.getSyncProgress();
      res.json(progress);
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Start Sync API
   * POST /api/sync
   * 
   * Used to trigger various synchronization operations including the special
   * reconciliation tool for missing payments from the March 6, 2025 gap.
   * 
   * Body: { 
   *   type: "orders" | "payments" | "gift_cards" | "all" | "missing_payments", 
   *   startDate?: string,  // Optional ISO date string, defaults to March 6, 2025 04:13:41 UTC for missing_payments
   *   endDate?: string     // Optional ISO date string, defaults to current time
   * }
   * 
   * The "missing_payments" type specifically addresses the architectural transition gap
   * where payments records were missing since March 6, 2025. This is part of our
   * dual-track strategy for maintaining data consistency during the transition.
   */
  router.post('/sync', requireAdmin, syncLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const syncSchema = z.object({
        type: z.enum(['orders', 'payments', 'gift_cards', 'gift_card_redemptions', 'refunds', 'catalog', 'all', 'missing_payments']),
        startDate: z.string().optional()
          .refine(date => !date || !isNaN(new Date(date).getTime()), {
            message: "startDate must be a valid date string"
          }),
        endDate: z.string().optional()
          .refine(date => !date || !isNaN(new Date(date).getTime()), {
            message: "endDate must be a valid date string"
          })
      });
      
      const validatedBody = syncSchema.parse(req.body);
      
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      
      if (validatedBody.startDate) {
        startDate = new Date(validatedBody.startDate);
      }
      
      if (validatedBody.endDate) {
        endDate = new Date(validatedBody.endDate);
      }
      
      let result;
      
      switch (validatedBody.type) {
        case 'orders':
          result = await syncService.syncOrders(startDate, endDate);
          break;
        case 'payments':
          result = await syncService.syncPayments(startDate, endDate);
          break;
        case 'gift_cards':
          // Route to the canonical Activities-API-based full reconciliation
          // (resumable, cursor-checkpointed) instead of the legacy listGiftCards path
          result = await syncService.syncGiftCardsHistoricalBackfill({
            actorUserId: (req as any).session?.userId ?? null,
            actorIp: req.ip ?? null,
          });
          break;
        case 'gift_card_redemptions':
          logger.info('sync.giftCardRedemptions.start');
          result = await syncService.syncGiftCardRedemptions(startDate, endDate);
          logger.info('sync.giftCardRedemptions.done', {
            processed: result.processed,
            created: result.created,
            errors: result.errors.length,
          });
          break;
        case 'refunds':
          logger.info('sync.refunds.start');
          result = await syncService.syncRefunds(startDate, endDate);
          logger.info('sync.refunds.done', {
            processed: result.processed,
            created: result.created,
            updated: result.updated,
            failed: result.failed,
          });
          break;
        case 'catalog':
          logger.info('sync.catalog.start');
          const { syncCatalog: runCatalogSync } = await import('../services/catalogService');
          result = await runCatalogSync();
          const catalogResult = result as { categories: number; items: number; errors: string[] };
          logger.info('sync.catalog.done', {
            categories: catalogResult.categories,
            items: catalogResult.items,
          });
          break;
        case 'missing_payments':
          logger.info('sync.missingPayments.start');
          const reconciliationStart = startDate || new Date('2025-03-06T04:13:41.000Z');
          const reconciliationEnd = endDate || new Date();
          result = await syncService.syncPayments(reconciliationStart, reconciliationEnd);
          logger.info('sync.missingPayments.done', {
            processed: result.processed,
            created: result.created,
          });
          break;
        case 'all':
          const actorCtx = {
            actorUserId: (req as any).session?.userId ?? null,
            actorIp: req.ip ?? null,
          };
          const [ordersResult, paymentsResult, giftCardsResult, redemptionsResult, refundsResult] = await Promise.all([
            syncService.syncOrders(startDate, endDate),
            syncService.syncPayments(startDate, endDate),
            syncService.syncGiftCardsHistoricalBackfill(actorCtx),
            syncService.syncGiftCardRedemptions(startDate, endDate),
            syncService.syncRefunds(startDate, endDate)
          ]);
          
          result = {
            orders: ordersResult,
            payments: paymentsResult,
            giftCards: giftCardsResult,
            giftCardRedemptions: redemptionsResult,
            refunds: refundsResult
          };
          break;
      }
      
      // Create a response message based on the sync type and result format
      let message = 'Sync started successfully';
      
      // Handle different result formats based on sync type
      if (result) {
        if (validatedBody.type === 'missing_payments' && 'processed' in result && 'created' in result) {
          message = `Payment reconciliation completed: ${result.processed} processed, ${result.created} created`;
        } else if (validatedBody.type === 'gift_card_redemptions' && 'matched' in result) {
          message = `Gift card redemption sync completed successfully: ${result.processed} processed, ${result.matched} matched, ${result.created} created, ${result.errors.length} errors`;
        } else if ('processed' in result) {
          if ('success' in result && result.success !== undefined) {
            // Gift card redemption result format
            message = `Sync completed: ${result.processed} processed, ${result.created} created`;
          } else {
            // Standard sync result format for orders, payments, gift cards
            const updated = 'updated' in result ? result.updated : 0;
            const failed = 'failed' in result ? result.failed : 0;
            message = `Sync completed: ${result.processed} processed, ${result.created} created, ${updated} updated, ${failed} failed`;
          }
        } else if ('orders' in result) {
          message = 'All sync operations completed';
        }
      }
      
      res.json({
        success: true,
        message,
        result
      });

      broadcast('data-updated', { syncType: validatedBody.type });
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Fix ALL Gift Card Activation Amounts API
   * POST /api/fix-gift-cards
   * 
   * This endpoint provides a comprehensive solution to the gift card activation amount issue for ALL cards,
   * by properly linking gift cards to their original orders and extracting accurate activation amounts.
   * 
   * Enhanced Implementation:
   * 1. Direct Square API integration for both cards and order data
   * 2. Multi-stage matching strategy with expanded timeframes:
   *    a. Square Order ID direct matching when available
   *    b. GAN (gift card number) matching with orders
   *    c. Temporal matching (order within 30 minutes of gift card creation)
   *    d. Line item name + amount matching
   * 3. Permanent linking of gift cards to their activation orders
   * 4. Future-proofing through automatic linking during creation
   * 
   * Critical Fix:
   * - Works for ALL cards in the system, not just recent ones
   * - Always uses basePriceMoney for accurate activation amounts on discounted cards
   * - Creates permanent order links for future reference
   * 
   * Returns detailed results of the operation including counts and individual card fixes.
   */
  router.post('/fix-gift-cards', requireAdmin, syncLimiter, fixGiftCardsLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // Use the Activities-API-first backfill (preferred) with order-matching fallback
      const { backfillGiftCardActivationAmounts } = await import('../services/enhancedGiftCardFix');
      
      const result = await backfillGiftCardActivationAmounts();
      
      res.json({
        success: true,
        message: `Backfill complete: ${result.updatedViaActivitiesApi} via Activities API, ${result.updatedViaOrderMatch} via order matching, ${result.stillUnresolved} unresolved`,
        result
      });
    } catch (error) {
      logger.error('giftCard.activationBackfill.failed', errorContext(error));
      next(error);
    }
  });
  
  /**
   * Analyze Gift Card Activation Amounts & Linking API
   * GET /api/analyze-gift-cards
   * 
   * This endpoint provides comprehensive analysis of gift card activation amounts
   * and their linking to original orders, including detailed statistics for monitoring
   * the health of the gift card system.
   */
  router.get('/analyze-gift-cards', analyzeGiftCardsLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // Import the enhanced gift card analysis service
      const { analyzeGiftCardLinkingStatus } = await import('../services/enhancedGiftCardFix');
      
      // Run the enhanced analysis
      const analysis = await analyzeGiftCardLinkingStatus();
      
      res.json({
        success: true,
        message: `Analysis complete: ${analysis.withOrderLink} of ${analysis.totalGiftCards} gift cards linked to orders`,
        analysis
      });
    } catch (error) {
      logger.error('giftCard.analyzeLinking.failed', errorContext(error));
      next(error);
    }
  });

  /**
   * Fix a single gift card's activation amount
   * POST /api/fix-gift-card/:id
   *
   * Operator-facing endpoint to retry the activation-amount link for one
   * specific gift card by internal ID. Re-homed here from the deleted
   * `server/api/giftCardFixer.ts` (the rest of that router was duplicate
   * dead code shadowed by the handlers above).
   */
  router.post('/fix-gift-card/:id', requireAdmin, fixGiftCardSingleLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const giftCardId = parseInt(req.params.id, 10);
      if (isNaN(giftCardId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid gift card ID',
          error: 'ID must be a number',
        });
      }

      const { fixNewGiftCardActivationAmount } = await import('../services/enhancedGiftCardFix');
      const result = await fixNewGiftCardActivationAmount(giftCardId);

      if (result.updated) {
        res.json({
          success: true,
          message: `Successfully fixed gift card #${giftCardId} with activation amount $${result.activationAmount}.`,
          source: result.source,
          result,
        });
      } else {
        res.json({
          success: false,
          message: `Could not fix gift card #${giftCardId}: ${result.error || 'Unknown error'}`,
          source: result.source,
          result,
        });
      }
    } catch (error) {
      next(error);
    }
  });
  
  /**
   * Sync Status API
   * GET /api/sync/status
   *
   * Returns the most recent sync timestamps for every sync type so the UI can
   * display a "last synced" indicator.
   */
  router.get('/sync/status', syncStatusLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = await import('../db');
      const { syncState } = await import('../../shared/schema');
      const { desc } = await import('drizzle-orm');

      const rows = await db
        .select()
        .from(syncState)
        .orderBy(desc(syncState.lastSyncedAt));

      // Collapse to one row per syncType (most recent)
      const byType: Record<string, { lastSyncedAt: Date | null; status: string; processedCount: number | null }> = {};
      for (const row of rows) {
        if (!byType[row.syncType]) {
          byType[row.syncType] = {
            lastSyncedAt: row.lastSyncedAt,
            status: row.status ?? '',
            processedCount: row.processedCount,
          };
        }
      }

      // Overall "last synced" = most recent completed sync across all types
      const completedSyncs = rows.filter(r => r.status === 'completed' && r.lastSyncedAt);
      const overallLastSynced = completedSyncs.length > 0
        ? completedSyncs.reduce((latest, r) =>
            r.lastSyncedAt! > latest ? r.lastSyncedAt! : latest,
            completedSyncs[0].lastSyncedAt!
          )
        : null;

      res.json({ success: true, byType, overallLastSynced });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Historical Catch-up Sync API
   * POST /api/sync/historical
   *
   * Kicks off a background process that loops through monthly date chunks from
   * startDate (default: 2 years ago) through today, calling syncOrders and
   * syncPayments for each chunk.  Also runs a full gift card sync and activation
   * backfill at the end.
   *
   * Returns 202 immediately so the HTTP request never times out.
   */
  router.post('/sync/historical', requireAdmin, syncLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

      let startDate = twoYearsAgo;
      if (req.body?.startDate) {
        const parsed = new Date(req.body.startDate);
        if (!isNaN(parsed.getTime())) {
          startDate = parsed;
        }
      }

      // DB-level concurrency: a single shared advisory lock guards every
      // historical/backfill flow so concurrent admin triggers cannot
      // double-up on the shared Square API.
      const lock = await tryAcquireSyncLock('historical_sync');
      const actorCtx = {
        actorUserId: (req as any).session?.userId ?? null,
        actorIp: req.ip ?? null,
      };
      if (!lock) {
        const rejectedAuditId = await recordAuditStart({
          syncType: 'historical_sync',
          action: 'historical_sync',
          ...actorCtx,
          params: { startDate: startDate.toISOString(), rejectedReason: 'already_running' },
        });
        await recordAuditFinish(rejectedAuditId, {
          status: 'rejected',
          result: { reason: 'already_running' },
        });
        res.status(409).json({
          success: false,
          message: 'Historical sync is already running',
        });
        return;
      }

      let auditId: number;
      try {
        auditId = await recordAuditStart({
          syncType: 'historical_sync',
          action: 'historical_sync',
          ...actorCtx,
          params: { startDate: startDate.toISOString() },
        });
      } catch (err) {
        await lock.release();
        throw err;
      }

      res.status(202).json({
        success: true,
        message: `Historical sync started from ${startDate.toISOString().slice(0, 10)}. This runs in the background — check server logs for progress.`,
        startDate: startDate.toISOString(),
      });

      // Run in background — no await so the HTTP response is sent first.
      // The lock is released and the audit row finalised inside the
      // background promise so concurrent triggers see the lock as held
      // until the run actually completes.
      runHistoricalSync(startDate)
        .then(async () => {
          await recordAuditFinish(auditId, { status: 'completed' });
        })
        .catch(async (err) => {
          logger.error('historicalSync.unhandled', errorContext(err));
          await recordAuditFinish(auditId, {
            status: 'failed',
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(async () => {
          await lock.release();
        });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Resumable Gift Card Full Reconciliation (canonical path)
   * POST /api/sync/gift-cards/full   — spec-required name
   * POST /api/sync/gift-cards-backfill — legacy alias kept for backwards compat
   *
   * Pages through ALL Square ACTIVATE events (oldest first) via the Activities API,
   * upserting each gift card with the correct UTC purchase_date and activation amount.
   * Saves a cursor checkpoint after every page so the job resumes from where it left
   * off if the server restarts mid-scan — fixing the March 9-20 data gap.
   *
   * Call repeatedly (each call processes up to 20 pages / 1,000 events) until the
   * response shows `finished: true`.
   */
  async function handleGiftCardFullSync(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await syncService.syncGiftCardsHistoricalBackfill({
        actorUserId: (req as any).session?.userId ?? null,
        actorIp: req.ip ?? null,
      });
      res.json({
        success: true,
        message: result.finished
          ? `Full sync complete! processed=${result.processed} created=${result.created} updated=${result.updated} failed=${result.failed} pages=${result.pagesProcessed}`
          : `Full sync in progress — call again to continue. processed=${result.processed} created=${result.created} updated=${result.updated} failed=${result.failed} pages=${result.pagesProcessed}`,
        result,
      });
    } catch (error) {
      logger.error('giftCard.fullSync.failed', errorContext(error));
      next(error);
    }
  }

  router.post('/sync/gift-cards/full', requireAdmin, syncLimiter, handleGiftCardFullSync);
  router.post('/sync/gift-cards-backfill', requireAdmin, syncLimiter, handleGiftCardFullSync);

  router.post('/sync/gift-cards/refresh-balances', requireAdmin, syncLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await giftCardService.refreshAllGiftCardBalances();
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('giftCard.balanceRefresh.failed', errorContext(error));
      next(error);
    }
  });

  router.post('/sync/quick', requireAdmin, syncLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { runFrequentSync } = await import('../services/schedulerService');
      await runFrequentSync();
      res.json({ success: true, message: 'Quick sync completed' });
    } catch (error) {
      next(error);
    }
  });

  router.post('/sync/catalog', requireAdmin, syncLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { syncCatalog } = await import('../services/catalogService');
      const result = await syncCatalog();
      res.json({ success: true, ...result });
      // Notify connected dashboards (e.g. the Items tab) so they can
      // refetch category and ranked-item data without a manual reload.
      broadcast('data-updated', { syncType: 'catalog' });
    } catch (error) {
      logger.error('sync.catalog.failed', errorContext(error));
      next(error);
    }
  });

  router.post('/sync/catalog/backfill', requireAdmin, syncLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { syncCatalog, backfillCategories } = await import('../services/catalogService');
      const catalogResult = await syncCatalog();
      logger.info('sync.catalog.done', {
        categories: catalogResult.categories,
        items: catalogResult.items,
      });
      const backfillResult = await backfillCategories();
      res.json({
        success: true,
        catalog: catalogResult,
        backfill: backfillResult,
      });
      broadcast('data-updated', { syncType: 'catalog' });
    } catch (error) {
      logger.error('sync.catalog.backfillFailed', errorContext(error));
      next(error);
    }
  });

  // Admin: read/update the in-process Square 429 alerter thresholds.
  // GET returns the currently effective tunable config (env defaults
  // merged with any persisted override). PUT validates, persists to
  // app_settings, and pushes the new values into the live alerter so
  // the change applies without a server restart.
  router.get(
    '/admin/alerts/square-rate-limit',
    requireAdmin,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const { squareRateLimitAlerter } = await import(
          '../services/squareRateLimitAlert'
        );
        const tunable = squareRateLimitAlerter.getTunable();
        const effective = squareRateLimitAlerter.getEffectiveConfig();
        res.json({
          ...tunable,
          // `webhookConfigured` lets the UI tell admins whether a
          // webhook is wired up at all without leaking the URL itself.
          webhookConfigured: effective.webhookUrl !== null,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Admin: live state of the in-process Square 429 alerter (Task #121).
  // Returns the rolling event count, breakdown by syncType+source,
  // last-alert timestamp, remaining cooldown, and episode flag — all
  // derived from process memory, no DB hit. `Cache-Control: no-store`
  // because the UI polls this every few seconds and any cached
  // response would be stale by the time the operator sees it.
  router.get(
    '/admin/alerts/square-rate-limit/state',
    requireAdmin,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const { squareRateLimitAlerter } = await import(
          '../services/squareRateLimitAlert'
        );
        res.set('Cache-Control', 'no-store');
        res.json(squareRateLimitAlerter.getRuntimeState());
      } catch (err) {
        next(err);
      }
    },
  );

  // Admin: re-validate every key registered in `appSettingsRegistry`
  // and report each one's current status (Task #167). The
  // invalid-row alerter (Task #122) only fires once per key per
  // cooldown window, so an admin who joins after the alert has
  // fired has no other in-app way to see which rows are still
  // broken — this endpoint is that view. Re-validates on every
  // call so a follow-up GET after a fix-up migration confirms the
  // row now parses; `Cache-Control: no-store` keeps a stale
  // response from masking a broken row.
  router.get(
    '/admin/app-settings/validation',
    requireAdmin,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const entries = await pgStorage.validateAllAppSettings();
        res.set('Cache-Control', 'no-store');
        res.json({
          validatedAt: new Date().toISOString(),
          entries,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Admin: delete a single row from `app_settings` so the consumer
  // falls back to its hard-coded default (Task #182). Designed for the
  // "Reset to default" button on the App settings registry panel —
  // when a row has gone invalid (legacy shape, dropped field) and the
  // correct fix is simply to drop it, this endpoint closes the loop
  // without shipping a one-off migration. The delete + audit-row write
  // commit together via `deleteAppSettingWithAudit` so we can never
  // lose the trail of who reset which key. Restricted to keys that
  // are actually in `appSettingsRegistry` so an attacker can't use
  // this to clear arbitrary jsonb rows that future code might add.
  router.delete(
    '/admin/app-settings/:key',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const key = req.params.key;
        if (!Object.prototype.hasOwnProperty.call(appSettingsRegistry, key)) {
          return res.status(404).json({
            error: 'Unknown app setting key',
            key,
          });
        }
        const typedKey = key as AppSettingKey;
        // Snapshot the current row (if any) so the audit metadata can
        // record what was cleared. We use the raw DB read instead of
        // `getAppSetting` so an invalid/legacy row — the very case
        // this endpoint exists to clean up — still surfaces in the
        // audit trail rather than coming back as `undefined`.
        const { db } = await import('../db');
        const { appSettings } = await import('../../shared/schema');
        const { eq } = await import('drizzle-orm');
        const existing = await db
          .select({ value: appSettings.value })
          .from(appSettings)
          .where(eq(appSettings.key, typedKey));
        const previousValue = existing[0]?.value ?? null;
        await pgStorage.deleteAppSettingWithAudit(typedKey, {
          actorUserId: req.user!.id,
          actorIp: req.ip ?? null,
          action: 'app_setting.reset_to_default',
          targetUserId: null,
          metadata: {
            key: typedKey,
            existed: existing.length > 0,
            previousValue,
          },
        });
        res.json({ key: typedKey, status: 'reset' });
      } catch (err) {
        next(err);
      }
    },
  );

  router.put(
    '/admin/alerts/square-rate-limit',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { squareRateLimitAlertSettingsSchema } = await import(
          '@shared/schema'
        );
        const parsed = squareRateLimitAlertSettingsSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: 'Invalid alert settings',
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          });
        }
        const { applyAndPersistSquareRateLimitAlertOverride } = await import(
          '../services/squareRateLimitAlertSettings'
        );
        await applyAndPersistSquareRateLimitAlertOverride(parsed.data);
        const { squareRateLimitAlerter } = await import(
          '../services/squareRateLimitAlert'
        );
        const effective = squareRateLimitAlerter.getEffectiveConfig();
        res.json({
          ...squareRateLimitAlerter.getTunable(),
          webhookConfigured: effective.webhookUrl !== null,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Admin: paginated browser for the MCP read-query audit log. Backed by
  // pgStorage.listMcpQueryAudit; supports filtering by admin username
  // substring, success/error outcome, and date range.
  router.get(
    '/admin/mcp-audit',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const querySchema = z.object({
          adminUsername: z.string().trim().max(100).optional(),
          outcome: z.enum(['success', 'error']).optional(),
          startDate: z.string().datetime().optional(),
          endDate: z.string().datetime().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        });
        const parsed = querySchema.safeParse(req.query);
        if (!parsed.success) {
          return res.status(400).json({
            error: 'Invalid query parameters',
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          });
        }
        const { adminUsername, outcome, startDate, endDate, limit, offset } = parsed.data;
        const page = await pgStorage.listMcpQueryAudit({
          adminUsername,
          outcome,
          startDate: startDate ? new Date(startDate) : undefined,
          endDate: endDate ? new Date(endDate) : undefined,
          limit,
          offset,
        });
        res.json(page);
      } catch (err) {
        next(err);
      }
    },
  );

  // Admin: paginated browser for the sync audit log. Surfaces who
  // triggered each historical/backfill run, with which params, and
  // how it completed.
  router.get(
    '/admin/sync-audit',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const querySchema = z.object({
          syncType: z.string().trim().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        });
        const parsed = querySchema.safeParse(req.query);
        if (!parsed.success) {
          return res.status(400).json({
            error: 'Invalid query parameters',
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          });
        }
        const page = await pgStorage.listSyncAudit(parsed.data);
        res.json(page);
      } catch (err) {
        next(err);
      }
    },
  );

  // Admin: CSV export of the same sync_audit rows the paginated
  // browser shows (Task #117). Returns text/csv with a Content-
  // Disposition: attachment header so the browser downloads to a
  // file rather than rendering inline. The same `syncType` filter
  // shape as `/admin/sync-audit` is honoured so the download matches
  // whatever the operator currently has applied in the UI.
  router.get(
    '/admin/sync-audit.csv',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const querySchema = z.object({
          syncType: z.string().trim().max(100).optional(),
          // `maxRows` lets an operator request a smaller, faster
          // download for triage and lets the test suite force
          // truncation without seeding 10k rows. Bounded to the same
          // safety range as the storage helper.
          maxRows: z.coerce.number().int().min(1).max(50_000).optional(),
        });
        const parsed = querySchema.safeParse(req.query);
        if (!parsed.success) {
          return res.status(400).json({
            error: 'Invalid query parameters',
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          });
        }

        const { entries, truncated } = await pgStorage.exportSyncAudit({
          syncType: parsed.data.syncType,
          maxRows: parsed.data.maxRows,
        });
        const csv = renderSyncAuditCsv(entries);

        // Filename embeds today's date (UTC; the audit timestamps are
        // stored in UTC) so multiple downloads in a session don't
        // collide in the browser's downloads folder. The `attachment`
        // disposition forces a file save instead of inline rendering.
        const today = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="sync-audit-${today}.csv"`,
        );
        // CSV is data, not a webpage — block the cached-by-CDN /
        // remembered-by-browser failure modes that would otherwise let
        // a stale export be served back the next day.
        res.setHeader('Cache-Control', 'no-store');
        // Surface row count + truncation as response headers (and
        // expose them to fetch() callers via Access-Control-Expose-
        // Headers so the UI can warn if it ever uses fetch instead
        // of the current `<a download>` approach). Without these the
        // operator can't tell a partial export from a complete one.
        res.setHeader('X-Sync-Audit-Row-Count', String(entries.length));
        res.setHeader('X-Sync-Audit-Truncated', truncated ? 'true' : 'false');
        res.setHeader(
          'Access-Control-Expose-Headers',
          'Content-Disposition, X-Sync-Audit-Row-Count, X-Sync-Audit-Truncated',
        );
        res.send(csv);
      } catch (err) {
        next(err);
      }
    },
  );

  // Admin: today's Square page-budget snapshot for the Backfill Audit
  // page widget (Task #119). Returns the UTC day key, how many pages
  // backfills have spent against today's row, and the hard cap. The
  // widget exists so an operator can see the rolling window without
  // dropping into psql.
  router.get(
    '/admin/sync-budget',
    requireAdmin,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const status = await getDailyBudgetStatus();
        // Data, not a webpage — and the value moves every time a
        // backfill consumes a page, so a cached response would be
        // immediately stale. no-store keeps the widget honest.
        res.setHeader('Cache-Control', 'no-store');
        res.json(status);
      } catch (err) {
        next(err);
      }
    },
  );

  // NOTE: do NOT attach the error middleware here — `server/routes.ts`
  // adds more routes to this router AFTER createApiRouter() returns,
  // and Express won't dispatch an error middleware to a route that was
  // registered after it. routes.ts calls attachApiErrorMiddleware once
  // every route has been mounted.
  return router;
}

/**
 * Background historical sync worker.
 * Processes one month at a time to avoid API rate limits and memory pressure.
 */
async function runHistoricalSync(startDate: Date): Promise<void> {
  const { backfillGiftCardActivationAmounts } = await import('../services/enhancedGiftCardFix');

  // Every line in this worker is grouped under the `historicalSync.*`
  // namespace so an operator can `grep historicalSync` to follow a run.
  // Per-chunk lines additionally carry chunkIndex / chunkStart / chunkEnd
  // so the structured log replaces the old free-form `[chunk N start→end]`
  // string prefix.
  logger.info('historicalSync.start', {
    startDate: startDate.toISOString().slice(0, 10),
  });

  const now = new Date();
  let chunkStart = new Date(startDate);
  let chunkIndex = 0;

  while (chunkStart < now) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setMonth(chunkEnd.getMonth() + 1);
    if (chunkEnd > now) chunkEnd.setTime(now.getTime());

    chunkIndex += 1;
    const chunkCtx = {
      chunkIndex,
      chunkStart: chunkStart.toISOString().slice(0, 10),
      chunkEnd: chunkEnd.toISOString().slice(0, 10),
    };
    logger.info('historicalSync.chunk.orders.start', chunkCtx);

    try {
      const ordersResult = await syncService.syncOrders(chunkStart, chunkEnd);
      logger.info('historicalSync.chunk.orders.done', {
        ...chunkCtx,
        processed: ordersResult.processed,
        created: ordersResult.created,
      });
    } catch (err) {
      logger.error('historicalSync.chunk.orders.failed', {
        ...chunkCtx,
        ...errorContext(err),
      });
    }

    try {
      const paymentsResult = await syncService.syncPayments(chunkStart, chunkEnd);
      logger.info('historicalSync.chunk.payments.done', {
        ...chunkCtx,
        processed: paymentsResult.processed,
        created: paymentsResult.created,
      });
    } catch (err) {
      logger.error('historicalSync.chunk.payments.failed', {
        ...chunkCtx,
        ...errorContext(err),
      });
    }

    try {
      const refundsResult = await syncService.syncRefunds(chunkStart, chunkEnd);
      logger.info('historicalSync.chunk.refunds.done', {
        ...chunkCtx,
        processed: refundsResult.processed,
        created: refundsResult.created,
      });
    } catch (err) {
      logger.error('historicalSync.chunk.refunds.failed', {
        ...chunkCtx,
        ...errorContext(err),
      });
    }

    chunkStart = new Date(chunkEnd);
    // Small pause between chunks to be kind to the Square API rate limits
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // After all date chunks, run the resumable Activities-API gift card reconciliation.
  // This replaces the old syncGiftCards() (listGiftCards — no date filter, arbitrary order,
  // loses progress on restart).  The new method pages through ALL ACTIVATE events ASC,
  // checkpointing after each page so restarts resume mid-scan.
  logger.info('historicalSync.giftCards.start');
  try {
    // Nested call: parent runHistoricalSync already holds the shared
    // historical advisory lock, so skip the lock here to avoid self-deadlock.
    const gcResult = await syncService.syncGiftCardsHistoricalBackfill({ skipLock: true });
    logger.info('historicalSync.giftCards.done', {
      processed: gcResult.processed,
      created: gcResult.created,
      updated: gcResult.updated,
      failed: gcResult.failed,
      pagesProcessed: gcResult.pagesProcessed,
      finished: gcResult.finished,
    });
  } catch (err) {
    logger.error('historicalSync.giftCards.failed', errorContext(err));
  }

  logger.info('historicalSync.activationBackfill.start');
  try {
    const backfillResult = await backfillGiftCardActivationAmounts();
    logger.info('historicalSync.activationBackfill.done', {
      filled: backfillResult.updatedViaActivitiesApi,
      corrected: backfillResult.correctedViaActivitiesApi,
      unresolved: backfillResult.stillUnresolved,
    });
  } catch (err) {
    logger.error('historicalSync.activationBackfill.failed', errorContext(err));
  }

  logger.info('historicalSync.complete', { chunksProcessed: chunkIndex });

  broadcast('data-updated', { syncType: 'historical' });
}