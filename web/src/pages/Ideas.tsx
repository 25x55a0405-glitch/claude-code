import { api, type IdeaKind } from '../api';
import { Empty, ErrorNote, PageHead, Skeleton, useToast } from '../components/ui';
import { useResource } from '../lib/hooks';
import { navigate } from '../lib/router';

const KIND: Record<IdeaKind, string> = { suggestion: 'Suggestion', tip: 'Tip', plan_update: 'Plan update' };

export function Ideas() {
  const toast = useToast();
  const ideas = useResource(() => api.listIdeas(), [], ['idea.created']);

  const doIt = async (prompt: string, id: string) => {
    const convs = await api.listConversations();
    const main = convs.find((c) => c.main) ?? convs[0];
    await api.sendMessage(main.id, prompt);
    await api.dismissIdea(id);
    navigate('chat');
  };

  return (
    <div className="page">
      <PageHead title="Ideas" sub="Things Skys noticed it could do for you, from your goals, your inbox and your routine." />
      {ideas.error ? (
        <ErrorNote error={ideas.error} retry={ideas.reload} />
      ) : !ideas.data ? (
        <Skeleton h={150} n={2} />
      ) : ideas.data.length === 0 ? (
        <Empty title="No new ideas">Skys will add some as it learns how you work.</Empty>
      ) : (
        <div className="idea-grid">
          {ideas.data.map((i, n) => (
            <article key={i.id} className="panel idea" style={{ animationDelay: `${n * 60}ms` }}>
              <span className="kind">{KIND[i.kind]}</span>
              <h3>{i.title}</h3>
              <p>{i.detail}</p>
              <div className="row">
                <button className="btn ink sm" onClick={() => doIt(i.prompt, i.id)}>Do it</button>
                <button
                  className="btn quiet sm"
                  onClick={async () => {
                    await api.dismissIdea(i.id);
                    ideas.setData((d) => d && d.filter((x) => x.id !== i.id));
                    toast('Dismissed');
                  }}
                >
                  Not for me
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
