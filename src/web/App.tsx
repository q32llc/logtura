import {
  AppShell,
  Avatar,
  Button,
  Group,
  Loader,
  MantineProvider,
  NavLink as MantineNavLink,
  Stack,
  Text,
  createTheme,
} from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import {
  IconBell,
  IconCloudUpload,
  IconLink,
  IconSend,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { ApiError, api } from "./api";
import { ConnectionDetail } from "./pages/ConnectionDetail";
import { Dashboard } from "./pages/Dashboard";
import { DeployWizard } from "./pages/DeployWizard";
import { Destinations } from "./pages/Destinations";
import { Home } from "./pages/Home";
import { Monitors } from "./pages/Monitors";
import { NewConnection } from "./pages/NewConnection";
import type { ApiUser } from "./types";

const theme = createTheme({
  primaryColor: "teal",
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  defaultRadius: "md",
});

interface AuthState {
  loading: boolean;
  user: ApiUser | null;
}

export function App() {
  const [auth, setAuth] = useState<AuthState>({ loading: true, user: null });

  useEffect(() => {
    api
      .me()
      .then((res) => setAuth({ loading: false, user: res.user }))
      .catch(() => setAuth({ loading: false, user: null }));
  }, []);

  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Notifications position="top-right" />
      <AppShellLayout user={auth.user} loading={auth.loading}>
        <Routes>
          <Route path="/" element={<Home user={auth.user} />} />
          <Route
            path="/app"
            element={
              <Authed loading={auth.loading} user={auth.user}>
                <Dashboard />
              </Authed>
            }
          />
          <Route
            path="/app/connections/new"
            element={
              <Authed loading={auth.loading} user={auth.user}>
                <NewConnection />
              </Authed>
            }
          />
          <Route
            path="/app/connections/:id"
            element={
              <Authed loading={auth.loading} user={auth.user}>
                <ConnectionDetail />
              </Authed>
            }
          />
          <Route
            path="/app/connections/:id/deploy"
            element={
              <Authed loading={auth.loading} user={auth.user}>
                <DeployWizard />
              </Authed>
            }
          />
          <Route
            path="/app/destinations"
            element={
              <Authed loading={auth.loading} user={auth.user}>
                <Destinations />
              </Authed>
            }
          />
          <Route
            path="/app/monitors"
            element={
              <Authed loading={auth.loading} user={auth.user}>
                <Monitors />
              </Authed>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShellLayout>
    </MantineProvider>
  );
}

function AppShellLayout({
  user,
  loading,
  children,
}: {
  user: ApiUser | null;
  loading: boolean;
  children: React.ReactNode;
}) {
  const location = useLocation();
  const isAppRoute = location.pathname.startsWith("/app");
  const showNavbar = isAppRoute && !!user;
  return (
    <AppShell
      header={{ height: 56 }}
      navbar={
        showNavbar
          ? { width: 220, breakpoint: "sm" }
          : { width: 0, breakpoint: "sm" }
      }
      padding={isAppRoute ? "lg" : 0}
      styles={(t) => ({
        main: { backgroundColor: t.colors.dark[8] },
      })}
      disabled={!showNavbar}
    >
      <AppShell.Header>
        <Group h="100%" px="lg" justify="space-between">
          <Group gap="md">
            <Text
              fw={700}
              size="lg"
              component={Link}
              to="/"
              style={{ textDecoration: "none", color: "inherit" }}
            >
              logtura
            </Text>
          </Group>
          <Group gap="md">
            {loading ? (
              <Loader size="xs" />
            ) : user ? (
              <>
                <Group gap="xs">
                  {user.avatarUrl && (
                    <Avatar src={user.avatarUrl} size="sm" radius="xl" />
                  )}
                  <Text size="sm" c="dimmed">
                    {user.githubLogin}
                  </Text>
                </Group>
                <Button
                  component="a"
                  href="/logout"
                  variant="subtle"
                  size="sm"
                >
                  Sign out
                </Button>
              </>
            ) : (
              <Button component="a" href="/login/github" size="sm">
                Sign in with GitHub
              </Button>
            )}
          </Group>
        </Group>
      </AppShell.Header>

      {showNavbar && (
        <AppShell.Navbar p="md">
          <Stack gap={4}>
            <NavItem
              to="/app"
              label="Connections"
              icon={<IconLink size={16} />}
              activeWhen={(p) =>
                p === "/app" || p.startsWith("/app/connections")
              }
            />
            <NavItem
              to="/app/destinations"
              label="Destinations"
              icon={<IconSend size={16} />}
            />
            <NavItem
              to="/app/monitors"
              label="Monitors"
              icon={<IconBell size={16} />}
            />
            <Text size="xs" c="dimmed" mt="xl" mb={4}>
              Coming next
            </Text>
            <MantineNavLink
              label="Deployments"
              leftSection={<IconCloudUpload size={16} />}
              disabled
            />
          </Stack>
        </AppShell.Navbar>
      )}

      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}

function NavItem({
  to,
  label,
  icon,
  activeWhen,
}: {
  to: string;
  label: string;
  icon: React.ReactNode;
  activeWhen?: (path: string) => boolean;
}) {
  const location = useLocation();
  const active = activeWhen
    ? activeWhen(location.pathname)
    : location.pathname === to;
  return (
    <MantineNavLink
      component={Link}
      to={to}
      label={label}
      leftSection={icon}
      active={active}
      variant="filled"
    />
  );
}

function Authed({
  loading,
  user,
  children,
}: {
  loading: boolean;
  user: ApiUser | null;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <Group justify="center" mt="xl">
        <Loader />
      </Group>
    );
  }
  if (!user) return <Navigate to="/?error=auth_required" replace />;
  return <>{children}</>;
}

export function reportApiError(err: unknown, fallback: string) {
  if (err instanceof ApiError) {
    return err.message || fallback;
  }
  return fallback;
}
