/**
 * Sync Service
 * 
 * Handles synchronization of data with the Square API.
 * Provides a clean API for other services to trigger synchronization.
 * 
 * NOTE: This version includes important fixes to prevent infinite loops and handle timeouts.
 */

import { db } from '../db';
import { eq, and, between, desc, asc, sql, isNull, gt, inArray } from 'drizzle-orm';
import { 
  syncState,
  giftCards,
  orders,
  orderLineItems,
  transactions,
  refunds,
  type SyncState,
  type InsertSyncState
} from '../../shared/schema';
import * as squareClient from '../squareClient';
import { orderService } from './orderService';
import { paymentService } from './paymentService';
import { giftCardService } from './giftCardService';
import { syncCatalog, preloadCatalogCache } from './catalogService';
import {
  tryAcquireSyncLock,
  recordAuditStart,
  recordAuditFinish,
  withDailyBudget,
  logIfSquare429,
  type SyncLock,
} from './syncLocks';

/** Audit/actor metadata accepted by the user-triggered backfill paths. */
export interface SyncTriggerContext {
  actorUserId?: number | null;
  actorIp?: string | null;
}

/** Approximate Square page-fetch cost charged per orders/payments chunk. */
const BACKFILL_BUDGET_PER_CHUNK = 10;

// SyncError now lives in `server/errors.ts` (see Task #58). Re-exported.
export { SyncError } from '../errors';
import { SyncError } from '../errors';
import { logger, errorContext } from '../logger';

export class SyncService {
  /** In-memory lock to prevent concurrent backfill runs within a single process */
  private _ordersPaymentsBackfillRunning = false;
  private _ordersSyncRunning = false;
  private _paymentsSyncRunning = false;

  /**
   * Get the current sync state for a specific sync type
   * 
   * @param syncType The type of sync to get state for (payments, orders, giftCards)
   * @returns The sync state or undefined if not found
   */
  async getSyncState(syncType: string): Promise<SyncState | undefined> {
    const result = await db.select().from(syncState)
      .where(eq(syncState.syncType, syncType))
      .limit(1);
    
    return result.length ? result[0] : undefined;
  }
  
  /**
   * Create a new sync state record
   * 
   * @param stateData The sync state data to insert
   * @returns The created sync state
   */
  async createSyncState(stateData: InsertSyncState): Promise<SyncState> {
    const result = await db.insert(syncState).values(stateData).returning();
    
    if (!result.length) {
      throw new SyncError('Failed to create sync state', 'DB_ERROR');
    }
    
    return result[0];
  }
  
  /**
   * Update an existing sync state record
   * 
   * @param id The sync state ID
   * @param updates The partial sync state data to update
   * @returns The updated sync state
   */
  async updateSyncState(id: number, updates: Partial<InsertSyncState>): Promise<SyncState> {
    const result = await db.update(syncState)
      .set({
        ...updates
        // Note: There's no updatedAt field in the syncState schema
      })
      .where(eq(syncState.id, id))
      .returning();
    
    if (!result.length) {
      throw new SyncError(`Failed to update sync state with ID ${id}`, 'DB_ERROR');
    }
    
    return result[0];
  }
  
  /**
   * Get the current sync progress for all sync types
   * 
   * @returns Object with sync progress for each type
   */
  async getSyncProgress(): Promise<Record<string, number>> {
    const states = await db.select().from(syncState);
    
    const progress: Record<string, number> = {};
    
    for (const state of states) {
      // Using totalCount and processedCount from the schema
      const totalCount = state.totalCount || 0;
      const processedCount = state.processedCount || 0;
      
      if (totalCount > 0) {
        progress[state.syncType] = Math.min(
          100,
          Math.round((processedCount / totalCount) * 100)
        );
      } else {
        progress[state.syncType] = 0;
      }
    }
    
    return progress;
  }
  
  /**
   * Synchronize gift card redemptions from historical transactions
   * This method scans past transactions to find gift card redemptions and records them
   * 
   * @param startDate Optional start date for the sync
   * @param endDate Optional end date for the sync
   * @returns Object with sync results
   */
  async syncGiftCardRedemptions(startDate?: Date, endDate?: Date): Promise<{
    success: boolean;
    processed: number;
    matched: number;
    created: number;
    errors: any[];
    redeemedGiftCardIds: string[];
  }> {
    // Cross-instance guard: only one instance may run the gift card redemption
    // sync at a time. Released in the finally block on every exit path.
    const lock = await tryAcquireSyncLock('gift_card_redemptions');
    if (!lock) {
      logger.info('sync.giftCardRedemption.lock_not_acquired');
      return { success: true, processed: 0, matched: 0, created: 0, errors: [], redeemedGiftCardIds: [] };
    }

    logger.info('sync.giftCardRedemption.start', { startDate: startDate?.toISOString() ?? null, endDate: endDate?.toISOString() ?? null });
    
    try {
      // Set default dates if not provided
      const effectiveStartDate = startDate || new Date('2025-01-01');
      const effectiveEndDate = endDate || new Date();
      
      // Step 1: Get all transactions that could be gift card redemptions
      const query = sql`
        SELECT t.* 
        FROM transactions t
        WHERE t.status = 'completed'
          AND t.timestamp BETWEEN ${effectiveStartDate} AND ${effectiveEndDate}
          AND (t.square_data->>'isGiftCardRedemption')::boolean IS TRUE
          AND NOT EXISTS (
            SELECT 1 FROM gift_card_redemptions gcr
            WHERE gcr.transaction_id = t.id
          )
      `;
      
      const transactions = await db.execute(query);
      
      logger.info('sync.giftCardRedemption.found', { count: transactions.rowCount });
      
      // Initialize result counters
      const result = {
        success: true,
        processed: 0,
        matched: 0,
        created: 0,
        errors: [] as any[],
        redeemedGiftCardIds: [] as string[]
      };
      
      // Step 2: Process each transaction
      if (transactions.rows && transactions.rows.length > 0) {
        for (const transaction of transactions.rows) {
          try {
            result.processed++;
            
            // Extract gift card ID (GAN) from Square data
            const squareData = transaction.square_data || {};
            // Safely access sourceId with type checking
            const squareDataObj = typeof squareData === 'object' && squareData !== null ? squareData : {};
            // TypeScript: Cast to any to avoid property access errors on unknown type
            const sourceId = (squareDataObj as any).sourceId || '';
            
            if (!sourceId) {
              result.errors.push({
                transactionId: transaction.id,
                error: 'No sourceId (GAN) found in transaction data'
              });
              continue;
            }
            
            // Process the redemption
            // Ensure transaction.id is a number
            const transactionId = typeof transaction.id === 'number' 
              ? transaction.id 
              : (transaction.id ? parseInt(String(transaction.id), 10) : 0);
              
            // Explicitly type the transaction.amount from unknown to number
            // Using type assertion after validation to ensure it's safe
            let amount = 0;
            if (transaction && 'amount' in transaction) {
              if (typeof transaction.amount === 'number') {
                amount = transaction.amount;
              } else if (transaction.amount !== undefined && transaction.amount !== null) {
                // Convert string/unknown to number if possible
                const parsedAmount = parseFloat(String(transaction.amount));
                if (!isNaN(parsedAmount)) {
                  amount = parsedAmount;
                }
              }
            }
              
            const redemptionResult = await giftCardService.processRedemptionFromSquare(
              sourceId,
              amount,
              transactionId,
              squareData
            );
            
            if (redemptionResult) {
              result.matched++;
              result.created++;
              if (redemptionResult.squareId) {
                result.redeemedGiftCardIds.push(redemptionResult.squareId);
              }
              logger.info('sync.giftCardRedemption.created', { transactionId: transaction.id, giftCardId: redemptionResult.id });
            } else {
              result.errors.push({
                transactionId: transaction.id,
                sourceId,
                error: 'Could not find matching gift card'
              });
            }
          } catch (error) {
            logger.error('sync.giftCardRedemption.tx_error', { ...errorContext(error), transactionId: transaction.id });
            result.errors.push({
              transactionId: transaction.id,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
      
      // Step 3: Update sync state
      try {
        const syncState = await this.getSyncState('gift_card_redemptions');
        
        if (syncState) {
          await this.updateSyncState(syncState.id, {
            lastSyncedAt: new Date(),
            processedCount: result.created,
            status: 'completed',
            errorMessage: result.errors.length > 0 ? JSON.stringify(result.errors) : undefined
          });
        } else {
          await this.createSyncState({
            syncType: 'gift_card_redemptions',
            lastSyncedAt: new Date(),
            processedCount: result.created,
            status: 'completed',
            errorMessage: result.errors.length > 0 ? JSON.stringify(result.errors) : undefined
          });
        }
      } catch (syncError) {
        logger.error('sync.state.update_failed', errorContext(syncError));
      }
      
      return result;
    } catch (error) {
      logger.error('sync.giftCardRedemption.fatal', errorContext(error));
      return {
        success: false,
        processed: 0,
        matched: 0,
        created: 0,
        redeemedGiftCardIds: [],
        errors: [{
          error: error instanceof Error ? error.message : String(error)
        }]
      };
    } finally {
      await lock.release();
    }
  }
  
  /**
   * Synchronize orders from Square API
   * 
   * @param startDate Optional start date for sync
   * @param endDate Optional end date for sync
   * @returns Object with sync results
   */
  async syncOrders(startDate?: Date, endDate?: Date): Promise<{
    processed: number;
    created: number;
    updated: number;
    failed: number;
    alreadyRunning?: boolean;
  }> {
    if (this._ordersSyncRunning) {
      logger.info('sync.orders.already_running');
      return { processed: 0, created: 0, updated: 0, failed: 0, alreadyRunning: true };
    }

    // Cross-instance guard: only one instance may run the orders sync at a
    // time. The in-process boolean above is the fast path; this advisory lock
    // is the authoritative guard on multi-instance deployments.
    const lock = await tryAcquireSyncLock('orders');
    if (!lock) {
      logger.info('sync.orders.lock_not_acquired');
      return { processed: 0, created: 0, updated: 0, failed: 0, alreadyRunning: true };
    }

    this._ordersSyncRunning = true;
    let processed = 0;
    let created = 0;
    let updated = 0;
    let failed = 0;
    
    try {
      let state = await this.getSyncState('orders');
      
      if (state && state.status === 'in_progress') {
        const lastSyncTime = state.lastSyncedAt ? new Date(state.lastSyncedAt) : new Date(0);
        const timeDifference = Date.now() - lastSyncTime.getTime();
        const timeThreshold = 5 * 60 * 1000;
        
        if (timeDifference < timeThreshold) {
          logger.info('sync.orders.db_in_progress', { lastSyncedAt: lastSyncTime.toISOString() });
          return { 
            processed: state.processedCount || 0, 
            created, 
            updated, 
            failed, 
            alreadyRunning: true 
          };
        } else {
          logger.warn('sync.orders.stuck_restart', { stuckMinutes: Math.round(timeDifference/60000) });
        }
      }
      
      if (!state) {
        state = await this.createSyncState({
          syncType: 'orders',
          lastSyncedAt: new Date(),
          isComplete: false,
          processedCount: 0,
          totalCount: 0,
          status: 'idle',
          errorMessage: null
        });
      }
      
      await this.updateSyncState(state.id, {
        isComplete: false,
        status: 'in_progress',
        lastSyncedAt: new Date(),
        processedCount: 0,
        totalCount: 0,
        errorMessage: null
      });
      
      try {
        logger.info('sync.orders.catalog_pre');
        const catalogResult = await syncCatalog();
        logger.info('sync.orders.catalog_done', { categories: catalogResult.categories, items: catalogResult.items });
        await preloadCatalogCache();
      } catch (catalogError) {
        logger.error('sync.orders.catalog_failed', errorContext(catalogError));
        try { await preloadCatalogCache(); } catch (_) {}
      }

      // Fetch orders from Square API with a timeout
      const fetchPromise = squareClient.fetchOrders(startDate, endDate);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Order fetch timed out after 2 minutes')), 120000);
      });
      
      const squareOrders = await Promise.race([fetchPromise, timeoutPromise]) as any[];
      
      if (!squareOrders || !Array.isArray(squareOrders)) {
        throw new SyncError(
          'Failed to fetch orders: Invalid response format',
          'INVALID_RESPONSE',
        );
      }
      
      // Set a reasonable limit to prevent processing too many orders at once
      const maxOrdersToProcess = 500; // Adjust as needed
      const ordersToProcess = squareOrders.slice(0, maxOrdersToProcess);
      
      // Update state with total items
      await this.updateSyncState(state.id, {
        totalCount: ordersToProcess.length,
        status: `Found ${ordersToProcess.length} orders to sync${ordersToProcess.length < squareOrders.length ? ' (limited to prevent timeout)' : ''}`
      });
      
      // Process each order
      for (const squareOrder of ordersToProcess) {
        try {
          // Convert Square order to our data model
          const orderData = squareClient.convertSquareOrderToOrder(squareOrder);
          
          // Check if order exists
          let existingOrder: any = null;
          try {
            existingOrder = await orderService.getOrderBySquareId(orderData.squareId);
          } catch (error) {
            // Order doesn't exist, which is fine
          }
          
          if (existingOrder && typeof existingOrder === 'object' && existingOrder !== null) {
            await orderService.updateOrderBySquareId(orderData.squareId, {
              status: orderData.status,
              totalMoney: orderData.totalMoney,
              totalTax: orderData.totalTax,
              totalDiscount: orderData.totalDiscount,
              closedAt: orderData.closedAt,
              source: orderData.source,
              squareData: orderData.squareData,
            });

            const existingOrderId = Number(existingOrder.id);
            if (squareOrder.lineItems && squareOrder.lineItems.length > 0 && existingOrderId > 0) {
              const existingLineItems = await orderService.getOrderItems(existingOrderId);
              const existingUids = new Set(
                existingLineItems
                  .map((li: any) => li.squareData?.uid)
                  .filter(Boolean)
              );

              let backfilledCount = 0;
              for (const squareLineItem of squareOrder.lineItems) {
                if (squareLineItem.uid && existingUids.has(squareLineItem.uid)) {
                  continue;
                }
                try {
                  const lineItemData = squareClient.convertSquareLineItemToOrderLineItem(
                    squareLineItem,
                    existingOrderId
                  );
                  const lineItem = await orderService.createOrderItem(lineItemData);
                  backfilledCount++;

                  if (squareLineItem.modifiers && squareLineItem.modifiers.length > 0) {
                    for (const squareModifier of squareLineItem.modifiers) {
                      try {
                        const modifierData = squareClient.convertSquareModifierToOrderModifier(
                          squareModifier,
                          lineItem.id
                        );
                        await orderService.createOrderModifier(modifierData);
                      } catch (modifierError) {
                        logger.error('sync.orders.modifier_error', { ...errorContext(modifierError), squareId: orderData.squareId });
                      }
                    }
                  }
                } catch (lineItemError) {
                  logger.error('sync.orders.lineItem_error', { ...errorContext(lineItemError), squareId: orderData.squareId });
                }
              }
              if (backfilledCount > 0) {
                logger.info('sync.orders.lineItem_backfilled', { count: backfilledCount, squareId: orderData.squareId });
              }
            }

            if (squareOrder.discounts && squareOrder.discounts.length > 0 && existingOrderId > 0) {
              const existingDiscounts = await orderService.getOrderDiscounts(existingOrderId);
              const existingDiscountUids = new Set(
                existingDiscounts
                  .map((d: any) => d.squareData?.uid)
                  .filter(Boolean)
              );

              for (const squareDiscount of squareOrder.discounts) {
                if (squareDiscount.uid && existingDiscountUids.has(squareDiscount.uid)) {
                  continue;
                }
                try {
                  const discountData = squareClient.convertSquareDiscountToOrderDiscount(
                    squareDiscount,
                    existingOrderId
                  );
                  await orderService.createOrderDiscount(discountData);
                } catch (discountError) {
                  logger.error('sync.orders.discount_error', { ...errorContext(discountError), squareId: orderData.squareId });
                }
              }
            }

            updated++;
          } else {
            // Order doesn't exist, create it
            const createdOrder = await orderService.createOrder(orderData);
            
            // Extract and create line items
            if (squareOrder.lineItems) {
              for (const squareLineItem of squareOrder.lineItems) {
                // Safely extract order ID with fallback
                let orderId = 0;
                
                // Type safe way to access order ID
                if (existingOrder && typeof existingOrder === 'object' && existingOrder !== null && 'id' in existingOrder) {
                  // existingOrder is an Order type from getOrderBySquareId
                  orderId = Number(existingOrder.id);
                } else if (createdOrder && typeof createdOrder === 'object' && createdOrder !== null && 'id' in createdOrder) {
                  // createdOrder is from createOrder which returns an Order
                  orderId = Number(createdOrder.id);
                }
                
                if (orderId === 0) {
                  logger.warn('sync.orders.lineItem_no_order_id');
                  continue;
                }
                
                const lineItemData = squareClient.convertSquareLineItemToOrderLineItem(
                  squareLineItem,
                  orderId
                );
                
                const lineItem = await orderService.createOrderItem(lineItemData);
                
                // Extract and create modifiers if any
                if (squareLineItem.modifiers && squareLineItem.modifiers.length > 0) {
                  for (const squareModifier of squareLineItem.modifiers) {
                    const modifierData = squareClient.convertSquareModifierToOrderModifier(
                      squareModifier,
                      lineItem.id
                    );
                    
                    // Create modifier (would need a createOrderModifier method)
                  }
                }
              }
            }
            
            // Extract and create discounts if any
            if (squareOrder.discounts) {
              for (const squareDiscount of squareOrder.discounts) {
                // Safely extract order ID with fallback
                let orderId = 0;
                
                // Type safe way to access order ID
                if (existingOrder && typeof existingOrder === 'object' && existingOrder !== null && 'id' in existingOrder) {
                  // existingOrder is an Order type from getOrderBySquareId
                  orderId = Number(existingOrder.id);
                } else if (createdOrder && typeof createdOrder === 'object' && createdOrder !== null && 'id' in createdOrder) {
                  // createdOrder is from createOrder which returns an Order
                  orderId = Number(createdOrder.id);
                }
                
                if (orderId === 0) {
                  logger.warn('sync.orders.discount_no_order_id');
                  continue;
                }
                
                const discountData = squareClient.convertSquareDiscountToOrderDiscount(
                  squareDiscount,
                  orderId
                );
                
                // Create discount (would need a createOrderDiscount method)
              }
            }
            
            created++;
          }
          
          processed++;
          
          // Update sync state progress
          if (processed % 10 === 0 || processed === ordersToProcess.length) {
            await this.updateSyncState(state.id, {
              processedCount: processed,
              status: `Processed ${processed} of ${ordersToProcess.length} orders`
            });
          }
        } catch (error) {
          failed++;
          logger.error('sync.orders.process_failed', errorContext(error));
        }
      }
      
      // Update state to completed
      await this.updateSyncState(state.id, {
        isComplete: true,
        status: 'completed',
        lastSyncedAt: new Date(),
        processedCount: processed
      });
      
      return { processed, created, updated, failed };
    } catch (error) {
      // Update state to error
      const state = await this.getSyncState('orders');
      
      if (state) {
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        });
      }
      
      throw new SyncError(
        'Failed to sync orders',
        'SYNC_ERROR',
        error instanceof Error ? error.message : error
      );
    } finally {
      this._ordersSyncRunning = false;
      await lock.release();
    }
  }
  
  /**
   * Synchronize payments from Square API
   * 
   * @param startDate Optional start date for sync
   * @param endDate Optional end date for sync
   * @returns Object with sync results
   */
  async syncPayments(startDate?: Date, endDate?: Date): Promise<{
    processed: number;
    created: number;
    updated: number;
    failed: number;
    alreadyRunning?: boolean;
  }> {
    if (this._paymentsSyncRunning) {
      logger.info('sync.payments.already_running');
      return { processed: 0, created: 0, updated: 0, failed: 0, alreadyRunning: true };
    }

    // Cross-instance guard: only one instance may run the payments sync at a
    // time. The in-process boolean above is the fast path; this advisory lock
    // is the authoritative guard on multi-instance deployments.
    const lock = await tryAcquireSyncLock('payments');
    if (!lock) {
      logger.info('sync.payments.lock_not_acquired');
      return { processed: 0, created: 0, updated: 0, failed: 0, alreadyRunning: true };
    }

    this._paymentsSyncRunning = true;
    let processed = 0;
    let created = 0;
    let updated = 0;
    let failed = 0;
    
    try {
      let state = await this.getSyncState('payments');
      
      if (state && state.status === 'in_progress') {
        const lastSyncTime = state.lastSyncedAt ? new Date(state.lastSyncedAt) : new Date(0);
        const timeDifference = Date.now() - lastSyncTime.getTime();
        const timeThreshold = 5 * 60 * 1000;
        
        if (timeDifference < timeThreshold) {
          logger.info('sync.payments.db_in_progress', { lastSyncedAt: lastSyncTime.toISOString() });
          return { 
            processed: state.processedCount || 0, 
            created, 
            updated, 
            failed, 
            alreadyRunning: true 
          };
        } else {
          logger.warn('sync.payments.stuck_restart', { stuckMinutes: Math.round(timeDifference/60000) });
        }
      }
      
      if (!state) {
        state = await this.createSyncState({
          syncType: 'payments',
          lastSyncedAt: new Date(),
          isComplete: false,
          processedCount: 0,
          totalCount: 0,
          status: 'idle',
          errorMessage: null
        });
      }
      
      await this.updateSyncState(state.id, {
        isComplete: false,
        status: 'in_progress',
        lastSyncedAt: new Date(),
        processedCount: 0,
        totalCount: 0,
        errorMessage: null
      });
      
      try {
        logger.info('sync.payments.catalog_pre');
        const catalogResult = await syncCatalog();
        logger.info('sync.payments.catalog_done', { categories: catalogResult.categories, items: catalogResult.items });
        await preloadCatalogCache();
      } catch (catalogError) {
        logger.error('sync.payments.catalog_failed', errorContext(catalogError));
        try { await preloadCatalogCache(); } catch (_) {}
      }

      const squarePayments = await squareClient.fetchPayments(startDate, endDate);
      
      await this.updateSyncState(state.id, {
        totalCount: squarePayments.length,
        status: `Found ${squarePayments.length} payments to sync`
      });
      
      for (const squarePayment of squarePayments) {
        try {
          const paymentData = squareClient.convertSquarePaymentToTransaction(squarePayment);
          
          if (!paymentData.amount || paymentData.amount === 0) {
            processed++;
            continue;
          }
          
          if (squarePayment.orderId) {
            try {
              const lineItemRows = await db.execute<{ product_id: string | null }>(sql`
                SELECT oli.product_id
                FROM order_line_items oli
                INNER JOIN orders o ON oli.order_id = o.id
                WHERE o.square_id = ${squarePayment.orderId}
                AND oli.product_id IS NOT NULL
                LIMIT 5
              `);
              const { lookupCategorySync: lookupCatSync } = await import('./catalogService');
              if (paymentData.categoryId !== 'giftCard') {
                for (const row of lineItemRows.rows) {
                  if (row.product_id) {
                    const cat = lookupCatSync(row.product_id);
                    if (cat) { paymentData.categoryId = cat; break; }
                  }
                }
              }
            } catch (_) {}
          }
          
          let existingPayment;
          try {
            existingPayment = await paymentService.getPaymentBySquareId(paymentData.squareId);
          } catch (error) {
          }
          
          if (existingPayment) {
            await paymentService.updatePayment(paymentData.squareId, {
              status: paymentData.status,
              amount: paymentData.amount,
              categoryId: paymentData.categoryId,
              squareData: paymentData.squareData,
            });
            updated++;
          } else {
            await paymentService.createPayment(paymentData);
            created++;
          }
          
          processed++;
          
          // Update sync state progress
          if (processed % 10 === 0 || processed === squarePayments.length) {
            await this.updateSyncState(state.id, {
              processedCount: processed,
              status: `Processed ${processed} of ${squarePayments.length} payments`
            });
          }
        } catch (error) {
          failed++;
          logger.error('sync.payments.process_failed', errorContext(error));
        }
      }
      
      // Update state to completed
      await this.updateSyncState(state.id, {
        isComplete: true,
        status: 'completed',
        lastSyncedAt: new Date(),
        processedCount: processed
      });
      
      return { processed, created, updated, failed };
    } catch (error) {
      // Update state to error
      const state = await this.getSyncState('payments');
      
      if (state) {
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        });
      }
      
      throw new SyncError(
        'Failed to sync payments',
        'SYNC_ERROR',
        error instanceof Error ? error.message : error
      );
    } finally {
      this._paymentsSyncRunning = false;
      await lock.release();
    }
  }
  
  async syncRefunds(startDate?: Date, endDate?: Date): Promise<{
    processed: number;
    created: number;
    updated: number;
    failed: number;
    alreadyRunning?: boolean;
  }> {
    // Cross-instance guard: only one instance may run the refunds sync at a
    // time. Released in the finally block on every exit path.
    const lock = await tryAcquireSyncLock('refunds');
    if (!lock) {
      logger.info('sync.refunds.lock_not_acquired');
      return { processed: 0, created: 0, updated: 0, failed: 0, alreadyRunning: true };
    }

    let processed = 0;
    let created = 0;
    let updated = 0;
    let failed = 0;

    try {
      let state = await this.getSyncState('refunds');

      if (!state) {
        state = await this.createSyncState({
          syncType: 'refunds',
          lastSyncedAt: new Date(),
          isComplete: false,
          processedCount: 0,
          totalCount: 0,
          status: 'idle',
          errorMessage: null
        });
      }

      await this.updateSyncState(state.id, {
        isComplete: false,
        status: 'in_progress',
        lastSyncedAt: new Date(),
        processedCount: 0,
        totalCount: 0,
        errorMessage: null
      });

      const squareRefunds = await squareClient.fetchRefunds(startDate, endDate);

      await this.updateSyncState(state.id, {
        totalCount: squareRefunds.length,
        status: `Found ${squareRefunds.length} refunds to sync`
      });

      for (const squareRefund of squareRefunds) {
        try {
          const refundData = squareClient.convertSquareRefundToInsert(squareRefund);

          const existing = await db.select()
            .from(refunds)
            .where(eq(refunds.squareRefundId, refundData.squareRefundId))
            .limit(1);

          if (existing.length > 0) {
            await db.update(refunds)
              .set({
                amount: refundData.amount,
                status: refundData.status,
                reason: refundData.reason,
                squareData: refundData.squareData,
              })
              .where(eq(refunds.squareRefundId, refundData.squareRefundId));
            updated++;
          } else {
            await db.insert(refunds).values(refundData);
            created++;
          }

          processed++;

          if (processed % 10 === 0 || processed === squareRefunds.length) {
            await this.updateSyncState(state.id, {
              processedCount: processed,
              status: `Processed ${processed} of ${squareRefunds.length} refunds`
            });
          }
        } catch (error) {
          failed++;
          logger.error('sync.refunds.process_failed', errorContext(error));
        }
      }

      await this.updateSyncState(state.id, {
        isComplete: true,
        status: 'completed',
        lastSyncedAt: new Date(),
        processedCount: processed
      });

      return { processed, created, updated, failed };
    } catch (error) {
      const state = await this.getSyncState('refunds');
      if (state) {
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        });
      }

      throw new SyncError(
        'Failed to sync refunds',
        'SYNC_ERROR',
        error instanceof Error ? error.message : error
      );
    } finally {
      await lock.release();
    }
  }

  /**
   * Incremental gift card sync — runs every 5 minutes.
   *
   * Instead of re-scanning all 8,000+ Square gift cards, this method:
   *   1. Reads the last successful sync watermark (defaults to 7 days ago on first run).
   *   2. Uses a 2-minute overlap on the lookback window to avoid dropping boundary events.
   *   3. Fetches ACTIVATE activities from Square, stopping once events are older than the window.
   *   4. Deduplicates by giftCardId (keeps highest activation amount per card).
   *   5. For each unique new activation: fetches the card and upserts it.
   *   6. Only advances the watermark to the run-start time when ALL cards succeed.
   *      If any card fails, the watermark is unchanged so the next cycle retries.
   */
  async syncIncrementalGiftCards(): Promise<{
    processed: number;
    created: number;
    updated: number;
    failed: number;
    sinceDate: string;
  }> {
    // Cross-instance guard: only one instance may run the incremental gift
    // card sync at a time. The in-process sync_state status check inside
    // _runIncrementalGiftCards remains the fast path. Released on every exit.
    const lock = await tryAcquireSyncLock('giftCards_incremental');
    if (!lock) {
      logger.info('sync.incrementalGc.lock_not_acquired');
      return { processed: 0, created: 0, updated: 0, failed: 0, sinceDate: 'skipped' };
    }
    try {
      return await this._runIncrementalGiftCards();
    } finally {
      await lock.release();
    }
  }

  private async _runIncrementalGiftCards(): Promise<{
    processed: number;
    created: number;
    updated: number;
    failed: number;
    sinceDate: string;
  }> {
    let processed = 0;
    let created = 0;
    let updated = 0;
    let failed = 0;

    // Capture run start before any I/O — this becomes the new watermark on success
    const runStartedAt = new Date();

    const SYNC_TYPE = 'giftCards_incremental';
    const OVERLAP_MS = 2 * 60 * 1000;          // 2-min overlap to catch boundary events
    const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

    let state = await this.getSyncState(SYNC_TYPE);

    const STALE_LOCK_MS = 10 * 60 * 1000;
    if (state?.status === 'in_progress') {
      const elapsed = state.lastSyncedAt ? Date.now() - new Date(state.lastSyncedAt).getTime() : Infinity;
      if (elapsed < STALE_LOCK_MS) {
        logger.info('sync.incrementalGc.in_progress_skip');
        return { processed: 0, created: 0, updated: 0, failed: 0, sinceDate: 'skipped' };
      }
      logger.warn('sync.incrementalGc.stale_lock_reset', { stuckMinutes: Math.round(elapsed / 60000) });
      await this.updateSyncState(state.id, { status: 'completed', isComplete: true });
    }

    // Determine the lookback cutoff (with overlap buffer)
    const lastWatermark: Date = (state?.lastSyncedAt && state.status === 'completed')
      ? new Date(state.lastSyncedAt)
      : new Date(runStartedAt.getTime() - DEFAULT_LOOKBACK_MS);
    const since = new Date(lastWatermark.getTime() - OVERLAP_MS);

    logger.info('sync.incrementalGc.window', { since: since.toISOString(), until: runStartedAt.toISOString(), overlapSec: OVERLAP_MS / 1000 });

    // Upsert sync state to in_progress (do NOT advance lastSyncedAt yet)
    if (!state) {
      state = await this.createSyncState({
        syncType: SYNC_TYPE,
        lastSyncedAt: lastWatermark, // keep old watermark until this run succeeds
        isComplete: false,
        processedCount: 0,
        totalCount: 0,
        status: 'in_progress',
        errorMessage: null
      });
    } else {
      await this.updateSyncState(state.id, {
        isComplete: false,
        status: 'in_progress',
        errorMessage: null
        // intentionally NOT updating lastSyncedAt here
      });
    }

    try {
      // Fetch ACTIVATE events in the window
      const recentActivations = await squareClient.fetchRecentGiftCardActivations(since);

      if (recentActivations.length === 0) {
        logger.info('sync.incrementalGc.no_activations');
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: 'completed',
          lastSyncedAt: runStartedAt, // advance watermark — no work to do
          processedCount: 0
        });
        return { processed: 0, created: 0, updated: 0, failed: 0, sinceDate: since.toISOString() };
      }

      // Deduplicate by giftCardId — keep highest activation amount + associated squareOrderId
      const uniqueActivations = new Map<string, { amount: number; squareOrderId?: string }>();
      for (const { giftCardId, activationAmountDollars, squareOrderId } of recentActivations) {
        const existing = uniqueActivations.get(giftCardId);
        if (!existing || activationAmountDollars > existing.amount) {
          uniqueActivations.set(giftCardId, { amount: activationAmountDollars, squareOrderId });
        }
      }

      logger.info('sync.incrementalGc.processing', { unique: uniqueActivations.size, raw: recentActivations.length });

      // Load existing squareIds for fast lookup (avoids per-card DB query)
      const existingRows = await db.select({ squareId: giftCards.squareId }).from(giftCards);
      const existingSquareIds = new Set(existingRows.map(r => r.squareId));

      await this.updateSyncState(state.id, {
        totalCount: uniqueActivations.size,
        status: `Processing ${uniqueActivations.size} unique activations`
      });

      for (const [giftCardId, { amount: activationAmountDollars, squareOrderId }] of Array.from(uniqueActivations)) {
        try {
          if (existingSquareIds.has(giftCardId)) {
            // Card already exists — fill in activation amount if still null
            const baseFields: { updatedAt: Date; activationAmount?: number } = {
              updatedAt: new Date(),
            };
            if (activationAmountDollars) baseFields.activationAmount = activationAmountDollars;
            await db.update(giftCards)
              .set(baseFields)
              .where(eq(giftCards.squareId, giftCardId));

            // Only write activationSquareOrderId when the column is currently NULL.
            // ACTIVATE-event-derived links are authoritative; never overwrite them.
            if (squareOrderId) {
              await db.update(giftCards)
                .set({ activationSquareOrderId: squareOrderId })
                .where(
                  and(
                    eq(giftCards.squareId, giftCardId),
                    isNull(giftCards.activationSquareOrderId),
                  ),
                );
            }
            updated++;
          } else {
            const squareCard = await squareClient.fetchGiftCardById(giftCardId);
            if (squareCard) {
              const cardData = squareClient.convertSquareGiftCardToGiftCard(squareCard, activationAmountDollars);
              if (squareOrderId) cardData.activationSquareOrderId = squareOrderId;
              await giftCardService.createGiftCard(cardData);
            } else {
              logger.warn('sync.incrementalGc.card_missing_in_square', { giftCardId });
              await giftCardService.createGiftCard({
                squareId: giftCardId,
                gan: null,
                amount: 0,
                isActive: false,
                activationAmount: activationAmountDollars || null,
                purchaseDate: new Date(),
                activationSquareOrderId: squareOrderId || null,
              });
            }
            existingSquareIds.add(giftCardId);
            created++;
          }

          processed++;
        } catch (err) {
          failed++;
          logger.error('sync.incrementalGc.card_failed', { ...errorContext(err), giftCardId });
        }
      }

      logger.info('sync.incrementalGc.done', { processed, created, updated, failed });

      if (failed === 0) {
        // Advance watermark to run-start time — next cycle picks up from here
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: 'completed',
          lastSyncedAt: runStartedAt,
          processedCount: processed
        });
      } else {
        // Keep existing watermark so next cycle retries the failed cards
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: `completed_with_errors (${failed} cards failed — will retry)`,
          processedCount: processed,
          errorMessage: `${failed} card(s) failed; watermark not advanced so next cycle retries`
        });
        logger.warn('sync.incrementalGc.watermark_held', { failed, watermark: lastWatermark.toISOString() });
      }

      return { processed, created, updated, failed, sinceDate: since.toISOString() };
    } catch (error) {
      await this.updateSyncState(state.id, {
        isComplete: true,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
        // watermark NOT advanced — entire run retried next cycle
      });
      logger.error('sync.incrementalGc.fatal', errorContext(error));
      return { processed, created, updated, failed, sinceDate: since.toISOString() };
    }
  }

  async syncRedeemActivityBalances(): Promise<{
    redeemEvents: number;
    cardsRefreshed: number;
  }> {
    // Cross-instance guard: only one instance may run the REDEEM balance
    // monitor at a time. The in-process sync_state status check inside
    // _runRedeemActivityBalances remains the fast path. Released on every exit.
    const lock = await tryAcquireSyncLock('giftCard_redeem_monitor');
    if (!lock) {
      logger.info('sync.redeemMonitor.lock_not_acquired');
      return { redeemEvents: 0, cardsRefreshed: 0 };
    }
    try {
      return await this._runRedeemActivityBalances();
    } finally {
      await lock.release();
    }
  }

  private async _runRedeemActivityBalances(): Promise<{
    redeemEvents: number;
    cardsRefreshed: number;
  }> {
    const SYNC_TYPE = 'giftCard_redeem_monitor';
    const OVERLAP_MS = 2 * 60 * 1000;
    const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
    const runStartedAt = new Date();

    let state = await this.getSyncState(SYNC_TYPE);

    const STALE_LOCK_MS = 10 * 60 * 1000;
    if (state?.status === 'in_progress') {
      const elapsed = state.lastSyncedAt ? Date.now() - new Date(state.lastSyncedAt).getTime() : Infinity;
      if (elapsed < STALE_LOCK_MS) {
        return { redeemEvents: 0, cardsRefreshed: 0 };
      }
      logger.warn('sync.redeemMonitor.stale_lock_reset', { stuckMinutes: Math.round(elapsed / 60000) });
      await this.updateSyncState(state.id, { status: 'completed', isComplete: true });
    }

    const lastWatermark: Date = (state?.lastSyncedAt && (state.status === 'completed' || state.status === 'error'))
      ? new Date(state.lastSyncedAt)
      : new Date(runStartedAt.getTime() - DEFAULT_LOOKBACK_MS);
    const since = new Date(lastWatermark.getTime() - OVERLAP_MS);

    if (!state) {
      state = await this.createSyncState({
        syncType: SYNC_TYPE,
        lastSyncedAt: lastWatermark,
        isComplete: false,
        processedCount: 0,
        totalCount: 0,
        status: 'in_progress',
        errorMessage: null
      });
    } else {
      await this.updateSyncState(state.id, {
        isComplete: false,
        status: 'in_progress',
        errorMessage: null
      });
    }

    try {
      const { events: recentRedemptions, complete: fetchComplete } = await squareClient.fetchRecentGiftCardRedemptions(since);

      if (recentRedemptions.length === 0) {
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: 'completed',
          lastSyncedAt: fetchComplete ? runStartedAt : undefined,
          processedCount: 0
        });
        return { redeemEvents: 0, cardsRefreshed: 0 };
      }

      const uniqueCardIds = Array.from(new Set(recentRedemptions.map(r => r.giftCardId)));
      logger.info('sync.redeemMonitor.events', { events: recentRedemptions.length, uniqueCards: uniqueCardIds.length });

      const refreshResult = await giftCardService.refreshGiftCardBalancesByIds(uniqueCardIds);

      const shouldAdvanceWatermark = fetchComplete && refreshResult.failed === 0;
      if (!shouldAdvanceWatermark) {
        logger.warn('sync.redeemMonitor.watermark_held', { fetchComplete, failedRefreshes: refreshResult.failed });
      }
      await this.updateSyncState(state.id, {
        isComplete: true,
        status: 'completed',
        lastSyncedAt: shouldAdvanceWatermark ? runStartedAt : undefined,
        processedCount: recentRedemptions.length
      });

      return { redeemEvents: recentRedemptions.length, cardsRefreshed: refreshResult.updated };
    } catch (error) {
      await this.updateSyncState(state.id, {
        isComplete: true,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });
      logger.error('sync.redeemMonitor.fatal', errorContext(error));
      return { redeemEvents: 0, cardsRefreshed: 0 };
    }
  }

  /**
   * Resumable historical gift card backfill via Activities API.
   *
   * Unlike syncGiftCards() which uses listGiftCards (no date filter, arbitrary order,
   * loses progress on restart), this method:
   *   1. Pages through ALL ACTIVATE events ASC (oldest → newest) using the Activities API.
   *   2. Saves the API cursor after every page using the 'giftCards_historical' sync key.
   *   3. On restart it reads the saved cursor and resumes mid-scan — no data is re-processed
   *      from the beginning.
   *   4. For each activation event it UPSERTs the card with the correct UTC purchase_date
   *      (fixing the timezone bug for any newly inserted records) and the authoritative
   *      activation amount from the event.
   *
   * This is the fix for the March 9-20 gap: those 228 cards live in pages that were
   * never reached before a server restart when using listGiftCards.
   */
  async syncGiftCardsHistoricalBackfill(ctx: SyncTriggerContext & { skipLock?: boolean } = {}): Promise<{
    processed: number;
    created: number;
    updated: number;
    failed: number;
    pagesProcessed: number;
    finished: boolean;
    rejected?: 'already_running' | 'daily_budget_exceeded';
  }> {
    const SYNC_TYPE = 'giftCards_historical';
    let processed = 0;
    let created = 0;
    let updated = 0;
    let failed = 0;
    let pagesProcessed = 0;

    // DB-level concurrency: a Postgres advisory lock guarantees only one
    // historical gift-card backfill runs cluster-wide, regardless of which
    // process / instance triggers it.
    const lock = ctx.skipLock ? { release: async () => {} } : await tryAcquireSyncLock(SYNC_TYPE);
    if (!lock) {
      logger.info('sync.historicalGc.lock_held');
      // Audit the rejected trigger so repeated/abusive attempts are visible
      const rejectedAuditId = await recordAuditStart({
        syncType: SYNC_TYPE,
        action: 'gift_cards_historical_backfill',
        actorUserId: ctx.actorUserId ?? null,
        actorIp: ctx.actorIp ?? null,
        params: { rejectedReason: 'already_running' },
      });
      await recordAuditFinish(rejectedAuditId, {
        status: 'rejected',
        result: { reason: 'already_running' },
      });
      return { processed: 0, created: 0, updated: 0, failed: 0, pagesProcessed: 0, finished: false, rejected: 'already_running' };
    }

    let auditId: number;
    try {
      auditId = await recordAuditStart({
        syncType: SYNC_TYPE,
        action: 'gift_cards_historical_backfill',
        actorUserId: ctx.actorUserId ?? null,
        actorIp: ctx.actorIp ?? null,
        params: null,
      });
    } catch (err) {
      await lock.release();
      throw err;
    }

    let state: SyncState | undefined;
    let savedCursor: string | undefined = undefined;
    let currentCursor: string | undefined;
    let finished = false;
    let budgetExceeded = false;

    try {
    state = await this.getSyncState(SYNC_TYPE);

    // Read saved cursor from errorMessage field (repurposed as a checkpoint store)
    if (state?.errorMessage?.startsWith('cursor:')) {
      savedCursor = state.errorMessage.slice('cursor:'.length) || undefined;
      logger.info('sync.historicalGc.resume_from_cursor');
    } else {
      logger.info('sync.historicalGc.start_fresh');
    }

    // Mark as in_progress
    if (!state) {
      state = await this.createSyncState({
        syncType: SYNC_TYPE,
        lastSyncedAt: new Date(),
        isComplete: false,
        processedCount: 0,
        totalCount: 0,
        status: 'in_progress',
        errorMessage: savedCursor ? `cursor:${savedCursor}` : null
      });
    } else {
      await this.updateSyncState(state.id, {
        isComplete: false,
        status: 'in_progress',
        lastSyncedAt: new Date(),
      });
    }

    // Pre-load ALL Square gift cards into a map (squareId → card data).
    // This avoids per-card API calls inside the activation-event loop — instead we
    // do a single bulk fetch up front and look up cards from the in-memory map.
    logger.info('sync.historicalGc.preload_start');
    const { cards: allSquareCards } = await squareClient.fetchGiftCards();
    const squareCardMap = new Map<string, any>();
    for (const card of allSquareCards) {
      const id = card.id || card.squareId;
      if (id) squareCardMap.set(id, card);
    }
    logger.info('sync.historicalGc.preload_done', { count: squareCardMap.size });

    // Load all existing squareIds once for fast lookup
    const existingRows = await db.select({ squareId: giftCards.squareId }).from(giftCards);
    const existingSquareIds = new Set(existingRows.map(r => r.squareId));

    currentCursor = savedCursor;

      // Process up to 20 pages per call (1,000 activities) to keep response times reasonable.
      // The endpoint will be called again to continue from where we left off.
      const MAX_PAGES_PER_CALL = 20;

      for (let page = 0; page < MAX_PAGES_PER_CALL; page++) {
        // Per-day Square page budget — stop cleanly when exceeded so a
        // runaway loop cannot saturate the shared Square API for the day.
        // `withDailyBudget` enforces the Task #120 ordering contract by
        // construction: budget is consumed BEFORE the Square fetch, and
        // any throw from the fetch propagates out without a refund (the
        // helper has no try/catch around its callback by design).
        const budgetResult = await withDailyBudget(1, async () => {
          try {
            return await squareClient.fetchGiftCardActivitiesPage(currentCursor, 'ASC');
          } catch (fetchErr) {
            logIfSquare429(fetchErr, { syncType: SYNC_TYPE, source: 'fetchGiftCardActivitiesPage' });
            throw fetchErr;
          }
        });
        if (!budgetResult.ok) {
          budgetExceeded = true;
          logger.warn('sync.historicalGc.budget_exhausted', { used: budgetResult.used, cap: budgetResult.cap });
          break;
        }
        const { activities, nextCursor } = budgetResult.result;
        pagesProcessed++;

        logger.info('sync.historicalGc.page', { page: page + 1, events: activities.length });

        for (const { giftCardId, activationAmountDollars, createdAt, squareOrderId } of activities) {
          try {
            // Look up from the pre-loaded map — avoids a per-card API call.
            // Fall back to fetchGiftCardById only for cards not in the bulk list
            // (e.g., cancelled/expired cards Square omits from listGiftCards).
            let squareCard = squareCardMap.get(giftCardId);
            if (!squareCard) {
              squareCard = await squareClient.fetchGiftCardById(giftCardId);
              if (!squareCard) {
                logger.warn('sync.historicalGc.card_unresolved', { giftCardId });
                failed++;
                continue;
              }
            }

            // Build the canonical card data (with correct UTC purchase_date)
            const cardData = squareClient.convertSquareGiftCardToGiftCard(squareCard, activationAmountDollars);
            // Use the authoritative createdAt from the Activities API event (correct UTC)
            cardData.purchaseDate = createdAt;
            // Link the gift card to its originating Square order (used to identify Web Res deposits)
            if (squareOrderId) cardData.activationSquareOrderId = squareOrderId;

            if (existingSquareIds.has(giftCardId)) {
              // Card exists — upsert current balance and active status from Square.
              // For purchaseDate, keep the EARLIEST activation event: since the backfill
              // iterates ASC (oldest first), a later activation event should NOT overwrite
              // a purchase_date that was set from an earlier event.
              await db.update(giftCards)
                .set({
                  amount: cardData.amount,
                  isActive: cardData.isActive,
                  activationAmount: activationAmountDollars,
                  purchaseDate: sql`CASE WHEN ${giftCards.purchaseDate} IS NULL OR ${giftCards.purchaseDate} > ${createdAt} THEN ${createdAt} ELSE ${giftCards.purchaseDate} END`,
                  ...(squareOrderId ? { activationSquareOrderId: squareOrderId } : {}),
                  updatedAt: new Date()
                })
                .where(eq(giftCards.squareId, giftCardId));
              updated++;
            } else {
              // Brand-new card — insert it
              await giftCardService.createGiftCard(cardData);
              existingSquareIds.add(giftCardId);
              created++;
            }
            processed++;
          } catch (err) {
            failed++;
            logger.error('sync.historicalGc.card_failed', { ...errorContext(err), giftCardId });
          }
        }

        currentCursor = nextCursor;

        // Save cursor checkpoint after each page so restarts resume here
        await this.updateSyncState(state.id, {
          processedCount: (state.processedCount || 0) + processed,
          status: `in_progress — page ${pagesProcessed} processed`,
          errorMessage: currentCursor ? `cursor:${currentCursor}` : 'cursor:done'
        });

        if (!nextCursor) {
          finished = true;
          break;
        }
      }

      if (finished) {
        await this.updateSyncState(state.id, {
          isComplete: true,
          status: 'completed',
          lastSyncedAt: new Date(),
          processedCount: (state.processedCount || 0) + processed,
          errorMessage: null // clear cursor checkpoint — done
        });
        logger.info('sync.historicalGc.complete', { processed, created, updated, failed });
      } else {
        const pausedReason = budgetExceeded
          ? 'paused — daily Square budget exhausted, retry tomorrow'
          : `paused — call again to continue (${pagesProcessed} pages this run)`;
        await this.updateSyncState(state.id, {
          isComplete: false,
          status: pausedReason,
          lastSyncedAt: new Date(),
          processedCount: (state.processedCount || 0) + processed,
          // errorMessage already updated with cursor above
        });
        logger.info('sync.historicalGc.paused', { reason: pausedReason });
      }

      await recordAuditFinish(auditId, {
        status: finished ? 'completed' : (budgetExceeded ? 'rejected' : 'partial'),
        result: { processed, created, updated, failed, pagesProcessed, finished, budgetExceeded },
        pagesUsed: pagesProcessed,
      });

      return {
        processed,
        created,
        updated,
        failed,
        pagesProcessed,
        finished,
        ...(budgetExceeded ? { rejected: 'daily_budget_exceeded' as const } : {}),
      };
    } catch (error) {
      // Save current cursor so we can resume from last successful page
      if (state) {
        await this.updateSyncState(state.id, {
          isComplete: false,
          status: 'error — will resume from checkpoint on next call',
          errorMessage: currentCursor ? `cursor:${currentCursor}` : (savedCursor ? `cursor:${savedCursor}` : null)
        });
      }
      await recordAuditFinish(auditId, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        pagesUsed: pagesProcessed,
      });
      logger.error('sync.historicalGc.error', errorContext(error));
      throw error;
    } finally {
      await lock.release();
    }
  }

  /**
   * Starts a full historical backfill for orders and payments in the background.
   *
   * - Processes data in weekly chunks (configurable) to avoid Square API timeouts.
   * - Persists progress in the 'orders_payments_backfill' sync state (lastCheckpoint JSONB)
   *   so it can resume from the last completed chunk if the server restarts.
   * - Updates existing orders' squareData so service charges / taxes stay accurate.
   * - After all chunks complete, runs the three gift-card linking phases so gift-card
   *   buckets (Bowling, Laser Tag, Gift Card) are accurate for historical dates.
   * - Returns immediately; progress can be polled via getHistoricalBackfillStatus().
   */
  async startHistoricalOrdersPaymentsBackfill(
    startDate: Date,
    endDate: Date,
    chunkDays: number = 30,
    ctx: SyncTriggerContext = {}
  ): Promise<{ alreadyRunning: boolean; message: string }> {
    const SYNC_TYPE = 'orders_payments_backfill';

    // DB-level concurrency: a Postgres advisory lock guarantees only one
    // historical backfill runs cluster-wide. Replaces the previous
    // in-memory flag (lost across restarts) and the wall-clock "stuck"
    // heuristic (which let a second admin race in after 10 minutes).
    const lock = await tryAcquireSyncLock(SYNC_TYPE);
    if (!lock) {
      logger.info('sync.historicalBackfill.lock_held');
      // Audit the rejected trigger so repeated/abusive attempts are visible
      const rejectedAuditId = await recordAuditStart({
        syncType: SYNC_TYPE,
        action: 'orders_payments_historical_backfill',
        actorUserId: ctx.actorUserId ?? null,
        actorIp: ctx.actorIp ?? null,
        params: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          chunkDays,
          rejectedReason: 'already_running',
        },
      });
      await recordAuditFinish(rejectedAuditId, {
        status: 'rejected',
        result: { reason: 'already_running' },
      });
      return { alreadyRunning: true, message: 'Backfill is already running' };
    }

    // Setup phase — runs synchronously before we hand off to the background
    // loop. Any throw here MUST release the advisory lock, otherwise it
    // would stay held until the process restarts.
    let existingState: SyncState | undefined;
    let auditId: number;
    let state: SyncState;
    let chunks: Array<{ start: Date; end: Date }>;
    let resumeFromChunk = 0;
    let initialCheckpoint: Record<string, unknown>;
    try {
      existingState = await this.getSyncState(SYNC_TYPE);

    // Build ordered list of chunk intervals
    chunks = [];
    let cursor = new Date(startDate);
    while (cursor < endDate) {
      const chunkEnd = new Date(Math.min(
        cursor.getTime() + chunkDays * 24 * 60 * 60 * 1000,
        endDate.getTime()
      ));
      chunks.push({ start: new Date(cursor), end: chunkEnd });
      cursor = chunkEnd;
    }

    // Determine resume point from stored checkpoint — only if params match exactly
    const savedCheckpoint = existingState?.lastCheckpoint as any;
    if (savedCheckpoint) {
      const cpStart = savedCheckpoint.startDate ?? '';
      const cpEnd   = savedCheckpoint.endDate   ?? '';
      const cpChunk = savedCheckpoint.chunkDays  ?? chunkDays;
      const paramsMatch =
        cpStart === startDate.toISOString() &&
        cpEnd   === endDate.toISOString()   &&
        cpChunk === chunkDays;

      if (paramsMatch) {
        // Prefer nextChunkToProcess (new checkpoint field) for accurate resume point;
        // fall back to legacy chunksCompleted field for backwards compatibility.
        const resumeIdx = savedCheckpoint.nextChunkToProcess ?? savedCheckpoint.chunksCompleted ?? 0;
        resumeFromChunk = Math.min(Math.max(0, resumeIdx), chunks.length);
        if (resumeFromChunk > 0) {
          logger.info('sync.historicalBackfill.resume_chunk', { resumeFromChunk, totalChunks: chunks.length });
        }
      } else {
        logger.info('sync.historicalBackfill.checkpoint_mismatch_fresh');
        resumeFromChunk = 0;
      }
    }

    initialCheckpoint = {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      chunkDays,
      totalChunks: chunks.length,
      nextChunkToProcess: resumeFromChunk,
      chunksCompleted: resumeFromChunk,
      lastCompletedDate: resumeFromChunk > 0 ? chunks[resumeFromChunk - 1].end.toISOString() : null,
    };

    if (existingState) {
      await this.updateSyncState(existingState.id, {
        isComplete: false,
        status: 'in_progress',
        lastSyncedAt: new Date(),
        processedCount: 0,
        totalCount: chunks.length,
        errorMessage: null,
        lastCheckpoint: initialCheckpoint,
      });
      state = existingState;
    } else {
      state = await this.createSyncState({
        syncType: SYNC_TYPE,
        lastSyncedAt: new Date(),
        isComplete: false,
        processedCount: 0,
        totalCount: chunks.length,
        status: 'in_progress',
        errorMessage: null,
        lastCheckpoint: initialCheckpoint,
      });
    }

    // Acquire in-memory lock immediately (before setImmediate so any concurrent call is blocked)
    this._ordersPaymentsBackfillRunning = true;

    // Audit row — written here so it appears even if the background loop
    // never gets a chance to start (e.g. process restart between dispatch
    // and the setImmediate callback).
      auditId = await recordAuditStart({
        syncType: SYNC_TYPE,
        action: 'orders_payments_historical_backfill',
        actorUserId: ctx.actorUserId ?? null,
        actorIp: ctx.actorIp ?? null,
        params: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          chunkDays,
          totalChunks: chunks.length,
          resumeFromChunk,
        },
      });
    } catch (setupErr) {
      // Any failure in synchronous setup must release the advisory lock
      // so a subsequent admin trigger can proceed.
      this._ordersPaymentsBackfillRunning = false;
      await lock.release();
      throw setupErr;
    }

    // Fire background loop — non-blocking
    setImmediate(async () => {
      logger.info('sync.historicalBackfill.start', { totalChunks: chunks.length, chunkDays, resumeFromChunk });
      let totalOrders = 0;
      let totalPayments = 0;
      let failedChunks = 0;
      let chunksProcessed = 0;
      let budgetExceeded = false;
      const cappedPaymentChunks: Array<{ start: Date; end: Date; chunkIndex: number }> = [];

      // nextChunkToProcess tracks the LOWEST chunk index that has not been confirmed
      // complete. It only advances when chunk i succeeds AND i === nextChunkToProcess
      // (i.e., no gap from a prior failure). This ensures failed chunks are always
      // retried on the next resume, regardless of later successes.
      let nextChunkToProcess = resumeFromChunk;
      try {

      for (let i = resumeFromChunk; i < chunks.length; i++) {
        const { start, end } = chunks[i];

        // Per-day shared Square page budget — stop cleanly when exceeded
        // so a runaway / hostile backfill can't hammer Square indefinitely.
        // `withDailyBudget` enforces the Task #120 ordering contract by
        // construction (consume FIRST, callback second, no refund on
        // throw). The chunk_start log moves inside the callback so it
        // still only fires AFTER a successful budget grant — matching
        // the pre-helper ordering that operators rely on when scanning
        // for "this chunk actually started" entries.
        try {
          const budgetResult = await withDailyBudget(BACKFILL_BUDGET_PER_CHUNK, async () => {
            logger.info('sync.historicalBackfill.chunk_start', { chunkIndex: i + 1, totalChunks: chunks.length, startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) });

            // --- Orders (batch upsert) ---
            const squareOrders = await squareClient.fetchOrders(start, end).catch((err) => {
              logIfSquare429(err, { syncType: SYNC_TYPE, source: 'fetchOrders' });
              throw err;
            });
            const orderRows: any[] = [];
            const squareOrderMap = new Map<string, any>();

            for (const squareOrder of squareOrders) {
              try {
                const orderData = squareClient.convertSquareOrderToOrder(squareOrder);
                orderRows.push(orderData);
                squareOrderMap.set(orderData.squareId, squareOrder);
              } catch (err) {
                logger.error('sync.historicalBackfill.order_convert_error', errorContext(err));
              }
            }

            let chunkOrdersUpserted = 0;
            if (orderRows.length > 0) {
              const BATCH = 200;
              for (let b = 0; b < orderRows.length; b += BATCH) {
                const batch = orderRows.slice(b, b + BATCH);
                const upserted = await db.insert(orders).values(batch)
                  .onConflictDoUpdate({
                    target: orders.squareId,
                    set: {
                      status: sql`excluded.status`,
                      totalMoney: sql`excluded.total_money`,
                      totalTax: sql`excluded.total_tax`,
                      totalDiscount: sql`excluded.total_discount`,
                      squareData: sql`excluded.square_data`,
                      closedAt: sql`excluded.closed_at`,
                    },
                  })
                  .returning({ id: orders.id, squareId: orders.squareId });
                chunkOrdersUpserted += upserted.length;

                const lineItemRows: any[] = [];
                const upsertedIds = upserted.map(r => r.id);
                if (upsertedIds.length > 0) {
                  await db.delete(orderLineItems).where(
                    inArray(orderLineItems.orderId, upsertedIds)
                  );
                }
                for (const row of upserted) {
                  const sqOrder = squareOrderMap.get(row.squareId);
                  if (sqOrder?.lineItems) {
                    for (const li of sqOrder.lineItems) {
                      try {
                        lineItemRows.push(
                          squareClient.convertSquareLineItemToOrderLineItem(li, row.id)
                        );
                      } catch { }
                    }
                  }
                }
                if (lineItemRows.length > 0) {
                  const LI_BATCH = 500;
                  await Promise.all(
                    Array.from(
                      { length: Math.ceil(lineItemRows.length / LI_BATCH) },
                      (_, i) => db.insert(orderLineItems)
                        .values(lineItemRows.slice(i * LI_BATCH, (i + 1) * LI_BATCH))
                        .onConflictDoNothing()
                    )
                  );
                }
              }
            }

            totalOrders += squareOrders.length;
            logger.info('sync.historicalBackfill.chunk_orders', { chunkIndex: i + 1, upserted: chunkOrdersUpserted, fetched: squareOrders.length });

            // --- Payments (batch upsert) ---
            const paymentResult = await squareClient.fetchPayments(start, end, { returnMeta: true })
              .catch((err) => {
                logIfSquare429(err, { syncType: SYNC_TYPE, source: 'fetchPayments' });
                throw err;
              });
            const squarePayments = paymentResult.payments;
            if (paymentResult.hitPageCap) {
              cappedPaymentChunks.push({ start, end, chunkIndex: i });
              logger.warn('sync.historicalBackfill.payment_cap_hit', { chunkIndex: i + 1 });
            }
            const paymentRows: any[] = [];

            for (const squarePayment of squarePayments) {
              try {
                const paymentData = squareClient.convertSquarePaymentToTransaction(squarePayment);
                if (!paymentData.amount || paymentData.amount === 0) continue;
                paymentRows.push(paymentData);
              } catch (err) {
                logger.error('sync.historicalBackfill.payment_convert_error', errorContext(err));
              }
            }

            let chunkPaymentsUpserted = 0;
            if (paymentRows.length > 0) {
              const BATCH = 200;
              const batchInserts: Array<Promise<{ id: number }[]>> = [];
              for (let b = 0; b < paymentRows.length; b += BATCH) {
                batchInserts.push(
                  db.insert(transactions).values(paymentRows.slice(b, b + BATCH))
                    .onConflictDoUpdate({
                      target: transactions.squareId,
                      set: {
                        amount: sql`excluded.amount`,
                        status: sql`excluded.status`,
                        squareData: sql`excluded.square_data`,
                        categoryId: sql`excluded.category_id`,
                      },
                    })
                    .returning({ id: transactions.id })
                );
              }
              const batchResults = await Promise.all(batchInserts);
              for (const r of batchResults) chunkPaymentsUpserted += r.length;
            }

            totalPayments += squarePayments.length;
            logger.info('sync.historicalBackfill.chunk_payments', { chunkIndex: i + 1, upserted: chunkPaymentsUpserted, fetched: squarePayments.length });
          });
          if (!budgetResult.ok) {
            budgetExceeded = true;
            logger.warn('sync.historicalBackfill.budget_exhausted', { used: budgetResult.used, cap: budgetResult.cap, chunkIndex: i + 1, totalChunks: chunks.length });
            break;
          }

        } catch (err) {
          failedChunks++;
          // Do NOT advance nextChunkToProcess so that this chunk is retried on resume.
          // All later chunks will also be re-processed (operations are idempotent).
          // Structured failure record so per-chunk errors are queryable
          // in the log pipeline (chunk index + window + cause) instead of
          // having to grep free-form console output during incident
          // triage. Console line kept for local-dev readability.
          logger.error('historicalBackfill.chunk_failed', {
            chunkIndex: i,
            chunkNumber: i + 1,
            totalChunks: chunks.length,
            chunkStart: start.toISOString(),
            chunkEnd: end.toISOString(),
            chunkDays,
            error: err instanceof Error ? err.message : String(err),
            errorName: err instanceof Error ? err.name : undefined,
          });
          logger.error('sync.historicalBackfill.chunk_failed', { ...errorContext(err), chunkIndex: i + 1 });
          await this.updateSyncState(state.id, {
            errorMessage: `Chunk ${i + 1} (${start.toISOString().slice(0, 10)}): ${err instanceof Error ? err.message : String(err)}`,
            lastCheckpoint: {
              startDate: startDate.toISOString(),
              endDate: endDate.toISOString(),
              chunkDays,
              totalChunks: chunks.length,
              nextChunkToProcess,        // lowest unconfirmed index (unchanged after failure)
              chunksCompleted: nextChunkToProcess,
              lastCompletedDate: nextChunkToProcess > 0 ? chunks[nextChunkToProcess - 1].end.toISOString() : null,
              lastError: `Chunk ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
            },
          });
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        // Advance nextChunkToProcess only when this chunk is the expected next one.
        // If an earlier chunk failed (leaving a gap), we do NOT advance past it, so
        // the resume always starts from the lowest unprocessed chunk.
        if (i === nextChunkToProcess) {
          nextChunkToProcess = i + 1;
        }
        chunksProcessed++;

        // Checkpoint saved after each successful chunk
        const checkpoint = {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          chunkDays,
          totalChunks: chunks.length,
          nextChunkToProcess,          // authoritative resume index
          chunksCompleted: nextChunkToProcess,
          lastCompletedDate: chunks[nextChunkToProcess - 1]?.end.toISOString() ?? end.toISOString(),
        };
        await this.updateSyncState(state.id, {
          processedCount: totalOrders + totalPayments,
          status: `in_progress`,
          lastSyncedAt: new Date(),
          lastCheckpoint: checkpoint,
          errorMessage: null,
        });

        // Per-chunk gift-card linking: scoped to this chunk's date range so we avoid
        // repeated full-table heuristic scans on every iteration.
        try {
          const gcResult = await giftCardService.backfillActivationSquareOrderIds({ start, end });
          if (gcResult.updated > 0) {
            logger.info('sync.historicalBackfill.chunk_gc_linked', { chunkIndex: i + 1, updated: gcResult.updated });
          }
        } catch (gcErr) {
          logger.error('sync.historicalBackfill.chunk_gc_failed', { ...errorContext(gcErr), chunkIndex: i + 1 });
        }

        // No inter-chunk delay needed — Square API rate limits are handled within fetch pagination
      }

      // All chunks complete — run full gift-card linking phases (including history scan)
      logger.info('sync.historicalBackfill.linking_phases_start');
      try {
        const r0 = await giftCardService.backfillActivationOrderIdsFromActivateHistory();
        logger.info('sync.historicalBackfill.phase0', { scanned: r0.scanned, linked: r0.linked });
      } catch (err) {
        logger.error('sync.historicalBackfill.phase0_failed', errorContext(err));
      }
      try {
        const r1 = await giftCardService.syncMissingActivationOrders();
        logger.info('sync.historicalBackfill.phase1', { inserted: r1.inserted });
      } catch (err) {
        logger.error('sync.historicalBackfill.phase1_failed', errorContext(err));
      }
      try {
        const repair = await giftCardService.repairMislinkedActivationOrders();
        if (repair.cleared > 0 || repair.relinked > 0) {
          logger.info('sync.historicalBackfill.phase1_5', { relinked: repair.relinked, cleared: repair.cleared });
        }
      } catch (err) {
        logger.error('sync.historicalBackfill.phase1_5_failed', errorContext(err));
      }
      try {
        const r2 = await giftCardService.backfillActivationSquareOrderIds();
        logger.info('sync.historicalBackfill.phase2', { updated: r2.updated });
      } catch (err) {
        logger.error('sync.historicalBackfill.phase2_failed', errorContext(err));
      }

      // --- Re-sweep capped payment chunks with smaller windows ---
      if (cappedPaymentChunks.length > 0) {
        logger.info('sync.historicalBackfill.resweep_start', { chunks: cappedPaymentChunks.length });
        const SUB_CHUNK_DAYS = 5;
        let resweepTotal = 0;

        for (const capped of cappedPaymentChunks) {
          const subChunks: Array<{ start: Date; end: Date }> = [];
          let subStart = new Date(capped.start);
          while (subStart < capped.end) {
            const subEnd = new Date(Math.min(subStart.getTime() + SUB_CHUNK_DAYS * 24 * 60 * 60 * 1000, capped.end.getTime()));
            subChunks.push({ start: new Date(subStart), end: subEnd });
            subStart = subEnd;
          }

          logger.info('sync.paymentResweep.chunk_split', { chunkIndex: capped.chunkIndex + 1, startDate: capped.start.toISOString().slice(0, 10), endDate: capped.end.toISOString().slice(0, 10), subChunks: subChunks.length, subChunkDays: SUB_CHUNK_DAYS });

          for (let s = 0; s < subChunks.length; s++) {
            const sub = subChunks[s];
            try {
              const subResult = await squareClient.fetchPayments(sub.start, sub.end, { returnMeta: true });
              if (subResult.hitPageCap) {
                logger.warn('sync.paymentResweep.sub_cap_hit', { subIndex: s + 1, totalSubs: subChunks.length, startDate: sub.start.toISOString().slice(0, 10), endDate: sub.end.toISOString().slice(0, 10), fetched: subResult.payments.length });
              }

              const paymentRows: any[] = [];
              for (const sp of subResult.payments) {
                try {
                  const pd = squareClient.convertSquarePaymentToTransaction(sp);
                  if (!pd.amount || pd.amount === 0) continue;
                  paymentRows.push(pd);
                } catch (err) {
                  logger.error('sync.paymentResweep.convert_error', errorContext(err));
                }
              }

              if (paymentRows.length > 0) {
                const BATCH = 200;
                for (let b = 0; b < paymentRows.length; b += BATCH) {
                  const batch = paymentRows.slice(b, b + BATCH);
                  await db.insert(transactions).values(batch)
                    .onConflictDoUpdate({
                      target: transactions.squareId,
                      set: {
                        amount: sql`excluded.amount`,
                        status: sql`excluded.status`,
                        squareData: sql`excluded.square_data`,
                        categoryId: sql`excluded.category_id`,
                      },
                    });
                }
                resweepTotal += paymentRows.length;
              }

              logger.info('sync.paymentResweep.sub_done', { subIndex: s + 1, totalSubs: subChunks.length, upserted: paymentRows.length, fetched: subResult.payments.length });
            } catch (err) {
              logger.error('sync.paymentResweep.sub_failed', { ...errorContext(err), subIndex: s + 1, totalSubs: subChunks.length });
            }
          }
        }

        totalPayments += resweepTotal;
        logger.info('sync.paymentResweep.complete', { upserted: resweepTotal, chunks: cappedPaymentChunks.length });
      }

      // isComplete only when every chunk was processed without failure
      const allSucceeded = !budgetExceeded && failedChunks === 0 && nextChunkToProcess >= chunks.length;
      const finalStatus = allSucceeded
        ? 'completed'
        : budgetExceeded
          ? `partial_complete — daily Square budget exhausted at chunk ${nextChunkToProcess + 1}; resume after UTC midnight`
          : `partial_complete — ${failedChunks} chunk(s) failed; resume to retry from chunk ${nextChunkToProcess + 1}`;
      await this.updateSyncState(state.id, {
        isComplete: allSucceeded,
        status: finalStatus,
        lastSyncedAt: new Date(),
        processedCount: totalOrders + totalPayments,
        lastCheckpoint: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          chunkDays,
          totalChunks: chunks.length,
          nextChunkToProcess: allSucceeded ? chunks.length : nextChunkToProcess,
          chunksCompleted: nextChunkToProcess,
          lastCompletedDate: nextChunkToProcess > 0
            ? (chunks[nextChunkToProcess - 1]?.end.toISOString() ?? endDate.toISOString())
            : null,
          failedChunks,
        },
      });
      if (allSucceeded) {
        logger.info('sync.historicalBackfill.complete', { totalOrders, totalPayments, chunks: chunks.length });
      } else {
        logger.warn('sync.historicalBackfill.partial', { failedChunks, totalOrders, totalPayments });
      }

      await recordAuditFinish(auditId, {
        status: budgetExceeded
          ? 'rejected'
          : (allSucceeded ? 'completed' : 'partial'),
        result: {
          totalOrders,
          totalPayments,
          chunksProcessed,
          failedChunks,
          budgetExceeded,
          nextChunkToProcess,
          totalChunks: chunks.length,
        },
        pagesUsed: chunksProcessed * BACKFILL_BUDGET_PER_CHUNK,
      });
      } catch (fatalErr) {
        logger.error('sync.historicalBackfill.fatal', errorContext(fatalErr));
        try {
          await this.updateSyncState(state.id, {
            status: 'failed',
            errorMessage: fatalErr instanceof Error ? fatalErr.message : String(fatalErr),
          });
        } catch { /* ignore secondary error */ }
        await recordAuditFinish(auditId, {
          status: 'failed',
          errorMessage: fatalErr instanceof Error ? fatalErr.message : String(fatalErr),
          pagesUsed: chunksProcessed * BACKFILL_BUDGET_PER_CHUNK,
          result: { totalOrders, totalPayments, chunksProcessed, failedChunks, budgetExceeded },
        });
      } finally {
        this._ordersPaymentsBackfillRunning = false;
        await lock.release();
      }
    });

    return { alreadyRunning: false, message: `Backfill started: ${chunks.length} chunks of ${chunkDays} days each, resuming from chunk ${resumeFromChunk + 1}` };
  }

  /**
   * Returns the current status of the historical orders/payments backfill.
   */
  async getHistoricalBackfillStatus(): Promise<{
    found: boolean;
    status: string;
    isRunning: boolean;
    isComplete: boolean;
    chunksCompleted: number;
    totalChunks: number;
    percentComplete: number;
    lastCompletedDate: string | null;
    processedCount: number;
    errorMessage: string | null;
    startDate: string | null;
    endDate: string | null;
    lastUpdated: string | null;
  }> {
    const state = await this.getSyncState('orders_payments_backfill');
    if (!state) {
      return {
        found: false,
        status: 'not_started',
        isRunning: false,
        isComplete: false,
        chunksCompleted: 0,
        totalChunks: 0,
        percentComplete: 0,
        lastCompletedDate: null,
        processedCount: 0,
        errorMessage: null,
        startDate: null,
        endDate: null,
        lastUpdated: null,
      };
    }

    const cp = state.lastCheckpoint as any ?? {};
    const total = cp.totalChunks ?? state.totalCount ?? 0;
    const done = cp.chunksCompleted ?? 0;
    return {
      found: true,
      status: state.status ?? 'unknown',
      isRunning: this._ordersPaymentsBackfillRunning || (!state.isComplete && (state.status ?? '').startsWith('in_progress')),
      isComplete: state.isComplete ?? false,
      chunksCompleted: done,
      totalChunks: total,
      percentComplete: total > 0 ? Math.round((done / total) * 100) : 0,
      lastCompletedDate: cp.lastCompletedDate ?? null,
      processedCount: state.processedCount ?? 0,
      errorMessage: state.errorMessage ?? null,
      startDate: cp.startDate ?? null,
      endDate: cp.endDate ?? null,
      lastUpdated: state.lastSyncedAt ? new Date(state.lastSyncedAt).toISOString() : null,
    };
  }
}

// Create and export a singleton instance
export const syncService = new SyncService();
