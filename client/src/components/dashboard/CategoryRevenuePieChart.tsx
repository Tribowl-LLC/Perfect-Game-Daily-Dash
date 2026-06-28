import { useQuery } from "@tanstack/react-query";
import { LabelList, Pie, PieChart } from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import type { CategoryRevenueTotal, DateRange } from "@shared/schema";
import { fetchCategoryTotals } from "@/lib/squareApi";

const SLICE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "hsl(280 65% 60%)",
  "hsl(25 80% 55%)",
  "hsl(180 50% 45%)",
];

const HIDDEN_NAMES = new Set(["online menu", "pg party menu"]);

const fmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

interface Props {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

export default function CategoryRevenuePieChart({
  dateRange,
  customStartDate,
  customEndDate,
}: Props) {
  const { data: rawTotals, isLoading, isError } = useQuery<CategoryRevenueTotal[]>({
    queryKey: [
      "/api/items/category-totals",
      dateRange,
      customStartDate?.toISOString(),
      customEndDate?.toISOString(),
    ],
    queryFn: () => fetchCategoryTotals(dateRange, customStartDate, customEndDate),
  });

  const totals = (rawTotals ?? []).filter(
    (t) => !HIDDEN_NAMES.has(t.categoryName.trim().toLowerCase()) && t.revenue > 0,
  );

  // Strip " Income" suffix for concise slice labels
  const shortName = (name: string) => name.replace(/ Income$/i, "");

  const chartData = totals.map((t, i) => ({
    id: t.categoryId,
    name: shortName(t.categoryName),
    fullName: t.categoryName,
    revenue: t.revenue,
    fill: SLICE_COLORS[i % SLICE_COLORS.length],
  }));

  const chartConfig: ChartConfig = Object.fromEntries(
    chartData.map((d) => [d.id, { label: d.name, color: d.fill }]),
  );

  const totalRevenue = totals.reduce((sum, t) => sum + t.revenue, 0);

  return (
    <Card>
      <CardHeader className="items-center pb-0">
        <CardTitle>Revenue by Category</CardTitle>
        {!isLoading && !isError && totalRevenue > 0 && (
          <CardDescription>
            {fmt.format(totalRevenue)} total
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="pb-4">
        {isLoading && (
          <div className="flex items-center justify-center h-[300px]">
            <Skeleton className="h-[260px] w-[260px] rounded-full" />
          </div>
        )}
        {isError && !isLoading && (
          <div className="flex items-center justify-center h-[300px] text-sm text-destructive">
            Failed to load category revenue.
          </div>
        )}
        {!isLoading && !isError && chartData.length === 0 && (
          <div className="flex items-center justify-center h-[300px] text-sm text-muted-foreground">
            No sales data for this period.
          </div>
        )}
        {!isLoading && !isError && chartData.length > 0 && (
          <ChartContainer
            config={chartConfig}
            className="mx-auto aspect-square max-h-[300px] [&_.recharts-text]:fill-background"
          >
            <PieChart>
              <ChartTooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0]?.payload as typeof chartData[number];
                  return (
                    <div className="rounded-lg border bg-background px-3 py-2 shadow-sm text-sm">
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                          style={{ background: d?.fill }}
                        />
                        <span className="font-medium">{d?.fullName}</span>
                      </div>
                      <div className="tabular-nums text-muted-foreground pl-[18px]">
                        {fmt.format(d?.revenue ?? 0)}
                        {totalRevenue > 0 && (
                          <span className="ml-1 text-xs">
                            ({((d?.revenue / totalRevenue) * 100).toFixed(1)}%)
                          </span>
                        )}
                      </div>
                    </div>
                  );
                }}
              />
              <Pie data={chartData} dataKey="revenue" nameKey="name">
                <LabelList
                  dataKey="name"
                  className="fill-background"
                  stroke="none"
                  fontSize={11}
                />
              </Pie>
            </PieChart>
          </ChartContainer>
        )}

        {/* Legend row below the chart */}
        {!isLoading && !isError && chartData.length > 0 && (
          <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
            {chartData.map((d) => (
              <div key={d.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                  style={{ background: d.fill }}
                />
                <span>{d.name}</span>
                <span className="tabular-nums font-medium text-foreground">
                  {fmt.format(d.revenue)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
