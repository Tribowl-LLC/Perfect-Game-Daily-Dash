import { DateRange } from "@shared/schema";
import { format, subDays, addDays, startOfMonth, endOfMonth, subMonths, addMonths, isSameDay, getDate } from "date-fns";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";

export const EASTERN_TIMEZONE = 'America/New_York';

/** Hour at which a new business day begins in Eastern Time (matches Square). */
const BUSINESS_DAY_START_HOUR = 6;

// Convert a UTC date to Eastern Time
export function toEasternTime(date: Date): Date {
  return toZonedTime(date, EASTERN_TIMEZONE);
}

// Format a date with timezone awareness
export function formatInTimezone(date: Date, fmt: string, timezone: string = 'America/New_York'): string {
  return formatInTimeZone(date, timezone, fmt);
}

/**
 * Returns the current business day as a plain yyyy-MM-dd string in Eastern Time.
 * Before 6 AM ET the business day is still the previous calendar date,
 * matching Square's 6 AM → 6 AM daily reporting boundary.
 */
export function currentBusinessDayET(now: Date = new Date()): string {
  const calendarDate = formatInTimeZone(now, EASTERN_TIMEZONE, 'yyyy-MM-dd');
  const hourET = parseInt(formatInTimeZone(now, EASTERN_TIMEZONE, 'H'), 10);

  if (hourET < BUSINESS_DAY_START_HOUR) {
    const [y, m, d] = calendarDate.split('-').map(Number);
    return format(new Date(y, m - 1, d - 1), 'yyyy-MM-dd');
  }

  return calendarDate;
}

/**
 * Build a plain local Date (midnight, no timezone) from a yyyy-MM-dd string.
 * Used only for date arithmetic (subDays, addDays, isSameDay) — never for queries.
 */
function localDateFrom(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Returns the active 6am→6am Eastern business day as a local Date at midnight,
 * suitable for date-fns formatting/arithmetic. Before 6 AM ET this returns the
 * previous calendar day so display labels match the underlying business-day stats.
 */
export function currentBusinessDayDateET(now: Date = new Date()): Date {
  return localDateFrom(currentBusinessDayET(now));
}

export function getFormattedDate(dateRange: DateRange, customStartDate?: Date, customEndDate?: Date): string {
  const now = new Date();
  const todayETStr = currentBusinessDayET(now);
  const todayET = localDateFrom(todayETStr);

  switch (dateRange) {
    case "today":
      return format(todayET, 'MMMM d, yyyy');
    case "yesterday": {
      const yest = subDays(todayET, 1);
      return format(yest, 'MMMM d, yyyy');
    }
    case "last7days": {
      const start = subDays(todayET, 6);
      return `${format(start, 'MMM d')} - ${format(todayET, 'MMMM d, yyyy')}`;
    }
    case "last30days": {
      const start = subDays(todayET, 29);
      return `${format(start, 'MMM d')} - ${format(todayET, 'MMMM d, yyyy')}`;
    }
    case "thisMonth":
      return format(todayET, 'MMMM yyyy');
    case "lastMonth":
      return format(subMonths(todayET, 1), 'MMMM yyyy');
    case "yearToDate":
      return `Jan 1 - ${format(todayET, 'MMMM d, yyyy')}`;
    case "custom":
      if (!customStartDate || !customEndDate) {
        return format(todayET, 'MMMM d, yyyy');
      }
      if (formatInTimeZone(customStartDate, EASTERN_TIMEZONE, 'yyyy-MM-dd') === formatInTimeZone(customEndDate, EASTERN_TIMEZONE, 'yyyy-MM-dd')) {
        return formatInTimeZone(customStartDate, EASTERN_TIMEZONE, 'MMMM d, yyyy');
      }
      {
        const startLocal = localDateFrom(formatInTimeZone(customStartDate, EASTERN_TIMEZONE, 'yyyy-MM-dd'));
        const endLocal = localDateFrom(formatInTimeZone(customEndDate, EASTERN_TIMEZONE, 'yyyy-MM-dd'));
        if (getDate(startLocal) === 1 && isSameDay(endLocal, endOfMonth(startLocal))) {
          return format(startLocal, 'MMMM yyyy');
        }
      }
      return `${formatInTimeZone(customStartDate, EASTERN_TIMEZONE, 'MMM d')} - ${formatInTimeZone(customEndDate, EASTERN_TIMEZONE, 'MMM d, yyyy')}`;
    default:
      return format(todayET, 'MMMM d, yyyy');
  }
}

export function navigateDate(
  direction: 'prev' | 'next',
  currentDateRange: DateRange,
  customStartDate?: Date,
  customEndDate?: Date
): { 
  dateRange: DateRange, 
  startDate?: Date, 
  endDate?: Date 
} {
  // Use the 6am-aware business day as the "today" reference for all comparisons
  const todayETStr = currentBusinessDayET();
  const today = localDateFrom(todayETStr);

  // Normalize input dates to midnight for consistent comparison
  let normalizedStartDate: Date | undefined;
  let normalizedEndDate: Date | undefined;

  if (customStartDate) {
    normalizedStartDate = new Date(customStartDate);
    normalizedStartDate.setHours(0, 0, 0, 0);
  }

  if (customEndDate) {
    normalizedEndDate = new Date(customEndDate);
    normalizedEndDate.setHours(0, 0, 0, 0);
  }

  switch (currentDateRange) {
    case 'today':
      if (normalizedStartDate) {
        if (direction === 'prev') {
          if (isSameDay(normalizedStartDate, today)) {
            return { dateRange: 'yesterday', startDate: undefined, endDate: undefined };
          }
          const prevDate = subDays(normalizedStartDate, 1);
          return { dateRange: 'custom', startDate: prevDate, endDate: prevDate };
        } else {
          if (isSameDay(normalizedStartDate, today)) {
            return { dateRange: 'today', startDate: undefined, endDate: undefined };
          }
          const nextDate = addDays(normalizedStartDate, 1);
          if (nextDate > today) {
            return { dateRange: 'today', startDate: undefined, endDate: undefined };
          }
          if (isSameDay(nextDate, today)) {
            return { dateRange: 'today', startDate: undefined, endDate: undefined };
          }
          return { dateRange: 'custom', startDate: nextDate, endDate: nextDate };
        }
      } else {
        if (direction === 'prev') {
          return { dateRange: 'yesterday', startDate: undefined, endDate: undefined };
        }
        return { dateRange: 'today', startDate: undefined, endDate: undefined };
      }

    case 'yesterday':
      if (direction === 'prev') {
        const twoDaysAgo = subDays(today, 2);
        return { dateRange: 'custom', startDate: twoDaysAgo, endDate: twoDaysAgo };
      } else {
        return { dateRange: 'today', startDate: undefined, endDate: undefined };
      }

    case 'last7days':
      if (normalizedStartDate && normalizedEndDate) {
        const rangeDays = Math.round((normalizedEndDate.getTime() - normalizedStartDate.getTime()) / (1000 * 60 * 60 * 24));
        if (direction === 'prev') {
          const newStartDate = subDays(normalizedStartDate, rangeDays + 1);
          const newEndDate = subDays(normalizedStartDate, 1);
          return { dateRange: 'custom', startDate: newStartDate, endDate: newEndDate };
        } else {
          const newStartDate = addDays(normalizedEndDate, 1);
          if (isSameDay(addDays(newStartDate, rangeDays), today) || addDays(newStartDate, rangeDays) > today) {
            return { dateRange: 'last7days', startDate: undefined, endDate: undefined };
          } else {
            const newEndDate = addDays(normalizedEndDate, rangeDays + 1);
            return { dateRange: 'custom', startDate: newStartDate, endDate: newEndDate };
          }
        }
      } else if (direction === 'prev') {
        const prevWeekStart = subDays(today, 13);
        const prevWeekEnd = subDays(today, 7);
        return { dateRange: 'custom', startDate: prevWeekStart, endDate: prevWeekEnd };
      } else {
        return { dateRange: 'last7days', startDate: undefined, endDate: undefined };
      }

    case 'last30days':
      if (normalizedStartDate && normalizedEndDate) {
        const rangeDays = Math.round((normalizedEndDate.getTime() - normalizedStartDate.getTime()) / (1000 * 60 * 60 * 24));
        if (direction === 'prev') {
          const newStartDate = subDays(normalizedStartDate, rangeDays + 1);
          const newEndDate = subDays(normalizedStartDate, 1);
          return { dateRange: 'custom', startDate: newStartDate, endDate: newEndDate };
        } else {
          const newStartDate = addDays(normalizedEndDate, 1);
          if (isSameDay(addDays(newStartDate, rangeDays), today) || addDays(newStartDate, rangeDays) > today) {
            return { dateRange: 'last30days', startDate: undefined, endDate: undefined };
          } else {
            const newEndDate = addDays(normalizedEndDate, rangeDays + 1);
            return { dateRange: 'custom', startDate: newStartDate, endDate: newEndDate };
          }
        }
      } else if (direction === 'prev') {
        const prevMonthStart = subDays(today, 59);
        const prevMonthEnd = subDays(today, 30);
        return { dateRange: 'custom', startDate: prevMonthStart, endDate: prevMonthEnd };
      } else {
        return { dateRange: 'last30days', startDate: undefined, endDate: undefined };
      }

    case 'thisMonth':
      if (direction === 'prev') {
        const lastMonthStart = startOfMonth(subMonths(today, 1));
        const lastMonthEnd = endOfMonth(subMonths(today, 1));
        return { dateRange: 'custom', startDate: lastMonthStart, endDate: lastMonthEnd };
      } else {
        return { dateRange: 'thisMonth', startDate: undefined, endDate: undefined };
      }

    case 'lastMonth':
      if (direction === 'prev') {
        const twoMonthsAgoStart = startOfMonth(subMonths(today, 2));
        const twoMonthsAgoEnd = endOfMonth(subMonths(today, 2));
        return { dateRange: 'custom', startDate: twoMonthsAgoStart, endDate: twoMonthsAgoEnd };
      } else {
        return { dateRange: 'thisMonth', startDate: undefined, endDate: undefined };
      }

    case 'yearToDate':
      if (direction === 'prev') {
        const prevYear = today.getFullYear() - 1;
        const prevYearStart = new Date(prevYear, 0, 1);
        const prevYearEnd = new Date(prevYear, 11, 31);
        return { dateRange: 'custom', startDate: prevYearStart, endDate: prevYearEnd };
      } else {
        return { dateRange: 'yearToDate', startDate: undefined, endDate: undefined };
      }

    case 'custom':
      if (normalizedStartDate && normalizedEndDate) {
        const rangeDays = Math.round((normalizedEndDate.getTime() - normalizedStartDate.getTime()) / (1000 * 60 * 60 * 24));

        if (rangeDays === 0) {
          if (direction === 'prev') {
            const prevDay = subDays(normalizedStartDate, 1);
            return { dateRange: 'custom', startDate: new Date(prevDay), endDate: new Date(prevDay) };
          } else {
            const nextDay = addDays(normalizedStartDate, 1);
            if (nextDay > today) {
              return { dateRange: 'today', startDate: undefined, endDate: undefined };
            }
            if (isSameDay(nextDay, subDays(today, 1))) {
              return { dateRange: 'yesterday', startDate: undefined, endDate: undefined };
            }
            if (isSameDay(nextDay, today)) {
              return { dateRange: 'today', startDate: undefined, endDate: undefined };
            }
            return { dateRange: 'custom', startDate: new Date(nextDay), endDate: new Date(nextDay) };
          }
        }

        const isFullMonth = getDate(normalizedStartDate) === 1
          && isSameDay(normalizedEndDate, endOfMonth(normalizedStartDate));

        if (isFullMonth) {
          if (direction === 'prev') {
            const prevMonthStart = startOfMonth(subMonths(normalizedStartDate, 1));
            const prevMonthEnd = endOfMonth(prevMonthStart);
            return { dateRange: 'custom', startDate: new Date(prevMonthStart), endDate: new Date(prevMonthEnd) };
          } else {
            const nextMonthStart = startOfMonth(addMonths(normalizedStartDate, 1));
            if (nextMonthStart > today) {
              return { dateRange: 'thisMonth', startDate: undefined, endDate: undefined };
            }
            const nextMonthEnd = endOfMonth(nextMonthStart);
            if (nextMonthEnd >= today) {
              return { dateRange: 'thisMonth', startDate: undefined, endDate: undefined };
            }
            return { dateRange: 'custom', startDate: new Date(nextMonthStart), endDate: new Date(nextMonthEnd) };
          }
        }

        if (direction === 'prev') {
          const newStartDate = subDays(normalizedStartDate, rangeDays + 1);
          const newEndDate = subDays(normalizedStartDate, 1);
          return { dateRange: 'custom', startDate: new Date(newStartDate), endDate: new Date(newEndDate) };
        } else {
          const newStartDate = addDays(normalizedEndDate, 1);
          const newEndDate = addDays(normalizedEndDate, rangeDays + 1);
          if (newEndDate > today) {
            if (newStartDate < today) {
              return { dateRange: 'custom', startDate: new Date(newStartDate), endDate: new Date(today) };
            } else {
              return { dateRange: 'today', startDate: undefined, endDate: undefined };
            }
          }
          return { dateRange: 'custom', startDate: new Date(newStartDate), endDate: new Date(newEndDate) };
        }
      } else {
        return { dateRange: 'today', startDate: undefined, endDate: undefined };
      }

    default:
      return { dateRange: 'today', startDate: undefined, endDate: undefined };
  }
}

export function isPositiveChange(value: number): boolean {
  return value >= 0;
}

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percentageFormatter = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function formatCurrency(value: number): string {
  return currencyFormatter.format(value);
}

export function formatPercentage(value: number): string {
  return percentageFormatter.format(value);
}
