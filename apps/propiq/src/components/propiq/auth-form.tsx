'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase-browser';
import { clientEnv } from '@/lib/env';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';

const credentialsSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(8, 'Use at least 8 characters.'),
});

type Mode = 'signin' | 'signup' | 'reset';

const COPY: Record<Mode, { title: string; cta: string; blurb: string }> = {
  signin: {
    title: 'Sign in',
    cta: 'Sign in',
    blurb: 'Your watchlist, portfolio and alerts live behind your account.',
  },
  signup: {
    title: 'Create your account',
    cta: 'Create account',
    blurb: 'Save properties, track changes, and get a verdict that is weighted for how you buy.',
  },
  reset: {
    title: 'Reset your password',
    cta: 'Send reset link',
    blurb: 'We will email you a link to set a new password.',
  },
};

export const AuthForm = ({ mode }: { mode: Mode }) => {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const configured = Boolean(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL && clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setNotice(undefined);

    if (mode !== 'reset') {
      const parsed = credentialsSchema.safeParse({ email, password });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? 'Check the details you entered.');
        return;
      }
    }

    startTransition(async () => {
      try {
        const supabase = createClient();
        if (mode === 'signup') {
          const { error: err } = await supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: `${clientEnv.NEXT_PUBLIC_SITE_URL}/dashboard` },
          });
          if (err) throw err;
          setNotice('Check your email to confirm your address, then sign in.');
        } else if (mode === 'signin') {
          const { error: err } = await supabase.auth.signInWithPassword({ email, password });
          if (err) throw err;
          router.push('/dashboard');
          router.refresh();
        } else {
          const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: `${clientEnv.NEXT_PUBLIC_SITE_URL}/login`,
          });
          if (err) throw err;
          setNotice('If that address has an account, a reset link is on its way.');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
      }
    });
  };

  const copy = COPY[mode];

  return (
    <div className="mx-auto max-w-md px-4 py-14">
      <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">{copy.blurb}</p>

      {!configured && (
        <div
          role="status"
          className="mt-5 rounded-lg border border-[var(--color-negotiate)] bg-[var(--color-negotiate)]/10 p-3 text-xs"
        >
          <p className="font-semibold text-[var(--color-negotiate)]">Auth is not configured here</p>
          <p className="mt-1 text-[var(--text-secondary)]">
            This environment has no Supabase project attached, so sign-in cannot work. In fixture
            mode the watchlist uses a local development identity instead, and everything else on the
            site is browsable without an account.
          </p>
        </div>
      )}

      <form onSubmit={submit} className="mt-6 space-y-4">
        <div className="space-y-1">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={error ? 'auth-error' : undefined}
          />
        </div>

        {mode !== 'reset' && (
          <div className="space-y-1">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        )}

        {error && (
          <p id="auth-error" role="alert" className="text-xs text-[var(--color-avoid)]">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-xs text-[var(--color-buy)]">
            {notice}
          </p>
        )}

        <Button type="submit" size="lg" disabled={pending || !configured} className="w-full">
          {pending && <Loader2 aria-hidden className="animate-spin" />}
          {copy.cta}
        </Button>
      </form>

      <div className="mt-5 space-y-1 text-xs text-[var(--text-secondary)]">
        {mode === 'signin' && (
          <>
            <p>
              No account?{' '}
              <Link href="/signup" className="text-[var(--text-accent)] hover:underline">
                Create one
              </Link>
            </p>
            <p>
              Forgotten your password?{' '}
              <Link href="/login?reset=1" className="text-[var(--text-accent)] hover:underline">
                Reset it
              </Link>
            </p>
          </>
        )}
        {mode !== 'signin' && (
          <p>
            Already have an account?{' '}
            <Link href="/login" className="text-[var(--text-accent)] hover:underline">
              Sign in
            </Link>
          </p>
        )}
      </div>
    </div>
  );
};
