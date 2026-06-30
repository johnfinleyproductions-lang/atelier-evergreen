// app/api/voice/transcribe/route.ts
//
// POST /api/voice/transcribe — multipart audio in, transcript out.
//
// Accepts a multipart/form-data body carrying an `audio` File (the blob a
// browser MediaRecorder produced), forwards the bytes to the Whisper STT
// service via lib/whisper-client.transcribe(), and returns the recognised
// `text`. When the form also carries a truthy `createTask` flag, the transcript
// is turned into an editable CAPTURED task (createTask seeds state='captured')
// so the voice-capture component can drop a spoken brief straight onto the floor.
//
// Errors follow the house shape: NextResponse.json({ error: CODE }, { status }).

import { NextResponse } from 'next/server';
import { transcribe } from '@/lib/whisper-client';
import { createTask } from '@/lib/atelier';
import type { Task } from '@/lib/atelier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Form fields whose presence (with a truthy value) requests task creation.
function isTruthyFlag(value: FormDataEntryValue | null): boolean {
  if (value === null) return false;
  const s = String(value).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

// POST /api/voice/transcribe -> { text } | { text, task }
export async function POST(req: Request) {
  // Parse the multipart body. A non-multipart or malformed body throws here.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'INVALID_FORM' }, { status: 400 });
  }

  // The uploaded audio clip. Accept either `audio` (canonical) or `file`.
  const upload = form.get('audio') ?? form.get('file');
  if (!(upload instanceof File)) {
    return NextResponse.json({ error: 'AUDIO_REQUIRED' }, { status: 400 });
  }
  if (upload.size === 0) {
    return NextResponse.json({ error: 'EMPTY_AUDIO' }, { status: 400 });
  }

  // Hand the File (a Blob) straight to the Whisper client, which POSTs the
  // bytes to ATELIER_STT_URL and returns { text, words }.
  let text: string;
  try {
    const result = await transcribe(upload);
    text = (result?.text ?? '').trim();
  } catch (err) {
    console.error('[POST /api/voice/transcribe] transcribe failed:', err);
    return NextResponse.json({ error: 'TRANSCRIBE_FAILED' }, { status: 502 });
  }

  if (!text) {
    return NextResponse.json({ error: 'NO_SPEECH' }, { status: 422 });
  }

  // The createTask flag may arrive as a form field OR a ?createTask=1 query
  // param. Without it we just hand back the transcript.
  const wantTask =
    isTruthyFlag(form.get('createTask')) ||
    isTruthyFlag(new URL(req.url).searchParams.get('createTask'));
  if (!wantTask) {
    return NextResponse.json({ text }, { status: 200 });
  }

  // Otherwise mint an editable CAPTURED task from the spoken brief.
  let task: Task;
  try {
    task = await createTask({ title: text, intent: text, kind: 'capture' });
  } catch (err) {
    console.error('[POST /api/voice/transcribe] createTask failed:', err);
    // The transcript is still useful, but signal the partial failure.
    return NextResponse.json(
      { text, error: 'CREATE_FAILED' },
      { status: 500 },
    );
  }

  return NextResponse.json({ text, task }, { status: 201 });
}
