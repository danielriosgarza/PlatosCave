import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

/** The element in the resource toolbar where the open tab puts its local tools (§5). */
export const ToolsHost = createContext<HTMLElement | null>(null);

/**
 * Local tools of the material on show: they sit in the resource toolbar, before Full screen and
 * Focus. Without a toolbar around (a viewer on its own) they render where they are.
 */
export function ResourceTools({ children }: { children: ReactNode }) {
  const host = useContext(ToolsHost);
  return host ? createPortal(children, host) : <div>{children}</div>;
}
