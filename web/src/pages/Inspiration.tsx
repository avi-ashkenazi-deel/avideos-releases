import { InspirationList } from '@/components/sections/InspirationList';
import { Footer } from '@/components/layout/Footer';
import { podcasts, books, people } from '@/data/inspiration';
import page from './OnePage.module.css';

function Section({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={page.section}>
      <div className={`grid ${page.sectionHead}`}>
        <h2 className={page.sectionTitle}>{title}</h2>
        {intro && <p className={page.sectionIntro}>{intro}</p>}
      </div>
      {children}
    </section>
  );
}

export default function Inspiration() {
  return (
    <div className="container">
      <header id="top" className={`grid ${page.hero}`}>
        <span className={page.kicker}>Inspiration — Knowledge consumption</span>
        <h1 className={page.name}>Inspiration</h1>
        <p className={page.bio}>Podcasts, books and people I learn from — a brain dump of what shapes my thinking.</p>
      </header>

      <Section id="podcasts" title="Podcasts" intro="Shows I keep coming back to.">
        <InspirationList items={podcasts} />
      </Section>

      <Section id="books" title="Books" intro="Writing I recommend.">
        <InspirationList items={books} />
      </Section>

      <Section id="people" title="People" intro="Voices I follow.">
        <InspirationList items={people} />
      </Section>

      <Footer />
    </div>
  );
}
