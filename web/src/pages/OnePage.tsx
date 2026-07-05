import { WritingBody } from '@/components/sections/WritingBody';
import { TalksBody } from '@/components/sections/TalksBody';
import { ProjectsBody } from '@/components/sections/ProjectsBody';
import { ToolsBody } from '@/components/sections/ToolsBody';
import { AboutBody } from '@/components/sections/AboutBody';
import { Footer } from '@/components/layout/Footer';
import { about } from '@/data/about';
import styles from './OnePage.module.css';

interface SectionProps {
  id: string;
  index: string;
  title: string;
  intro?: string;
  children: React.ReactNode;
}

function Section({ id, index, title, intro, children }: SectionProps) {
  return (
    <section id={id} className={styles.section}>
      <div className={`grid ${styles.sectionHead}`}>
        <span className={styles.sectionIndex}>{index}</span>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {intro && <p className={styles.sectionIntro}>{intro}</p>}
      </div>
      {children}
    </section>
  );
}

export default function OnePage() {
  return (
    <div className="container">
      <header id="top" className={`grid ${styles.hero}`}>
        <span className={styles.kicker}>Designer &amp; Technologist — London</span>
        <h1 className={styles.name}>Avi Ashkenazi</h1>
        <p className={styles.bio}>{about.bio}</p>
      </header>

      <Section id="writing" index="01" title="Writing" intro="Posts, essays and conversations — from the blog, LinkedIn and Substack.">
        <WritingBody />
      </Section>

      <Section id="talks" index="02" title="Talks" intro="Conferences, podcasts and panels — with links to watch.">
        <TalksBody />
      </Section>

      <Section id="projects" index="03" title="Projects" intro="Things I'm building.">
        <ProjectsBody />
      </Section>

      <Section id="tools" index="04" title="Tools" intro="Apps I've built.">
        <ToolsBody />
      </Section>

      <Section id="about" index="05" title="About">
        <AboutBody />
      </Section>

      <Footer />
    </div>
  );
}
