import { BrowserRouter } from 'react-router-dom';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { DesktopShell, MobileShell } from '@/components/layout/Shell';

function ShellSwitch() {
  const mode = useBreakpoint();
  return mode === 'mobile' ? <MobileShell /> : <DesktopShell />;
}

export default function App() {
  return (
    <BrowserRouter>
      <ShellSwitch />
    </BrowserRouter>
  );
}
