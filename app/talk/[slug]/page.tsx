import '../../dashboard.css';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAgent, getThread, listAgents } from '@/lib/agents/chat';
import { TalkChat } from './TalkChat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function TalkPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const agent = await getAgent(slug);
  if (!agent) notFound();
  const [history, team] = await Promise.all([getThread(slug, 'default', 40), listAgents()]);
  return (
    <div className="dash">
      <nav className="dash-nav">
        <div className="dash-brand"><div className="logo">A</div><div><b>ATELIER</b><span>Talk to your team</span></div></div>
        <div className="group">Command Center</div>
        <Link href="/">Floor</Link>
        <Link href="/project/launch-course-19">Projects</Link>
        <div className="group">Your team</div>
        {team.map((a) => (
          <Link key={a.slug} href={`/talk/${a.slug}`} className={a.slug === slug ? 'active' : ''}>
            {a.slug === slug ? <span className="dot" /> : null}{a.name}
          </Link>
        ))}
      </nav>
      <div className="dash-main" style={{ maxWidth: 760 }}>
        <div className="dash-crumb"><Link href="/" style={{ color: 'var(--muted)' }}>Atelier</Link> › {agent.name}</div>
        <div className="dash-title">{agent.name} <span className="badge ok">● {agent.role}</span></div>
        <div className="dash-sub">Talk to {agent.name} in-app — a local model, nothing leaves the LAN. No Slack needed.</div>
        <TalkChat slug={slug} name={agent.name} initial={history} />
      </div>
    </div>
  );
}
