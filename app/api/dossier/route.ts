import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { ATELIER_WS } from '@/lib/atelier';

// Read-only history endpoint for a dossier's append-only entry log.
// GET /api/dossier?dossierId=<uuid>
//   -> { dossierId, entries: AtelierDossierEntry[] } ordered by created_at ASC
// The atelier_dossier_entry table is APPEND-ONLY: this route never mutates.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type EntryRow = {
  id: string;
  workspace_id: string;
  dossier_id: string;
  task_id: string | null;
  employee_slug: string;
  entry_type: string;
  from_station: string | null;
  to_station: string | null;
  body: string;
  payload: unknown;
  created_at: string;
};

function serialize(row: EntryRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    dossierId: row.dossier_id,
    taskId: row.task_id,
    employeeSlug: row.employee_slug,
    entryType: row.entry_type,
    fromStation: row.from_station,
    toStation: row.to_station,
    body: row.body,
    payload: row.payload ?? {},
    createdAt: row.created_at,
  };
}

export async function GET(req: NextRequest) {
  const dossierId = req.nextUrl.searchParams.get('dossierId');

  if (!dossierId) {
    return NextResponse.json(
      { error: 'MISSING_DOSSIER_ID' },
      { status: 400 },
    );
  }

  try {
    const rows = (await sql`
      select
        id,
        workspace_id,
        dossier_id,
        task_id,
        employee_slug,
        entry_type,
        from_station,
        to_station,
        body,
        payload,
        created_at
      from atelier_dossier_entry
      where workspace_id = ${ATELIER_WS}
        and dossier_id = ${dossierId}
      order by created_at asc
    `) as unknown as EntryRow[];

    return NextResponse.json({
      dossierId,
      entries: rows.map(serialize),
    });
  } catch (err) {
    console.error('[api/dossier] failed to load entries', err);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
