import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '@/context/AuthContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import UserManagement from '@/components/admin/UserManagement';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { ShieldCheck, Users, ArrowLeft, RefreshCw, Clock, CheckCircle, AlertCircle, Bell, KeyRound, Smartphone, Database, ShieldAlert, ShieldOff, Activity, Gauge, History, ChevronDown, ChevronRight } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import QRCode from 'qrcode';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { formatDistanceToNow, format } from 'date-fns';
import {
  useInvalidAppSettingsCount,
  APP_SETTINGS_VALIDATION_QUERY_KEY,
} from '@/hooks/use-invalid-app-settings-count';

interface SyncStatusData {
  success: boolean;
  overallLastSynced: string | null;
  byType: Record<string, {
    lastSyncedAt: string | null;
    status: string;
    processedCount: number | null;
  }>;
}

const SYNC_TYPE_LABELS: Record<string, string> = {
  giftCards: 'Gift Cards',
  payments: 'Payments',
  orders: 'Orders',
  giftCardRedemptions: 'Gift Card Redemptions',
};

export default function Admin() {
  const { user, isLoading } = useAuth();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState('users');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const invalidAppSettings = useInvalidAppSettingsCount();

  useEffect(() => {
    if (!isLoading && user?.role !== 'admin') {
      navigate('/');
    }
  }, [user, isLoading, navigate]);

  const { data: syncStatus, isLoading: syncStatusLoading } = useQuery<SyncStatusData>({
    queryKey: ['/api/sync/status'],
    refetchInterval: false,
  });

  const historicalSyncMutation = useMutation({
    mutationFn: () => apiRequest('POST', '/api/sync/historical'),
    onSuccess: () => {
      toast({
        title: 'Full catch-up sync started',
        description: 'Running in the background — this may take 10–20 minutes. The dashboard will update as data comes in.',
      });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['/api/sync/status'] }), 5000);
    },
    onError: () => {
      toast({
        title: 'Sync failed to start',
        description: 'Check the server logs for details.',
        variant: 'destructive',
      });
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <Spinner className="h-8 w-8" />
          <p className="mt-2 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user || user.role !== 'admin') {
    return null;
  }

  const formatSyncTime = (ts: string | null) => {
    if (!ts) return 'Never';
    const d = new Date(ts);
    return `${formatDistanceToNow(d, { addSuffix: true })} (${format(d, 'MMM d, yyyy h:mm a')})`;
  };

  const staleDays = (ts: string | null) => {
    if (!ts) return null;
    return Math.floor((Date.now() - new Date(ts).getTime()) / (1000 * 60 * 60 * 24));
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center">
            <ShieldCheck className="mr-2 h-8 w-8 text-purple-600" />
            <h1 className="text-3xl font-bold text-gray-900">Admin Dashboard</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate('/admin/mcp-audit')}
              className="flex items-center rounded-md bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
            >
              <Database className="mr-2 h-4 w-4" />
              SQL Query History
            </button>
            <button
              type="button"
              onClick={() => navigate('/admin/sync-audit')}
              className="flex items-center rounded-md bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
            >
              <Database className="mr-2 h-4 w-4" />
              Backfill Audit
            </button>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="flex items-center rounded-md bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Dashboard
            </button>
          </div>
        </div>

        <Card className="mb-8">
          <CardHeader className="pb-3">
            <CardTitle>Welcome, {user.username}</CardTitle>
            <CardDescription>
              Admin panel gives you access to user management and data sync controls.
            </CardDescription>
          </CardHeader>
        </Card>

        <Tabs defaultValue="users" value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6 grid w-full grid-cols-1 md:w-auto md:grid-cols-5">
            <TabsTrigger value="users" className="flex items-center">
              <Users className="mr-2 h-4 w-4" />
              <span>Users</span>
            </TabsTrigger>
            <TabsTrigger value="sync" className="flex items-center">
              <RefreshCw className="mr-2 h-4 w-4" />
              <span>Sync</span>
            </TabsTrigger>
            <TabsTrigger
              value="alerts"
              className="flex items-center"
              data-testid="tab-trigger-alerts"
            >
              <span className="relative mr-2 flex h-4 w-4 items-center justify-center">
                <Bell className="h-4 w-4" />
                {invalidAppSettings > 0 ? (
                  <span
                    className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-destructive ring-2 ring-background"
                    data-testid="badge-alerts-tab-invalid-app-settings"
                    aria-label={`${invalidAppSettings} broken app setting${invalidAppSettings === 1 ? '' : 's'}`}
                  />
                ) : null}
              </span>
              <span>Alerts</span>
              {invalidAppSettings > 0 ? (
                <span className="ml-1.5 rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-medium leading-none text-destructive-foreground">
                  {invalidAppSettings}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="security" className="flex items-center">
              <KeyRound className="mr-2 h-4 w-4" />
              <span>Security</span>
            </TabsTrigger>
            <TabsTrigger value="diagnostics" className="flex items-center">
              <Activity className="mr-2 h-4 w-4" />
              <span>Diagnostics</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="users" className="mt-0">
            <Card>
              <CardContent className="pt-6">
                <UserManagement />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="sync" className="mt-0 space-y-6">
            {/* Sync status card */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="h-5 w-5 text-muted-foreground" />
                  Data Freshness
                </CardTitle>
                <CardDescription>
                  A nightly sync runs automatically at 3 AM Eastern Time. This table shows when each data type was last updated.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {syncStatusLoading ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Spinner className="h-4 w-4" />
                    <span>Loading sync status...</span>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {Object.entries(syncStatus?.byType ?? {}).map(([type, info]) => {
                      const days = staleDays(info.lastSyncedAt);
                      const isStale = days !== null && days > 1;
                      return (
                        <div key={type} className="flex items-center justify-between rounded-lg border p-3">
                          <div className="flex items-center gap-3">
                            {isStale ? (
                              <AlertCircle className="h-4 w-4 text-amber-500" />
                            ) : (
                              <CheckCircle className="h-4 w-4 text-green-500" />
                            )}
                            <div>
                              <p className="font-medium text-sm">{SYNC_TYPE_LABELS[type] ?? type}</p>
                              <p className="text-xs text-muted-foreground">
                                {formatSyncTime(info.lastSyncedAt)}
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                              isStale
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-green-100 text-green-700'
                            }`}>
                              {isStale ? `${days}d stale` : 'Current'}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                    {Object.keys(syncStatus?.byType ?? {}).length === 0 && (
                      <p className="text-sm text-muted-foreground">No sync history found. Run a sync to get started.</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Historical catch-up card */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <RefreshCw className="h-5 w-5 text-muted-foreground" />
                  Full Catch-up Sync
                </CardTitle>
                <CardDescription>
                  Use this when months of data are missing — for example, after the app has been offline or a sync type has fallen far behind. It re-syncs orders, payments, and gift cards in monthly chunks from the past 2 years through today, then runs the gift card activation repair. This runs entirely in the background and may take 10–20 minutes.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-4">
                <p className="text-sm text-muted-foreground max-w-md">
                  The nightly automatic sync handles day-to-day freshness. Only run this if you notice large gaps in the dashboard data.
                </p>
                <Button
                  onClick={() => historicalSyncMutation.mutate()}
                  disabled={historicalSyncMutation.isPending}
                  className="shrink-0 gap-2"
                >
                  <RefreshCw className={`h-4 w-4 ${historicalSyncMutation.isPending ? 'animate-spin' : ''}`} />
                  {historicalSyncMutation.isPending ? 'Starting...' : 'Start Full Catch-up Sync'}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="alerts" className="mt-0 space-y-6">
            <SquareRateLimitAlertSettingsCard />
            <SquareRateLimitAlertRuntimeStateCard />
            <AppSettingsRegistryStatusCard />
          </TabsContent>

          <TabsContent value="security" className="mt-0 space-y-6">
            <TwoFactorAuthCard />
            <AdminSecurityOverviewCard />
            <TotpAuthAlertsCard />
            <SecurityAuditLogCard />
          </TabsContent>

          <TabsContent value="diagnostics" className="mt-0 space-y-6">
            <UserCacheDiagnosticsCard />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

interface AlertSettingsResponse {
  threshold: number;
  windowMs: number;
  cooldownMs: number;
  webhookConfigured: boolean;
}

const ALERT_SETTINGS_KEY = ['/api/admin/alerts/square-rate-limit'] as const;

/**
 * Settings card for the in-process Square 429 alerter. Lets on-call
 * tune sensitivity (count + rolling window) and quiet-period without
 * a deploy. The webhook URL itself stays in the deployment env and
 * is intentionally never round-tripped through the UI; we only show
 * a "configured / not configured" indicator.
 */
function SquareRateLimitAlertSettingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useQuery<AlertSettingsResponse>({
    queryKey: ALERT_SETTINGS_KEY,
  });

  // Local form state — the inputs are minute-based to match how
  // operators reason about quiet hours, but the API speaks ms.
  const [threshold, setThreshold] = useState('');
  const [windowMin, setWindowMin] = useState('');
  const [cooldownMin, setCooldownMin] = useState('');

  useEffect(() => {
    if (!data) return;
    setThreshold(String(data.threshold));
    setWindowMin(String(Math.round(data.windowMs / 60000)));
    setCooldownMin(String(Math.round(data.cooldownMs / 60000)));
  }, [data]);

  const mutation = useMutation({
    mutationFn: (body: { threshold: number; windowMs: number; cooldownMs: number }) =>
      apiRequest('PUT', '/api/admin/alerts/square-rate-limit', {
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      toast({ title: 'Alert thresholds updated', description: 'Changes are live immediately.' });
      queryClient.invalidateQueries({ queryKey: ALERT_SETTINGS_KEY });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Could not save alert settings.';
      toast({ title: 'Update failed', description: message, variant: 'destructive' });
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = Number.parseInt(threshold, 10);
    const w = Number.parseInt(windowMin, 10);
    const c = Number.parseInt(cooldownMin, 10);
    if (!Number.isFinite(t) || !Number.isFinite(w) || !Number.isFinite(c)) {
      toast({
        title: 'Invalid values',
        description: 'All fields must be whole numbers.',
        variant: 'destructive',
      });
      return;
    }
    mutation.mutate({
      threshold: t,
      windowMs: w * 60_000,
      cooldownMs: c * 60_000,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5 text-muted-foreground" />
          Square Rate-Limit (HTTP 429) Alert
        </CardTitle>
        <CardDescription>
          When Square throttles us, the server fires a webhook alert if enough 429s land in the
          rolling window. Use these knobs to quiet noisy periods or tighten sensitivity after an
          incident — changes take effect immediately, no restart required.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="h-4 w-4" />
            <span>Loading current settings...</span>
          </div>
        ) : isError || !data ? (
          // Surface load failures explicitly (e.g. missing app_settings
          // table on an env that hasn't bootstrapped yet) so admins
          // see an actionable error instead of an indefinite spinner.
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Could not load alert settings.</p>
                <p className="text-xs opacity-80">
                  {error instanceof Error ? error.message : 'Please try again.'}
                </p>
              </div>
            </div>
            <Button type="button" variant="outline" onClick={() => refetch()} className="gap-2">
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4 max-w-md">
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
              Webhook URL:{' '}
              <span className={data.webhookConfigured ? 'font-medium text-green-700' : 'font-medium text-amber-700'}>
                {data.webhookConfigured ? 'configured' : 'not configured (alerts will not fire)'}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="alert-threshold">Threshold (events)</Label>
                <Input
                  id="alert-threshold"
                  type="number"
                  min={1}
                  max={1000}
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="alert-window">Window (minutes)</Label>
                <Input
                  id="alert-window"
                  type="number"
                  min={1}
                  max={1440}
                  value={windowMin}
                  onChange={(e) => setWindowMin(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="alert-cooldown">Cooldown (minutes)</Label>
                <Input
                  id="alert-cooldown"
                  type="number"
                  min={1}
                  max={1440}
                  value={cooldownMin}
                  onChange={(e) => setCooldownMin(e.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Fires when at least <strong>threshold</strong> Square 429s land within the rolling{' '}
              <strong>window</strong>; then waits <strong>cooldown</strong> before firing again.
            </p>
            <div className="flex justify-end">
              <Button type="submit" disabled={mutation.isPending} className="gap-2">
                {mutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                {mutation.isPending ? 'Saving...' : 'Save alert thresholds'}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

interface AlertRuntimeStateResponse {
  now: number;
  eventCount: number;
  windowMs: number;
  breakdown: Array<{ key: string; count: number }>;
  lastAlertAt: number | null;
  cooldownRemainingMs: number;
  episodeActive: boolean;
  webhookConfigured: boolean;
}

const ALERT_RUNTIME_STATE_KEY = ['/api/admin/alerts/square-rate-limit/state'] as const;

/**
 * Read-only panel that surfaces the alerter's live in-process state
 * (Task #121). Lets on-call see — without ssh-ing into the box and
 * grepping logs — whether their freshly-tuned thresholds would
 * actually have fired during the most recent incident: how many 429s
 * are currently in the rolling window, the per-source breakdown, when
 * the last alert went out, and whether we're still inside cooldown.
 *
 * Polls every 5s while the Alerts tab is open. The endpoint is a
 * pure read against process memory, so the cost is trivial.
 */
function SquareRateLimitAlertRuntimeStateCard() {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useQuery<AlertRuntimeStateResponse>({
      queryKey: ALERT_RUNTIME_STATE_KEY,
      // 5s feels live without hammering the box; the underlying
      // operation is O(events-in-window) memory access only.
      refetchInterval: 5_000,
      refetchIntervalInBackground: false,
    });

  // Render the "last alert" timestamp relative to the SERVER clock
  // returned by the snapshot, so a skewed client clock never shows
  // misleading "in 3 minutes" values.
  const lastAlertLabel = (() => {
    if (!data || data.lastAlertAt === null) return 'no alert since process start';
    const ageMs = Math.max(0, data.now - data.lastAlertAt);
    return `${formatDistanceToNow(new Date(Date.now() - ageMs), { addSuffix: true })}`;
  })();

  const cooldownLabel = (() => {
    if (!data) return '';
    if (data.cooldownRemainingMs <= 0) return 'ready to fire';
    const sec = Math.ceil(data.cooldownRemainingMs / 1000);
    if (sec < 60) return `${sec}s remaining`;
    const min = Math.ceil(sec / 60);
    return `${min}m remaining`;
  })();

  const windowMin = data ? Math.max(1, Math.round(data.windowMs / 60_000)) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" />
          Alerter live state
          {data?.episodeActive ? (
            <Badge variant="destructive" className="ml-2">incident in progress</Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          What the in-process alerter sees right now. Refreshes every few seconds — useful for
          checking whether a freshly-tuned threshold would have caught the last incident.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="h-4 w-4" />
            <span>Loading alerter state...</span>
          </div>
        ) : isError || !data ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Could not load alerter state.</p>
                <p className="text-xs opacity-80">
                  {error instanceof Error ? error.message : 'Please try again.'}
                </p>
              </div>
            </div>
            <Button type="button" variant="outline" onClick={() => refetch()} className="gap-2">
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-md border bg-muted/30 px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  In-window 429s
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">
                  {data.eventCount}
                </div>
                <div className="text-xs text-muted-foreground">
                  in the last {windowMin}m
                </div>
              </div>
              <div className="rounded-md border bg-muted/30 px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Last alert
                </div>
                <div className="mt-1 text-sm font-medium">{lastAlertLabel}</div>
                <div className="text-xs text-muted-foreground">
                  {data.lastAlertAt === null
                    ? '—'
                    : `at ${format(new Date(Date.now() - (data.now - data.lastAlertAt)), 'PP p')}`}
                </div>
              </div>
              <div className="rounded-md border bg-muted/30 px-3 py-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Cooldown
                </div>
                <div className="mt-1 text-sm font-medium">{cooldownLabel}</div>
                <div className="text-xs text-muted-foreground">
                  {data.cooldownRemainingMs > 0
                    ? 'next alert is suppressed'
                    : 'next threshold breach will alert'}
                </div>
              </div>
            </div>

            {!data.webhookConfigured ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-200">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  No webhook URL is configured — even if thresholds are exceeded, no alert will be
                  delivered. Set <code>SQUARE_RATE_LIMIT_ALERT_WEBHOOK_URL</code> in the deployment
                  env to enable delivery.
                </span>
              </div>
            ) : null}

            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-medium">Breakdown by sync path</div>
                {isFetching ? (
                  <Spinner className="h-3 w-3 text-muted-foreground" />
                ) : null}
              </div>
              {data.breakdown.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No 429 events in the rolling window.
                </p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {data.breakdown.map((b) => (
                    <li key={b.key} className="flex items-center justify-between rounded border bg-muted/20 px-3 py-1.5">
                      <code className="text-xs">{b.key}</code>
                      <span className="font-semibold tabular-nums">{b.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface AppSettingsValidationIssue {
  path: string;
  message: string;
}

interface AppSettingsValidationEntry {
  key: string;
  status: 'valid' | 'invalid' | 'missing';
  issues: AppSettingsValidationIssue[];
  updatedAt: string | null;
  validatedAt: string;
}

interface AppSettingsValidationResponse {
  validatedAt: string;
  entries: AppSettingsValidationEntry[];
}

const APP_SETTINGS_VALIDATION_KEY = APP_SETTINGS_VALIDATION_QUERY_KEY;

/**
 * Read-only panel that lists every key registered in
 * `appSettingsRegistry` and shows whether its persisted JSON still
 * parses against the registered zod schema (Task #167). Companion to
 * the invalid-row alerter (Task #122) — the alerter only fires once
 * per key per cooldown window, so an admin who joins after the alert
 * needs an in-app way to see which keys are still broken.
 *
 * "Refresh" re-runs the validation server-side; useful for
 * confirming that a fix-up migration has actually landed without
 * having to ssh into the box and re-trigger a read.
 */
function AppSettingsRegistryStatusCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const { data, isLoading, isError, error, refetch, isFetching } =
    useQuery<AppSettingsValidationResponse>({
      queryKey: APP_SETTINGS_VALIDATION_KEY,
    });

  // "Reset to default" — calls the admin DELETE endpoint that drops
  // the row and writes a security_audit_log entry, then refetches the
  // validation query so the panel re-renders without the now-cleared
  // entry (Task #182). Closes the loop on broken/legacy rows without
  // a one-off migration.
  const resetMutation = useMutation({
    mutationFn: (key: string) =>
      apiRequest('DELETE', `/api/admin/app-settings/${encodeURIComponent(key)}`),
    onSuccess: (_data, key) => {
      toast({
        title: 'Setting reset',
        description: `${key} cleared — consumer will fall back to its default.`,
      });
      queryClient.invalidateQueries({ queryKey: APP_SETTINGS_VALIDATION_KEY });
      queryClient.invalidateQueries({
        queryKey: ['/api/admin/alerts/square-rate-limit'],
      });
    },
    onError: (err) => {
      toast({
        title: 'Reset failed',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setResetTarget(null);
    },
  });

  const invalidCount = data?.entries.filter((e) => e.status === 'invalid').length ?? 0;
  const validatedLabel = data
    ? `${formatDistanceToNow(new Date(data.validatedAt), { addSuffix: true })} (${format(new Date(data.validatedAt), 'PP p')})`
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-5 w-5 text-muted-foreground" />
          App settings registry
          {invalidCount > 0 ? (
            <Badge variant="destructive" className="ml-2">
              {invalidCount} broken
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          Each row in <code>app_settings</code> is re-validated against the schema registered in{' '}
          <code>shared/schema.ts</code>. The on-call alert fires only once per key per cooldown
          window; this panel is the durable view of which rows are currently broken. Use Refresh
          after shipping a fix-up migration to confirm the row now parses.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="h-4 w-4" />
            <span>Loading validation status...</span>
          </div>
        ) : isError || !data ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Could not load validation status.</p>
                <p className="text-xs opacity-80">
                  {error instanceof Error ? error.message : 'Please try again.'}
                </p>
              </div>
            </div>
            <Button type="button" variant="outline" onClick={() => refetch()} className="gap-2">
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Last validated {validatedLabel}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                disabled={isFetching}
                className="gap-2"
              >
                <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
                {isFetching ? 'Refreshing...' : 'Refresh'}
              </Button>
            </div>

            {data.entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No keys are registered in <code>appSettingsRegistry</code>.
              </p>
            ) : (
              <ul className="space-y-2">
                {data.entries.map((entry) => (
                  <li
                    key={entry.key}
                    className="rounded-md border bg-muted/20 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <code className="text-sm font-medium">{entry.key}</code>
                      <div className="flex items-center gap-2">
                        {entry.status === 'valid' ? (
                          <Badge
                            variant="outline"
                            className="border-green-500/40 bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300"
                          >
                            <CheckCircle className="mr-1 h-3 w-3" />
                            Valid
                          </Badge>
                        ) : entry.status === 'invalid' ? (
                          <Badge variant="destructive">
                            <AlertCircle className="mr-1 h-3 w-3" />
                            Invalid
                          </Badge>
                        ) : (
                          <Badge variant="secondary">No row (using defaults)</Badge>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {entry.updatedAt
                            ? `updated ${formatDistanceToNow(new Date(entry.updatedAt), { addSuffix: true })}`
                            : '—'}
                        </span>
                      </div>
                    </div>
                    {entry.status === 'invalid' ? (
                      <div className="mt-2 space-y-2 border-t border-destructive/20 pt-2">
                        {entry.issues.length > 0 ? (
                          // Show the same zod issue list the alert payload
                          // contains so an on-call who lands here without
                          // the alert in front of them sees the same
                          // diagnostic detail.
                          <ul className="space-y-1 text-xs text-destructive">
                            {entry.issues.map((issue, idx) => (
                              <li key={`${issue.path ?? idx}:${issue.message}`} className="flex gap-2">
                                <span className="font-mono">
                                  {issue.path || '(root)'}:
                                </span>
                                <span>{issue.message}</span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-2"
                          disabled={
                            resetMutation.isPending &&
                            resetMutation.variables === entry.key
                          }
                          onClick={() => setResetTarget(entry.key)}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          {resetMutation.isPending &&
                          resetMutation.variables === entry.key
                            ? 'Resetting...'
                            : 'Reset to default'}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {invalidCount > 0 ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-200">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Affected consumers are silently falling back to defaults. Use{' '}
                  <strong>Reset to default</strong> to clear a broken row in place — the
                  delete is recorded in the security audit log. Never hand-edit{' '}
                  <code>app_settings</code> in production; if the row needs a rewrite
                  rather than a reset, ship a one-off migration instead.
                </span>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
      <AlertDialog
        open={resetTarget !== null}
        onOpenChange={(open) => {
          if (!open && !resetMutation.isPending) setResetTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset this app setting to its default?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the <code>{resetTarget}</code> row from{' '}
              <code>app_settings</code> so the consumer falls back to its hard-coded
              default. The action is recorded in the security audit log. You can
              always re-tune the setting from its panel afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (resetTarget) resetMutation.mutate(resetTarget);
              }}
              disabled={resetMutation.isPending}
            >
              {resetMutation.isPending ? 'Resetting...' : 'Reset to default'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Two-factor authentication (TOTP) — Task #56
// ---------------------------------------------------------------------------
//
// Self-service enrollment screen for the signed-in admin. Three states:
//   1. Not enrolled            — show "Enable 2FA" button.
//   2. Pending enrollment      — show QR + secret + 6-digit verification.
//   3. Enabled                 — show recovery-code count + "Disable 2FA"
//      button (re-prompts for the current password).
// Recovery codes are only shown once, immediately after a successful
// verification — never re-fetched, never persisted client-side beyond
// the lifetime of the current page render.

interface TotpStatusResponse {
  enabled: boolean;
  pendingEnrollment: boolean;
  recoveryCodesRemaining: number;
}

interface TotpEnrollResponse {
  secret: string;
  otpauthUrl: string;
}

const TOTP_STATUS_KEY = ['/api/auth/totp/status'] as const;

function TwoFactorAuthCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useQuery<TotpStatusResponse>({
    queryKey: TOTP_STATUS_KEY,
  });

  const [enrollment, setEnrollment] = useState<TotpEnrollResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState('');
  // Recovery-code regeneration (Task #101). The form is collapsed by
  // default — users explicitly click "Regenerate recovery codes" to
  // open it, which keeps the more dangerous password+TOTP prompt out
  // of the way during normal admin work.
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenPassword, setRegenPassword] = useState('');
  const [regenCode, setRegenCode] = useState('');

  // Render the QR whenever a fresh otpauth URL arrives. We do this in
  // an effect (rather than inline) so the (sync) qrcode call doesn't
  // run on every re-render.
  useEffect(() => {
    if (!enrollment) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(enrollment.otpauthUrl, { width: 240, margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enrollment]);

  const enrollMutation = useMutation({
    mutationFn: () =>
      apiRequest('POST', '/api/auth/totp/enroll', { body: '{}' }) as Promise<TotpEnrollResponse>,
    onSuccess: (data) => {
      setEnrollment(data);
      setRecoveryCodes(null);
      setVerifyCode('');
      queryClient.invalidateQueries({ queryKey: TOTP_STATUS_KEY });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Could not start enrollment.';
      toast({ title: 'Enrollment failed', description: message, variant: 'destructive' });
    },
  });

  const verifyMutation = useMutation({
    mutationFn: (code: string) =>
      apiRequest('POST', '/api/auth/totp/enroll/verify', {
        body: JSON.stringify({ code }),
      }) as Promise<{ success: boolean; recoveryCodes: string[] }>,
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes);
      setEnrollment(null);
      setQrDataUrl(null);
      setVerifyCode('');
      queryClient.invalidateQueries({ queryKey: TOTP_STATUS_KEY });
      toast({ title: 'Two-factor authentication enabled', description: 'Save your recovery codes — they will not be shown again.' });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'That code did not match.';
      toast({ title: 'Verification failed', description: message, variant: 'destructive' });
    },
  });

  const disableMutation = useMutation({
    mutationFn: (password: string) =>
      apiRequest('POST', '/api/auth/totp/disable', {
        body: JSON.stringify({ password }),
      }),
    onSuccess: () => {
      setDisablePassword('');
      setRecoveryCodes(null);
      queryClient.invalidateQueries({ queryKey: TOTP_STATUS_KEY });
      toast({ title: 'Two-factor authentication disabled' });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Could not disable 2FA.';
      toast({ title: 'Disable failed', description: message, variant: 'destructive' });
    },
  });

  const regenMutation = useMutation({
    mutationFn: (vars: { password: string; code: string }) =>
      apiRequest('POST', '/api/auth/totp/recovery-codes/regenerate', {
        body: JSON.stringify(vars),
      }) as Promise<{ success: boolean; recoveryCodes: string[] }>,
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes);
      setRegenOpen(false);
      setRegenPassword('');
      setRegenCode('');
      queryClient.invalidateQueries({ queryKey: TOTP_STATUS_KEY });
      toast({
        title: 'New recovery codes generated',
        description: 'Save them now — your previous codes no longer work.',
      });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Could not regenerate recovery codes.';
      toast({ title: 'Regenerate failed', description: message, variant: 'destructive' });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="h-5 w-5 text-muted-foreground" />
          Two-Factor Authentication (TOTP)
        </CardTitle>
        <CardDescription>
          Add a 6-digit one-time code from an authenticator app (Google
          Authenticator, 1Password, Authy, etc.) to your sign-in. Even
          if your password leaks, an attacker still needs your phone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="h-4 w-4" />
            <span>Checking 2FA status...</span>
          </div>
        ) : (
          <>
            {/* Status banner */}
            <div
              className={`rounded-md border px-3 py-2 text-sm ${
                status?.enabled
                  ? 'border-green-200 bg-green-50 text-green-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}
            >
              {status?.enabled ? (
                <>
                  <strong>Enabled.</strong> You have{' '}
                  {status.recoveryCodesRemaining} recovery code
                  {status.recoveryCodesRemaining === 1 ? '' : 's'} remaining.
                </>
              ) : (
                <>
                  <strong>Not enabled.</strong> Your account is currently
                  protected by your password only.
                </>
              )}
            </div>

            {/* Freshly-generated recovery codes */}
            {recoveryCodes && (
              <div className="space-y-2 rounded-md border border-blue-200 bg-blue-50 p-4">
                <p className="text-sm font-semibold text-blue-900">
                  Save these recovery codes somewhere safe:
                </p>
                <p className="text-xs text-blue-900/80">
                  Each code works exactly once. Use them to sign in if you
                  lose access to your authenticator. They will not be shown
                  again.
                </p>
                <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm text-blue-900">
                  {recoveryCodes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Pending enrollment: show QR + verify form */}
            {enrollment ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Scan this QR code with your authenticator app, then enter
                  the 6-digit code it shows to finish setup.
                </p>
                <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt="TOTP QR code"
                      className="h-60 w-60 rounded border"
                    />
                  ) : (
                    <div className="flex h-60 w-60 items-center justify-center rounded border text-sm text-muted-foreground">
                      <Spinner className="h-4 w-4" />
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label className="text-xs">Or enter this secret manually:</Label>
                    <div className="rounded bg-muted px-2 py-1 font-mono text-xs">
                      {enrollment.secret}
                    </div>
                  </div>
                </div>
                <div className="max-w-xs space-y-1.5">
                  <Label htmlFor="totp-enroll-code">6-digit code</Label>
                  <Input
                    id="totp-enroll-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    onClick={() => verifyMutation.mutate(verifyCode)}
                    disabled={verifyMutation.isPending || verifyCode.length < 6}
                    className="gap-2"
                  >
                    {verifyMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                    {verifyMutation.isPending ? 'Verifying...' : 'Verify and enable'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEnrollment(null);
                      setVerifyCode('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : status?.enabled ? (
              // Enabled state: offer to disable (after password re-check)
              // or to re-enroll (which replaces the secret only after the
              // new code is verified, so the old factor stays live until
              // then).
              <div className="space-y-3">
                <div className="max-w-xs space-y-1.5">
                  <Label htmlFor="totp-disable-pw">
                    Confirm your password to disable
                  </Label>
                  <Input
                    id="totp-disable-pw"
                    type="password"
                    autoComplete="current-password"
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => disableMutation.mutate(disablePassword)}
                    disabled={disableMutation.isPending || !disablePassword}
                    className="gap-2"
                  >
                    {disableMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                    Disable 2FA
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => enrollMutation.mutate()}
                    disabled={enrollMutation.isPending}
                    className="gap-2"
                  >
                    {enrollMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                    Re-enroll device
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setRegenOpen((v) => !v);
                      setRegenPassword('');
                      setRegenCode('');
                    }}
                    className="gap-2"
                  >
                    {regenOpen ? 'Cancel regenerate' : 'Regenerate recovery codes'}
                  </Button>
                </div>

                {regenOpen && (
                  <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4">
                    <p className="text-sm">
                      Generate a fresh batch of one-time recovery codes.
                      Your previous codes will stop working immediately,
                      and the new codes are <strong>shown only once</strong>
                      {' '}— save them somewhere safe.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="regen-pw" className="text-xs">
                          Confirm your password
                        </Label>
                        <Input
                          id="regen-pw"
                          type="password"
                          autoComplete="current-password"
                          value={regenPassword}
                          onChange={(e) => setRegenPassword(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="regen-code" className="text-xs">
                          Current 6-digit authenticator code
                        </Label>
                        <Input
                          id="regen-code"
                          type="text"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          value={regenCode}
                          onChange={(e) => setRegenCode(e.target.value)}
                        />
                      </div>
                    </div>
                    <Button
                      type="button"
                      onClick={() =>
                        regenMutation.mutate({
                          password: regenPassword,
                          code: regenCode,
                        })
                      }
                      disabled={
                        regenMutation.isPending ||
                        !regenPassword ||
                        regenCode.length < 6
                      }
                      className="gap-2"
                    >
                      {regenMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                      Generate new codes
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <Button
                type="button"
                onClick={() => enrollMutation.mutate()}
                disabled={enrollMutation.isPending}
                className="gap-2"
              >
                {enrollMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                Enable 2FA
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface AdminSecurityOverviewRow {
  id: number;
  username: string;
  role: string;
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
  totpLastUsedAt: string | null;
}

interface RequireTwoFactorResponse {
  enabled: boolean;
}

const SECURITY_OVERVIEW_KEY = ['/api/auth/admin/security/overview'] as const;
const REQUIRE_2FA_KEY = ['/api/auth/admin/security/require-2fa'] as const;

/**
 * Admin-only Security overview (Task #100). Renders one row per account
 * with its 2FA state, recovery codes remaining, and last-used timestamp,
 * a deployment-wide toggle to require 2FA on every admin login, and a
 * per-row "Disable 2FA" button for other admins (re-checks the calling
 * admin's own password and is server-side audit-logged).
 */
function AdminSecurityOverviewCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [disableTarget, setDisableTarget] = useState<AdminSecurityOverviewRow | null>(null);
  const [disablePassword, setDisablePassword] = useState('');

  const {
    data: rows,
    isLoading: rowsLoading,
    isError: rowsError,
    error: rowsErrorObj,
    refetch: refetchRows,
  } = useQuery<AdminSecurityOverviewRow[]>({
    queryKey: SECURITY_OVERVIEW_KEY,
  });
  const {
    data: requireSetting,
    isLoading: settingLoading,
    isError: settingError,
    error: settingErrorObj,
    refetch: refetchSetting,
  } = useQuery<RequireTwoFactorResponse>({
    queryKey: REQUIRE_2FA_KEY,
  });

  const requireMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest('PUT', '/api/auth/admin/security/require-2fa', {
        body: JSON.stringify({ enabled }),
      }) as Promise<RequireTwoFactorResponse>,
    onSuccess: (data) => {
      queryClient.setQueryData(REQUIRE_2FA_KEY, data);
      toast({
        title: data.enabled
          ? 'Two-factor authentication is now required for all admins'
          : 'Two-factor authentication is no longer required',
      });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Could not update setting.';
      toast({ title: 'Update failed', description: message, variant: 'destructive' });
    },
  });

  const disableMutation = useMutation({
    mutationFn: ({ targetId, password }: { targetId: number; password: string }) =>
      apiRequest('POST', `/api/auth/admin/security/users/${targetId}/disable-totp`, {
        body: JSON.stringify({ password }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SECURITY_OVERVIEW_KEY });
      setDisableTarget(null);
      setDisablePassword('');
      toast({ title: 'Two-factor authentication disabled for that account' });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Could not disable 2FA.';
      toast({ title: 'Disable failed', description: message, variant: 'destructive' });
    },
  });

  const formatLastUsed = (ts: string | null) => {
    if (!ts) return 'Never';
    const d = new Date(ts);
    return `${formatDistanceToNow(d, { addSuffix: true })}`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          Admin 2FA Overview
        </CardTitle>
        <CardDescription>
          See which accounts have a second factor enrolled and require
          every admin to use one. Disabling another admin&apos;s 2FA is
          recorded in the security audit log.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-start justify-between gap-4 rounded-md border p-4">
          <div className="space-y-1">
            <Label htmlFor="require-2fa-toggle" className="text-sm font-medium">
              Require 2FA for all admin logins
            </Label>
            <p className="text-xs text-muted-foreground">
              When on, any admin who hasn&apos;t enrolled an authenticator
              app will be forced through enrollment on their next sign-in
              before they can use the dashboard.
            </p>
          </div>
          {settingLoading ? (
            <Spinner className="h-4 w-4" />
          ) : settingError ? (
            <div className="flex flex-col items-end gap-1">
              <span className="text-xs text-destructive">
                {settingErrorObj instanceof Error
                  ? settingErrorObj.message
                  : 'Failed to load setting.'}
              </span>
              <Button type="button" size="sm" variant="outline" onClick={() => refetchSetting()}>
                Retry
              </Button>
            </div>
          ) : (
            <Switch
              id="require-2fa-toggle"
              checked={Boolean(requireSetting?.enabled)}
              disabled={requireMutation.isPending}
              onCheckedChange={(checked) => requireMutation.mutate(checked)}
            />
          )}
        </div>

        {rowsError ? (
          <div className="flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span>
                {rowsErrorObj instanceof Error
                  ? rowsErrorObj.message
                  : 'Failed to load accounts.'}
              </span>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => refetchRows()}>
              Retry
            </Button>
          </div>
        ) : rowsLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="h-4 w-4" />
            <span>Loading accounts...</span>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">2FA</th>
                  <th className="px-3 py-2">Recovery codes</th>
                  <th className="px-3 py-2">Last used</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((row) => {
                  const isSelf = user?.id === row.id;
                  // Server already restricts the disable endpoint to
                  // admin targets; mirror that in the UI so the button
                  // never appears for a row the API would refuse.
                  const canDisable = !isSelf && row.totpEnabled && row.role === 'admin';
                  return (
                    <tr key={row.id} className="border-t">
                      <td className="px-3 py-2 font-medium">{row.username}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${
                          row.role === 'admin'
                            ? 'bg-purple-100 text-purple-800'
                            : 'bg-gray-100 text-gray-700'
                        }`}>
                          {row.role}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {row.totpEnabled ? (
                          <span className="inline-flex items-center gap-1 text-green-700">
                            <ShieldCheck className="h-4 w-4" /> Enabled
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-700">
                            <ShieldAlert className="h-4 w-4" /> Not enabled
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {row.totpEnabled ? row.recoveryCodesRemaining : '—'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {row.totpEnabled ? formatLastUsed(row.totpLastUsedAt) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {canDisable && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="gap-1"
                            onClick={() => {
                              setDisableTarget(row);
                              setDisablePassword('');
                            }}
                          >
                            <ShieldOff className="h-3.5 w-3.5" />
                            Disable
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {(rows ?? []).length === 0 && (
                  <tr>
                    <td className="px-3 py-4 text-center text-muted-foreground" colSpan={6}>
                      No accounts found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {disableTarget && (
          <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm">
              Disable 2FA for <strong>{disableTarget.username}</strong>?
              They&apos;ll be able to sign in with just their password
              until they re-enroll. This action is logged.
            </p>
            <div className="max-w-xs space-y-1.5">
              <Label htmlFor="admin-disable-pw" className="text-xs">
                Confirm your password
              </Label>
              <Input
                id="admin-disable-pw"
                type="password"
                autoComplete="current-password"
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                disabled={disableMutation.isPending || !disablePassword}
                onClick={() =>
                  disableMutation.mutate({
                    targetId: disableTarget.id,
                    password: disablePassword,
                  })
                }
                className="gap-2"
              >
                {disableMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                Disable 2FA
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDisableTarget(null);
                  setDisablePassword('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface UserCacheStatsResponse {
  size: number;
  hits: number;
  misses: number;
  ttlSeconds: number;
  maxEntries: number;
}

const USER_CACHE_STATS_KEY = ['/api/auth/admin/diagnostics/user-cache'] as const;

function UserCacheDiagnosticsCard() {
  const {
    data: stats,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery<UserCacheStatsResponse>({
    queryKey: USER_CACHE_STATS_KEY,
    refetchInterval: 5000,
  });

  const totalLookups = stats ? stats.hits + stats.misses : 0;
  const hitRatio = totalLookups > 0 ? (stats!.hits / totalLookups) * 100 : null;
  const formatNumber = (n: number) => n.toLocaleString();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-muted-foreground" />
          User Lookup Cache
        </CardTitle>
        <CardDescription>
          Live counters for the in-process user-by-id cache that backs every
          authenticated request. A high hit ratio means the cache is paying
          off; a stuck-low ratio suggests the TTL ({stats ? `${stats.ttlSeconds}s` : '…'})
          may need tuning. Counts are cumulative since the server started.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="h-4 w-4" />
            <span>Loading cache stats…</span>
          </div>
        ) : isError ? (
          <div className="flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span>
                {error instanceof Error
                  ? error.message
                  : 'Failed to load cache stats.'}
              </span>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : stats ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-lg border p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Hit ratio
                </p>
                <p className="mt-1 text-2xl font-semibold">
                  {hitRatio === null ? '—' : `${hitRatio.toFixed(1)}%`}
                </p>
                <p className="text-xs text-muted-foreground">
                  {hitRatio === null
                    ? 'No lookups yet'
                    : `${formatNumber(totalLookups)} lookups`}
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Hits
                </p>
                <p className="mt-1 text-2xl font-semibold text-green-600">
                  {formatNumber(stats.hits)}
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Misses
                </p>
                <p className="mt-1 text-2xl font-semibold text-amber-600">
                  {formatNumber(stats.misses)}
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Cache size
                </p>
                <p className="mt-1 text-2xl font-semibold">
                  {formatNumber(stats.size)}
                </p>
                <p className="text-xs text-muted-foreground">
                  of {formatNumber(stats.maxEntries)} max
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                TTL: {stats.ttlSeconds}s · refreshes every 5s
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => refetch()}
                disabled={isFetching}
                className="gap-2"
              >
                <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface TotpBruteForceAlertRow {
  userId: number;
  username: string | null;
  failureCount: number;
  peakAttemptCount: number;
  firstEventAt: string;
  lastEventAt: string;
}

interface TotpRecoveryBurstAlertRow {
  userId: number;
  username: string | null;
  recoveryCount: number;
  firstEventAt: string;
  lastEventAt: string;
}

interface TotpAuthAlertsResponse {
  bruteForce: TotpBruteForceAlertRow[];
  recoveryBurst: TotpRecoveryBurstAlertRow[];
  windowMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  generatedAt: string;
}

const TOTP_ALERTS_KEY = ['/api/auth/admin/security/totp-alerts'] as const;

/**
 * In-product surface for the TOTP brute-force / recovery-code-burst
 * alerts (Task #177). The webhook in `services/totpAuthAlert.ts` is
 * the immediate page-on-call channel; this card is the long-tail
 * review surface — same window + thresholds, sourced from the
 * `security_audit_log` rows that the webhook already fires off so
 * the panel survives a server restart and an operator who never
 * wired the webhook still has somewhere to triage from.
 *
 * Polls every 30s for near-real-time updates without hammering the
 * DB. We intentionally do NOT show every individual failure event —
 * the audit log card right below this one already has the row-level
 * browser; this card is the per-account headline.
 */
function TotpAuthAlertsCard() {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<TotpAuthAlertsResponse>({
    queryKey: TOTP_ALERTS_KEY,
    refetchInterval: 30_000,
    // Background refetches let the panel feel live without an
    // operator manually clicking "Refresh"; the in-flight indicator
    // on the Refresh button surfaces long-running fetches.
    refetchIntervalInBackground: false,
  });

  const formatWindow = (ms: number) => {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `${minutes}m`;
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
  };

  const totalAlerts = (data?.bruteForce.length ?? 0) + (data?.recoveryBurst.length ?? 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-muted-foreground" />
          Two-Factor Brute-Force Alerts
        </CardTitle>
        <CardDescription>
          Accounts that crossed the brute-force or recovery-code-burst
          thresholds inside the active rolling window. Same data the
          webhook fires on, so this panel surfaces real attacks even
          when no webhook is configured. Updates every 30 seconds.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            {isLoading ? (
              'Loading…'
            ) : data ? (
              <>
                Window: <span className="font-medium text-foreground">last {formatWindow(data.windowMs)}</span>
                {' • '}
                Brute-force threshold: <span className="font-medium text-foreground">{data.failureThreshold}</span>
                {' • '}
                Recovery threshold: <span className="font-medium text-foreground">{data.recoveryThreshold}</span>
              </>
            ) : (
              '—'
            )}
          </p>
          <div className="flex items-center gap-2">
            {data && totalAlerts > 0 ? (
              <Badge variant="destructive">{totalAlerts} active</Badge>
            ) : data && !isLoading ? (
              <Badge variant="outline" className="text-muted-foreground">
                No active alerts
              </Badge>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="gap-1"
            >
              <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {isError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Could not load alerts.</p>
              <p className="text-xs opacity-80">
                {error instanceof Error ? error.message : 'Please try again.'}
              </p>
            </div>
          </div>
        ) : isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="h-4 w-4" />
            <span>Loading alerts…</span>
          </div>
        ) : (
          <div className="space-y-6">
            <div>
              <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <ShieldOff className="h-4 w-4 text-destructive" />
                Brute-force on verify endpoint
              </h4>
              {data && data.bruteForce.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No accounts have crossed the brute-force threshold in the window.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2">Account</th>
                        <th className="px-3 py-2">Failures in window</th>
                        <th className="px-3 py-2">Peak attemptCount</th>
                        <th className="px-3 py-2">First seen</th>
                        <th className="px-3 py-2">Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data?.bruteForce.map((row) => (
                        <tr key={`bf-${row.userId}`} className="border-t">
                          <td className="px-3 py-2 font-medium">
                            {row.username ?? <span className="text-muted-foreground">user #{row.userId}</span>}
                            <span className="ml-1 text-xs text-muted-foreground">(id {row.userId})</span>
                          </td>
                          <td className="px-3 py-2 font-mono">{row.failureCount}</td>
                          <td className="px-3 py-2 font-mono">{row.peakAttemptCount}</td>
                          <td className="px-3 py-2 text-xs">
                            {format(new Date(row.firstEventAt), 'MMM d, HH:mm:ss')}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {formatDistanceToNow(new Date(row.lastEventAt), { addSuffix: true })}
                            <span className="ml-1 text-muted-foreground">
                              ({format(new Date(row.lastEventAt), 'HH:mm:ss')})
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <KeyRound className="h-4 w-4 text-amber-600" />
                Recovery-code burst
              </h4>
              {data && data.recoveryBurst.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No accounts have crossed the recovery-code-burst threshold in the window.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2">Account</th>
                        <th className="px-3 py-2">Codes used in window</th>
                        <th className="px-3 py-2">First seen</th>
                        <th className="px-3 py-2">Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data?.recoveryBurst.map((row) => (
                        <tr key={`rb-${row.userId}`} className="border-t">
                          <td className="px-3 py-2 font-medium">
                            {row.username ?? <span className="text-muted-foreground">user #{row.userId}</span>}
                            <span className="ml-1 text-xs text-muted-foreground">(id {row.userId})</span>
                          </td>
                          <td className="px-3 py-2 font-mono">{row.recoveryCount}</td>
                          <td className="px-3 py-2 text-xs">
                            {format(new Date(row.firstEventAt), 'MMM d, HH:mm:ss')}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {formatDistanceToNow(new Date(row.lastEventAt), { addSuffix: true })}
                            <span className="ml-1 text-muted-foreground">
                              ({format(new Date(row.lastEventAt), 'HH:mm:ss')})
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface SecurityAuditEntry {
  id: number;
  actorUserId: number | null;
  actorUsername: string | null;
  actorIp: string | null;
  action: string;
  targetUserId: number | null;
  targetUsername: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface SecurityAuditPage {
  entries: SecurityAuditEntry[];
  total: number;
  limit: number;
  offset: number;
  actions: string[];
}

const SECURITY_AUDIT_PAGE_SIZE = 25;

/**
 * Security audit history (Task #126). Read-only paginated browser
 * over the security_audit_log table — surfaces who flipped the
 * require-2FA toggle, who disabled another admin's 2FA, and any
 * future security-relevant action recorded with `recordSecurityAudit`
 * / the WithAudit transactional helpers in pgStorage. There is
 * intentionally no UI to delete or edit entries; the table is
 * append-only by design so a compromised admin can be reconstructed
 * after the fact.
 */
function SecurityAuditLogCard() {
  // Form inputs (what the operator is currently typing).
  const [actorInput, setActorInput] = useState('');
  const [targetInput, setTargetInput] = useState('');
  const [actionInput, setActionInput] = useState<string>('all');

  // Applied filters (what's actually in the query). Splitting the
  // "typed" vs "applied" state mirrors the pattern in the standalone
  // McpAudit / SyncAudit pages so a partial filter doesn't refetch on
  // every keystroke.
  const [filters, setFilters] = useState<{
    actorUsername: string;
    targetUsername: string;
    action: string;
  }>({ actorUsername: '', targetUsername: '', action: 'all' });
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const queryKey = [
    '/api/auth/admin/security/audit',
    {
      actorUsername: filters.actorUsername,
      targetUsername: filters.targetUsername,
      action: filters.action,
      limit: SECURITY_AUDIT_PAGE_SIZE,
      offset: page * SECURITY_AUDIT_PAGE_SIZE,
    },
  ] as const;

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<SecurityAuditPage>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.actorUsername.trim()) params.set('actorUsername', filters.actorUsername.trim());
      if (filters.targetUsername.trim()) params.set('targetUsername', filters.targetUsername.trim());
      if (filters.action && filters.action !== 'all') params.set('action', filters.action);
      params.set('limit', String(SECURITY_AUDIT_PAGE_SIZE));
      params.set('offset', String(page * SECURITY_AUDIT_PAGE_SIZE));
      const res = await fetch(`/api/auth/admin/security/audit?${params.toString()}`, {
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

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / SECURITY_AUDIT_PAGE_SIZE));
  const currentPage = page + 1;

  const applyFilters = () => {
    setFilters({
      actorUsername: actorInput,
      targetUsername: targetInput,
      action: actionInput,
    });
    setPage(0);
    setExpanded(new Set());
  };

  const resetFilters = () => {
    setActorInput('');
    setTargetInput('');
    setActionInput('all');
    setFilters({ actorUsername: '', targetUsername: '', action: 'all' });
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5 text-muted-foreground" />
          Security Audit Log
        </CardTitle>
        <CardDescription>
          Tamper-resistant history of admin security actions: who flipped
          the require-2FA toggle, who disabled another admin&apos;s second
          factor, and similar events. Read-only; entries are never
          edited or removed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters();
          }}
          className="grid grid-cols-1 gap-3 md:grid-cols-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="security-audit-action">Action</Label>
            <Select value={actionInput} onValueChange={setActionInput}>
              <SelectTrigger id="security-audit-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actions</SelectItem>
                {(data?.actions ?? []).map((a) => (
                  <SelectItem key={a} value={a}>{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="security-audit-actor">Actor (admin) username</Label>
            <Input
              id="security-audit-actor"
              placeholder="(any)"
              value={actorInput}
              onChange={(e) => setActorInput(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="security-audit-target">Target username</Label>
            <Input
              id="security-audit-target"
              placeholder="(any)"
              value={targetInput}
              onChange={(e) => setTargetInput(e.target.value)}
            />
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" className="flex-1">Apply</Button>
            <Button type="button" variant="outline" onClick={resetFilters}>Reset</Button>
          </div>
        </form>

        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {isLoading
              ? 'Loading…'
              : `${total.toLocaleString()} matching ${total === 1 ? 'entry' : 'entries'}`}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page === 0 || isLoading}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isLoading || currentPage >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="gap-1"
            >
              <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="h-4 w-4" />
            <span>Loading audit entries…</span>
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
              const actorLabel = entry.actorUsername
                ?? (entry.actorUserId !== null ? `user #${entry.actorUserId}` : 'unknown');
              const targetLabel = entry.targetUsername
                ?? (entry.targetUserId !== null ? `user #${entry.targetUserId}` : null);
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
                      <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          <span className="font-mono text-xs rounded bg-muted px-1.5 py-0.5 mr-2">
                            {entry.action}
                          </span>
                          <span>{actorLabel}</span>
                          {targetLabel && (
                            <>
                              <span className="text-muted-foreground"> → </span>
                              <span>{targetLabel}</span>
                            </>
                          )}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {format(new Date(entry.createdAt), 'MMM d, yyyy HH:mm:ss')} • {entry.actorIp ?? 'no ip'}
                        </p>
                      </div>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="space-y-3 border-t bg-muted/20 px-3 py-3">
                      <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                        <div>
                          <span className="font-semibold uppercase tracking-wide text-muted-foreground">Actor: </span>
                          <span>
                            {actorLabel}
                            {entry.actorUserId !== null && (
                              <span className="text-muted-foreground"> (id {entry.actorUserId})</span>
                            )}
                          </span>
                        </div>
                        <div>
                          <span className="font-semibold uppercase tracking-wide text-muted-foreground">Target: </span>
                          <span>
                            {targetLabel ?? '—'}
                            {entry.targetUserId !== null && (
                              <span className="text-muted-foreground"> (id {entry.targetUserId})</span>
                            )}
                          </span>
                        </div>
                        <div>
                          <span className="font-semibold uppercase tracking-wide text-muted-foreground">IP: </span>
                          <span>{entry.actorIp ?? '—'}</span>
                        </div>
                        <div>
                          <span className="font-semibold uppercase tracking-wide text-muted-foreground">When: </span>
                          <span>{format(new Date(entry.createdAt), 'MMM d, yyyy HH:mm:ss xxx')}</span>
                        </div>
                      </div>
                      <div>
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Metadata
                        </p>
                        <pre className="max-h-72 overflow-auto rounded border bg-background p-2 font-mono text-xs whitespace-pre-wrap break-words">
                          {entry.metadata === null
                            ? '(none)'
                            : JSON.stringify(entry.metadata, null, 2)}
                        </pre>
                      </div>
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
