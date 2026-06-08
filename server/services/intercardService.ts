import { db } from '../db';
import { eq, sql } from 'drizzle-orm';
import { intercardRevenue, syncState, type DateRange } from '../../shared/schema';
import { getEasternBusinessDateStrings } from '../dateUtils';
import { logger, errorContext } from '../logger';
import { tryAcquireSyncLock } from './syncLocks';

const INTERCARD_HOST = (process.env.INTERCARD_HOST || '').replace(/\/+$/, '');
const INTERCARD_MAC_ID = process.env.INTERCARD_MAC_ID || '';
const INTERCARD_CORP_ID = process.env.INTERCARD_CORP_ID || '';
const INTERCARD_AUTH_KEY = process.env.INTERCARD_AUTH_KEY || '';
const INTERCARD_BASE_PATH = '/WS_RevenueExtract_REST/Revenue';
const INTERCARD_TOKEN_PATH = '/WS_RevenueExtract_REST/api/Tokens/corp';

interface IntercardRevenueRow {
  LocationID: string;
  DeviceType: string;
  DeviceName: string;
  CashRevenue: number;
  CreditCardRevenue: number;
  CashRefunds: number;
  CreditRefunds: number;
  OtherPayment: number;
  CustomerCardUse: number;
  Revenue: number;
}

interface FetchResult {
  ok: boolean;
  rows: IntercardRevenueRow[];
  errorType?: 'missing_config' | 'auth_failed' | 'api_error' | 'network_error' | 'parse_error';
}

interface BackfillCheckpoint {
  lastDate: string;
  daysProcessed: number;
  failedDays: number;
}

const easternDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

function formatDateET(d: Date): string {
  return easternDateFormatter.format(d);
}

function getEasternUtcOffset(d: Date): number {
  const eastern = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((eastern.getTime() - utc.getTime()) / 60000);
}

function addOneDayToDateStr(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  const ny = next.getFullYear();
  const nm = String(next.getMonth() + 1).padStart(2, '0');
  const nd = String(next.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

function todayDateStrET(): string {
  return formatDateET(new Date());
}

function isIntercardConfigured(): boolean {
  return Boolean(INTERCARD_MAC_ID && INTERCARD_HOST);
}

export class IntercardService {
  private cachedToken: string | null = null;
  private tokenExpiresAt: number = 0;

  private async getAuthToken(): Promise<string | null> {
    if (!INTERCARD_CORP_ID || !INTERCARD_AUTH_KEY) {
      return null;
    }

    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const url = `${INTERCARD_HOST}${INTERCARD_TOKEN_PATH}/${INTERCARD_CORP_ID}/GetJwt`;
    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'auth_key': INTERCARD_AUTH_KEY,
        },
      });
      if (!response.ok) {
        logger.error('intercard.auth.token_error', { httpStatus: response.status });
        return null;
      }
      const token = await response.text();
      this.cachedToken = token.replace(/^"|"$/g, '');
      this.tokenExpiresAt = Date.now() + 50 * 60 * 1000;
      logger.info('intercard.auth.token_acquired');
      return this.cachedToken;
    } catch (err) {
      logger.error('intercard.auth.token_fetch_failed', errorContext(err));
      return null;
    }
  }

  async fetchRevenueByDateStr(startDateStr: string, endDateStr?: string): Promise<FetchResult> {
    if (!isIntercardConfigured()) {
      return { ok: false, rows: [], errorType: 'missing_config' };
    }

    const dateForOffset = new Date(startDateStr + 'T12:00:00');
    const utcOffset = String(getEasternUtcOffset(dateForOffset));
    const end = endDateStr || startDateStr;

    const params = new URLSearchParams({
      macId: INTERCARD_MAC_ID,
      startdate: startDateStr,
      enddate: end,
      utcOffset,
      isBusinessDay: 'true',
    });

    const url = `${INTERCARD_HOST}${INTERCARD_BASE_PATH}?${params.toString()}`;
    logger.info('intercard.fetch.start', { startDate: startDateStr, endDate: end });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const headers: Record<string, string> = { 'Accept': 'application/json' };
      const token = await this.getAuthToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(url, {
        signal: controller.signal,
        headers,
      });

      clearTimeout(timeout);

      if (response.status === 401 || response.status === 403) {
        logger.error('intercard.fetch.auth_error', { httpStatus: response.status });
        this.cachedToken = null;
        this.tokenExpiresAt = 0;
        return { ok: false, rows: [], errorType: 'auth_failed' };
      }

      if (!response.ok) {
        logger.error('intercard.fetch.api_error', { httpStatus: response.status });
        return { ok: false, rows: [], errorType: 'api_error' };
      }

      const data = await response.json();
      if (!Array.isArray(data)) {
        logger.error('intercard.fetch.parse_error');
        return { ok: false, rows: [], errorType: 'parse_error' };
      }

      logger.info('intercard.fetch.done', { count: data.length });
      return { ok: true, rows: data as IntercardRevenueRow[] };
    } catch (err) {
      logger.error('intercard.fetch.network_error', errorContext(err));
      return { ok: false, rows: [], errorType: 'network_error' };
    }
  }

  async syncSingleDay(dateStr: string): Promise<{
    ok: boolean;
    fetched: number;
    upserted: number;
    failed: number;
  }> {
    const result = { ok: false, fetched: 0, upserted: 0, failed: 0 };

    const fetchResult = await this.fetchRevenueByDateStr(dateStr);
    if (!fetchResult.ok) {
      return result;
    }

    result.ok = true;
    result.fetched = fetchResult.rows.length;

    await db.transaction(async (tx) => {
      await tx.delete(intercardRevenue)
        .where(eq(intercardRevenue.date, dateStr));

      if (fetchResult.rows.length === 0) return;

      try {
        await tx.insert(intercardRevenue).values(
          fetchResult.rows.map(row => ({
            date: dateStr,
            locationId: String(row.LocationID ?? ''),
            deviceType: String(row.DeviceType ?? ''),
            deviceName: String(row.DeviceName ?? ''),
            cashRevenue: Number(row.CashRevenue) || 0,
            creditCardRevenue: Number(row.CreditCardRevenue) || 0,
            cashRefunds: Number(row.CashRefunds) || 0,
            creditRefunds: Number(row.CreditRefunds) || 0,
            otherPayment: Number(row.OtherPayment) || 0,
            customerCardUse: Number(row.CustomerCardUse) || 0,
            revenue: Number(row.Revenue) || 0,
          }))
        );
        result.upserted += fetchResult.rows.length;
      } catch (err) {
        result.failed += fetchResult.rows.length;
        logger.error('intercard.insert_error', errorContext(err));
      }
    });

    return result;
  }

  async syncToday(): Promise<void> {
    if (!isIntercardConfigured()) return;

    // Cross-instance guard: only one instance runs the recurring Intercard
    // today-sync at a time. Released on every exit path.
    const lock = await tryAcquireSyncLock('intercard_today');
    if (!lock) {
      logger.info('intercard.today.lock_not_acquired');
      return;
    }

    try {
      const todayStr = formatDateET(new Date());
      const dayResult = await this.syncSingleDay(todayStr);
      if (dayResult.upserted > 0) {
        logger.info('intercard.today.synced', { upserted: dayResult.upserted });
      }
    } finally {
      await lock.release();
    }
  }

  async runHistoricalBackfill(): Promise<void> {
    if (!isIntercardConfigured()) {
      logger.info('intercard.backfill.skipped_unconfigured');
      return;
    }

    const syncType = 'intercard_backfill';
    const existingState = await db.select().from(syncState)
      .where(eq(syncState.syncType, syncType))
      .limit(1);

    if (existingState.length > 0 && existingState[0].isComplete && existingState[0].status === 'completed') {
      logger.info('intercard.backfill.already_complete');
      return;
    }

    const rawCheckpoint = existingState.length > 0 ? existingState[0].lastCheckpoint : null;
    const checkpoint: BackfillCheckpoint | null =
      rawCheckpoint && typeof rawCheckpoint === 'object' && 'lastDate' in rawCheckpoint
        ? rawCheckpoint as BackfillCheckpoint
        : null;

    const BACKFILL_START = '2025-01-01';
    const backfillEndStr = todayDateStrET();

    let currentDateStr = checkpoint?.lastDate
      ? addOneDayToDateStr(checkpoint.lastDate)
      : BACKFILL_START;

    if (currentDateStr < BACKFILL_START) currentDateStr = BACKFILL_START;

    logger.info('intercard.backfill.start', { startDate: currentDateStr, endDate: backfillEndStr });

    if (existingState.length === 0) {
      await db.insert(syncState).values({
        syncType,
        lastSyncedAt: new Date(),
        isComplete: false,
        status: 'in_progress',
        processedCount: 0,
        totalCount: 0,
      });
    } else {
      await db.update(syncState)
        .set({ status: 'in_progress', lastSyncedAt: new Date() })
        .where(eq(syncState.syncType, syncType));
    }

    let daysProcessed = checkpoint?.daysProcessed || 0;
    let failedDays = checkpoint?.failedDays || 0;
    let consecutiveFailures = 0;

    while (currentDateStr <= backfillEndStr) {
      try {
        const dayResult = await this.syncSingleDay(currentDateStr);

        if (dayResult.ok) {
          daysProcessed++;
          consecutiveFailures = 0;
        } else {
          failedDays++;
          consecutiveFailures++;
        }

        if (daysProcessed % 30 === 0 && daysProcessed > 0) {
          logger.info('intercard.backfill.progress', { daysProcessed, failedDays, currentDate: currentDateStr });
        }

        if (consecutiveFailures >= 10) {
          logger.error('intercard.backfill.paused', { consecutiveFailures, currentDate: currentDateStr });
          await db.update(syncState)
            .set({
              status: 'paused',
              lastSyncedAt: new Date(),
              processedCount: daysProcessed,
              lastCheckpoint: { lastDate: currentDateStr, daysProcessed, failedDays } satisfies BackfillCheckpoint,
              errorMessage: `Paused after ${consecutiveFailures} consecutive failures`,
            })
            .where(eq(syncState.syncType, syncType));
          return;
        }

        await db.update(syncState)
          .set({
            lastSyncedAt: new Date(),
            processedCount: daysProcessed,
            lastCheckpoint: { lastDate: currentDateStr, daysProcessed, failedDays } satisfies BackfillCheckpoint,
          })
          .where(eq(syncState.syncType, syncType));
      } catch (err) {
        logger.error('intercard.backfill.day_error', { ...errorContext(err), currentDate: currentDateStr });
        failedDays++;
      }

      currentDateStr = addOneDayToDateStr(currentDateStr);

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    if (failedDays > 0) {
      logger.warn('intercard.backfill.completed_with_errors', { failedDays, daysProcessed });
      await db.update(syncState)
        .set({
          isComplete: false,
          status: 'completed_with_errors',
          lastSyncedAt: new Date(),
          processedCount: daysProcessed,
          errorMessage: `${failedDays} days failed`,
        })
        .where(eq(syncState.syncType, syncType));
    } else {
      await db.update(syncState)
        .set({
          isComplete: true,
          status: 'completed',
          lastSyncedAt: new Date(),
          processedCount: daysProcessed,
          errorMessage: null,
        })
        .where(eq(syncState.syncType, syncType));
      logger.info('intercard.backfill.complete', { daysProcessed });
    }
  }

  async getRevenueForDateRange(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date,
  ): Promise<{ cash: number; credit: number; total: number }> {
    const { startStr, endStr } = getEasternBusinessDateStrings(dateRange, startDate, endDate);

    const result = await db.execute<{ total: number; cash: number; credit: number }>(sql`
      SELECT
        COALESCE(SUM(revenue), 0) as total,
        COALESCE(SUM(cash_revenue), 0) as cash,
        COALESCE(SUM(credit_card_revenue), 0) as credit
      FROM intercard_revenue
      WHERE date >= ${startStr} AND date <= ${endStr}
    `);

    return {
      cash: Number(result.rows[0]?.cash || 0),
      credit: Number(result.rows[0]?.credit || 0),
      total: Number(result.rows[0]?.total || 0),
    };
  }
}

export const intercardService = new IntercardService();
