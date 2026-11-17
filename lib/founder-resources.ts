/**
 * The office-hours founder-resource pool (Phase 6 "Founder Resources").
 *
 * The 34 entries used to sit inline in office-hours/sections/design-and-handoff.md.
 * They live here now and bin/gstack-founder-resources prints the ones a user
 * has not been shown yet, in the exact form the prompt carried.
 * test/founder-resources-bin.test.ts checks the pool against
 * test/fixtures/founder-resources-pool.txt, the prompt's last inline copy.
 */
export interface FounderResource { id: number; category: string; text: string }

export const FOUNDER_RESOURCES: readonly FounderResource[] = [
  { id: 1, category: "GARRY TAN VIDEOS", text: "\"My $200 million startup mistake: Peter Thiel asked and I said no\" (5 min) — The single best \"why you should take the leap\" video. Peter Thiel writes him a check at dinner, he says no because he might get promoted to Level 60. That 1% stake would be worth $350-500M today. https://www.youtube.com/watch?v=dtnG0ELjvcM" },
  { id: 2, category: "GARRY TAN VIDEOS", text: "\"Unconventional Advice for Founders\" (48 min, Stanford) — The magnum opus. Covers everything a pre-launch founder needs: get therapy before your psychology kills your company, good ideas look like bad ideas, the Katamari Damacy metaphor for growth. No filler. https://www.youtube.com/watch?v=Y4yMc99fpfY" },
  { id: 3, category: "GARRY TAN VIDEOS", text: "\"The New Way To Build A Startup\" (8 min) — The 2026 playbook. Introduces the \"20x company\" — tiny teams beating incumbents through AI automation. Three real case studies. If you're starting something now and aren't thinking this way, you're already behind. https://www.youtube.com/watch?v=rWUWfj_PqmM" },
  { id: 4, category: "GARRY TAN VIDEOS", text: "\"How To Build The Future: Sam Altman\" (30 min) — Sam talks about what it takes to go from an idea to something real — picking what's important, finding your tribe, and why conviction matters more than credentials. https://www.youtube.com/watch?v=xXCBz_8hM9w" },
  { id: 5, category: "GARRY TAN VIDEOS", text: "\"What Founders Can Do To Improve Their Design Game\" (15 min) — Garry was a designer before he was an investor. Taste and craft are the real competitive advantage, not MBA skills or fundraising tricks. https://www.youtube.com/watch?v=ksGNfd-wQY4" },
  { id: 6, category: "YC BACKSTORY / HOW TO BUILD THE FUTURE", text: "\"Tom Blomfield: How I Created Two Billion-Dollar Fintech Startups\" (20 min) — Tom built Monzo from nothing into a bank used by 10% of the UK. The actual human journey — fear, mess, persistence. Makes founding feel like something a real person does. https://www.youtube.com/watch?v=QKPgBAnbc10" },
  { id: 7, category: "YC BACKSTORY / HOW TO BUILD THE FUTURE", text: "\"DoorDash CEO: Customer Obsession, Surviving Startup Death & Creating A New Market\" (30 min) — Tony started DoorDash by literally driving food deliveries himself. If you've ever thought \"I'm not the startup type,\" this will change your mind. https://www.youtube.com/watch?v=3N3TnaViyjk" },
  { id: 8, category: "LIGHTCONE PODCAST", text: "\"How to Spend Your 20s in the AI Era\" (40 min) — The old playbook (good job, climb the ladder) may not be the best path anymore. How to position yourself to build things that matter in an AI-first world. https://www.youtube.com/watch?v=ShYKkPPhOoc" },
  { id: 9, category: "LIGHTCONE PODCAST", text: "\"How Do Billion Dollar Startups Start?\" (25 min) — They start tiny, scrappy, and embarrassing. Demystifies the origin stories and shows that the beginning always looks like a side project, not a corporation. https://www.youtube.com/watch?v=HB3l1BPi7zo" },
  { id: 10, category: "LIGHTCONE PODCAST", text: "\"Billion-Dollar Unpopular Startup Ideas\" (25 min) — Uber, Coinbase, DoorDash — they all sounded terrible at first. The best opportunities are the ones most people dismiss. Liberating if your idea feels \"weird.\" https://www.youtube.com/watch?v=Hm-ZIiwiN1o" },
  { id: 11, category: "LIGHTCONE PODCAST", text: "\"Vertical AI Agents Could Be 10X Bigger Than SaaS\" (40 min) — The most-watched Lightcone episode. If you're building in AI, this is the landscape map — where the biggest opportunities are and why vertical agents win. https://www.youtube.com/watch?v=ASABxNenD_U" },
  { id: 12, category: "LIGHTCONE PODCAST", text: "\"The Truth About Building AI Startups Today\" (35 min) — Cuts through the hype. What's actually working, what's not, and where the real defensibility comes from in AI startups right now. https://www.youtube.com/watch?v=TwDJhUJL-5o" },
  { id: 13, category: "LIGHTCONE PODCAST", text: "\"Startup Ideas You Can Now Build With AI\" (30 min) — Concrete, actionable ideas for things that weren't possible 12 months ago. If you're looking for what to build, start here. https://www.youtube.com/watch?v=K4s6Cgicw_A" },
  { id: 14, category: "LIGHTCONE PODCAST", text: "\"Vibe Coding Is The Future\" (30 min) — Building software just changed forever. If you can describe what you want, you can build it. The barrier to being a technical founder has never been lower. https://www.youtube.com/watch?v=IACHfKmZMr8" },
  { id: 15, category: "LIGHTCONE PODCAST", text: "\"How To Get AI Startup Ideas\" (30 min) — Not theoretical. Walks through specific AI startup ideas that are working right now and explains why the window is open. https://www.youtube.com/watch?v=TANaRNMbYgk" },
  { id: 16, category: "LIGHTCONE PODCAST", text: "\"10 People + AI = Billion Dollar Company?\" (25 min) — The thesis behind the 20x company. Small teams with AI leverage are outperforming 100-person incumbents. If you're a solo builder or small team, this is your permission slip to think big. https://www.youtube.com/watch?v=CKvo_kQbakU" },
  { id: 17, category: "YC STARTUP SCHOOL", text: "\"Should You Start A Startup?\" (17 min, Harj Taggar) — Directly addresses the question most people are too afraid to ask out loud. Breaks down the real tradeoffs honestly, without hype. https://www.youtube.com/watch?v=BUE-icVYRFU" },
  { id: 18, category: "YC STARTUP SCHOOL", text: "\"How to Get and Evaluate Startup Ideas\" (30 min, Jared Friedman) — YC's most-watched Startup School video. How founders actually stumbled into their ideas by paying attention to problems in their own lives. https://www.youtube.com/watch?v=Th8JoIan4dg" },
  { id: 19, category: "YC STARTUP SCHOOL", text: "\"How David Lieb Turned a Failing Startup Into Google Photos\" (20 min) — His company Bump was dying. He noticed a photo-sharing behavior in his own data, and it became Google Photos (1B+ users). A masterclass in seeing opportunity where others see failure. https://www.youtube.com/watch?v=CcnwFJqEnxU" },
  { id: 20, category: "YC STARTUP SCHOOL", text: "\"Tips For Technical Startup Founders\" (15 min, Diana Hu) — How to leverage your engineering skills as a founder rather than thinking you need to become a different person. https://www.youtube.com/watch?v=rP7bpYsfa6Q" },
  { id: 21, category: "YC STARTUP SCHOOL", text: "\"Why Startup Founders Should Launch Companies Sooner Than They Think\" (12 min, Tyler Bosmeny) — Most builders over-prepare and under-ship. If your instinct is \"it's not ready yet,\" this will push you to put it in front of people now. https://www.youtube.com/watch?v=Nsx5RDVKZSk" },
  { id: 22, category: "YC STARTUP SCHOOL", text: "\"How To Talk To Users\" (20 min, Gustaf Alströmer) — You don't need sales skills. You need genuine conversations about problems. The most approachable tactical talk for someone who's never done it. https://www.youtube.com/watch?v=z1iF1c8w5Lg" },
  { id: 23, category: "YC STARTUP SCHOOL", text: "\"How To Find A Co-Founder\" (15 min, Harj Taggar) — The practical mechanics of finding someone to build with. If \"I don't want to do this alone\" is stopping you, this removes that blocker. https://www.youtube.com/watch?v=Fk9BCr5pLTU" },
  { id: 24, category: "YC STARTUP SCHOOL", text: "\"Should You Quit Your Job At A Unicorn?\" (12 min, Tom Blomfield) — Directly speaks to people at big tech companies who feel the pull to build something of their own. If that's your situation, this is the permission slip. https://www.youtube.com/watch?v=chAoH_AeGAg" },
  { id: 25, category: "PAUL GRAHAM ESSAYS", text: "\"How to Do Great Work\" — Not about startups. About finding the most meaningful work of your life. The roadmap that often leads to founding without ever saying \"startup.\" https://paulgraham.com/greatwork.html" },
  { id: 26, category: "PAUL GRAHAM ESSAYS", text: "\"How to Do What You Love\" — Most people keep their real interests separate from their career. Makes the case for collapsing that gap — which is usually how companies get born. https://paulgraham.com/love.html" },
  { id: 27, category: "PAUL GRAHAM ESSAYS", text: "\"The Bus Ticket Theory of Genius\" — The thing you're obsessively into that other people find boring? PG argues it's the actual mechanism behind every breakthrough. https://paulgraham.com/genius.html" },
  { id: 28, category: "PAUL GRAHAM ESSAYS", text: "\"Why to Not Not Start a Startup\" — Takes apart every quiet reason you have for not starting — too young, no idea, don't know business — and shows why none hold up. https://paulgraham.com/notnot.html" },
  { id: 29, category: "PAUL GRAHAM ESSAYS", text: "\"Before the Startup\" — Written specifically for people who haven't started anything yet. What to focus on now, what to ignore, and how to tell if this path is for you. https://paulgraham.com/before.html" },
  { id: 30, category: "PAUL GRAHAM ESSAYS", text: "\"Superlinear Returns\" — Some efforts compound exponentially; most don't. Why channeling your builder skills into the right project has a payoff structure a normal career can't match. https://paulgraham.com/superlinear.html" },
  { id: 31, category: "PAUL GRAHAM ESSAYS", text: "\"How to Get Startup Ideas\" — The best ideas aren't brainstormed. They're noticed. Teaches you to look at your own frustrations and recognize which ones could be companies. https://paulgraham.com/startupideas.html" },
  { id: 32, category: "PAUL GRAHAM ESSAYS", text: "\"Schlep Blindness\" — The best opportunities hide inside boring, tedious problems everyone avoids. If you're willing to tackle the unsexy thing you see up close, you might already be standing on a company. https://paulgraham.com/schlep.html" },
  { id: 33, category: "PAUL GRAHAM ESSAYS", text: "\"You Weren't Meant to Have a Boss\" — If working inside a big organization has always felt slightly wrong, this explains why. Small groups on self-chosen problems is the natural state for builders. https://paulgraham.com/boss.html" },
  { id: 34, category: "PAUL GRAHAM ESSAYS", text: "\"Relentlessly Resourceful\" — PG's two-word description of the ideal founder. Not \"brilliant.\" Not \"visionary.\" Just someone who keeps figuring things out. If that's you, you're already qualified. https://paulgraham.com/relres.html" },
];

export const resourceUrl = (r: FounderResource): string => r.text.slice(r.text.lastIndexOf(' ') + 1);

export function renderPool(entries: readonly FounderResource[] = FOUNDER_RESOURCES): string {
  const out: string[] = [];
  let category = '';
  for (const r of entries) {
    if (r.category !== category) {
      if (category) out.push('');
      out.push(`${r.category}:`);
      category = r.category;
    }
    out.push(`${r.id}. ${r.text}`);
  }
  return out.join('\n') + '\n';
}

export function renderIndex(shownUrls: readonly string[]): string {
  const shown = new Set(shownUrls);
  const left = FOUNDER_RESOURCES.filter(r => !shown.has(resourceUrl(r)));
  const head = [`RESOURCES_TOTAL: ${FOUNDER_RESOURCES.length}`, `RESOURCES_SHOWN_COUNT: ${FOUNDER_RESOURCES.length - left.length}`];
  if (!left.length) return [...head, 'RESOURCES: exhausted'].join('\n') + '\n';
  return [...head, `RESOURCES: ${left.length} not yet shown`, '', renderPool(left)].join('\n');
}
