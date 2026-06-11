import { Page } from '@/components/layout/Page';
import { WritingBody } from '@/components/sections/WritingBody';

export default function Writing() {
  return (
    <Page index="01" title="Writing" intro="Posts, essays and conversations — from the blog, LinkedIn and Substack.">
      <WritingBody />
    </Page>
  );
}
