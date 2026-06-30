import '../dashboard.css';
import Link from 'next/link';
import { getWrenThread } from '@/lib/agents/wren-chat';
import { WrenChat } from './WrenChat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function WrenPage() {
  const history = await getWrenThread('default', 40);
  return (
    <div className="dash" style={{ gridTemplateColumns: '1fr' }}>
      <div className="dash-main" style={{ maxWidth: 760, margin: '0 auto' }}>
        <div className="dash-crumb"><Link href="/" style={{ color: 'var(--muted)' }}>Atelier</Link> › Wren</div>
        <div className="dash-title">✍️ Wren <span className="badge ok">● copywriter</span></div>
        <div className="dash-sub">A persistent teammate — qwen3.5 on Framerstation, remembers your taste, nothing leaves the LAN. Try: "6 headlines for course 19", then "make them punchier".</div>
        <WrenChat initial={history} />
      </div>
    </div>
  );
}
