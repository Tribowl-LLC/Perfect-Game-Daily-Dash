import { ReactNode, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '@/context/AuthContext';
import { Spinner } from '@/components/ui/spinner';

interface ProtectedRouteProps {
  children: ReactNode;
  requiredRole?: string;
}

export default function ProtectedRoute({ 
  children, 
  requiredRole 
}: ProtectedRouteProps) {
  const { user, isLoading, isAuthenticated, checkAuth } = useAuth();
  const [, navigate] = useLocation();
  
  // Force a check for authentication on component mount
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);
  
  // Use useEffect for navigation to prevent state updates during render
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/login');
    }
  }, [isLoading, isAuthenticated, navigate]);
  
  // Show loading spinner while checking authentication
  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }
  
  // Don't render anything if not authenticated (the useEffect above will handle redirect)
  if (!isAuthenticated) {
    return null;
  }
  
  // Check role if required
  if (requiredRole && user?.role !== requiredRole) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center p-4 text-center">
        <h1 className="text-2xl font-bold text-red-600">Access Denied</h1>
        <p className="mt-2 text-gray-600">
          You don't have permission to access this page.
        </p>
        <button
          type="button"
          className="mt-4 rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600"
          onClick={() => navigate('/')}
        >
          Go to Dashboard
        </button>
      </div>
    );
  }
  
  // Render children if authenticated and authorized
  return <>{children}</>;
}