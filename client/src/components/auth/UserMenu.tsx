import { useState } from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '@/context/AuthContext';
import { 
  ChevronDown, 
  User, 
  LogOut, 
  Settings,
  ShieldCheck
} from 'lucide-react';
import { useInvalidAppSettingsCount } from '@/hooks/use-invalid-app-settings-count';

export default function UserMenu() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const invalidAppSettings = useInvalidAppSettingsCount();

  const toggleMenu = () => {
    setIsOpen(!isOpen);
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const handleNavigate = (path: string) => {
    navigate(path);
    setIsOpen(false);
  };

  if (!user) {
    return null;
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggleMenu}
        className="relative flex items-center space-x-1 rounded-full px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
      >
        <span>{user.username}</span>
        <ChevronDown size={16} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        {user.role === 'admin' && invalidAppSettings > 0 ? (
          <span
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-destructive ring-2 ring-background"
            data-testid="badge-user-menu-invalid-app-settings"
            aria-label={`${invalidAppSettings} broken app setting${invalidAppSettings === 1 ? '' : 's'}`}
          />
        ) : null}
      </button>

      {isOpen && (
        <div
          className="absolute right-0 mt-2 w-48 origin-top-right rounded-md bg-white py-1 shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none"
          onBlur={() => setIsOpen(false)}
        >
          <div className="border-b border-gray-100 px-4 py-2">
            <p className="text-sm font-medium text-gray-900">{user.username}</p>
            <p className="text-xs text-gray-500 capitalize">{user.role}</p>
          </div>

          {user.role === 'admin' && (
            <button
              type="button"
              onClick={() => handleNavigate('/admin')}
              className="flex w-full items-center px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
            >
              <ShieldCheck size={16} className="mr-2" />
              Admin Dashboard
            </button>
          )}

          <button
            type="button"
            onClick={() => handleNavigate('/')}
            className="flex w-full items-center px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
          >
            <User size={16} className="mr-2" />
            Dashboard
          </button>

          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
          >
            <LogOut size={16} className="mr-2" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}