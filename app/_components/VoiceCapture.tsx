'use client';

import { useCallback, useRef, useState } from 'react';

type Phase =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'editing'
  | 'creating'
  | 'done'
  | 'error';

type TranscribeResponse = {
  text: string;
  words?: { word: string; start: number; end: number }[];
};

type CreatedResponse = {
  task?: { id: string };
  id?: string;
};

const TRANSCRIBE_URL = '/api/voice/transcribe';

export default function VoiceCapture({
  onCreated,
}: {
  onCreated?: (taskId: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [draft, setDraft] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const stopTracks = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
  }, []);

  const transcribe = useCallback(async (blob: Blob) => {
    setPhase('transcribing');
    setError(null);
    try {
      const body = new FormData();
      body.append('audio', blob, 'capture.webm');
      const res = await fetch(TRANSCRIBE_URL, { method: 'POST', body });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.error) || 'TRANSCRIBE_FAILED');
      }
      const data: TranscribeResponse = await res.json();
      setDraft((data.text || '').trim());
      setPhase('editing');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'TRANSCRIBE_FAILED');
      setPhase('error');
    }
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    setCreatedId(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        stopTracks();
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        chunksRef.current = [];
        if (blob.size === 0) {
          setError('NO_AUDIO');
          setPhase('error');
          return;
        }
        void transcribe(blob);
      };

      recorderRef.current = recorder;
      recorder.start();
      setPhase('recording');
    } catch {
      setError('MIC_DENIED');
      setPhase('error');
    }
  }, [stopTracks, transcribe]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    recorderRef.current = null;
  }, []);

  const confirm = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setPhase('creating');
    setError(null);
    try {
      const res = await fetch(`${TRANSCRIBE_URL}?createTask=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.error) || 'CREATE_FAILED');
      }
      const data: CreatedResponse = await res.json();
      const id = data.task ? data.task.id : data.id || null;
      setCreatedId(id);
      setPhase('done');
      if (id && onCreated) onCreated(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CREATE_FAILED');
      setPhase('error');
    }
  }, [draft, onCreated]);

  const reset = useCallback(() => {
    stopTracks();
    recorderRef.current = null;
    chunksRef.current = [];
    setDraft('');
    setError(null);
    setCreatedId(null);
    setPhase('idle');
  }, [stopTracks]);

  const recording = phase === 'recording';
  const busy = phase === 'transcribing' || phase === 'creating';

  return (
    <div className="surface surface--pad" style={{ display: 'grid', gap: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>Voice capture</strong>
        <span className={`chip chip--${recording ? 'working' : 'captured'}`}>
          {recording
            ? 'recording'
            : phase === 'transcribing'
              ? 'transcribing'
              : phase === 'creating'
                ? 'creating'
                : phase === 'done'
                  ? 'captured'
                  : 'ready'}
        </span>
      </div>

      {(phase === 'idle' || phase === 'recording' || phase === 'transcribing') && (
        <div className="row" style={{ gap: 12 }}>
          <button
            type="button"
            className={`btn ${recording ? 'btn--gold' : 'btn--primary'}`}
            onClick={recording ? stopRecording : startRecording}
            disabled={busy}
            aria-pressed={recording}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                marginRight: 8,
                borderRadius: recording ? 2 : '50%',
                background: '#fff',
                verticalAlign: 'middle',
              }}
            />
            {recording ? 'Stop' : 'Record brief'}
          </button>
          {phase === 'transcribing' && (
            <span className="muted">Transcribing audio...</span>
          )}
          {phase === 'idle' && (
            <span className="muted mono" style={{ fontSize: '0.8rem' }}>
              Speak a task. We will transcribe it for you to edit.
            </span>
          )}
        </div>
      )}

      {phase === 'editing' && (
        <div style={{ display: 'grid', gap: 10 }}>
          <label
            className="muted mono"
            htmlFor="voice-capture-draft"
            style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}
          >
            Transcribed brief
          </label>
          <input
            id="voice-capture-draft"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm();
            }}
            placeholder="Edit the captured task..."
            autoFocus
            style={{
              padding: '10px 12px',
              borderRadius: 'var(--r-sm)',
              border: '1px solid var(--line-2)',
              background: 'var(--surface)',
              color: 'var(--ink)',
              font: 'inherit',
            }}
          />
          <div className="row" style={{ gap: 10 }}>
            <button
              type="button"
              className="btn btn--primary"
              onClick={confirm}
              disabled={!draft.trim()}
            >
              Confirm capture
            </button>
            <button type="button" className="btn btn--ghost" onClick={reset}>
              Discard
            </button>
          </div>
        </div>
      )}

      {phase === 'creating' && <span className="muted">Creating task...</span>}

      {phase === 'done' && (
        <div className="row" style={{ gap: 12, justifyContent: 'space-between' }}>
          <span className="chip chip--captured">Captured</span>
          <span className="muted mono" style={{ fontSize: '0.8rem' }}>
            {createdId ? `task ${createdId.slice(0, 8)}` : 'task created'}
          </span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={reset}>
            Capture another
          </button>
        </div>
      )}

      {phase === 'error' && (
        <div className="row" style={{ gap: 12, justifyContent: 'space-between' }}>
          <span className="chip chip--fail">{error || 'error'}</span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={reset}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}