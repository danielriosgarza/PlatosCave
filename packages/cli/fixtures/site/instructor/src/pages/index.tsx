import { Link, type PageProps } from 'parallax-site/pages';

export default function Front({ site }: PageProps) {
  return (
    <main>
      {site.logo && <img src={site.logo.src} alt={site.logo.alt} />}
      <h1>{site.name}</h1>
      <Link to={site.entry}>Open the course</Link>
    </main>
  );
}
