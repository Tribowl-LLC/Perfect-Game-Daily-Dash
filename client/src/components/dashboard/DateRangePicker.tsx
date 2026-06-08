import { useState, useEffect } from "react";
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { DateRange } from "@shared/schema";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { format } from "date-fns";

interface DateRangePickerProps {
  value: DateRange;
  onValueChange: (range: DateRange, start?: Date, end?: Date) => void;
  customStartDate?: Date;
  customEndDate?: Date;
}

export default function DateRangePicker({ 
  value, 
  onValueChange, 
  customStartDate, 
  customEndDate 
}: DateRangePickerProps) {
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [tempStartDate, setTempStartDate] = useState<Date | undefined>(customStartDate);
  const [tempEndDate, setTempEndDate] = useState<Date | undefined>(customEndDate);
  const [calendarMode, setCalendarMode] = useState<'start' | 'end'>('start');

  // Sync with external state. Use functional updates to avoid reading
  // tempStartDate/tempEndDate as effect deps (they're only needed for
  // the conditional check, not as synchronization triggers).
  useEffect(() => {
    if (value !== 'custom') {
      setTempStartDate(undefined);
      setTempEndDate(undefined);
    } else {
      setTempStartDate((prev) => prev ?? customStartDate);
      setTempEndDate((prev) => prev ?? customEndDate);
    }
  }, [value, customStartDate, customEndDate]);

  const handleDateSelect = (date: Date | undefined) => {
    if (calendarMode === 'start') {
      setTempStartDate(date);
      setCalendarMode('end');
    } else {
      setTempEndDate(date);
      
      // Auto-apply if both dates are selected
      if (tempStartDate && date) {
        // Ensure end date is not before start date
        const finalEndDate = date < tempStartDate ? tempStartDate : date;
        onValueChange('custom', tempStartDate, finalEndDate);
        setIsCalendarOpen(false);
      }
    }
  };

  const handleValueChange = (newValue: string) => {
    if (newValue === 'custom') {
      setIsCalendarOpen(true);
      setCalendarMode('start');
      // Don't change value yet until dates are selected
    } else {
      onValueChange(newValue as DateRange);
    }
  };

  const handleCalendarCancel = () => {
    setIsCalendarOpen(false);
    // Reset to previous value if not custom
    if (value !== 'custom') {
      setTempStartDate(undefined);
      setTempEndDate(undefined);
    }
  };

  return (
    <div className="relative">
      <Select
        value={value}
        onValueChange={handleValueChange}
      >
        <SelectTrigger className="h-10 bg-white w-[180px]">
          <SelectValue placeholder="Select date range" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="today">Today</SelectItem>
          <SelectItem value="yesterday">Yesterday</SelectItem>
          <SelectItem value="last7days">Weekly</SelectItem>
          <SelectItem value="thisMonth">Monthly</SelectItem>
          <SelectItem value="yearToDate">Year to Date</SelectItem>
          <SelectItem value="custom">Custom Range</SelectItem>
        </SelectContent>
      </Select>

      {/* Calendar popover for custom date range */}
      <Popover open={isCalendarOpen} onOpenChange={setIsCalendarOpen}>
        <PopoverTrigger asChild>
          <div className="sr-only">Open calendar</div>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <div className="p-3">
            <h4 className="font-medium mb-2">
              {calendarMode === 'start' ? 'Select start date' : 'Select end date'}
            </h4>
            {tempStartDate && calendarMode === 'end' && (
              <p className="text-sm text-muted-foreground mb-2">
                Start date: {format(tempStartDate, 'PPP')}
              </p>
            )}
            <Calendar
              mode="single"
              selected={calendarMode === 'start' ? tempStartDate : tempEndDate}
              onSelect={handleDateSelect}
              disabled={
                calendarMode === 'end' && tempStartDate
                  ? { before: tempStartDate }
                  : undefined
              }
              initialFocus
            />
            <div className="flex justify-between mt-4">
              <Button variant="outline" size="sm" onClick={handleCalendarCancel}>
                Cancel
              </Button>
              <Button 
                variant="default" 
                size="sm" 
                disabled={!tempStartDate || (calendarMode === 'end' && !tempEndDate)}
                onClick={() => {
                  if (tempStartDate && tempEndDate) {
                    onValueChange('custom', tempStartDate, tempEndDate);
                    setIsCalendarOpen(false);
                  } else if (tempStartDate && calendarMode === 'start') {
                    // If only selecting start date, use it as both start and end
                    onValueChange('custom', tempStartDate, tempStartDate);
                    setTempEndDate(tempStartDate);
                    setIsCalendarOpen(false);
                  }
                }}
              >
                Apply
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
