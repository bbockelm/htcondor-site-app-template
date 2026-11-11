import { useRef, useState, type DragEvent } from 'react';

interface Props {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}

/**
 * Drag-and-drop file picker.
 *
 * Keyboard and click both work, not only drag: a drop target that
 * cannot be reached from the keyboard is unusable for some people and
 * merely annoying on a laptop trackpad for everyone else.
 */
export function Dropzone({ files, onChange, disabled }: Props) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  function add(incoming: FileList | null) {
    if (!incoming) return;
    const byName = new Map(files.map((f) => [f.name, f]));
    for (const f of Array.from(incoming)) byName.set(f.name, f);
    onChange(Array.from(byName.values()));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    if (!disabled) add(e.dataTransfer.files);
  }

  return (
    <>
      <div
        className={`dropzone${over ? ' over' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="Add input files"
        onClick={() => !disabled && input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!disabled) input.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={input}
          type="file"
          multiple
          data-testid="file-input"
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />
        Drop input files here, or choose files
      </div>

      {files.length > 0 && (
        <ul className="files" data-testid="file-list">
          {files.map((f) => (
            <li key={f.name}>
              <span className="name">{f.name}</span>
              <span className="size">{formatSize(f.size)}</span>
              <button
                type="button"
                className="secondary"
                aria-label={`Remove ${f.name}`}
                onClick={() => onChange(files.filter((x) => x.name !== f.name))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
