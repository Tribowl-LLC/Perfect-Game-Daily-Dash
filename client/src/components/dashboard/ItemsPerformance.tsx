/**
 * Items tab content
 *
 * Loads the Square category tree and renders one ItemsByCategory panel
 * per top-level rollup that has children, in a 3-column grid with the
 * operator-specified row order:
 *   Row 1: Bowling Income · Shoe Rental Income · Attraction Income
 *   Row 2: Grille Income  · Bar Income         · Pop Income
 *   Row 3: Packages Income
 * Any rollup not listed explicitly lands at the end in alphabetical order.
 */
import { useQuery } from "@tanstack/react-query";
import { CategoryTreeNode, DateRange } from "@shared/schema";
import { fetchCategoryTree } from "@/lib/squareApi";
import ItemsByCategory from "./ItemsByCategory";
import CategoryRevenuePieChart from "./CategoryRevenuePieChart";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface ItemsPerformanceProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

// Operator-specified panel order (case-insensitive). Panels not found in this
// list appear after all pinned entries, sorted alphabetically.
const PANEL_ORDER = [
  "bowling income",
  "shoe rental income",
  "attraction income",
  "grille income",
  "bar income",
  "pop income",
  "packages income",
];

// Top-level categories that should never surface as their own panel —
// Square's online-ordering "menu" rollups the business tracks separately.
const HIDDEN_PANEL_NAMES = new Set(["online menu", "pg party menu"]);

export default function ItemsPerformance({
  dateRange,
  customStartDate,
  customEndDate,
}: ItemsPerformanceProps) {
  const { data: tree, isLoading, isError } = useQuery<CategoryTreeNode[]>({
    queryKey: ["/api/items/categories"],
    queryFn: fetchCategoryTree,
  });

  const visibleTree = (tree ?? []).filter(
    (n) => !HIDDEN_PANEL_NAMES.has(n.name.trim().toLowerCase()),
  );

  // Only top-level categories with at least one child become panels.
  const rollups = visibleTree.filter((n) => n.children.length > 0);

  const panels = [...rollups].sort((a, b) => {
    const ai = PANEL_ORDER.indexOf(a.name.trim().toLowerCase());
    const bi = PANEL_ORDER.indexOf(b.name.trim().toLowerCase());
    const ar = ai === -1 ? PANEL_ORDER.length : ai;
    const br = bi === -1 ? PANEL_ORDER.length : bi;
    if (ar !== br) return ar - br;
    return a.name.localeCompare(b.name);
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-9 w-full mt-3" />
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {Array.from({ length: 8 }).map((_, j) => (
                  <Skeleton key={j} className="h-8 w-full" />
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-sm text-destructive py-8 text-center">
        Failed to load categories. Try refreshing the page.
      </div>
    );
  }

  if (panels.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        No Square categories found. Run a catalog sync from the Account drawer to populate items.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <CategoryRevenuePieChart
        dateRange={dateRange}
        customStartDate={customStartDate}
        customEndDate={customEndDate}
      />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {panels.map((rollup) => (
          <ItemsByCategory
            key={rollup.squareCategoryId}
            rollup={rollup}
            dateRange={dateRange}
            customStartDate={customStartDate}
            customEndDate={customEndDate}
          />
        ))}
      </div>
    </div>
  );
}
