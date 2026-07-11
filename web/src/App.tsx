import { BrowserRouter } from 'react-router-dom';
import { Site } from '@/components/layout/Site';

export default function App() {
  const basename = import.meta.env.BASE_URL.replace(/\/$/, '');
  return (
    <BrowserRouter basename={basename}>
      <Site />
    </BrowserRouter>
  );
}
