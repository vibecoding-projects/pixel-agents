import { useEffect, useRef, useState } from 'react';

import type { LaunchAgentFailure } from '../hooks/useExtensionMessages.js';
import type { NewAgentSpawn } from './newAgentSpawn.js';
import { buildSpawnRequest } from './newAgentSpawn.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';
import { Modal } from './ui/Modal.js';

interface NewAgentModalProps {
  isOpen: boolean;
  /** MRU list from settingsLoaded (config.json), newest first. */
  recentFolders: string[];
  /** A refused spawn (launchAgentFailed). The form re-opens seeded with the
   *  rejected folder and shows the server's reason until the field is edited. */
  failure?: LaunchAgentFailure | null;
  onSpawn: (spawn: NewAgentSpawn) => void;
  onClose: () => void;
}

/** "New agent" form — the browser runtime's + Agent flow. Both fields are
 *  optional; blank means the same defaults a plain spawn uses. Ported from
 *  v2-orchestrator's NewAgentPopover, re-skinned onto the shared Modal. */
export function NewAgentModal({
  isOpen,
  recentFolders,
  failure,
  onSpawn,
  onClose,
}: NewAgentModalProps) {
  // Folder starts EMPTY — the effective default is placeholder text only, so
  // the form never displays a path it would not honor.
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [bypass, setBypass] = useState(false);
  // The seq of the refusal currently displayed; stale once the user edits the
  // folder field, so the error clears while they fix the path.
  const [shownFailureSeq, setShownFailureSeq] = useState<number | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setFolder('');
      setBypass(false);
      setShownFailureSeq(null);
      // Modal mounts its content on open; focus after that commit.
      setTimeout(() => nameRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // A refusal seeds the rejected folder + reason exactly once (consumedSeqRef
  // survives close/reopen, so a manual + Agent later starts clean). The name
  // and bypass choice of the refused request are restored too — a retry after
  // a folder typo must not silently drop half the request.
  const consumedSeqRef = useRef(0);
  const lastSpawnRef = useRef<{ name: string; bypass: boolean } | null>(null);
  useEffect(() => {
    if (isOpen && failure && failure.seq > consumedSeqRef.current) {
      consumedSeqRef.current = failure.seq;
      setFolder(failure.folderPath);
      setName(lastSpawnRef.current?.name ?? '');
      setBypass(lastSpawnRef.current?.bypass ?? false);
      setShownFailureSeq(failure.seq);
    }
  }, [isOpen, failure]);

  const shownError = failure && failure.seq === shownFailureSeq ? failure.reason : null;

  const spawn = () => {
    lastSpawnRef.current = { name, bypass };
    onSpawn(buildSpawnRequest(name, folder, bypass));
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New agent" className="w-340">
      <div
        role="dialog"
        aria-label="New agent"
        className="px-10 pb-6"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
            return;
          }
          // Enter submits only from the text fields — never from Cancel or the
          // recents quick-picks (those handle their own activation).
          if (
            e.key === 'Enter' &&
            e.target instanceof HTMLInputElement &&
            e.target.type === 'text'
          ) {
            e.preventDefault();
            spawn();
          }
        }}
      >
        <label className="block text-2xs text-text-muted mb-4">Name (optional)</label>
        <Input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Research Bot"
          aria-label="Agent name"
          className="mb-10"
        />

        <label className="block text-2xs text-text-muted mb-4">
          Starting folder (~ or home-relative)
        </label>
        <Input
          value={folder}
          onChange={(e) => {
            setFolder(e.target.value);
            setShownFailureSeq(null);
          }}
          placeholder="default folder"
          aria-label="Starting folder"
          className={shownError ? 'mb-2' : recentFolders.length ? 'mb-6' : 'mb-10'}
        />
        {shownError && (
          <p role="alert" className="text-2xs text-warning mt-0 mb-6">
            {shownError}
          </p>
        )}

        {recentFolders.length > 0 && (
          <div className="mb-10 overflow-y-auto" style={{ maxHeight: 120 }}>
            {recentFolders.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFolder(f)}
                title={f}
                className="block w-full text-left text-2xs px-6 py-3 bg-transparent border-none text-text-muted cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap hover:text-text"
              >
                {f}
              </button>
            ))}
          </div>
        )}

        <label className="flex items-center gap-6 text-2xs text-text-muted mb-10 cursor-pointer">
          <input type="checkbox" checked={bypass} onChange={(e) => setBypass(e.target.checked)} />
          Skip permissions mode <span className="text-warning">⚠</span>
        </label>

        <div className="flex gap-8 justify-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={spawn}>
            Spawn
          </Button>
        </div>
      </div>
    </Modal>
  );
}
