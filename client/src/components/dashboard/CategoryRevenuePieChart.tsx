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

// Blue-shade palette (light → dark), matching the shadcn pie-chart example.
// Largest slice (first, revenue-sorted) gets the lightest shade.
const SLICE_COLORS = [
  "hsl(213, 90%, 72%)",
  "hsl(215, 89%, 64%)",
  "hsl(217, 91%, 56%)",
  "hsl(221, 83%, 49%)",
  "hsl(224, 76%, 42%)",
  "hsl(226, 71%, 34%)",
  "hsl(228, 64%, 27%)",
  "hsl(229, 60%, 20%)",
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

  // Concise slice labels: explicit overrides first, else strip " Income" suffix
  const LABEL_OVERRIDES: Record<string, string> = {
    "shoe rental income": "Shoes",
  };
  const shortName = (name: string) =>
    LABEL_OVERRIDES[name.trim().toLowerCase()] ?? name.replace(/ Income$/i, "");

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
                  fontSize={12}
                />
              </Pie>
            </PieChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
