import Link from 'next/link';
import { notFound } from 'next/navigation';
import '../../dashboard.css';
import { getProjectDashboard, listProjects, type FlowStage } from '@/lib/dashboard';
import { DecisionCard } from './DecisionCard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STAGE_ICON: Record<string, string> = {
  discover: '🔍', design: '🎨', build: '</>', produce: '🎬', verify: '🛡', launch: '🚀',
};
const STAGE_COLOR: Record<FlowStage['status'], string> = {
  complete: 'var(--teal)', in_progress: 'var(--purple)', pending: 'var(--faint)',
};

export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const d = await getProjectDashboard(slug);
  if (!d) notFound();
  const projects = await listProjects();
  const k = d.kpis;
  const confColor = k.confidence >= 80 ? 'var(--teal)' : k.confidence >= 60 ? 'var(--amber)' : 'var(--red)';

  return (
    <div className="dash">
      {/* ── sidebar ── */}
      <nav className="dash-nav">
        <div className="dash-brand">
          <div className="logo">A</div>
          <div><b>ATELIER</b><span>Studio Command Center</span></div>
        </div>
        <div className="group">Command Center</div>
        <Link href="/" >Home</Link>
        <a className="active"><span className="dot" /> Projects</a>
        <Link href="/employee/cleo">Agents</Link>
        <Link href="/style">Knowledge Bases</Link>
        <div className="group">Active Projects</div>
        {projects.map((p) => (
          <Link key={p.slug} href={`/project/${p.slug}`} className={p.slug === slug ? 'active' : ''}>
            {p.slug === slug ? <span className="dot" /> : null}{p.title}
          </Link>
        ))}
        <div className="group">System</div>
        <Link href="/">Floor</Link>
      </nav>

      {/* ── main + rail ── */}
      <div className="dash-main">
        <div className="dash-wrap">
          <div>
            {/* header */}
            <div className="dash-head">
              <div>
                <div className="dash-crumb">Projects › {d.title}</div>
                <div className="dash-title">{d.title} <span className="badge ok">● {d.status === 'active' ? 'On Track' : d.status}</span></div>
                <div className="dash-sub">{d.objective || 'A proof-gated build — nothing reaches you without a machine-checkable proof.'}</div>
              </div>
              <button className="btn-primary">Approve &amp; Publish 🚀</button>
            </div>

            <div className="dash-tabs">
              <a className="on">Overview</a><a>Briefing</a><a>Outputs</a><a>Tasks</a><a>Agents</a><a>Sources</a><a>Activity</a>
            </div>

            {/* KPIs */}
            <div className="kpis">
              <div className="kpi">
                <div className="k">Progress</div>
                <div className="v">{k.progressPct}%</div>
                <div className="bar"><i style={{ width: `${k.progressPct}%`, background: 'linear-gradient(90deg,var(--purple),var(--teal))' }} /></div>
                <div className="meta">{k.tasksTotal - k.tasksDone} tasks remaining</div>
              </div>
              <div className="kpi">
                <div className="k">Agents Active</div>
                <div className="v">{k.agentsActive} <small>/ {k.agentsTotal}</small></div>
                <div className="meta">● all systems operational</div>
              </div>
              <div className="kpi">
                <div className="k">Tasks Shipped</div>
                <div className="v">{k.tasksDone} <small>/ {k.tasksTotal}</small></div>
                <div className="bar"><i style={{ width: `${k.tasksTotal ? (k.tasksDone / k.tasksTotal) * 100 : 0}%`, background: 'var(--teal)' }} /></div>
                <div className="meta">proof-gated</div>
              </div>
              <div className="kpi">
                <div className="k">Confidence Score</div>
                <div className="v" style={{ color: confColor }}>{k.confidence} <small>/ 100</small></div>
                <div className="bar"><i style={{ width: `${k.confidence}%`, background: confColor }} /></div>
                <div className="meta">avg of real proof scores</div>
              </div>
            </div>

            {/* Project Flow */}
            <div className="section-h">Project Flow</div>
            <div className="flow">
              {d.flow.map((s, i) => (
                <div className="stage" key={s.key}>
                  <div className="icon" style={{ borderColor: STAGE_COLOR[s.status], color: STAGE_COLOR[s.status] }}>{STAGE_ICON[s.key]}</div>
                  <div className="num">{i + 1}. {s.role}</div>
                  <div className="name">{s.label}</div>
                  <div className={`st ${s.status}`}>{s.status === 'in_progress' ? 'In Progress' : s.status === 'complete' ? 'Complete' : 'Pending'}</div>
                  {s.subtasks.length === 0 ? <div className="sub pending"><span className="mark">○</span>—</div> : null}
                  {s.subtasks.slice(0, 5).map((t, j) => (
                    <div className={`sub ${t.status}`} key={j}>
                      <span className="mark">{t.status === 'done' ? '✓' : t.status === 'active' ? '◐' : '○'}</span>
                      {t.title.length > 26 ? t.title.slice(0, 25) + '…' : t.title}
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {/* Latest Outputs */}
            <div className="section-h">Latest Outputs <span style={{ color: 'var(--faint)', fontWeight: 400 }}>(verified)</span></div>
            <div className="outputs">
              {d.outputs.length ? d.outputs.map((o, i) => (
                <div className="out" key={i}>
                  <div className="thumb" style={{ backgroundImage: o.screenshotRef ? `url(${o.screenshotRef})` : undefined }} />
                  <div className="cap">
                    <div className="t">{o.title.length > 22 ? o.title.slice(0, 21) + '…' : o.title}</div>
                    <div className="m"><span>Updated {o.updated}</span><span className="tag">{o.kind}</span></div>
                  </div>
                </div>
              )) : <div className="card" style={{ gridColumn: '1/-1', color: 'var(--faint)' }}>No verified outputs yet — they appear here once a proof passes.</div>}
            </div>

            {/* footer */}
            <div className="foot">
              <div className="card">
                <div className="section-h" style={{ margin: '0 0 12px' }}>Knowledge Bases In Use</div>
                <div className="kbs">
                  {d.knowledgeBases.map((kb) => (
                    <div className="kb" key={kb.handle}><div className="t">{kb.name}</div><div className="m">{kb.handle} · {kb.count} attrs</div></div>
                  ))}
                  <div className="kb" style={{ display: 'grid', placeItems: 'center', color: 'var(--faint)' }}>+ add</div>
                </div>
              </div>
              <div className="card">
                <div className="section-h" style={{ margin: '0 0 12px' }}>System Health</div>
                <div className="spark">{[5, 7, 4, 8, 6, 9, 5, 7, 8, 6, 9, 7, 8].map((h, i) => <i key={i} style={{ height: `${h * 3}px` }} />)}</div>
                <div style={{ fontSize: 11, color: 'var(--teal)', marginTop: 8 }}>● All systems operational · local · $0</div>
              </div>
            </div>
          </div>

          {/* ── right rail ── */}
          <div className="rail">
            <div className="card">
              <h4>🧠 Executive Briefing</h4>
              <div className="brief">{d.briefing.summary}</div>
              <div style={{ marginTop: 10 }}>
                {d.briefing.bullets.map((b, i) => <div className="bul" key={i}><span className="c">✓</span>{b}</div>)}
              </div>
            </div>

            {d.decision ? (
              <DecisionCard taskId={d.decision.taskId} question={d.decision.question} options={d.decision.options} />
            ) : d.decidedAngle ? (
              <div className="card" style={{ borderColor: 'var(--teal)' }}>
                <h4>✓ Decision Made</h4>
                <div className="brief">Leading with <strong style={{ color: 'var(--teal)' }}>{d.decidedAngle}</strong> — recorded to the Dossier; the line continues.</div>
              </div>
            ) : null}

            <div className="card feed">
              <h4>📡 Live Activity</h4>
              {d.activity.length ? d.activity.map((a, i) => (
                <div className="row" key={i}>
                  <div className="av">{a.employee.slice(0, 1)}</div>
                  <div><div className="who">{a.employee}</div><div className="what">{a.body}</div></div>
                  <div className="when">{a.at}</div>
                </div>
              )) : <div style={{ fontSize: 12, color: 'var(--faint)' }}>No activity yet.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
