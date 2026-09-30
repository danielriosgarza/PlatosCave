import { createRootRoute, Outlet } from '@tanstack/react-router';
import { GlobalBar } from '../components/GlobalBar';

export const Route = createRootRoute({
  component: () => (
    <>
      <GlobalBar />
      <Outlet />
    </>
  ),
});
