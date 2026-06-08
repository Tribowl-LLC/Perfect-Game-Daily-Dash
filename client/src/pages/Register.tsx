import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '@/context/AuthContext';
import { ShieldAlert, ArrowLeft } from 'lucide-react';

export default function Register() {
  const { user } = useAuth();
  const [, navigate] = useLocation();

  // Redirect to dashboard if already logged in
  useEffect(() => {
    if (user) {
      navigate('/');
    }
  }, [user, navigate]);

  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-md">
        <div className="mb-6 text-center">
          <img 
            src="/images/PG_logo_web.PNG" 
            alt="Perfect Game Logo" 
            className="mx-auto h-24"
          />
          <p className="mt-4 text-gray-600">User Registration</p>
        </div>
        
        <div className="flex flex-col items-center justify-center space-y-4 py-8">
          <div className="rounded-full bg-amber-100 p-4">
            <ShieldAlert className="h-10 w-10 text-amber-600" />
          </div>
          <h2 className="text-xl font-semibold text-gray-800">Registration Restricted</h2>
          <p className="text-center text-gray-600">
            Public registration is not available. New user accounts can only be created by an administrator.
          </p>
          <p className="text-center text-gray-600">
            Please contact your system administrator to request access.
          </p>
        </div>
        
        <div className="mt-8 flex justify-center">
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="flex items-center rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Login
          </button>
        </div>
      </div>
    </div>
  );
}