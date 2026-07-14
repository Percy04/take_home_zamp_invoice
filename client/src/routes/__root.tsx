import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootComponent,
  notFoundComponent: () => (
    <div className="panel p-6 text-center">
      <p className="eyebrow">404</p>
      <h1 className="mt-2 text-2xl font-semibold">Page not found</h1>
      <a
        href="/"
        className="mt-6 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Return to invoices
      </a>
    </div>
  ),
});

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell>
        <Outlet />
      </AppShell>
    </QueryClientProvider>
  );
}
