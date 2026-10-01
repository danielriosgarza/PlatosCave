/** Full-page navigation: the session changed, so nothing cached for the previous one may survive. */
export const leavePage = (path: string) => window.location.assign(path);
