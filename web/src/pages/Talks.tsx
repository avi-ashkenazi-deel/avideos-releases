import { Page } from '@/components/layout/Page';
import { TalksBody } from '@/components/sections/TalksBody';

export default function Talks() {
  return (
    <Page index="02" title="Talks" intro="Conferences, podcasts and panels — with links to watch.">
      <TalksBody />
    </Page>
  );
}
