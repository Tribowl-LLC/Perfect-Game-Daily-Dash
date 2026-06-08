import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useLocation } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';

import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * Self-service account settings page (Task #179, #185). Currently hosts
 * a "Change password" form (POST /api/auth/me/password, Task #171) and a
 * "Two-factor authentication" card (Task #185) that lets a regular
 * user enroll, regenerate recovery codes, and disable 2FA on their own
 * account — previously only possible from the admin panel.
 *
 * The change-password endpoint verifies the current password, then
 * revokes every OTHER active session while re-persisting this one —
 * other tabs/devices get redirected to /login on their next
 * /api/auth/me poll via the global navigation guard in App.tsx.
 */

// Mirror of shared/schema.ts strongPasswordSchema. Duplicated for
// bundle-size reasons; the server is authoritative and any policy
// drift surfaces as a 400 we map inline.
const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Please enter your current password'),
    newPassword: z
      .string()
      .min(12, 'Password must be at least 12 characters')
      .max(128, 'Password must be at most 128 characters')
      .refine((p) => /[A-Za-z]/.test(p), 'Password must contain at least one letter')
      .refine((p) => /[0-9]/.test(p), 'Password must contain at least one digit'),
    confirmPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    // Block no-op rotations — they'd revoke every other device for
    // a password that didn't actually change.
    message: 'New password must be different from your current password',
    path: ['newPassword'],
  });

type FormValues = z.infer<typeof changePasswordSchema>;

export default function AccountSettings() {
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
  });

  const changePassword = useMutation({
    mutationFn: async (values: FormValues) => {
      // confirmPassword is a client-side guard only; don't send it.
      return await apiRequest('POST', '/api/auth/me/password', {
        body: JSON.stringify({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
        }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/auth/me'] });
      toast({
        title: 'Password updated',
        description:
          'Your password has been changed. Other tabs and devices have been signed out.',
      });
      form.reset();
      setServerError(null);
    },
    onError: (error: unknown) => {
      // apiRequest throws `Error('${status}: ${body}')`. Parse status
      // and body so we can map 401/400 to the right field instead of
      // showing a generic banner.
      const { status, message: serverMsg } = parseApiError(error);

      if (status === '401') {
        form.setError('currentPassword', {
          type: 'server',
          message: serverMsg || 'Current password is incorrect',
        });
        setServerError(null);
      } else if (status === '400') {
        form.setError('newPassword', {
          type: 'server',
          message: serverMsg || 'That password does not meet our policy.',
        });
        setServerError(null);
      } else if (status === '429') {
        setServerError(
          'Too many password-change attempts. Please wait a few minutes and try again.',
        );
      } else {
        setServerError(
          serverMsg || 'Something went wrong. Please try again in a moment.',
        );
      }
    },
  });

  const onSubmit = (values: FormValues) => {
    setServerError(null);
    changePassword.mutate(values);
  };

  return (
    <div className="min-h-screen bg-background py-8 px-4">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-6">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => navigate('/')}
            className="gap-1"
            data-testid="button-back-to-dashboard"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to dashboard
          </Button>
        </div>

        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-foreground">
            Account settings
          </h1>
          {user?.username && (
            <p className="mt-1 text-sm text-muted-foreground">
              Signed in as <span className="font-mono">{user.username}</span>
            </p>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              Change password
            </CardTitle>
            <CardDescription>
              Choose a new password for your account. Your other browser
              tabs and devices will be signed out automatically; this
              device stays signed in.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-4"
              noValidate
            >
              {serverError && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                  data-testid="text-change-password-error"
                >
                  {serverError}
                </div>
              )}

              <div>
                <Label htmlFor="current-password">Current password</Label>
                <Input
                  id="current-password"
                  type="password"
                  autoComplete="current-password"
                  className="mt-1"
                  data-testid="input-current-password"
                  {...form.register('currentPassword')}
                />
                {form.formState.errors.currentPassword && (
                  <p
                    className="mt-1 text-sm text-destructive"
                    data-testid="error-current-password"
                  >
                    {form.formState.errors.currentPassword.message}
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  className="mt-1"
                  data-testid="input-new-password"
                  {...form.register('newPassword')}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  At least 12 characters, including a letter and a digit.
                </p>
                {form.formState.errors.newPassword && (
                  <p
                    className="mt-1 text-sm text-destructive"
                    data-testid="error-new-password"
                  >
                    {form.formState.errors.newPassword.message}
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  className="mt-1"
                  data-testid="input-confirm-password"
                  {...form.register('confirmPassword')}
                />
                {form.formState.errors.confirmPassword && (
                  <p
                    className="mt-1 text-sm text-destructive"
                    data-testid="error-confirm-password"
                  >
                    {form.formState.errors.confirmPassword.message}
                  </p>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    form.reset();
                    setServerError(null);
                  }}
                  disabled={changePassword.isPending}
                  data-testid="button-reset-form"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={changePassword.isPending}
                  data-testid="button-submit-change-password"
                >
                  {changePassword.isPending ? 'Updating...' : 'Update password'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="mt-6">
          <TwoFactorAuthCard />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Two-factor authentication (TOTP) — self-service for the signed-in user
// ---------------------------------------------------------------------

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

/**
 * Parse the `Error('${status}: ${body}')` shape produced by `apiRequest`
 * into `{ status, message }`. The body may be JSON (`{error, message}`)
 * or plain text — return whichever is most user-readable.
 */
function parseApiError(error: unknown): { status: string | undefined; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  const status = raw.match(/^(\d{3}):/)?.[1];
  const bodyText = raw.replace(/^\d{3}:\s*/, '');
  let message = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as { error?: string; message?: string };
    message = parsed.error || parsed.message || bodyText;
  } catch {
    // Plain-text body — keep it.
  }
  return { status, message };
}

/**
 * Self-service 2FA management. Mirrors the admin-panel flow in
 * client/src/pages/Admin.tsx → TwoFactorAuthCard, but adapted to the
 * inline-error pattern used by the change-password form on this page:
 * field-level messages for 400/401, a distinct rate-limit banner for
 * 429, and a fall-through banner for anything else.
 */
function TwoFactorAuthCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {
    data: status,
    isLoading,
    isError: statusIsError,
    error: statusError,
    refetch: refetchStatus,
  } = useQuery<TotpStatusResponse>({
    queryKey: TOTP_STATUS_KEY,
  });

  // Pending-enrollment + freshly-issued-recovery-codes UI state.
  const [enrollment, setEnrollment] = useState<TotpEnrollResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [enrollBanner, setEnrollBanner] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // Disable form (password-gated, mirrors the change-password gate).
  const [disablePassword, setDisablePassword] = useState('');
  const [disablePasswordError, setDisablePasswordError] = useState<string | null>(null);
  const [disableBanner, setDisableBanner] = useState<string | null>(null);

  // Regenerate-recovery-codes form (password + current TOTP code).
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenPassword, setRegenPassword] = useState('');
  const [regenCode, setRegenCode] = useState('');
  const [regenPasswordError, setRegenPasswordError] = useState<string | null>(null);
  const [regenCodeError, setRegenCodeError] = useState<string | null>(null);
  const [regenBanner, setRegenBanner] = useState<string | null>(null);

  // Render the QR whenever a fresh otpauth URL arrives. Done in an
  // effect (rather than inline) so the qrcode call doesn't run on every
  // re-render.
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
      setVerifyError(null);
      setEnrollBanner(null);
      queryClient.invalidateQueries({ queryKey: TOTP_STATUS_KEY });
    },
    onError: (error: unknown) => {
      const { status, message } = parseApiError(error);
      if (status === '429') {
        // Distinct rate-limit banner — same pattern as the verify /
        // disable / regenerate flows on this card.
        setEnrollBanner(
          'Too many attempts. Please wait a few minutes and try again.',
        );
      } else {
        setEnrollBanner(message || 'Could not start 2FA setup. Please try again.');
      }
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
      setVerifyError(null);
      setEnrollBanner(null);
      queryClient.invalidateQueries({ queryKey: TOTP_STATUS_KEY });
      toast({
        title: 'Two-factor authentication enabled',
        description: 'Save your recovery codes — they will not be shown again.',
      });
    },
    onError: (error: unknown) => {
      const { status, message } = parseApiError(error);
      if (status === '429') {
        setEnrollBanner(
          'Too many attempts. Please wait a few minutes and try again.',
        );
        setVerifyError(null);
      } else {
        setVerifyError(message || 'That code did not match.');
        setEnrollBanner(null);
      }
    },
  });

  const disableMutation = useMutation({
    mutationFn: (password: string) =>
      apiRequest('POST', '/api/auth/totp/disable', {
        body: JSON.stringify({ password }),
      }),
    onSuccess: () => {
      setDisablePassword('');
      setDisablePasswordError(null);
      setDisableBanner(null);
      setRecoveryCodes(null);
      queryClient.invalidateQueries({ queryKey: TOTP_STATUS_KEY });
      toast({ title: 'Two-factor authentication disabled' });
    },
    onError: (error: unknown) => {
      const { status, message } = parseApiError(error);
      if (status === '401') {
        setDisablePasswordError(message || 'Password did not match.');
        setDisableBanner(null);
      } else if (status === '429') {
        setDisableBanner(
          'Too many attempts. Please wait a few minutes and try again.',
        );
        setDisablePasswordError(null);
      } else {
        setDisableBanner(message || 'Could not disable 2FA. Please try again.');
        setDisablePasswordError(null);
      }
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
      setRegenPasswordError(null);
      setRegenCodeError(null);
      setRegenBanner(null);
      queryClient.invalidateQueries({ queryKey: TOTP_STATUS_KEY });
      toast({
        title: 'New recovery codes generated',
        description: 'Save them now — your previous codes no longer work.',
      });
    },
    onError: (error: unknown) => {
      const { status, message } = parseApiError(error);
      if (status === '401') {
        setRegenPasswordError(message || 'Password did not match.');
        setRegenCodeError(null);
        setRegenBanner(null);
      } else if (status === '400') {
        // The server returns 400 for a wrong authenticator code. The
        // password field has its own 401 path above, so a 400 here is
        // safe to attribute to the code field.
        setRegenCodeError(message || 'That authenticator code did not match.');
        setRegenPasswordError(null);
        setRegenBanner(null);
      } else if (status === '429') {
        setRegenBanner(
          'Too many attempts. Please wait a few minutes and try again.',
        );
        setRegenPasswordError(null);
        setRegenCodeError(null);
      } else {
        setRegenBanner(
          message || 'Could not regenerate recovery codes. Please try again.',
        );
        setRegenPasswordError(null);
        setRegenCodeError(null);
      }
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="h-5 w-5 text-primary" />
          Two-factor authentication
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
        ) : statusIsError || !status ? (
          // Distinct fallback so a transient /totp/status failure isn't
          // misread as "2FA is off" — that would push the user toward
          // re-enrolling on top of an already-active factor.
          <div
            role="alert"
            className="space-y-3"
            data-testid="container-totp-status-error"
          >
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <p className="font-medium">
                Could not load your 2FA status.
              </p>
              <p className="mt-1 text-xs opacity-80">
                {statusError instanceof Error
                  ? statusError.message
                  : 'Please try again in a moment.'}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => refetchStatus()}
              data-testid="button-retry-totp-status"
            >
              Retry
            </Button>
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
              data-testid="text-totp-status"
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

            {/* Freshly-generated recovery codes (one-time reveal) */}
            {recoveryCodes && (
              <div
                className="space-y-2 rounded-md border border-blue-200 bg-blue-50 p-4"
                data-testid="container-recovery-codes"
              >
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
                    <li key={c} data-testid="text-recovery-code">
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Pending enrollment: QR + code-entry */}
            {enrollment ? (
              <div className="space-y-3">
                {enrollBanner && (
                  <div
                    role="alert"
                    className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                    data-testid="text-enroll-error"
                  >
                    {enrollBanner}
                  </div>
                )}
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
                      data-testid="img-totp-qr"
                    />
                  ) : (
                    <div className="flex h-60 w-60 items-center justify-center rounded border text-sm text-muted-foreground">
                      <Spinner className="h-4 w-4" />
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label className="text-xs">Or enter this secret manually:</Label>
                    <div
                      className="rounded bg-muted px-2 py-1 font-mono text-xs"
                      data-testid="text-totp-secret"
                    >
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
                    onChange={(e) => {
                      setVerifyCode(e.target.value);
                      if (verifyError) setVerifyError(null);
                    }}
                    data-testid="input-totp-enroll-code"
                  />
                  {verifyError && (
                    <p
                      className="text-sm text-destructive"
                      data-testid="error-totp-enroll-code"
                    >
                      {verifyError}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    onClick={() => {
                      setVerifyError(null);
                      setEnrollBanner(null);
                      verifyMutation.mutate(verifyCode);
                    }}
                    disabled={verifyMutation.isPending || verifyCode.length < 6}
                    className="gap-2"
                    data-testid="button-verify-totp-enroll"
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
                      setVerifyError(null);
                      setEnrollBanner(null);
                    }}
                    data-testid="button-cancel-totp-enroll"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : status?.enabled ? (
              // Enabled state: regenerate recovery codes (password+code
              // gate) and disable 2FA (password gate, mirrors the
              // change-password gate above).
              <div className="space-y-4">
                <div className="space-y-3">
                  {disableBanner && (
                    <div
                      role="alert"
                      className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                      data-testid="text-totp-disable-error"
                    >
                      {disableBanner}
                    </div>
                  )}
                  <div className="max-w-xs space-y-1.5">
                    <Label htmlFor="totp-disable-pw">
                      Confirm your password to disable
                    </Label>
                    <Input
                      id="totp-disable-pw"
                      type="password"
                      autoComplete="current-password"
                      value={disablePassword}
                      onChange={(e) => {
                        setDisablePassword(e.target.value);
                        if (disablePasswordError) setDisablePasswordError(null);
                      }}
                      data-testid="input-totp-disable-password"
                    />
                    {disablePasswordError && (
                      <p
                        className="text-sm text-destructive"
                        data-testid="error-totp-disable-password"
                      >
                        {disablePasswordError}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => {
                        setDisablePasswordError(null);
                        setDisableBanner(null);
                        disableMutation.mutate(disablePassword);
                      }}
                      disabled={disableMutation.isPending || !disablePassword}
                      className="gap-2"
                      data-testid="button-disable-totp"
                    >
                      {disableMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                      Disable 2FA
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setRegenOpen((v) => !v);
                        setRegenPassword('');
                        setRegenCode('');
                        setRegenPasswordError(null);
                        setRegenCodeError(null);
                        setRegenBanner(null);
                      }}
                      className="gap-2"
                      data-testid="button-toggle-regenerate"
                    >
                      {regenOpen ? 'Cancel regenerate' : 'Regenerate recovery codes'}
                    </Button>
                  </div>
                </div>

                {regenOpen && (
                  <div
                    className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4"
                    data-testid="container-regenerate-form"
                  >
                    <p className="text-sm">
                      Generate a fresh batch of one-time recovery codes.
                      Your previous codes will stop working immediately,
                      and the new codes are <strong>shown only once</strong>
                      {' '}— save them somewhere safe.
                    </p>
                    {regenBanner && (
                      <div
                        role="alert"
                        className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                        data-testid="text-totp-regenerate-error"
                      >
                        {regenBanner}
                      </div>
                    )}
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
                          onChange={(e) => {
                            setRegenPassword(e.target.value);
                            if (regenPasswordError) setRegenPasswordError(null);
                          }}
                          data-testid="input-regenerate-password"
                        />
                        {regenPasswordError && (
                          <p
                            className="text-xs text-destructive"
                            data-testid="error-regenerate-password"
                          >
                            {regenPasswordError}
                          </p>
                        )}
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
                          onChange={(e) => {
                            setRegenCode(e.target.value);
                            if (regenCodeError) setRegenCodeError(null);
                          }}
                          data-testid="input-regenerate-code"
                        />
                        {regenCodeError && (
                          <p
                            className="text-xs text-destructive"
                            data-testid="error-regenerate-code"
                          >
                            {regenCodeError}
                          </p>
                        )}
                      </div>
                    </div>
                    <Button
                      type="button"
                      onClick={() => {
                        setRegenPasswordError(null);
                        setRegenCodeError(null);
                        setRegenBanner(null);
                        regenMutation.mutate({
                          password: regenPassword,
                          code: regenCode,
                        });
                      }}
                      disabled={
                        regenMutation.isPending ||
                        !regenPassword ||
                        regenCode.length < 6
                      }
                      className="gap-2"
                      data-testid="button-submit-regenerate"
                    >
                      {regenMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                      Generate new codes
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              // Off state: single CTA to start enrollment.
              <div className="space-y-3">
                {enrollBanner && (
                  <div
                    role="alert"
                    className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                    data-testid="text-enroll-error"
                  >
                    {enrollBanner}
                  </div>
                )}
                <Button
                  type="button"
                  onClick={() => {
                    setEnrollBanner(null);
                    enrollMutation.mutate();
                  }}
                  disabled={enrollMutation.isPending}
                  className="gap-2"
                  data-testid="button-start-totp-enroll"
                >
                  {enrollMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                  Set up 2FA
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
