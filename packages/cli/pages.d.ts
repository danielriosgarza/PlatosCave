// The types of `parallax-site/pages`, what a site page imports (docs/design/site.md §6.4, §6.6,
// §6.7). They are those of `apps/web/src/sitePages.tsx`, to which the build resolves the name.
import type { AnchorHTMLAttributes, ComponentType, ReactElement } from 'react';

/** What every page of the site receives, fixed when the site is built. */
export interface PageProps {
  site: { name: string; logo?: { src: string; alt: string }; entry: string };
  catalogue: {
    instructors: { slug: string; name: string; courses: { slug: string; title: string }[] }[];
  };
}

/** A page file: its component, and the document title it sets while it is shown. */
export interface PageModule {
  default: ComponentType<PageProps>;
  title?: string;
}

export type PageLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string };

/** A link to another page or to a Parallax screen (`site.entry`), by its address. */
export declare function Link(props: PageLinkProps): ReactElement;
