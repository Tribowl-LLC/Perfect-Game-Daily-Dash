import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { ShieldAlert, Smartphone } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/context/AuthContext';

interface TotpEnrollResponse {
  secret: string;
  otpauthUrl: string;
}

/**
 * Forced TOTP enrollment screen (Task #100). Mounted by the router when
 * the authenticated user is an admin who has not enrolled TOTP and the
 * deployment-wide require-admin-2FA setting is on. The user cannot
 * navigate away — every other route is gated until they finish
 * enrollment OR the setting is turned off.
 *
 * Mirrors the enrollment portion of the self-service TwoFactorAuthCard
 * but with a logout escape hatch instead of a Cancel button so an
 * operator who can't enrol on this device isn't trapped.
 */
export default function ForceEnable2FA() {
  const { user, logout, checkAuth } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [enrollment, setEnrollment] = useState<TotpEnrollResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

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
      queryClient.invalidateQueries({ queryKey: ['/api/auth/me'] });
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
      queryClient.invalidateQueries({ queryKey: ['/api/auth/me'] });
      toast({
        title: 'Two-factor authentication enabled',
        description: 'Save your recovery codes — they will not be shown again.',
      });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'That code did not match.';
      toast({ title: 'Verification failed', description: message, variant: 'destructive' });
    },
  });

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-6 w-6 text-amber-600" />
              Two-factor authentication is required
            </CardTitle>
            <CardDescription>
              Your administrator has required every admin account to use
              an authenticator app. Finish enrolling {user?.username
                ? <strong>{user.username}</strong>
                : 'your account'} to continue.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {recoveryCodes ? (
              <div className="space-y-3 rounded-md border border-blue-200 bg-blue-50 p-4">
                <p className="text-sm font-semibold text-blue-900">
                  Save these recovery codes somewhere safe:
                </p>
                <p className="text-xs text-blue-900/80">
                  Each code works exactly once. Use them to sign in if you
                  lose access to your authenticator. They will not be
                  shown again.
                </p>
                <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm text-blue-900">
                  {recoveryCodes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <Button
                  type="button"
                  className="mt-3"
                  onClick={() => checkAuth()}
                >
                  I&apos;ve saved my recovery codes — continue
                </Button>
              </div>
            ) : enrollment ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Scan this QR code with your authenticator app, then
                  enter the 6-digit code it shows to finish setup.
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
                  <Label htmlFor="totp-force-code">6-digit code</Label>
                  <Input
                    id="totp-force-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value)}
                  />
                </div>
                <Button
                  type="button"
                  onClick={() => verifyMutation.mutate(verifyCode)}
                  disabled={verifyMutation.isPending || verifyCode.length < 6}
                  className="gap-2"
                >
                  {verifyMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                  {verifyMutation.isPending ? 'Verifying...' : 'Verify and enable'}
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Click below to generate a setup QR code. You&apos;ll need
                  an authenticator app such as Google Authenticator,
                  1Password, or Authy.
                </p>
                <Button
                  type="button"
                  onClick={() => enrollMutation.mutate()}
                  disabled={enrollMutation.isPending}
                  className="gap-2"
                >
                  <Smartphone className="h-4 w-4" />
                  {enrollMutation.isPending ? 'Starting...' : 'Set up authenticator'}
                </Button>
              </div>
            )}
            <div className="border-t pt-4 text-xs text-muted-foreground">
              Can&apos;t enrol right now?{' '}
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => logout()}
              >
                Sign out
              </button>{' '}
              and ask another administrator to disable the requirement
              or to disable 2FA on your account.
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
