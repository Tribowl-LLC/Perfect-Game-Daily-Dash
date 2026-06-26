import { useEffect, useState } from "react";
import { 
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/context/AuthContext";
import { useTheme } from "@/context/ThemeContext";
import { ShieldCheck, User, LogOut, CreditCard, CircleCheck, Moon, Sun, KeyRound, RefreshCw } from "lucide-react";
import { useLocation } from "wouter";
import { useInvalidAppSettingsCount } from "@/hooks/use-invalid-app-settings-count";
import { apiRequest } from "@/lib/queryClient";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

interface AccountDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function AccountDrawer({ open, onOpenChange }: AccountDrawerProps) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [_, navigate] = useLocation();
  const invalidAppSettings = useInvalidAppSettingsCount();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [catalogSyncing, setCatalogSyncing] = useState(false);

  const handleNavigate = (path: string) => {
    navigate(path);
    onOpenChange(false);
  };

  const handleLogout = () => {
    logout();
    onOpenChange(false);
  };

  const handleCatalogSync = async () => {
    setCatalogSyncing(true);
    try {
      await apiRequest('POST', '/api/sync/catalog');
      queryClient.invalidateQueries({ queryKey: ['/api/items/categories'] });
      queryClient.invalidateQueries({ queryKey: ['/api/items/ranked'] });
      toast({ title: 'Catalog sync complete', description: 'Items and categories refreshed from Square.' });
    } catch {
      toast({ title: 'Catalog sync failed', description: 'Check server logs for details.', variant: 'destructive' });
    } finally {
      setCatalogSyncing(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="bg-background/95 backdrop-blur-sm border-t border-t-border">
        <div className="mx-auto w-full max-w-sm">
          <DrawerHeader>
            <DrawerTitle className="text-foreground text-center">Account</DrawerTitle>
            <DrawerDescription className="text-muted-foreground text-center">
              {user ? `Logged in as ${user.username}` : 'Manage your account'}
            </DrawerDescription>
          </DrawerHeader>
          <div className="px-4 py-2 pb-6 space-y-4">
            {user?.role === 'admin' && (
              <>
                <Button
                  variant="outline"
                  className="w-full text-left justify-start gap-2 border-border hover:bg-accent/50"
                  onClick={() => handleNavigate('/admin')}
                  data-testid="button-admin-nav"
                >
                  <span className="relative flex h-5 w-5 items-center justify-center">
                    <ShieldCheck className="h-5 w-5 text-primary" />
                    {invalidAppSettings > 0 ? (
                      <span
                        className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-destructive ring-2 ring-background"
                        data-testid="badge-admin-nav-invalid-app-settings"
                        aria-label={`${invalidAppSettings} broken app setting${invalidAppSettings === 1 ? '' : 's'}`}
                      />
                    ) : null}
                  </span>
                  Users
                  {invalidAppSettings > 0 ? (
                    <span className="ml-auto rounded-full bg-destructive px-2 py-0.5 text-xs font-medium text-destructive-foreground">
                      {invalidAppSettings}
                    </span>
                  ) : null}
                </Button>
                <Button
                  variant="outline"
                  className="w-full text-left justify-start gap-2 border-border hover:bg-accent/50"
                  onClick={handleCatalogSync}
                  disabled={catalogSyncing}
                >
                  <RefreshCw className={`h-5 w-5 text-primary ${catalogSyncing ? 'animate-spin' : ''}`} />
                  {catalogSyncing ? 'Syncing catalog…' : 'Sync catalog'}
                </Button>
              </>
            )}
            <Button
              variant="outline"
              className="w-full text-left justify-start gap-2 border-border hover:bg-accent/50"
              onClick={() => handleNavigate('/account')}
              data-testid="button-account-settings"
            >
              <KeyRound className="h-5 w-5 text-primary" />
              Account settings
            </Button>
            <Button 
              variant="outline" 
              className="w-full text-left justify-start gap-2 border-border hover:bg-accent/50"
              onClick={handleLogout}
            >
              <LogOut className="h-5 w-5 text-primary" />
              Sign out
            </Button>
            
            {/* Dark Mode Toggle */}
            <div className="flex items-center justify-between px-2 py-3 border border-border rounded-md">
              <div className="flex items-center gap-2">
                {theme === 'dark' ? (
                  <Moon className="h-5 w-5 text-primary" />
                ) : (
                  <Sun className="h-5 w-5 text-primary" />
                )}
                <span className="text-foreground">{theme === 'dark' ? 'Dark' : 'Light'} Mode</span>
              </div>
              <Switch 
                checked={theme === 'dark'}
                onCheckedChange={toggleTheme}
              />
            </div>
          </div>
          <DrawerFooter>
            <DrawerClose asChild>
              <Button variant="outline" className="border-border hover:bg-accent/50">
                Close
              </Button>
            </DrawerClose>
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
}