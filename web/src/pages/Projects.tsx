import { Page } from '@/components/layout/Page';
import { ProjectsBody } from '@/components/sections/ProjectsBody';

export default function Projects() {
  return (
    <Page index="03" title="Projects" intro="Selected work, with a little more detail.">
      <ProjectsBody />
    </Page>
  );
}
