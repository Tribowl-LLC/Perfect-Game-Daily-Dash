import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { ArrowLeft, Download, History, ChevronDown, ChevronRight, AlertCircle, CheckCircle, Clock, Gauge } from 'lucide-react';
import { format } from 'date-fns';

interface SyncAuditEntry {
  id: number;
  syncType: string;
  action: string;
  actorUserId: number | null;
  actorUsername: string | null;
  actorIp: string | null;
  params: Record<string, unknown> | null;
  status: string;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
  pagesUsed: number;
  startedAt: string;
  completedAt: string | null;
}

interface SyncAuditPage {
  entries: SyncAuditEntry[];
  total: number;
  limit: number;
  offset: number;
  syncTypes: string[];
}

interface SyncBudgetStatus {
  day: string;
  pagesUsed: number;
  cap: number;
}

const PAGE_SIZE = 25;
const ALL_TYPES = '__all__';

function statusIcon(status: string) {
  if (status === 'completed') return <CheckCircle className="h-4 w-4 shrink-0 text-green-600" />;
  if (status === 'failed' || status === 'rejected') return <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />;
  return <Clock className="h-4 w-4 shrink-0 text-amber-500" />;
}

function actorLabel(entry: SyncAuditEntry) {
  if (entry.actorUsername) return entry.actorUsername;
  if (entry.actorUserId !== null) return `user #${entry.actorUserId}`;
  return 'system / scheduler';
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface SyncEntriesCardProps {
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  data: SyncAuditPage | undefined;
  total: number;
  currentPage: number;
  totalPages: number;
  page: number;
  setPage: (fn: (p: number) => number) => void;
  expanded: Set<number>;
  toggleExpanded: (id: number) => void;
  downloadCsv: () => void;
}

function SyncEntriesCard({
  isLoading,
  isError,
  error,
  data,
  total,
  currentPage,
  totalPages,
  page,
  setPage,
  expanded,
  toggleExpanded,
  downloadCsv,
}: SyncEntriesCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Entries</CardTitle>
          <CardDescription>
            {isLoading ? 'Loading...' : `${total.toLocaleString()} matching ${total === 1 ? 'entry' : 'entries'}`}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isLoading || total === 0}
            onClick={downloadCsv}
            data-testid="button-download-csv"
            title="Download all matching entries as CSV"
          >
            <Download className="mr-1 h-4 w-4" />
            Download CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0 || isLoading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {currentPage} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={isLoading || currentPage >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="h-4 w-4" />
            <span>Loading audit entries...</span>
          </div>
        ) : isError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Could not load audit entries.</p>
              <p className="text-xs opacity-80">
                {error instanceof Error ? error.message : 'Please try again.'}
              </p>
            </div>
          </div>
        ) : data && data.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matching audit entries.</p>
        ) : (
          <div className="space-y-2">
            {data?.entries.map((entry) => {
              const isOpen = expanded.has(entry.id);
              return (
                <div key={entry.id} className="rounded-lg border">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(entry.id)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/40"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      {statusIcon(entry.status)}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          <span className="font-mono text-xs text-muted-foreground">{entry.syncType}</span>
                          <span className="mx-1.5 text-muted-foreground">·</span>
                          {entry.action}
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            by {actorLabel(entry)}
                          </span>
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {format(new Date(entry.startedAt), 'MMM d, yyyy HH:mm:ss')}
                          {entry.completedAt && (
                            <> → {format(new Date(entry.completedAt), 'MMM d, yyyy HH:mm:ss')}</>
                          )}
                          <> · status: {entry.status} · pages: {entry.pagesUsed}</>
                          {entry.actorIp && <> · {entry.actorIp}</>}
                        </p>
                      </div>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="space-y-3 border-t bg-muted/20 px-3 py-3">
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <div>
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Params
                          </p>
                          <pre className="max-h-72 overflow-auto rounded border bg-background p-2 font-mono text-xs whitespace-pre-wrap break-words">
                            {entry.params ? formatJson(entry.params) : '(none)'}
                          </pre>
                        </div>
                        <div>
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Result
                          </p>
                          <pre className="max-h-72 overflow-auto rounded border bg-background p-2 font-mono text-xs whitespace-pre-wrap break-words">
                            {entry.result ? formatJson(entry.result) : '(none)'}
                          </pre>
                        </div>
                      </div>
                      {entry.errorMessage && (
                        <div>
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-destructive">
                            Error
                          </p>
                          <pre className="max-h-48 overflow-auto rounded border border-destructive/40 bg-destructive/5 p-2 font-mono text-xs whitespace-pre-wrap break-words text-destructive">
                            {entry.errorMessage}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SyncAudit() {
  const { user, isLoading: authLoading } = useAuth();
  const [, navigate] = useLocation();

  const [syncTypeInput, setSyncTypeInput] = useState<string>(ALL_TYPES);
  const [filters, setFilters] = useState<{ syncType: string }>({ syncType: '' });
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!authLoading && user?.role !== 'admin') {
      navigate('/');
    }
  }, [user, authLoading, navigate]);

  const queryKey = useMemo(
    () => [
      '/api/admin/sync-audit',
      {
        syncType: filters.syncType,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      },
    ],
    [filters, page],
  );

  const { data, isLoading, isError, error } = useQuery<SyncAuditPage>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.syncType) params.set('syncType', filters.syncType);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      const res = await fetch(`/api/admin/sync-audit?${params.toString()}`, {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      return res.json();
    },
  });

  // Today's Square page-budget snapshot for the widget. Refreshed
  // every 30s so an operator watching a backfill drain the cap sees
  // the counter move without having to reload the page.
  const { data: budget } = useQuery<SyncBudgetStatus>({
    queryKey: ['/api/admin/sync-budget'],
    queryFn: async () => {
      const res = await fetch('/api/admin/sync-budget', {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      return res.json();
    },
    refetchInterval: 30_000,
  });

  if (authLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }
  if (!user || user.role !== 'admin') return null;

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = page + 1;
  const syncTypes = data?.syncTypes ?? [];

  const applyFilters = () => {
    setFilters({ syncType: syncTypeInput === ALL_TYPES ? '' : syncTypeInput });
    setPage(0);
    setExpanded(new Set());
  };

  const resetFilters = () => {
    setSyncTypeInput(ALL_TYPES);
    setFilters({ syncType: '' });
    setPage(0);
    setExpanded(new Set());
  };

  // Trigger a CSV download of the currently-filtered audit rows.
  // We open the URL via a hidden <a download> rather than fetch() so
  // (a) the browser handles the file save dialog and respects the
  // server-supplied Content-Disposition filename, and (b) the entire
  // export — which can be much larger than the 25-row visible page —
  // never has to live in JS memory.
  const downloadCsv = () => {
    const params = new URLSearchParams();
    if (filters.syncType) params.set('syncType', filters.syncType);
    const qs = params.toString();
    const url = qs
      ? `/api/admin/sync-audit.csv?${qs}`
      : '/api/admin/sync-audit.csv';
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center">
            <History className="mr-2 h-8 w-8 text-purple-600" />
            <h1 className="text-3xl font-bold text-gray-900">Backfill Audit</h1>
          </div>
          <button
            type="button"
            onClick={() => navigate('/admin')}
            className="flex items-center rounded-md bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Admin
          </button>
        </div>

        {budget && (
          <Card className="mb-6" data-testid="card-sync-budget">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Gauge className="h-4 w-4 text-purple-600" />
                  Today's Square page budget
                </CardTitle>
                <span className="text-xs text-muted-foreground">
                  UTC {budget.day}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <p className="text-sm">
                    <span className="font-mono text-base font-semibold" data-testid="text-budget-used">
                      {budget.pagesUsed.toLocaleString()}
                    </span>
                    <span className="text-muted-foreground"> / </span>
                    <span className="font-mono" data-testid="text-budget-cap">
                      {budget.cap.toLocaleString()}
                    </span>
                    <span className="text-muted-foreground"> pages used</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {budget.cap > 0
                      ? `${Math.min(100, Math.round((budget.pagesUsed / budget.cap) * 100))}%`
                      : '—'}
                  </p>
                </div>
                <Progress
                  value={budget.cap > 0 ? Math.min(100, (budget.pagesUsed / budget.cap) * 100) : 0}
                  className="h-2"
                />
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Filters</CardTitle>
            <CardDescription>
              Every historical and backfill sync trigger is logged here, including who started it,
              what parameters were used, and how it ended.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                applyFilters();
              }}
              className="grid grid-cols-1 gap-4 md:grid-cols-3"
            >
              <div className="space-y-1.5">
                <Label htmlFor="filter-synctype">Sync type</Label>
                <Select value={syncTypeInput} onValueChange={setSyncTypeInput}>
                  <SelectTrigger id="filter-synctype">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_TYPES}>All</SelectItem>
                    {syncTypes.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-2 md:col-span-2">
                <Button type="submit">Apply</Button>
                <Button type="button" variant="outline" onClick={resetFilters}>Reset</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <SyncEntriesCard
          isLoading={isLoading}
          isError={isError}
          error={error}
          data={data}
          total={total}
          currentPage={currentPage}
          totalPages={totalPages}
          page={page}
          setPage={setPage}
          expanded={expanded}
          toggleExpanded={toggleExpanded}
          downloadCsv={downloadCsv}
        />
      </div>
    </div>
  );
}
