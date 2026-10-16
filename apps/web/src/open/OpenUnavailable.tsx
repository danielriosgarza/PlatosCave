import { Link } from '@tanstack/react-router';
import page from '../components/Page.module.css';
import { usePageTitle } from '../components/pageTitle';
import { StatePage } from '../components/StatePage';

/** An address whose data file the site does not have, or that no screen of the site has (§6). */
export function OpenUnavailable() {
  usePageTitle('This page is not available');
  return (
    <StatePage
      title="This page is not available"
      action={
        <Link to="/courses" className={page.link}>
          Go to the courses
        </Link>
      }
    >
      This site has no page at this address.
    </StatePage>
  );
}
