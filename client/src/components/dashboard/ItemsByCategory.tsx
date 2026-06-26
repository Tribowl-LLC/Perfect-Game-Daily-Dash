/**
 * Items by Category — Dashboard panel (Task #188)
 *
 * Renders one side of the Items tab: a single rollup (e.g. "Food") with
 * its own category dropdown (rollup parent + every child) and its own
 * Revenue / Units / Transactions metric toggle. Below the controls is
 * the full ranked list of every non-archived item in the chosen
 * category for the current dashboard date range. Items with zero sales
 * are kept in the list (rendered at the bottom) so the operator can
 * see what nobody bought.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CategoryTreeNode,
  DateRange,
  ItemMetric,
  RankedItem,
} from "@shared/schema";
import { fetchRankedItems } from "@/lib/squareApi";

interface ItemsByCategoryProps {
  rollup: CategoryTreeNode;
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

const ALL_VALUE = "__all__";

/** Flatten a category tree into a depth-annotated list for the dropdown. */
function flattenDescendants(
  nodes: CategoryTreeNode[],
  depth = 0,
): { node: CategoryTreeNode; depth: number }[] {
  const out: { node: CategoryTreeNode; depth: number }[] = [];
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (n.children.length > 0) out.push(...flattenDescendants(n.children, depth + 1));
  }
  return out;
}

const revenueFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const intFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const formatRevenue = (n: number) => revenueFormatter.format(n);
const formatInt = (n: number) => intFormatter.format(n);
const formatPercent = (n: number) => `${(n * 100).toFixed(n >= 0.1 ? 1 : 2)}%`;

const metricValue = (item: RankedItem, metric: ItemMetric): number =>
  metric === "revenue"
    ? item.revenue
    : metric === "units"
    ? item.units
    : item.transactions;

const formatMetric = (item: RankedItem, metric: ItemMetric): string =>
  metric === "revenue"
    ? formatRevenue(item.revenue)
    : metric === "units"
    ? formatInt(item.units)
    : formatInt(item.transactions);

const formatSourceMix = (item: RankedItem, metric: ItemMetric): string => {
  const total = metricValue(item, metric);
  if (total <= 0 || item.sourceBreakdown.length === 0) return "—";

  return item.sourceBreakdown
    .slice(0, 2)
    .map((source) => {
      const value =
        metric === "revenue"
          ? source.revenue
          : metric === "units"
          ? source.units
          : source.transactions;
      return `${source.source} ${formatPercent(value / total)}`;
    })
    .join(" / ");
};

export default function ItemsByCategory({
  rollup,
  dateRange,
  customStartDate,
  customEndDate,
}: ItemsByCategoryProps) {
  // ALL = the rollup itself (server expands descendants). Children are
  // sub-categories whose IDs come straight from Square.
  const [selection, setSelection] = useState<string>(ALL_VALUE);
  const [metric, setMetric] = useState<ItemMetric>("revenue");

  const selectedCategoryId =
    selection === ALL_VALUE ? rollup.squareCategoryId : selection;

  const showCategoryColumn = selection === ALL_VALUE && rollup.children.length > 0;
  const columnCount = showCategoryColumn ? 7 : 6;

  const queryKey = [
    "/api/items/ranked",
    selectedCategoryId,
    metric,
    dateRange,
    customStartDate?.toISOString(),
    customEndDate?.toISOString(),
  ];

  const { data: items, isLoading, isError } = useQuery<RankedItem[]>({
    queryKey,
    queryFn: () =>
      fetchRankedItems(
        selectedCategoryId,
        metric,
        dateRange,
        customStartDate,
        customEndDate,
      ),
  });

  const totals = useMemo(() => {
    if (!items || items.length === 0) {
      return { revenue: 0, units: 0, transactions: 0 };
    }
    return items.reduce(
      (acc, i) => ({
        revenue: acc.revenue + i.revenue,
        units: acc.units + i.units,
        transactions: acc.transactions + i.transactions,
      }),
      { revenue: 0, units: 0, transactions: 0 },
    );
  }, [items]);

  const totalLabel =
    metric === "revenue"
      ? formatRevenue(totals.revenue)
      : metric === "units"
      ? `${formatInt(totals.units)} units`
      : `${formatInt(totals.transactions)} transactions`;

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-lg">{rollup.name}</CardTitle>
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {totalLabel}
          </span>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 mt-3">
          <Select value={selection} onValueChange={setSelection}>
            <SelectTrigger className="h-9 bg-white sm:w-[200px]" data-testid={`select-category-${rollup.squareCategoryId}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_VALUE}>All {rollup.name}</SelectItem>
              {flattenDescendants(rollup.children).map(({ node, depth }) => (
                <SelectItem
                  key={node.squareCategoryId}
                  value={node.squareCategoryId}
                >
                  {depth > 0 ? "\u00A0".repeat(depth * 3) + "› " : ""}{node.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ToggleGroup
            type="single"
            value={metric}
            onValueChange={(v) => {
              if (v === "revenue" || v === "units" || v === "transactions") {
                setMetric(v);
              }
            }}
            className="justify-start"
          >
            <ToggleGroupItem value="revenue" aria-label="Revenue" className="h-9 px-3 text-xs">
              Revenue
            </ToggleGroupItem>
            <ToggleGroupItem value="units" aria-label="Units sold" className="h-9 px-3 text-xs">
              Units
            </ToggleGroupItem>
            <ToggleGroupItem value="transactions" aria-label="Transactions" className="h-9 px-3 text-xs">
              Transactions
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0">
        <div className="max-h-[600px] overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow>
                <TableHead className="w-12 text-right">#</TableHead>
                <TableHead>Item</TableHead>
                {showCategoryColumn && <TableHead>Category</TableHead>}
                <TableHead className="text-right">
                  {metric === "revenue"
                    ? "Revenue"
                    : metric === "units"
                    ? "Units"
                    : "Txns"}
                </TableHead>
                <TableHead className="text-right">% Cat</TableHead>
                <TableHead className="text-right">% Total</TableHead>
                <TableHead>Source Mix</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={`sk-${i}`}>
                    <TableCell><Skeleton className="h-4 w-6 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-40" /></TableCell>
                    {showCategoryColumn && <TableCell><Skeleton className="h-4 w-24" /></TableCell>}
                    <TableCell><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                  </TableRow>
                ))
              )}
              {isError && !isLoading && (
                <TableRow>
                  <TableCell colSpan={columnCount} className="text-center text-sm text-destructive py-6">
                    Failed to load items.
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && !isError && items && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={columnCount} className="text-center text-sm text-muted-foreground py-6">
                    No items found for this category.
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && !isError && items && (() => {
                const baseNamesWithMultipleVariants = new Set<string>();
                for (const it of items) {
                  const base = it.itemName.replace(/ - Regular$/i, '');
                  if (base !== it.itemName) {
                    if (items.some(other => other.catalogObjectId !== it.catalogObjectId && other.itemName.startsWith(base + ' - '))) {
                      baseNamesWithMultipleVariants.add(base);
                    }
                  }
                }
                const displayName = (name: string) => {
                  const base = name.replace(/ - Regular$/i, '');
                  return baseNamesWithMultipleVariants.has(base) ? name : base;
                };
                return items.map((item, idx) => {
                const isZero = metricValue(item, metric) === 0;
                return (
                  <TableRow
                    key={item.catalogObjectId}
                    data-testid={`row-item-${item.catalogObjectId}`}
                    className={isZero ? "text-muted-foreground" : ""}
                  >
                    <TableCell className="text-right tabular-nums">{idx + 1}</TableCell>
                    <TableCell className="font-medium">{displayName(item.itemName)}</TableCell>
                    {showCategoryColumn && (
                      <TableCell className="text-sm text-muted-foreground">
                        {item.categoryName || "—"}
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">
                      {formatMetric(item, metric)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPercent(item.shareOfCategory)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPercent(item.shareOfTotal)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatSourceMix(item, metric)}
                    </TableCell>
                  </TableRow>
                );
              });
              })()}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
