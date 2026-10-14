import type { SiteCatalogue } from '@parallax/contracts';
import {
  type AnyRoute,
  createRoute,
  lazyRouteComponent,
  Link as RouterLink,
} from '@tanstack/react-router';
import type { AnchorHTMLAttributes, ComponentType } from 'react';
import { usePageTitle } from './components/pageTitle';

/**
 * A site's own pages (docs/design/site.md §6): what the application and the level 0 shell share.
 * Nothing here reads Parallax data or changes a Parallax screen.
 */

/** What every page of a site receives, fixed when the site is built (§6.6). */
export interface PageProps {
  site: { name: string; logo?: { src: string; alt: string }; entry: string };
  catalogue: SiteCatalogue;
}

/** A page file: its component, and the document title it sets while it is shown (§6.7). */
export interface PageModule {
  default: ComponentType<PageProps>;
  title?: string;
}

export interface SitePage {
  /** The page's address, as `pageAddress` gives it. */
  path: string;
  load: () => Promise<PageModule>;
}

/** What a site hands to `mount`: its pages and the props each of them receives. */
export interface Site {
  pages: SitePage[];
  props: PageProps;
}

/** One route per page under `parent`, each loading its page when first shown. */
export function siteRoutes(parent: AnyRoute, site: Site): AnyRoute[] {
  return site.pages.map((page) =>
    createRoute({
      getParentRoute: () => parent,
      path: page.path,
      component: lazyRouteComponent(async () => {
        const { default: Page, title } = await page.load();
        return { default: () => <Shown Page={Page} title={title} props={site.props} /> };
      }),
    }),
  );
}

function Shown({
  Page,
  title,
  props,
}: {
  Page: ComponentType<PageProps>;
  title?: string;
  props: PageProps;
}) {
  usePageTitle(title);
  return <Page {...props} />;
}

export type PageLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string };

/** A link from a page to another page or to a Parallax screen (`site.entry`), by its address. */
export function Link({ to, ...rest }: PageLinkProps) {
  return <RouterLink {...rest} to={to as never} />;
}

const SEGMENT = /^[a-z0-9-]+$/;

/**
 * The address of a file under `src/pages`, given relative to that folder (§6.2): `index.tsx` is
 * `/`, `about.tsx` is `/about`, `team/index.tsx` is `/team`. `null` for a file that is not a page:
 * one that is not `.tsx` or `.jsx`, or one with a name starting with `_` (a helper). Throws for a
 * segment other than lower-case letters, digits and hyphens, so an address has no parameter.
 */
export function pageAddress(file: string): string | null {
  const parts = file.split(/[\\/]/).filter(Boolean);
  const name = parts.pop() ?? '';
  const page = /^(.*)\.[jt]sx$/.exec(name);
  if (!page || [...parts, name].some((part) => part.startsWith('_'))) return null;
  const segments = [...parts, page[1] ?? ''];
  if (segments.at(-1) === 'index') segments.pop();
  const bad = segments.find((segment) => !SEGMENT.test(segment));
  if (bad !== undefined) {
    throw new Error(
      `${file}: "${bad}" cannot be part of a page's address, which takes lower-case letters, digits and hyphens.`,
    );
  }
  return `/${segments.join('/')}`;
}

/** One slash before each segment and none at the end; `/` for no segment. */
export const cleanPath = (path: string) => `/${path.split('/').filter(Boolean).join('/')}`;

/**
 * An address as the router matches it: percent-escapes decoded, lower case, one slash between
 * segments and none at the end. `/courses/`, `/Courses` and `/%63ourses` are all `/courses`.
 */
export function normalise(address: string): string {
  const decoded = address.replace(/(%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
  return cleanPath(decoded.toLowerCase());
}

/**
 * The first of `patterns` (screen addresses, where `$name` stands for any one segment) at which
 * `address` lies, both compared after `normalise`; `undefined` when there is none.
 */
export function screenAt(address: string, patterns: readonly string[]): string | undefined {
  const parts = normalise(address).split('/');
  return patterns.find((pattern) => {
    const want = normalise(pattern).split('/');
    return (
      want.length === parts.length &&
      want.every((segment, i) => segment.startsWith('$') || segment === parts[i])
    );
  });
}
