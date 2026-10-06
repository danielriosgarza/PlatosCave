import { getRuntimes } from '@parallax/contracts/routes/authoring';
import { useQuery } from '@tanstack/react-query';
import { call } from '../api/client';
import buttons from '../components/Buttons.module.css';
import styles from '../components/Page.module.css';
import local from './Authoring.module.css';
import { authoringKey } from './queries';
import { Area, Check, moved, replaceAt, Select, Text } from './TestFields';
import {
  blankCheck,
  blankFile,
  type CheckKind,
  checksAfterFileChange,
  type DraftCheck,
  type DraftFile,
  type DraftQuestion,
  fileUidOf,
  limitBounds,
  lines,
  withKind,
} from './testForm';

const checkKinds = [
  ['call', 'Call a function and compare the result'],
  ['stdio', 'Run the program and compare its output'],
  ['script', 'Run a script (its own exit status decides)'],
] as const;
const compareModes = {
  call: [
    ['exact', 'Exact'],
    ['numeric', 'Numeric (within a tolerance)'],
    ['repr', 'Same printed form'],
  ],
  stdio: [
    ['exact', 'Exact'],
    ['trimmed', 'Ignoring surrounding whitespace'],
    ['tokens', 'Word by word'],
    ['numeric', 'Numeric (within a tolerance)'],
  ],
} as const;

interface Props {
  question: DraftQuestion;
  courseId: string;
  onChange: (patch: Partial<DraftQuestion>) => void;
}

/**
 * The code question's definition (`codeTask.v1`, design §8.1): runtime, starter and hidden
 * files, allowed packages, limits within the server's bounds, and the sample and hidden checks.
 */
export function CodeQuestionEditor({ question: q, courseId, onChange }: Props) {
  const runtimes = useQuery({
    queryKey: [...authoringKey(courseId), 'runtimes'],
    queryFn: () => call(getRuntimes, { params: { courseId } }),
    staleTime: 5 * 60_000,
  });
  const offered = runtimes.data?.runtimes ?? [];
  const runtime = offered.find((r) => r.id === q.runtime);
  const setFile = (i: number, patch: Partial<DraftFile>) =>
    onChange({ files: replaceAt(q.files, i, { ...(q.files[i] as DraftFile), ...patch }) });
  const setCheck = (i: number, patch: Partial<DraftCheck>) =>
    onChange({ checks: replaceAt(q.checks, i, { ...(q.checks[i] as DraftCheck), ...patch }) });
  const paths = q.files.map((f) => f.path).filter(Boolean);

  return (
    <div>
      {runtimes.isError ? (
        <p role="alert" className={styles.small}>
          The approved runtimes could not be loaded.
        </p>
      ) : (
        <Select
          label="Language and version"
          value={q.runtime}
          onChange={(v) => onChange({ runtime: v, allowedPackages: [] })}
          options={[
            ...(q.runtime && !runtime && runtimes.data
              ? ([[q.runtime, `${q.runtime} (not offered)`]] as const)
              : []),
            ...(q.runtime === '' ? ([['', 'Choose a runtime']] as const) : []),
            ...offered.map((r) => [r.id, r.id] as const),
          ]}
        />
      )}

      <fieldset className={local.choices}>
        <legend>Files</legend>
        <p className={local.hint}>
          Editable files are the student’s answer and start with this content. Hidden files are
          never shown to students and are used only by hidden checks.
        </p>
        {q.files.map((f, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: files are renamed while typing, so the position is the only stable key.
          <div key={i} className={local.block}>
            <div className={local.cardHead}>
              <strong>File {i + 1}</strong>
              <button
                type="button"
                className={buttons.textButton}
                disabled={q.files.length <= 1}
                onClick={() =>
                  onChange({
                    files: q.files.filter((_, j) => j !== i),
                    checks: checksAfterFileChange(q.checks, f, undefined, q.files),
                  })
                }
              >
                Remove file {i + 1}
              </button>
            </div>
            <Text
              label={`File ${i + 1} path`}
              value={f.path}
              onChange={(v) =>
                onChange({
                  files: replaceAt(q.files, i, { ...f, path: v }),
                  // The checks that named the file follow it.
                  checks: checksAfterFileChange(q.checks, f, v, q.files),
                })
              }
            />
            <Check
              label={`File ${i + 1} is editable by students`}
              checked={f.editable}
              onChange={(v) => setFile(i, { editable: v })}
            />
            <Check
              label={`File ${i + 1} is hidden from students`}
              checked={f.hidden}
              onChange={(v) => setFile(i, { hidden: v })}
            />
            <Area
              label={`File ${i + 1} content`}
              mono
              rows={f.hidden ? 5 : 8}
              value={f.content}
              hint={f.encoding === 'base64' ? 'Stored as base64.' : undefined}
              onChange={(v) => setFile(i, { content: v })}
            />
          </div>
        ))}
        <div className={styles.mt12}>
          <button
            type="button"
            className={buttons.outline}
            disabled={q.files.length >= 64}
            onClick={() =>
              onChange({
                files: [...q.files, blankFile()],
              })
            }
          >
            Add file
          </button>
        </div>
      </fieldset>

      <fieldset className={local.choices}>
        <legend>Allowed packages</legend>
        {runtime && runtime.packages.length === 0 ? (
          <p className={local.hint}>This runtime offers no extra packages.</p>
        ) : null}
        {(runtime?.packages ?? []).map((name) => (
          <Check
            key={name}
            label={name}
            checked={q.allowedPackages.includes(name)}
            onChange={(on) =>
              onChange({
                allowedPackages: on
                  ? [...q.allowedPackages, name]
                  : q.allowedPackages.filter((p) => p !== name),
              })
            }
          />
        ))}
        {q.allowedPackages
          .filter((p) => !runtime?.packages.includes(p))
          .map((name) => (
            <Check
              key={name}
              label={`${name} (not in this runtime)`}
              checked
              onChange={() =>
                onChange({ allowedPackages: q.allowedPackages.filter((p) => p !== name) })
              }
            />
          ))}
        <p className={local.hint}>Students see this list with the question.</p>
      </fieldset>

      <fieldset className={local.choices}>
        <legend>Limits</legend>
        <div className={local.inlineFields}>
          {(
            [
              ['wallSeconds', 'Wall time (seconds)'],
              ['memoryMiB', 'Memory (MiB)'],
              ['outputBytes', 'Captured output (bytes)'],
            ] as const
          ).map(([key, label]) => (
            <Text
              key={key}
              label={label}
              inputMode="numeric"
              value={q.limits[key]}
              placeholder={`default ${limitBounds[key].default}`}
              hint={`${limitBounds[key].min} to ${limitBounds[key].max}`}
              onChange={(v) => onChange({ limits: { ...q.limits, [key]: v } })}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className={local.choices}>
        <legend>Checks</legend>
        <p className={local.hint}>
          Sample checks are shown to students when they run sample tests. Hidden checks run when
          work is graded and in your preview runs below; prefer function-call and program-output
          checks for hidden checks.
        </p>
        {q.checks.map((c, i) => (
          <CheckEditor
            // biome-ignore lint/suspicious/noArrayIndexKey: names are edited, so the position is the only stable key.
            key={i}
            index={i}
            count={q.checks.length}
            check={c}
            paths={paths}
            files={q.files}
            onChange={(patch) => setCheck(i, patch)}
            onMove={(by) => onChange({ checks: moved(q.checks, i, by) })}
            onRemove={() => onChange({ checks: q.checks.filter((_, j) => j !== i) })}
          />
        ))}
        <div className={styles.mt12}>
          <button
            type="button"
            className={buttons.outline}
            disabled={q.checks.length >= 50}
            onClick={() =>
              onChange({
                checks: [
                  ...q.checks,
                  blankCheck(paths[0] ?? '', fileUidOf(q.files, paths[0] ?? '')),
                ],
              })
            }
          >
            Add check
          </button>
        </div>
      </fieldset>
    </div>
  );
}

function CheckEditor({
  index,
  count,
  check: c,
  paths,
  files,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  check: DraftCheck;
  paths: string[];
  files: DraftFile[];
  onChange: (patch: Partial<DraftCheck>) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const others = lines(c.files);
  const toggle = (path: string, on: boolean) =>
    onChange({ files: (on ? [...others, path] : others.filter((p) => p !== path)).join('\n') });
  return (
    <div className={local.block}>
      <div className={local.cardHead}>
        <strong>
          Check {n}
          <span className={local.badge}>{c.visibility === 'hidden' ? 'Hidden' : 'Sample'}</span>
        </strong>
        <span className={styles.row}>
          <button
            type="button"
            className={buttons.textButton}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            Move check {n} up
          </button>
          <button
            type="button"
            className={buttons.textButton}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            Move check {n} down
          </button>
          <button type="button" className={buttons.textButton} onClick={onRemove}>
            Remove check {n}
          </button>
        </span>
      </div>
      <div className={local.inlineFields}>
        <Text label={`Check ${n} name`} value={c.name} onChange={(v) => onChange({ name: v })} />
        <Select
          label={`Check ${n} visibility`}
          value={c.visibility}
          onChange={(v) => onChange({ visibility: v })}
          options={[
            ['public', 'Sample (shown to students)'],
            ['hidden', 'Hidden (never shown)'],
          ]}
        />
        <Text
          label={`Check ${n} points`}
          inputMode="decimal"
          value={c.points}
          onChange={(v) => onChange({ points: v })}
        />
        <Text
          label={`Check ${n} time limit (seconds)`}
          inputMode="numeric"
          value={c.timeoutSeconds}
          placeholder="whole run"
          onChange={(v) => onChange({ timeoutSeconds: v })}
        />
      </div>
      <Select
        label={`Check ${n} kind`}
        value={c.kind}
        onChange={(kind: CheckKind) => onChange(withKind(c, kind))}
        options={checkKinds}
      />
      <Select
        label={c.kind === 'script' ? `Check ${n} script file` : `Check ${n} program file`}
        value={c.file}
        onChange={(v) => onChange({ file: v, fileUid: fileUidOf(files, v) })}
        options={[
          ...(paths.includes(c.file) ? [] : ([[c.file, c.file || 'Choose a file']] as const)),
          ...paths.map((p) => [p, p] as const),
        ]}
      />
      <fieldset className={local.choices}>
        <legend>{`Check ${n} also needs these files`}</legend>
        {paths
          .filter((p) => p !== c.file)
          .map((p) => (
            <Check
              key={p}
              label={p}
              checked={others.includes(p)}
              onChange={(on) => toggle(p, on)}
            />
          ))}
      </fieldset>
      {c.kind === 'call' ? (
        <>
          <Text label={`Check ${n} function`} value={c.fn} onChange={(v) => onChange({ fn: v })} />
          <Area
            label={`Check ${n} arguments (JSON array)`}
            mono
            rows={2}
            value={c.args}
            onChange={(v) => onChange({ args: v })}
          />
          <Area
            label={`Check ${n} keyword arguments (JSON object, optional)`}
            mono
            rows={2}
            value={c.kwargs}
            onChange={(v) => onChange({ kwargs: v })}
          />
          <Select
            label={`Check ${n} expects`}
            value={c.expects}
            onChange={(v) => onChange({ expects: v })}
            options={[
              ['value', 'A returned value'],
              ['raises', 'An exception'],
            ]}
          />
          {c.expects === 'value' ? (
            <Area
              label={`Check ${n} expected value (JSON)`}
              mono
              rows={2}
              value={c.expectedValue}
              onChange={(v) => onChange({ expectedValue: v })}
            />
          ) : (
            <div className={local.inlineFields}>
              <Text
                label={`Check ${n} exception type`}
                value={c.raisesType}
                onChange={(v) => onChange({ raisesType: v })}
              />
              <Text
                label={`Check ${n} exception message (optional)`}
                value={c.raisesMessage}
                onChange={(v) => onChange({ raisesMessage: v })}
              />
            </div>
          )}
        </>
      ) : null}
      {c.kind === 'stdio' ? (
        <>
          <Area
            label={`Check ${n} input (standard input)`}
            mono
            rows={3}
            value={c.stdin}
            onChange={(v) => onChange({ stdin: v })}
          />
          <Area
            label={`Check ${n} expected output`}
            mono
            rows={3}
            value={c.expectedStdout}
            onChange={(v) => onChange({ expectedStdout: v })}
          />
          <Text
            label={`Check ${n} expected exit code (optional)`}
            inputMode="numeric"
            value={c.exitCode}
            onChange={(v) => onChange({ exitCode: v })}
          />
        </>
      ) : null}
      {c.kind !== 'call' ? (
        <Area
          label={`Check ${n} command-line arguments (one per line)`}
          mono
          rows={2}
          value={c.args}
          onChange={(v) => onChange({ args: v })}
        />
      ) : null}
      {c.kind !== 'script' ? (
        <div className={local.inlineFields}>
          <Select
            label={`Check ${n} comparison`}
            value={c.compareMode}
            onChange={(v) => onChange({ compareMode: v })}
            options={compareModes[c.kind]}
          />
          {c.compareMode === 'numeric' ? (
            <>
              <Text
                label={`Check ${n} absolute tolerance`}
                inputMode="decimal"
                value={c.abs}
                onChange={(v) => onChange({ abs: v })}
              />
              <Text
                label={`Check ${n} relative tolerance`}
                inputMode="decimal"
                value={c.rel}
                onChange={(v) => onChange({ rel: v })}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
