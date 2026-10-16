import { openCatalogue, openCourse, openPaths, openResource, openTopic } from '@parallax/contracts';
import { useQuery } from '@tanstack/react-query';

/**
 * The one module of the open site that fetches (docs/design/open-site.md §6): a `GET` of a data
 * file the build wrote, by its address in `openPaths`, without credentials, parsed by its schema.
 * Nothing else is requested, so the shell makes no request to `/api`.
 */

/** The site has no such file (404): the address names nothing on this site. */
export class Missing extends Error {}

async function read<T>(address: string, schema: { parse(value: unknown): T }): Promise<T> {
  const response = await fetch(address, { method: 'GET', credentials: 'omit' });
  if (response.status === 404) throw new Missing(address);
  if (!response.ok) throw new Error(`${address} answered ${response.status}`);
  return schema.parse(await response.json());
}

const useFile = <T>(address: string, schema: { parse(value: unknown): T }) =>
  useQuery({ queryKey: ['open', address], queryFn: () => read(address, schema) });

export const useCatalogue = () => useFile(openPaths.catalogue, openCatalogue);
export const useCourse = (ref: string) => useFile(openPaths.courseData(ref), openCourse);
export const useTopic = (ref: string, topicId: string) =>
  useFile(openPaths.topicData(ref, topicId), openTopic);
export const useResource = (ref: string, topicId: string, resourceId: string) =>
  useFile(openPaths.resourceData(ref, topicId, resourceId), openResource);
