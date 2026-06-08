import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowLeft, Database, ChevronDown, ChevronRight, AlertCircle, CheckCircle } from 'lucide-react';
import { format } from 'date-fns';

interface McpAuditEntry {
  id: number;
  adminUserId: number | null;
  adminUsername: string | null;
  ip: string | null;
  query: string;
  rowCount: number | null;
  error: string | null;
  durationMs: number;
  createdAt: string;
}

interface McpAuditPage {
  entries: McpAuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

const PAGE_SIZE = 25;

interface McpEntriesCardProps {
  isLoading: boolean;
  isQueryError: boolean;
  error: Error | null;
  data: McpAuditPage | undefined;
  total: number;
  currentPage: number;
  totalPages: number;
  page: number;
  setPage: (fn: (p: number) => number) => void;
  expanded: Set<number>;
  toggleExpanded: (id: number) => void;
}

function McpEntriesCard({
  isLoading,
  isQueryError,
  error,
  data,
  total,
  currentPage,
  totalPages,
  page,
  setPage,
  expanded,
  toggleExpanded,
}: McpEntriesCardProps) {
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
        ) : isQueryError ? (
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
              const hasError = entry.error !== null;
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
                      {hasError ? (
                        <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
                      ) : (
                        <CheckCircle className="h-4 w-4 shrink-0 text-green-600" />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {entry.adminUsername ?? (entry.adminUserId !== null ? `user #${entry.adminUserId}` : 'unknown user')}
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            {format(new Date(entry.createdAt), 'MMM d, yyyy HH:mm:ss')}
                          </span>
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {entry.ip ?? 'no ip'} • {entry.durationMs}ms •{' '}
                          {hasError
                            ? 'error'
                            : `${entry.rowCount ?? 0} ${entry.rowCount === 1 ? 'row' : 'rows'}`}
                        </p>
                      </div>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="space-y-3 border-t bg-muted/20 px-3 py-3">
                      <div>
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Query
                        </p>
                        <pre className="max-h-72 overflow-auto rounded border bg-background p-2 font-mono text-xs whitespace-pre-wrap break-words">
                          {entry.query}
                        </pre>
                      </div>
                      {hasError && (
                        <div>
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-destructive">
                            Error
                          </p>
                          <pre className="max-h-48 overflow-auto rounded border border-destructive/40 bg-destructive/5 p-2 font-mono text-xs whitespace-pre-wrap break-words text-destructive">
                            {entry.error}
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

export default function McpAudit() {
  const { user, isLoading: authLoading } = useAuth();
  const [, navigate] = useLocation();

  // Form inputs (what the user is typing)
  const [usernameInput, setUsernameInput] = useState('');
  const [outcomeInput, setOutcomeInput] = useState<'all' | 'success' | 'error'>('all');
  const [startDateInput, setStartDateInput] = useState('');
  const [endDateInput, setEndDateInput] = useState('');

  // Applied filters (what's actually queried)
  const [filters, setFilters] = useState<{
    adminUsername: string;
    outcome: 'all' | 'success' | 'error';
    startDate: string;
    endDate: string;
  }>({ adminUsername: '', outcome: 'all', startDate: '', endDate: '' });
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!authLoading && user?.role !== 'admin') {
      navigate('/');
    }
  }, [user, authLoading, navigate]);

  const queryKey = useMemo(
    () => [
      '/api/admin/mcp-audit',
      {
        adminUsername: filters.adminUsername,
        outcome: filters.outcome,
        startDate: filters.startDate,
        endDate: filters.endDate,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      },
    ],
    [filters, page],
  );

  const { data, isLoading, isError, error } = useQuery<McpAuditPage>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.adminUsername.trim()) params.set('adminUsername', filters.adminUsername.trim());
      if (filters.outcome !== 'all') params.set('outcome', filters.outcome);
      if (filters.startDate) params.set('startDate', new Date(filters.startDate).toISOString());
      if (filters.endDate) params.set('endDate', new Date(filters.endDate).toISOString());
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      const res = await fetch(`/api/admin/mcp-audit?${params.toString()}`, {
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

  const applyFilters = () => {
    setFilters({
      adminUsername: usernameInput,
      outcome: outcomeInput,
      startDate: startDateInput,
      endDate: endDateInput,
    });
    setPage(0);
    setExpanded(new Set());
  };

  const resetFilters = () => {
    setUsernameInput('');
    setOutcomeInput('all');
    setStartDateInput('');
    setEndDateInput('');
    setFilters({ adminUsername: '', outcome: 'all', startDate: '', endDate: '' });
    setPage(0);
    setExpanded(new Set());
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
            <Database className="mr-2 h-8 w-8 text-purple-600" />
            <h1 className="text-3xl font-bold text-gray-900">SQL Query History</h1>
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

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Filters</CardTitle>
            <CardDescription>
              Browse the audit log of every read-only SQL query the MCP layer has run. Use the filters
              below to narrow by admin, outcome, or date range.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                applyFilters();
              }}
              className="grid grid-cols-1 gap-4 md:grid-cols-5"
            >
              <div className="space-y-1.5">
                <Label htmlFor="filter-username">Admin username</Label>
                <Input
                  id="filter-username"
                  placeholder="(any)"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="filter-outcome">Outcome</Label>
                <Select value={outcomeInput} onValueChange={(v) => setOutcomeInput(v as typeof outcomeInput)}>
                  <SelectTrigger id="filter-outcome">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="success">Success</SelectItem>
                    <SelectItem value="error">Error</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="filter-start">From</Label>
                <Input
                  id="filter-start"
                  type="datetime-local"
                  value={startDateInput}
                  onChange={(e) => setStartDateInput(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="filter-end">To</Label>
                <Input
                  id="filter-end"
                  type="datetime-local"
                  value={endDateInput}
                  onChange={(e) => setEndDateInput(e.target.value)}
                />
              </div>
              <div className="flex items-end gap-2">
                <Button type="submit" className="flex-1">Apply</Button>
                <Button type="button" variant="outline" onClick={resetFilters}>Reset</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <McpEntriesCard
          isLoading={isLoading}
          isQueryError={isError}
          error={error}
          data={data}
          total={total}
          currentPage={currentPage}
          totalPages={totalPages}
          page={page}
          setPage={setPage}
          expanded={expanded}
          toggleExpanded={toggleExpanded}
        />
      </div>
    </div>
  );
}
