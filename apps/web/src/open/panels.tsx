import type { OpenTopic } from '@parallax/contracts';
import type { ReactNode } from 'react';
import buttons from '../components/Buttons.module.css';
import { Loading } from '../components/Loading';
import page from '../components/Page.module.css';
import { RetryNotice } from '../components/RetryNotice';
import { NativeReading } from '../reading/NativeReading';
import { PdfReading } from '../reading/PdfReading';
import reading from '../reading/Reading.module.css';
import slides from '../slides/Slides.module.css';
import { SlideViewer } from '../slides/SlideViewer';
import type { TopicTab } from '../topics/topics';
import { ResourceTools } from '../workspace/ResourceTools';
import { Missing, useResource } from './data';

/**
 * The panels of a topic's tabs at level 0 (docs/design/open-site.md §6): Slides and Reading in the
 * existing viewers, given what a data file holds and nothing that saves, renews or calls the API
 * (no `source.key`, so no download through the API); the other three tabs list their titles.
 */
export interface PanelProps {
  course: string;
  topicId: string;
  tab: TopicTab;
  lists: OpenTopic;
  /** The resource and the slide the address names. */
  resource: string | undefined;
  page: number | undefined;
  onResource: (resourceId: string) => void;
}

// One function each for as long as a resource is shown: a viewer loads again when one changes.
const nothing = () => {};
const noRenewal = async () => null;

const EMPTY = {
  slides: 'No slides have been added',
  reading: 'No reading has been added',
  exercises: 'No exercises have been added',
  notebooks: 'No notebook has been added',
  tests: 'No tests have been added',
};

export function Panel(props: PanelProps) {
  const { tab, lists } = props;
  if (tab !== 'slides' && tab !== 'reading') {
    const titles = lists[tab].map(({ resourceId, title }) => <li key={resourceId}>{title}</li>);
    if (!titles.length) return <p className={page.intro}>{EMPTY[tab]}</p>;
    return <ul className={page.bareList}>{titles}</ul>;
  }
  const staged = (node: ReactNode) =>
    tab === 'reading' ? <div className={reading.stage}>{node}</div> : node;
  const items: OpenTopic['slides'] = lists[tab];
  const chosen = items.find((item) => item.resourceId === props.resource) ?? items[0];
  if (!chosen) {
    return staged(<p className={tab === 'slides' ? slides.empty : reading.empty}>{EMPTY[tab]}</p>);
  }
  const picker = (
    <label className={slides.picker}>
      <span className={slides.label}>{tab === 'slides' ? 'Slides' : 'Reading'}</span>
      <select value={chosen.resourceId} onChange={(e) => props.onResource(e.target.value)}>
        {items.map(({ resourceId, title }) => (
          <option key={resourceId} value={resourceId}>
            {title}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <ResourceTools>
        {items.length > 1 ? picker : <span className={slides.label}>{chosen.title}</span>}
      </ResourceTools>
      {staged(<Shown key={chosen.resourceId} at={props} resourceId={chosen.resourceId} />)}
    </>
  );
}

/** One deck or reading, from its data file. */
function Shown({ at, resourceId }: { at: PanelProps; resourceId: string }) {
  const file = useResource(at.course, at.topicId, resourceId);
  const data = file.data;
  const deck = at.tab === 'slides';
  if (data?.type !== 'slides' && data?.type !== 'reading') {
    const what = deck ? 'These slides' : 'This reading';
    const state =
      file.error instanceof Missing ? (
        <p className={page.feedback} role="alert">
          {`${what} ${deck ? 'are' : 'is'} not available.`}
        </p>
      ) : file.isError ? (
        <RetryNotice message={`${what} could not be loaded.`} onRetry={() => void file.refetch()} />
      ) : (
        <Loading label={`Loading ${at.tab}`} />
      );
    return data ? null : <div className={deck ? slides.status : undefined}>{state}</div>;
  }
  const { pdf } = data;
  const source = { classId: '', revisionId: resourceId, key: null };
  const shown = { source, initialPage: at.page ?? 1, onPage: nothing };
  const read = { source, initial: null, onPosition: nothing };
  return (
    <>
      {/* A plain link to the object on the content origin, in the toolbar: it stays when the
          viewer says that the PDF could not be loaded. */}
      {pdf && (
        <ResourceTools>
          <a className={buttons.tool} href={pdf.url}>
            Download
          </a>
        </ResourceTools>
      )}
      {data.type === 'reading' && data.html !== null ? (
        <NativeReading html={data.html} initial={null} onPosition={nothing} />
      ) : data.type === 'slides' && data.web ? (
        <SlideViewer {...shown} slides={data.web.slides} pageCount={data.web.slides.length} />
      ) : !pdf ? null : data.type === 'slides' ? (
        <SlideViewer {...shown} url={pdf.url} pageCount={pdf.pageCount} />
      ) : (
        <PdfReading {...read} url={pdf.url} pageCount={pdf.pageCount} renew={noRenewal} />
      )}
    </>
  );
}
