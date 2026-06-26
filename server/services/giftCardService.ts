/**
 * Gift Card Service
 * 
 * Handles all gift card-related business logic with proper error handling
 * and data validation. Provides a clean API for the rest of the application.
 */

import { db } from '../db';
import { eq, and, between, desc, asc, sql, isNull, gt, inArray } from 'drizzle-orm';
import { 
  giftCards,
  orders,
  syncState,
  giftCardRedemptions,
  transactions,
  type GiftCard, 
  type InsertGiftCard,
  type GiftCardRedemption,
  type InsertGiftCardRedemption,
  type DateRange,
  type GiftCardSummary
} from '../../shared/schema';
import { getEasternDateRange } from '../dateUtils';
import { fetchOrdersByIds, fetchGiftCardActivitiesPage } from '../squareClient';
import { logger, errorContext } from '../logger';

// Error classes now live in `server/errors.ts` (see Task #58: centralized
// error hierarchy). Re-exported here so existing imports keep working.
export {
  GiftCardError,
  GiftCardNotFoundError,
  InsufficientBalanceError,
} from '../errors';
import { GiftCardError, GiftCardNotFoundError, InsufficientBalanceError } from '../errors';

export class GiftCardService {
  /**
   * Get a gift card by ID
   * 
   * @param id The gift card ID
   * @returns The gift card or throws if not found
   */
  async getGiftCardById(id: number): Promise<GiftCard> {
    const result = await db.select().from(giftCards).where(eq(giftCards.id, id)).limit(1);
    
    if (!result.length) {
      throw new GiftCardNotFoundError(id);
    }
    
    return result[0];
  }
  
  /**
   * Create a new gift card with automatic order linking
   * 
   * This enhanced version not only creates a gift card but also:
   * 1. Automatically finds the purchase order for accurate activation amount
   * 2. Links the gift card to its activation order permanently
   * 3. Sets the proper activation amount based on order data
   * 
   * @param giftCardData The gift card data to insert
   * @returns The created gift card with accurate activation amount
   */
  async createGiftCard(giftCardData: InsertGiftCard): Promise<GiftCard> {
    // First create the gift card with the data provided
    const result = await db.insert(giftCards).values(giftCardData).returning();
    
    if (!result.length) {
      throw new GiftCardError('Failed to create gift card', 'DB_ERROR');
    }
    
    // Get the created gift card
    const newGiftCard = result[0];
    
    try {
      // Now enhance it with accurate activation amount by linking to its order
      logger.info('giftCard.create.link_order', { giftCardId: newGiftCard.id });
      
      // Import the enhanced gift card fix function for single cards
      const { fixNewGiftCardActivationAmount } = await import('./enhancedGiftCardFix');
      
      // Fix the new gift card's activation amount
      const enhancedGiftCardResult = await fixNewGiftCardActivationAmount(newGiftCard.id);
      
      // If the enhancement was successful, update the gift card with the new data
      if (enhancedGiftCardResult && enhancedGiftCardResult.updated && enhancedGiftCardResult.activationAmount) {
        // Update the gift card with the enhanced data
        return {
          ...newGiftCard,
          activationAmount: enhancedGiftCardResult.activationAmount,
          activationOrderId: enhancedGiftCardResult.orderId || null,
          activationSquareOrderId: enhancedGiftCardResult.squareOrderId || null
        };
      }
    } catch (error) {
      // Log the error but don't fail - we'll just return the original gift card
      logger.error('giftCard.create.enhance_failed', { ...errorContext(error), giftCardId: newGiftCard.id });
    }
    
    // Return the original gift card if enhancement failed
    return newGiftCard;
  }
  
  /**
   * Process a gift card redemption
   * 
   * @param giftCardId The gift card ID
   * @param amount The redemption amount
   * @param paymentId Optional payment ID associated with the redemption
   * @param orderId Optional order ID associated with the redemption
   * @returns The updated gift card
   */
  async processRedemption(
    giftCardId: number,
    amount: number,
    paymentId?: number,
    orderId?: number
  ): Promise<GiftCard> {
    return await db.transaction(async (tx) => {
      // Get the gift card with locking for update
      const giftCard = await tx.select().from(giftCards)
        .where(eq(giftCards.id, giftCardId))
        .limit(1);
      
      if (!giftCard.length) {
        throw new GiftCardNotFoundError(giftCardId);
      }
      
      const currentCard = giftCard[0];
      const currentBalance = currentCard.amount || 0;
      
      // Check if balance is sufficient
      if (currentBalance < amount) {
        throw new InsufficientBalanceError(giftCardId, amount, currentBalance);
      }
      
      // Update gift card balance
      const newBalance = currentBalance - amount;
      const newRedeemedAmount = (currentCard.redeemedAmount || 0) + amount;
      
      // Create a new object for square data
      const updatedSquareData = typeof currentCard.squareData === 'object' && currentCard.squareData !== null
        ? { ...currentCard.squareData, lastRedemptionDate: new Date().toISOString() }
        : { lastRedemptionDate: new Date().toISOString() };

      const updatedCard = await tx.update(giftCards)
        .set({
          amount: newBalance,
          redeemedAmount: newRedeemedAmount,
          squareData: updatedSquareData
        })
        .where(eq(giftCards.id, giftCardId))
        .returning();
      
      if (!updatedCard.length) {
        throw new GiftCardError('Failed to update gift card balance', 'DB_ERROR');
      }
      
      // Create redemption record - align with schema
      // Transaction ID is required by the schema, so we must ensure it has a value
      const transactionId = typeof paymentId === 'number' ? paymentId : 0;
      
      const redemptionData: InsertGiftCardRedemption = {
        giftCardId,
        amount,
        timestamp: new Date(),
        transactionId: transactionId  // Use the definitely-typed transaction ID
      };
      
      await tx.insert(giftCardRedemptions).values(redemptionData);
      
      return updatedCard[0];
    });
  }
  
  /**
   * Get gift card summary for a date range
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @returns Gift card summary including sales and redemptions
   */
  async getGiftCardSummary(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<GiftCardSummary> {
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);

    const activationsResult = await db.execute(sql`
      SELECT 
        COUNT(*) as sold_count,
        COALESCE(SUM(gc.activation_amount), 0) as sold_amount
      FROM gift_cards gc
      LEFT JOIN orders o ON o.square_id = gc.activation_square_order_id
      WHERE gc.purchase_date BETWEEN ${start} AND ${end}
        AND gc.activation_amount > 0
        AND (o.source IS NULL OR o.source NOT IN ('Web Reservation', 'Web Reservation-Attraction', 'Multi Attractions Reservation'))
    `);

    const redemptionsResult = await db.execute(sql`
      SELECT 
        COUNT(*) as redeemed_count,
        COALESCE(SUM(amount), 0) as redeemed_amount
      FROM gift_card_redemptions
      WHERE timestamp BETWEEN ${start} AND ${end}
    `);

    const outstandingResult = await db.execute(sql`
      SELECT COALESCE(SUM(gc.amount), 0) as outstanding_balance
      FROM gift_cards gc
      WHERE gc.amount > 0
    `);

    const webResAdvResult = await db.execute(sql`
      SELECT COALESCE(SUM(gc.amount), 0) as web_res_adv_deposits
      FROM gift_cards gc
      INNER JOIN orders o ON o.square_id = gc.activation_square_order_id
      WHERE gc.amount > 0
        AND o.source IN ('Web Reservation', 'Web Reservation-Attraction', 'Multi Attractions Reservation')
    `);

    const soldCount = parseInt(String(activationsResult.rows?.[0]?.sold_count || '0'), 10) || 0;
    const soldAmount = parseFloat(String(activationsResult.rows?.[0]?.sold_amount || '0')) || 0;
    const redeemedCount = parseInt(String(redemptionsResult.rows?.[0]?.redeemed_count || '0'), 10) || 0;
    const redeemedAmount = parseFloat(String(redemptionsResult.rows?.[0]?.redeemed_amount || '0')) || 0;
    const averageValue = soldCount > 0 ? soldAmount / soldCount : 0;
    const outstandingBalance = parseFloat(String(outstandingResult.rows?.[0]?.outstanding_balance || '0')) || 0;
    const webResAdvDeposits = parseFloat(String(webResAdvResult.rows?.[0]?.web_res_adv_deposits || '0')) || 0;

    return {
      soldCount,
      soldAmount,
      redeemedCount,
      redeemedAmount,
      averageValue,
      outstandingBalance,
      webResAdvDeposits
    };
  }
  
  /**
   * Get gift card sales total for a date range
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @returns Total gift card sales amount
   */
  async getGiftCardSales(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<number> {
    const breakdown = await this.getGiftCardBreakdown(dateRange, startDate, endDate);
    return breakdown.giftCardSales;
  }

  /**
   * Return gift card activations split into three buckets for the business day:
   *  - bowlingWebResDeposits: activations linked to orders with a "Deposit" line item
   *    where the order source is NOT laser-tag related
   *  - laserTagWebResDeposits: activations linked to orders with a "Deposit" line item
   *    where the order source IS laser-tag related
   *  - giftCardSales: activations linked to orders WITHOUT a "Deposit" line item,
   *    or activations with no linked order (genuine gift card purchases)
   *
   * Uses activation_amount from the gift_cards table (the authoritative activation
   * value from Square's ACTIVATE event), NOT tender amounts or order totals.
   */
  async getGiftCardBreakdown(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<{ bowlingWebResDeposits: number; laserTagWebResDeposits: number; giftCardSales: number }> {
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);

    const result = await db.execute<{
      bowling_deposits: string;
      laser_tag_deposits: string;
      gc_sales: string;
    }>(sql`
      SELECT
        COALESCE(SUM(CASE
          WHEN has_deposit_item AND NOT is_laser_tag THEN activation_amount
          ELSE 0
        END), 0) AS bowling_deposits,
        COALESCE(SUM(CASE
          WHEN has_deposit_item AND is_laser_tag THEN activation_amount
          ELSE 0
        END), 0) AS laser_tag_deposits,
        COALESCE(SUM(CASE
          WHEN NOT has_deposit_item THEN activation_amount
          ELSE 0
        END), 0) AS gc_sales
      FROM (
        SELECT
          gc.activation_amount,
          COALESCE(EXISTS (
            SELECT 1 FROM order_line_items oli
            WHERE oli.order_id = o.id AND oli.name = 'Deposit'
          ), false) AS has_deposit_item,
          COALESCE(o.source IN ('Web Reservation-Attraction', 'Multi Attractions Reservation'), false) AS is_laser_tag
        FROM gift_cards gc
        LEFT JOIN orders o ON o.square_id = gc.activation_square_order_id
        WHERE gc.purchase_date >= ${start}
          AND gc.purchase_date < ${end}
          AND gc.activation_amount > 0
      ) classified
    `);

    const row = result.rows?.[0] ?? { bowling_deposits: '0', laser_tag_deposits: '0', gc_sales: '0' };

    return {
      bowlingWebResDeposits: parseFloat(String(row.bowling_deposits || '0')) || 0,
      laserTagWebResDeposits: parseFloat(String(row.laser_tag_deposits || '0')) || 0,
      giftCardSales: parseFloat(String(row.gc_sales || '0')) || 0,
    };
  }

  /**
   * PRIMARY backfill — Phase 0: scans ALL Square ACTIVATE events and writes
   * activation_square_order_id for any gift card where Square returned an orderId.
   *
   * Uses a dedicated sync state key ('gift_card_order_id_history') so it:
   *   - Runs independently of the historical gift card backfill completion state
   *   - Is resumable: saves the Square cursor after every page so a restart
   *     continues where it left off
   *   - After the first full scan (isComplete=true), subsequent calls only scan
   *     events newer than lastSyncedAt (incremental)
   *
   * ACTIVATE-event-derived orderId is considered authoritative.
   * Only updates rows where activation_square_order_id IS NULL (never overwrites).
   *
   * @returns { scanned, linked } — events inspected and order IDs written
   */
  async backfillActivationOrderIdsFromActivateHistory(): Promise<{ scanned: number; linked: number }> {
    const STATE_KEY = 'gift_card_order_id_history';

    // Load existing sync state for this backfill (separate from historical backfill state)
    const [existing] = await db.select().from(syncState)
      .where(eq(syncState.syncType, STATE_KEY))
      .limit(1);

    let stateRow = existing ?? null;
    let scanned = 0;
    let linked = 0;

    // Incremental mode: full scan done previously — only process new events
    if (stateRow?.isComplete && stateRow.lastSyncedAt) {
      const since = stateRow.lastSyncedAt;
      logger.info('giftCard.orderIdBackfill.incremental_start', { since: since.toISOString() });
      let cursor: string | undefined;
      let pageNum = 0;
      while (true) {
        const { activities, nextCursor } = await fetchGiftCardActivitiesPage(cursor, 'DESC');
        pageNum++;
        let reachedCutoff = false;
        for (const { giftCardId, squareOrderId, createdAt } of activities) {
          if (createdAt <= since) { reachedCutoff = true; break; }
          scanned++;
          if (!squareOrderId) continue;
          const rows = await db.update(giftCards)
            .set({ activationSquareOrderId: squareOrderId, updatedAt: new Date() })
            .where(and(eq(giftCards.squareId, giftCardId), isNull(giftCards.activationSquareOrderId)))
            .returning({ id: giftCards.id });
          if (rows.length > 0) linked++;
        }
        if (reachedCutoff || !nextCursor || activities.length === 0) break;
        cursor = nextCursor;
      }
      await db.update(syncState)
        .set({ lastSyncedAt: new Date(), processedCount: (stateRow.processedCount ?? 0) + scanned })
        .where(eq(syncState.id, stateRow.id));
      logger.info('giftCard.orderIdBackfill.incremental_done', { scanned, linked });
      return { scanned, linked };
    }

    // Full scan (first run or resumed after restart)
    const savedCursor = stateRow?.cursor || undefined;
    const isResume = !!savedCursor;
    logger.info('giftCard.orderIdBackfill.full_start', { isResume });

    if (!stateRow) {
      const [created] = await db.insert(syncState).values({
        syncType: STATE_KEY,
        lastSyncedAt: new Date(),
        status: 'running',
        processedCount: 0,
        cursor: '',
      }).returning();
      stateRow = created;
    } else {
      await db.update(syncState)
        .set({ status: 'running' })
        .where(eq(syncState.id, stateRow.id));
    }

    let cursor: string | undefined = savedCursor;
    let pageNum = 0;
    while (true) {
      const { activities, nextCursor } = await fetchGiftCardActivitiesPage(cursor, 'DESC');
      pageNum++;
      for (const { giftCardId, squareOrderId } of activities) {
        scanned++;
        if (!squareOrderId) continue;
        const rows = await db.update(giftCards)
          .set({ activationSquareOrderId: squareOrderId, updatedAt: new Date() })
          .where(and(eq(giftCards.squareId, giftCardId), isNull(giftCards.activationSquareOrderId)))
          .returning({ id: giftCards.id });
        if (rows.length > 0) linked++;
      }
      cursor = nextCursor;
      // Persist cursor so a restart can resume
      await db.update(syncState)
        .set({ cursor: cursor ?? '', processedCount: scanned, lastSyncedAt: new Date() })
        .where(eq(syncState.id, stateRow.id));
      if (pageNum % 20 === 0) {
        logger.info('giftCard.orderIdBackfill.page', { pageNum, scanned, linked });
      }
      if (!cursor || activities.length === 0) break;
    }

    await db.update(syncState)
      .set({ isComplete: true, status: 'completed', processedCount: scanned, lastSyncedAt: new Date() })
      .where(eq(syncState.id, stateRow.id));
    logger.info('giftCard.orderIdBackfill.full_done', { scanned, linked });
    return { scanned, linked };
  }

  /**
   * FALLBACK backfill — Phase 2: write activation_square_order_id for gift cards
   * where Square's ACTIVATE events did NOT return an orderId.
   *
   * Matching strategy: activation_amount = order.total_money AND
   *   |gc.purchase_date - order.created_at| < 5 minutes AND
   *   order has a "Deposit" line item (for deposit orders) or gift card line items
   *
   * Guards to prevent mislinking:
   *   (a) Never link to an order already claimed by another gift card
   *   (b) Prefer orders where a line item amount matches the activation amount
   *   (c) When multiple candidates exist, pick best amount match, then closest in time
   *
   * @param orderDateRange  Optional date window to scope the order search.
   */
  async backfillActivationSquareOrderIds(
    orderDateRange?: { start: Date; end: Date }
  ): Promise<{ updated: number }> {
    const dateFilter = orderDateRange
      ? sql`AND o.created_at >= ${orderDateRange.start.toISOString()} AND o.created_at < ${orderDateRange.end.toISOString()}`
      : sql``;

    const result = await db.execute(sql`
      WITH candidates AS (
        SELECT
          gc2.id AS gc_id,
          o.square_id,
          ABS(EXTRACT(EPOCH FROM (gc2.purchase_date - o.created_at))) AS time_diff
        FROM gift_cards gc2
        JOIN orders o
          ON  o.total_money = gc2.activation_amount
          AND ABS(EXTRACT(EPOCH FROM (gc2.purchase_date - o.created_at))) < 300
          ${dateFilter}
        WHERE gc2.activation_square_order_id IS NULL
          AND gc2.activation_amount > 0
          AND NOT EXISTS (
            SELECT 1 FROM gift_cards other
            WHERE other.activation_square_order_id = o.square_id
              AND other.id != gc2.id
          )
          AND EXISTS (
            SELECT 1 FROM order_line_items oli
            WHERE oli.order_id = o.id
              AND ABS(oli.total_money - gc2.activation_amount) < 0.01
              AND (oli.name = 'Deposit'
                   OR oli.name ILIKE '%gift%card%'
                   OR oli.name ILIKE '%gift card%')
          )
      ),
      ranked_per_gc AS (
        SELECT gc_id, square_id, time_diff,
               ROW_NUMBER() OVER (PARTITION BY gc_id ORDER BY time_diff) AS rn_gc
        FROM candidates
      ),
      best_per_gc AS (
        SELECT gc_id, square_id, time_diff
        FROM ranked_per_gc WHERE rn_gc = 1
      ),
      unique_orders AS (
        SELECT gc_id, square_id
        FROM (
          SELECT gc_id, square_id,
                 ROW_NUMBER() OVER (PARTITION BY square_id ORDER BY time_diff) AS rn_order
          FROM best_per_gc
        ) t WHERE rn_order = 1
      )
      UPDATE gift_cards gc
      SET activation_square_order_id = unique_orders.square_id,
          updated_at = NOW()
      FROM unique_orders
      WHERE gc.id = unique_orders.gc_id
      RETURNING gc.id
    `);

    const updated = result.rows.length;
    logger.info('giftCard.backfill.activation_order_id', { updated });
    return { updated };
  }

  /**
   * Repair mislinkings: detect gift cards where activation_square_order_id points to
   * an order whose line item amounts don't match the card's activation_amount.
   *
   * Example: card 3992 ($60) linked to a $25 Gift Card order instead of the $60
   * Web Reservation deposit order — both created within seconds of each other.
   *
   * This clears the bad link so the next heuristic backfill run can re-match correctly.
   * Should run BEFORE the heuristic backfill.
   */
  async repairMislinkedActivationOrders(): Promise<{ cleared: number; relinked: number }> {
    const mislinked = await db.execute<{
      gc_id: string;
      gc_activation_amount: string;
      bad_order_square_id: string;
    }>(sql`
      SELECT gc.id AS gc_id,
             gc.activation_amount AS gc_activation_amount,
             gc.activation_square_order_id AS bad_order_square_id
      FROM gift_cards gc
      JOIN orders o ON o.square_id = gc.activation_square_order_id
      WHERE gc.activation_square_order_id IS NOT NULL
        AND gc.activation_amount > 0
        AND (
          (ABS(o.total_money - gc.activation_amount) > 0.01
           AND NOT EXISTS (
             SELECT 1 FROM order_line_items oli
             WHERE oli.order_id = o.id
               AND ABS(oli.total_money - gc.activation_amount) < 0.01
           ))
          OR
          (EXISTS (
             SELECT 1 FROM order_line_items oli
             WHERE oli.order_id = o.id AND oli.name = 'Deposit'
           )
           AND NOT EXISTS (
             SELECT 1 FROM order_line_items oli
             WHERE oli.order_id = o.id
               AND oli.name = 'Deposit'
               AND ABS(oli.total_money - gc.activation_amount) < 0.01
           ))
        )
    `);

    if (mislinked.rows.length === 0) {
      logger.info('giftCard.repair.none_found');
      return { cleared: 0, relinked: 0 };
    }

    logger.info('giftCard.repair.found', { count: mislinked.rows.length });

    let cleared = 0;
    let relinked = 0;

    for (const row of mislinked.rows) {
      const gcId = parseInt(String(row.gc_id));
      const activationAmount = parseFloat(String(row.gc_activation_amount));

      const betterMatch = await db.execute<{ better_square_id: string }>(sql`
        SELECT o.square_id AS better_square_id
        FROM gift_cards gc
        JOIN orders o
          ON o.total_money = gc.activation_amount
          AND ABS(EXTRACT(EPOCH FROM (gc.purchase_date - o.created_at))) < 300
        WHERE gc.id = ${gcId}
          AND NOT EXISTS (
            SELECT 1 FROM gift_cards other
            WHERE other.activation_square_order_id = o.square_id
              AND other.id != gc.id
          )
          AND EXISTS (
            SELECT 1 FROM order_line_items oli
            WHERE oli.order_id = o.id
              AND ABS(oli.total_money - gc.activation_amount) < 0.01
              AND (oli.name = 'Deposit'
                   OR oli.name ILIKE '%gift%card%'
                   OR oli.name ILIKE '%gift card%')
          )
        ORDER BY ABS(EXTRACT(EPOCH FROM (gc.purchase_date - o.created_at)))
        LIMIT 1
      `);

      if (betterMatch.rows.length > 0) {
        const betterSquareId = String(betterMatch.rows[0].better_square_id);
        await db.execute(sql`
          UPDATE gift_cards
          SET activation_square_order_id = ${betterSquareId}, updated_at = NOW()
          WHERE id = ${gcId}
        `);
        relinked++;
        logger.info('giftCard.repair.relinked', { giftCardId: gcId });
      } else {
        await db.execute(sql`
          UPDATE gift_cards
          SET activation_square_order_id = NULL, updated_at = NOW()
          WHERE id = ${gcId}
        `);
        cleared++;
        logger.info('giftCard.repair.cleared', { giftCardId: gcId });
      }
    }

    logger.info('giftCard.repair.done', { relinked, cleared });
    return { cleared, relinked };
  }

  /**
   * Sync orders from Square that are referenced by gift cards (via activation_square_order_id)
   * but are not yet present in the local orders table.
   *
   * This happens when the historical gift card backfill discovers orderId values from Square's
   * ACTIVATE activity events, but those orders were created outside the normal order sync window.
   *
   * After this runs, getGiftCardBreakdown()'s LEFT JOIN resolves those order IDs and correctly
   * classifies each card into the Bowling/Laser Tag/Gift Card Sales bucket.
   *
   * @returns count of orders inserted
   */
  async syncMissingActivationOrders(): Promise<{ inserted: number }> {
    // Find activation_square_order_ids that have no matching row in the orders table
    const missing = await db.execute(sql`
      SELECT DISTINCT gc.activation_square_order_id AS order_square_id
      FROM gift_cards gc
      WHERE gc.activation_square_order_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM orders o WHERE o.square_id = gc.activation_square_order_id
        )
    `);

    const missingIds = missing.rows.map(r => String(r.order_square_id));
    if (missingIds.length === 0) {
      logger.info('giftCard.backfill.no_missing_orders');
      return { inserted: 0 };
    }

    logger.info('giftCard.backfill.fetch_missing', { count: missingIds.length });

    const fetched = await fetchOrdersByIds(missingIds);
    if (fetched.length === 0) {
      logger.info('giftCard.backfill.square_returned_zero');
      return { inserted: 0 };
    }

    const insertResults = await Promise.all(fetched.map(async (order) => {
      try {
        await db.insert(orders).values(order).onConflictDoNothing();
        return 1;
      } catch (err) {
        logger.error('giftCard.backfill.order_insert_failed', { ...errorContext(err), squareId: order.squareId });
        return 0;
      }
    }));
    const inserted = insertResults.reduce<number>((sum, n) => sum + n, 0);

    logger.info('giftCard.backfill.missing_orders_inserted', { inserted, fetched: fetched.length });
    return { inserted };
  }
  
  /**
   * Process a gift card redemption from a Square payment
   * 
   * This method handles the linking between a Square payment made using a gift card
   * and the corresponding gift card record in our database. It:
   * 1. Finds the gift card by its GAN (Gift Account Number)
   * 2. Creates a redemption record
   * 3. Updates the gift card balance
   * 
   * @param sourceId The Square gift card ID (GAN)
   * @param amount The redemption amount
   * @param paymentId The database ID of the payment/transaction
   * @param squareData Additional Square payment data
   * @returns The processed gift card or null if gift card not found
   */
  async processRedemptionFromSquare(
    sourceId: string,
    amount: number,
    paymentId: number,
    squareData: any = {}
  ): Promise<GiftCard | null> {
    try {
      // Step 1: Find the gift card by GAN (Gift Account Number)
      // First try exact match on squareId
      let giftCard: GiftCard | undefined;
      
      try {
        // Try to find by square ID first
        giftCard = await db.select().from(giftCards)
          .where(eq(giftCards.squareId, sourceId))
          .limit(1)
          .then(results => results[0]);
      } catch (error) {
        logger.warn('giftCard.lookup.squareId_failed', errorContext(error));
      }
      
      // If not found by squareId, try GAN
      if (!giftCard) {
        try {
          giftCard = await db.select().from(giftCards)
            .where(eq(giftCards.gan, sourceId))
            .limit(1)
            .then(results => results[0]);
        } catch (error) {
          logger.warn('giftCard.lookup.gan_failed', errorContext(error));
        }
      }
      
      // If still not found, try searching in the squareData JSON
      if (!giftCard) {
        try {
          // This is a more complex query to search in JSON data
          const cards = await db.execute(sql`
            SELECT * FROM gift_cards
            WHERE square_data::text LIKE ${`%${sourceId}%`}
            LIMIT 1
          `);
          
          if (cards.rows && cards.rows.length > 0) {
            giftCard = cards.rows[0] as GiftCard;
          }
        } catch (error) {
          logger.warn('giftCard.lookup.squareData_search_failed', errorContext(error));
        }
      }
      
      // If gift card is still not found, log and return null
      if (!giftCard) {
        logger.info('giftCard.lookup.not_found');
        return null;
      }
      
      // Step 2: Process the redemption
      return await this.processRedemption(
        giftCard.id,
        amount,
        paymentId
      );
    } catch (error) {
      logger.error('giftCard.redemption.process_failed', errorContext(error));
      return null;
    }
  }

  async refreshGiftCardBalancesByIds(squareIds: string[]): Promise<{ updated: number; failed: number; total: number }> {
    if (squareIds.length === 0) return { updated: 0, failed: 0, total: 0 };

    const { fetchGiftCardById } = await import('../squareClient');
    let updated = 0;
    let failed = 0;

    for (const squareId of squareIds) {
      try {
        const card = await fetchGiftCardById(squareId);
        if (!card) {
          const zeroResult = await db.update(giftCards)
            .set({ amount: 0, isActive: false, updatedAt: new Date() })
            .where(eq(giftCards.squareId, squareId));
          if (zeroResult.rowCount && zeroResult.rowCount > 0) {
            updated++;
            logger.info('giftCard.balanceRefresh.zeroed_missing', { squareId });
          }
          continue;
        }

        let balance = 0;
        if (card.balanceMoney?.amount) {
          balance = Number(card.balanceMoney.amount) / 100;
        } else if (card.balance_money?.amount) {
          balance = Number(card.balance_money.amount) / 100;
        }

        const state = card.state || card.status || 'ACTIVE';
        const isActive = state === 'ACTIVE';

        const result = await db.update(giftCards)
          .set({ amount: balance, isActive, updatedAt: new Date() })
          .where(eq(giftCards.squareId, squareId));

        if (result.rowCount && result.rowCount > 0) updated++;
      } catch (err) {
        failed++;
        logger.error('giftCard.balanceRefresh.failed', { ...errorContext(err), squareId });
      }
    }

    logger.info('giftCard.balanceRefresh.batch_done', { updated, failed, total: squareIds.length });
    return { updated, failed, total: squareIds.length };
  }

  async refreshAllGiftCardBalances(): Promise<{ updated: number; total: number }> {
    const { fetchGiftCards } = await import('../squareClient');

    logger.info('giftCard.balanceRefresh.fetch_all_start');
    const { cards: allSquareCards, complete: fetchComplete } = await fetchGiftCards();
    logger.info('giftCard.balanceRefresh.fetched_all', { count: allSquareCards.length, fetchComplete });

    const values: { squareId: string; balance: number; isActive: boolean }[] = [];
    for (const card of allSquareCards) {
      const squareId = card.id || card.squareId;
      if (!squareId) continue;

      let balance = 0;
      if (card.balanceMoney?.amount) {
        balance = Number(card.balanceMoney.amount) / 100;
      } else if (card.balance_money?.amount) {
        balance = Number(card.balance_money.amount) / 100;
      }

      const state = card.state || card.status || 'ACTIVE';
      values.push({ squareId, balance, isActive: state === 'ACTIVE' });
    }

    let updated = 0;
    const BATCH = 500;
    for (let i = 0; i < values.length; i += BATCH) {
      const batch = values.slice(i, i + BATCH);
      const valuesChunks = batch.map(v => sql`(${v.squareId}::text, ${v.balance}::real, ${v.isActive}::boolean)`);
      const valuesSql = sql.join(valuesChunks, sql`, `);

      const result = await db.execute(sql`
        UPDATE gift_cards gc SET
          amount = v.balance,
          is_active = v.is_active,
          updated_at = NOW()
        FROM (VALUES ${valuesSql}) AS v(square_id, balance, is_active)
        WHERE gc.square_id = v.square_id
      `);
      updated += result.rowCount ?? 0;
      logger.info('giftCard.balanceRefresh.progress', { processed: Math.min(i + BATCH, values.length), total: values.length });
    }

    logger.info('giftCard.balanceRefresh.done', { updated, total: allSquareCards.length });

    if (fetchComplete) {
      const squareIdSet = new Set(values.map(v => v.squareId));
      const staleCards = await db.select({ squareId: giftCards.squareId })
        .from(giftCards)
        .where(gt(giftCards.amount, 0));

      const deletedIds = staleCards
        .filter(c => !squareIdSet.has(c.squareId))
        .map(c => c.squareId);

      if (deletedIds.length > 0) {
        const BATCH_SIZE = 500;
        const batches: string[][] = [];
        for (let i = 0; i < deletedIds.length; i += BATCH_SIZE) {
          batches.push(deletedIds.slice(i, i + BATCH_SIZE));
        }
        const batchResults = await Promise.all(batches.map(batch =>
          db.update(giftCards)
            .set({ amount: 0, isActive: false, updatedAt: new Date() })
            .where(inArray(giftCards.squareId, batch))
        ));
        const zeroed = batchResults.reduce((sum, r) => sum + (r.rowCount ?? 0), 0);
        logger.info('giftCard.balanceRefresh.zeroed_deleted', { count: zeroed });
      }
    } else {
      logger.warn('giftCard.balanceRefresh.skip_cleanup_incomplete_fetch');
    }

    return { updated, total: allSquareCards.length };
  }
}

// Create and export a singleton instance
export const giftCardService = new GiftCardService();
