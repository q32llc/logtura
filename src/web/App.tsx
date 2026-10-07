import {
  AppShell,
  Avatar,
  Badge,
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
  IconTerminal,
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
import { CliAccess } from "./pages/CliAccess";
import { Dashboard } from "./pages/Dashboard";
import { DeployWizard } from "./pages/DeployWizard";
import { DeploymentDetail } from "./pages/DeploymentDetail";
import { Deployments } from "./pages/Deployments";
import { Destinations } from "./pages/Destinations";
import { Docs } from "./pages/Docs";
import { Home } from "./pages/Home";
import { Privacy, Support, Terms } from "./pages/Policies";
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

export function App({ initialUser, staticRender = false }: { initialUser?: ApiUser | null; staticRender?: boolean } = {}) {
  const [auth, setAuth] = useState<AuthState>({ loading: initialUser === undefined, user: initialUser ?? null });

  useEffect(() => {
    if (staticRender) return;
    api
      .me()
      .then((res) => setAuth({ loading: false, user: res.user }))
      .catch(() => setAuth({ loading: false, user: null }));
  }, [staticRender]);

  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Notifications position="top-right" />
      <AppShellLayout user={auth.user} loading={auth.loading}>
        <Routes>
          <Route path="/" element={<Home user={auth.user} />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/support" element={<Support />} />
          <Route path="/app/cli" element={<CliAccess user={auth.user} loading={auth.loading} />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/docs/:slug" element={<Docs />} />
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
          <Route
            path="/app/deployments"
            element={
              <Authed loading={auth.loading} user={auth.user}>
                <Deployments />
              </Authed>
            }
          />
          <Route
            path="/app/deployments/:id"
            element={
              <Authed loading={auth.loading} user={auth.user}>
                <DeploymentDetail />
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

  // Light-weight poll for out-of-date deployment count so the nav
  // can surface a badge. 30s cadence keeps the badge fresh enough
  // that a config change becomes visible without a page reload, and
  // the request is dirt cheap (one D1 row read per deployment).
  const [outdatedCount, setOutdatedCount] = useState(0);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api.listDeployments();
        if (cancelled) return;
        setOutdatedCount(
          r.deployments.filter((d) => d.bundleOutdated).length,
        );
      } catch {
        // ignore polling errors; the badge just stays stale
      }
    };
    void tick();
    const handle = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [user]);
  return (
    <AppShell
      header={{ height: 56 }}
      navbar={
        showNavbar
          ? { width: 220, breakpoint: "sm" }
          : { width: 0, breakpoint: "sm", collapsed: { desktop: true, mobile: true } }
      }
      padding={isAppRoute ? "lg" : 0}
      styles={(t) => ({
        main: { backgroundColor: t.colors.dark[8] },
      })}
    >
      <AppShell.Header>
        <Group h="100%" px="lg" justify="space-between">
          <Group gap="sm">
            <Link
              to="/"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <img
                src="/logo.svg"
                alt=""
                width={28}
                height={28}
                style={{ display: "block" }}
              />
              <Text fw={700} size="lg">
                logtura
              </Text>
            </Link>
          </Group>
          <Group gap="md">
            {!isAppRoute && (
              <Button
                component={Link}
                to="/docs"
                variant="subtle"
                size="sm"
              >
                Docs
              </Button>
            )}
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
            <NavItem to="/app/cli" label="CLI access" icon={<IconTerminal size={16} />} />
            <NavItem
              to="/app/deployments"
              label="Deployments"
              icon={<IconCloudUpload size={16} />}
              activeWhen={(p) => p.startsWith("/app/deployments")}
              badge={outdatedCount > 0 ? outdatedCount : undefined}
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
  badge,
}: {
  to: string;
  label: string;
  icon: React.ReactNode;
  activeWhen?: (path: string) => boolean;
  /** Optional small number to surface in the nav. Used today by
   *  Deployments to show how many have out-of-date bundles. */
  badge?: number;
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
      rightSection={
        badge !== undefined ? (
          <Badge size="xs" color="orange" variant="filled">
            {badge}
          </Badge>
        ) : undefined
      }
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
