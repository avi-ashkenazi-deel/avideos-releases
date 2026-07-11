import { WritingBody } from '@/components/sections/WritingBody';
import { TalksBody } from '@/components/sections/TalksBody';
import { ProjectsBody } from '@/components/sections/ProjectsBody';
import { AboutBody } from '@/components/sections/AboutBody';
import { Footer } from '@/components/layout/Footer';
import { about } from '@/data/about';
import { useScrollSpy } from '@/hooks/useScrollSpy';
import styles from './OnePage.module.css';

const SECTION_IDS = ['top', 'talks', 'projects', 'writing', 'about'];

interface SectionProps {
  id: string;
  title: string;
  intro?: string;
  children: React.ReactNode;
}

function Section({ id, title, intro, children }: SectionProps) {
  return (
    <section id={id} className={styles.section}>
      <div className={`grid ${styles.sectionHead}`}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {intro && <p className={styles.sectionIntro}>{intro}</p>}
      </div>
      {children}
    </section>
  );
}

export default function OnePage() {
  useScrollSpy(SECTION_IDS);
  return (
    <div className="container">
      <header id="top" className={`grid ${styles.hero}`}>
        <span className={styles.kicker}>Designer &amp; Technologist — London</span>
        <h1 className={styles.name}>Avi Ashkenazi</h1>
        <p className={styles.bio}>{about.bio}</p>
      </header>

      <Section id="talks" title="Talks" intro="Conferences, podcasts and panels — with links to watch.">
        <TalksBody />
      </Section>

      <Section id="projects" title="Projects" intro="Things I've designed and built.">
        <ProjectsBody />
      </Section>

      <Section id="writing" title="Writing" intro="Posts, essays and conversations — from the blog, LinkedIn and Substack.">
        <WritingBody />
      </Section>

      <Section id="about" title="About">
        <AboutBody />
      </Section>

      <Footer />
    </div>
  );
}
