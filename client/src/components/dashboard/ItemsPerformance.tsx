/**
 * Items tab content (Task #188)
 *
 * Loads the Square category tree and renders one ItemsByCategory panel
 * per top-level rollup that actually has children — typically Food on
 * the left and Beverage on the right, but driven entirely by Square's
 * configured hierarchy so the layout adapts if the merchant adds or
 * renames a rollup.
 */
import { useQuery } from "@tanstack/react-query";
import { CategoryTreeNode, DateRange } from "@shared/schema";
import { fetchCategoryTree } from "@/lib/squareApi";
import ItemsByCategory from "./ItemsByCategory";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface ItemsPerformanceProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

export default function ItemsPerformance({
  dateRange,
  customStartDate,
  customEndDate,
}: ItemsPerformanceProps) {
  const { data: tree, isLoading, isError } = useQuery<CategoryTreeNode[]>({
    queryKey: ["/api/items/categories"],
    queryFn: fetchCategoryTree,
  });

  // Operator-hidden top-level categories: these are Square's online-ordering
  // "menu" rollups, which the business does not want surfaced as their own
  // Items-tab panels. Matched by name (case-insensitive); "PG Menu" is a
  // different category and intentionally NOT excluded.
  const HIDDEN_PANEL_NAMES = new Set(["online menu", "pg party menu"]);
  const visibleTree = (tree ?? []).filter(
    (n) => !HIDDEN_PANEL_NAMES.has(n.name.trim().toLowerCase()),
  );

  // A rollup is any top-level category with at least one child. This is
  // intentional: if the operator hasn't set up sub-categories under
  // "Beverage" yet, that node is just a leaf and doesn't earn its own
  // panel. If there are no rollups at all, we fall back to all
  // top-level categories so the tab is still useful.
  const rollups = visibleTree.filter((n) => n.children.length > 0);
  // Spec asks for Food on the left and Beverage on the right. We honor
  // that explicitly when both are present; everything else falls back
  // to the alphabetical order the API already returns. Any rollup not
  // matching one of the well-known names lands after the two anchors so
  // additional rollups don't push Food/Beverage out of the leftmost
  // pair of columns.
  const sortedRollups = [...rollups].sort((a, b) => {
    const rank = (name: string): number => {
      const lower = name.trim().toLowerCase();
      if (lower === "food") return 0;
      if (lower === "beverage" || lower === "beverages") return 1;
      return 2;
    };
    const diff = rank(a.name) - rank(b.name);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });
  const panels = sortedRollups.length > 0 ? sortedRollups : visibleTree;

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {[0, 1].map((i) => (
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
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {panels.slice(0, 2).map((rollup) => (
        <ItemsByCategory
          key={rollup.squareCategoryId}
          rollup={rollup}
          dateRange={dateRange}
          customStartDate={customStartDate}
          customEndDate={customEndDate}
        />
      ))}
      {/* If Square has more than two top-level rollups, show the rest below
          in the same grid so nothing is hidden. */}
      {panels.slice(2).map((rollup) => (
        <ItemsByCategory
          key={rollup.squareCategoryId}
          rollup={rollup}
          dateRange={dateRange}
          customStartDate={customStartDate}
          customEndDate={customEndDate}
        />
      ))}
    </div>
  );
}
