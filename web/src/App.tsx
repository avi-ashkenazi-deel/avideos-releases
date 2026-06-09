import { BrowserRouter } from 'react-router-dom';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { DesktopShell, MobileShell } from '@/components/layout/Shell';

function ShellSwitch() {
  const mode = useBreakpoint();
  return mode === 'mobile' ? <MobileShell /> : <DesktopShell />;
}

export default function App() {
  // Strip the trailing slash so routing works under a project subpath
  // (e.g. GitHub Pages '/avideos-releases/') as well as at the domain root.
  const basename = import.meta.env.BASE_URL.replace(/\/$/, '');
  return (
    <BrowserRouter basename={basename}>
      <ShellSwitch />
    </BrowserRouter>
  );
}
