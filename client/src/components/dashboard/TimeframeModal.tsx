import { useState, useEffect } from "react";
import { 
  Drawer, 
  DrawerContent, 
  DrawerHeader, 
  DrawerTitle,
  DrawerClose
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { DateRange } from "@shared/schema";
import { Calendar, ArrowLeft, CheckCircle } from "lucide-react";
import { format, addDays, isAfter, isBefore, isSameDay } from "date-fns";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";

interface TimeframeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
  onDateRangeChange: (range: DateRange, start?: Date, end?: Date) => void;
}

export default function TimeframeModal({
  open,
  onOpenChange,
  dateRange,
  customStartDate,
  customEndDate,
  onDateRangeChange
}: TimeframeModalProps) {
  const [selectedRange, setSelectedRange] = useState<DateRange>(dateRange);
  const [startDate, setStartDate] = useState<Date | undefined>(customStartDate);
  const [endDate, setEndDate] = useState<Date | undefined>(customEndDate);
  const [calendarOpen, setCalendarOpen] = useState(false);
  
  // Update selected range when dateRange prop changes
  useEffect(() => {
    setSelectedRange(dateRange);
  }, [dateRange]);

  // Update custom dates when props change
  useEffect(() => {
    setStartDate(customStartDate);
    setEndDate(customEndDate);
  }, [customStartDate, customEndDate]);

  const handleSelectRange = (newRange: DateRange) => {
    setSelectedRange(newRange);
    
    // If custom date is selected, keep the drawer open for date selection
    if (newRange === 'custom') {
      // Initialize with current date if no dates are set
      if (!startDate) {
        const today = new Date();
        setStartDate(today);
        setEndDate(today);
      }
      setCalendarOpen(true);
      return;
    }
    
    // For standard date ranges, close the drawer and apply
    onDateRangeChange(newRange);
    onOpenChange(false);
  };

  const handleDateSelect = (date: Date | undefined) => {
    if (!date) return;
    
    if (!startDate || (startDate && endDate)) {
      // Start a new selection
      setStartDate(date);
      setEndDate(undefined);
    } else {
      // Complete the selection
      if (isBefore(date, startDate)) {
        setEndDate(startDate);
        setStartDate(date);
      } else {
        setEndDate(date);
      }
    }
  };

  const handleApplyCustomDates = () => {
    if (startDate && endDate) {
      onDateRangeChange('custom', startDate, endDate);
      onOpenChange(false);
    }
  };

  const timeframes: { label: string, value: DateRange }[] = [
    { label: "Today", value: "today" },
    { label: "Weekly", value: "last7days" },
    { label: "Monthly", value: "thisMonth" },
    { label: "Year to Date", value: "yearToDate" },
    { label: "Custom date", value: "custom" },
  ];

  
  // Custom date selection display
  const getDateRangePreview = () => {
    if (!startDate) return "Select start date";
    if (!endDate) return `From ${format(startDate, "MMM d, yyyy")}`;
    
    if (isSameDay(startDate, endDate)) {
      return format(startDate, "MMMM d, yyyy");
    }
    return `${format(startDate, "MMM d")} - ${format(endDate, "MMM d, yyyy")}`;
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="bg-gradient-to-b from-gray-900 to-black border-t border-white/10 rounded-t-xl overflow-hidden backdrop-blur-sm" aria-describedby="timeframe-description">
        <DrawerHeader>
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
            <DrawerTitle className="text-xl font-semibold text-white">Select Timeframe</DrawerTitle>
            <DrawerClose asChild>
              <Button variant="outline" className="bg-black/30 border-white/20 text-white hover:bg-white/10 px-4 py-1 h-auto">
                Done
              </Button>
            </DrawerClose>
          </div>
          <div className="sr-only" id="timeframe-description">
            Select a timeframe for your dashboard data
          </div>
        </DrawerHeader>
        <div className={`px-6 py-4 ${calendarOpen ? 'overflow-y-auto max-h-[70vh]' : ''}`}>
          {/* Predefined timeframes */}
          {!calendarOpen && (
            <>
              <div className="space-y-2 mt-2">
                {timeframes.map((timeframe) => (
                  <div
                    key={timeframe.value}
                    role="button"
                    tabIndex={0}
                    className={`p-3 rounded-lg flex items-center justify-between cursor-pointer transition-all ${
                      selectedRange === timeframe.value 
                        ? "bg-primary text-white shadow-lg shadow-primary/20" 
                        : "bg-white/5 hover:bg-white/10 text-white border border-white/5"
                    }`}
                    onClick={() => handleSelectRange(timeframe.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelectRange(timeframe.value); } }}
                  >
                    <span className="font-medium">{timeframe.label}</span>
                    {selectedRange === timeframe.value && (
                      <CheckCircle className="h-5 w-5" />
                    )}
                  </div>
                ))}
              </div>

            </>
          )}

          {/* Calendar for custom date selection */}
          {calendarOpen && (
            <div className="mt-2">
              <Button 
                variant="ghost" 
                className="mb-6 text-white/70 hover:text-white flex items-center gap-2"
                onClick={() => setCalendarOpen(false)}
              >
                <ArrowLeft className="h-4 w-4" />
                <span>Back to timeframes</span>
              </Button>
              
              <div className="mb-4">
                <h3 className="text-lg font-bold text-white mb-1">Custom date range</h3>
                <p className="text-white/60 text-sm">
                  {!startDate 
                    ? "Tap a start date" 
                    : !endDate 
                      ? "Now tap an end date" 
                      : "Tap a date card to change it"}
                </p>
              </div>

              <div className="flex gap-3 mb-4">
                <button
                  className={`flex-1 p-3 rounded-lg border text-left cursor-pointer transition-all ${startDate ? 'border-primary bg-primary/10 hover:bg-primary/20' : 'border-white/10 bg-white/5'}`}
                  onClick={() => { setStartDate(undefined); setEndDate(undefined); }}
                >
                  <p className="text-white/50 text-xs mb-1">Start</p>
                  <p className="text-white font-medium text-sm">{startDate ? format(startDate, "MMM d, yyyy") : "—"}</p>
                </button>
                <button
                  className={`flex-1 p-3 rounded-lg border text-left cursor-pointer transition-all ${endDate ? 'border-primary bg-primary/10 hover:bg-primary/20' : 'border-white/10 bg-white/5'}`}
                  onClick={() => { if (endDate) setEndDate(undefined); }}
                >
                  <p className="text-white/50 text-xs mb-1">End</p>
                  <p className="text-white font-medium text-sm">{endDate ? format(endDate, "MMM d, yyyy") : "—"}</p>
                </button>
              </div>
              
              <div className="bg-black/40 p-6 rounded-xl border border-white/10 shadow-lg">
                <CalendarComponent
                  mode="range"
                  selected={{
                    from: startDate,
                    to: endDate
                  }}
                  onSelect={(range) => {
                    if (range?.from) setStartDate(range.from);
                    setEndDate(range?.to || undefined);
                  }}
                  disabled={{
                    after: new Date()
                  }}
                  className="mx-auto"
                  classNames={{
                    caption_label: "text-sm font-medium text-white",
                    head_cell: "text-white/70 rounded-md w-9 font-normal text-[0.8rem]",
                    day: "h-9 w-9 p-0 font-normal text-white hover:bg-white/10 hover:text-white aria-selected:opacity-100 inline-flex items-center justify-center rounded-md text-sm ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    day_selected: "bg-primary text-white hover:bg-primary hover:text-white focus:bg-primary focus:text-white",
                    day_today: "bg-white/10 text-white",
                    day_outside: "day-outside text-white/40 aria-selected:bg-accent/50 aria-selected:text-white/50",
                    day_disabled: "text-white/40",
                    day_range_middle: "aria-selected:bg-primary/20 aria-selected:text-white",
                    nav_button: "h-7 w-7 bg-transparent p-0 text-white opacity-70 hover:opacity-100 border border-white/20 rounded-md inline-flex items-center justify-center",
                  }}
                />
              </div>
              
              <div className="mt-4 flex justify-end">
                <Button 
                  className="bg-primary hover:bg-primary/90 text-white font-medium py-2 px-6 shadow-lg shadow-primary/30"
                  onClick={handleApplyCustomDates}
                  disabled={!startDate || !endDate}
                >
                  Apply
                </Button>
              </div>
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}