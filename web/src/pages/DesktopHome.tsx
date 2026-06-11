import { Suspense } from 'react';
import { HeroCanvas } from '@/components/hero/HeroCanvas';
import { SectionHeader } from '@/components/sections/SectionHeader';
import { WritingBody } from '@/components/sections/WritingBody';
import { TalksBody } from '@/components/sections/TalksBody';
import { ProjectsBody } from '@/components/sections/ProjectsBody';
import { ToolsBody } from '@/components/sections/ToolsBody';
import { AboutBody } from '@/components/sections/AboutBody';
import { Footer } from '@/components/layout/Footer';
import { about } from '@/data/about';
import styles from './DesktopHome.module.css';

export default function DesktopHome() {
  return (
    <>
      <div id="top" className={styles.hero}>
        <div className={styles.heroCanvas}>
          <Suspense fallback={null}>
            <HeroCanvas />
          </Suspense>
        </div>
        <div className={styles.heroContent}>
          <h1 className={styles.name}>{about.name}</h1>
          <p className={styles.bio}>{about.bio}</p>
        </div>
      </div>

      <div className="container">
        <section id="writing" className={styles.section}>
          <SectionHeader index="01" title="Writing" intro="Posts, essays and conversations — from the blog, LinkedIn and Substack." />
          <WritingBody />
        </section>

        <section id="talks" className={styles.section}>
          <SectionHeader index="02" title="Talks" intro="Conferences, podcasts and panels — with links to watch." />
          <TalksBody />
        </section>

        <section id="projects" className={styles.section}>
          <SectionHeader index="03" title="Projects" intro="Selected work, with a little more detail." />
          <ProjectsBody />
        </section>

        <section id="tools" className={styles.section}>
          <SectionHeader index="04" title="Tools" intro="Apps I've built." />
          <ToolsBody />
        </section>

        <section id="about" className={styles.section}>
          <SectionHeader index="05" title="About" />
          <AboutBody />
        </section>

        <Footer />
      </div>
    </>
  );
}
