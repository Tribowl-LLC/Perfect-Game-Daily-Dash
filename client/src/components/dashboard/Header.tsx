import { ChevronLeft, ChevronRight, Calendar, Activity, Clock } from "lucide-react";
import { DateRange } from "@shared/schema";
import { format, isSameDay, subDays, formatDistanceToNow } from "date-fns";
import { navigateDate, currentBusinessDayDateET } from "@/lib/dateUtils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useQuery } from "@tanstack/react-query";

interface HeaderProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
  onDateRangeChange: (range: DateRange, start?: Date, end?: Date) => void;
  onOpenTimeframeModal: () => void;
}

export default function Header({ 
  dateRange, 
  customStartDate, 
  customEndDate, 
  onDateRangeChange,
  onOpenTimeframeModal,
}: HeaderProps) {
  const { data: syncStatus } = useQuery<{ overallLastSynced: string | null }>({
    queryKey: ['/api/sync/status'],
    refetchInterval: false,
  });

  const lastSyncedLabel = (() => {
    if (!syncStatus?.overallLastSynced) return null;
    const d = new Date(syncStatus.overallLastSynced);
    return formatDistanceToNow(d, { addSuffix: true });
  })();

  // Format the current display date.
  // Use the 6am→6am Eastern business day so the label matches the stats below
  // (between midnight and 6am ET, "today" is still the previous calendar day).
  const today = currentBusinessDayDateET();

  let displayDate;
  
  if (customStartDate) {
    // If we have a custom start date, always use it for display
    if (customEndDate && !isSameDay(customStartDate, customEndDate)) {
      displayDate = `${format(customStartDate, 'MMM d')} - ${format(customEndDate, 'MMM d')}`;
    } else {
      displayDate = format(customStartDate, 'MMM d, yyyy');
    }
  } else {
    // Fall back to standard labels when no custom date is set
    displayDate = dateRange === 'today' 
      ? `Today, ${format(today, 'MMM d')}`
      : dateRange === 'yesterday'
        ? `Yesterday, ${format(subDays(today, 1), 'MMM d')}`
        : dateRange === 'thisMonth'
          ? `This Month`
          : dateRange === 'last7days'
            ? 'This Week'
            : dateRange === 'last30days'
              ? 'Last 30 Days'
              : dateRange === 'yearToDate'
                ? 'Year to Date'
                : dateRange === 'custom' && !customStartDate
                  ? 'Custom Range'
                  : format(today, 'MMM d, yyyy');
  }
  
  const handlePrevDate = (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = navigateDate('prev', dateRange, customStartDate, customEndDate);
    onDateRangeChange(result.dateRange, result.startDate, result.endDate);
  };

  const handleNextDate = (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = navigateDate('next', dateRange, customStartDate, customEndDate);
    onDateRangeChange(result.dateRange, result.startDate, result.endDate);
  };

  return (
    <header className="backdrop-blur-sm border-b border-border bg-card/80 px-4 py-4 pt-[calc(env(safe-area-inset-top,0px)+1rem)]">
      <div className="w-full max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center">
            <Activity className="h-8 w-8 text-primary mr-2" />
            <h1 className="text-2xl font-bold text-card-foreground">Perfect Game Analytics</h1>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <div className="flex items-center">
              <div className="flex items-center bg-background/90 p-1 rounded-lg shadow-lg border border-border md:mr-4">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="p-2 cursor-pointer hover:bg-accent/50 rounded-full transition-colors"
                        onClick={handlePrevDate}
                        aria-label="Previous date"
                      >
                        <ChevronLeft className="h-5 w-5 text-primary" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <p>Previous {dateRange === 'today' ? 'day' : dateRange === 'last7days' ? 'week' : dateRange === 'thisMonth' ? 'month' : dateRange === 'yearToDate' ? 'year' : 'period'}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                
                <button
                  type="button"
                  className="flex items-center gap-2 text-center font-medium text-foreground mx-2 cursor-pointer px-4 py-1.5 hover:bg-accent/50 rounded-md transition-colors"
                  onClick={onOpenTimeframeModal}
                >
                  <Calendar className="h-4 w-4 text-primary" />
                  <span>{displayDate}</span>
                </button>
                
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="p-2 cursor-pointer hover:bg-accent/50 rounded-full transition-colors"
                        onClick={handleNextDate}
                        aria-label="Next date"
                      >
                        <ChevronRight className="h-5 w-5 text-primary" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <p>Next {dateRange === 'today' ? 'day' : dateRange === 'last7days' ? 'week' : dateRange === 'thisMonth' ? 'month' : dateRange === 'yearToDate' ? 'year' : 'period'}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              
              <div className="hidden md:flex items-center gap-3">
                {lastSyncedLabel && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    <span>Synced {lastSyncedLabel}</span>
                  </div>
                )}
              </div>
            </div>
            
            {lastSyncedLabel && (
              <div className="flex md:hidden items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                <span>Synced {lastSyncedLabel}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
