import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { queryClient } from '@/lib/queryClient';

interface User {
  id: number;
  username: string;
  role?: string;
  // True for accounts whose stored password predates the strong-password
  // policy (Task #55). When set, the app must redirect to the forced
  // password-change screen and refuse to render any other page.
  mustRotatePassword?: boolean;
  // Recovery email address attached to the account (or null if the user
  // hasn't been enrolled in account recovery yet). Set/cleared by an
  // admin from the user-management page (Task #59).
  email?: string | null;
  // Server-reported TOTP state. `mustEnrollTotp` is true only when the
  // user is an admin without TOTP enrolled AND the deployment-wide
  // require-admin-2FA setting is on (Task #100). The router gates the
  // rest of the app behind a forced-enrollment screen when set.
  totpEnabled?: boolean;
  mustEnrollTotp?: boolean;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/auth/me', { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      
      if (response.ok) {
        const userData = await response.json();
        if (userData) {
          setUser(userData);
          setIsAuthenticated(true);
        } else {
          setUser(null);
          setIsAuthenticated(false);
        }
      } else {
        setUser(null);
        setIsAuthenticated(false);
      }
    } catch (error) {
      console.error('Auth check error:', error);
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const login = async (username: string, password: string): Promise<boolean> => {
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ username, password }),
        credentials: 'include',
      });

      const responseData = await response.json();
      
      if (response.ok && responseData.success && responseData.user) {
        setUser(responseData.user);
        setIsAuthenticated(true);
        return true;
      } else {
        return false;
      }
    } catch (error) {
      console.error('Login error:', error);
      return false;
    }
  };

  const logout = async (): Promise<void> => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include' });
      setUser(null);
      setIsAuthenticated(false);
      await queryClient.invalidateQueries();
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const value = {
    user,
    isLoading,
    isAuthenticated,
    login,
    logout,
    checkAuth,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  
  return context;
}
