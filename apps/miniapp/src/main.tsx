import '@fontsource-variable/unbounded/wght.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { Root } from './app/Root.tsx';
import { bootstrap } from './boot.ts';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
const root = createRoot(container);

bootstrap()
  .then((env) => root.render(<Root env={env} />))
  .catch((err: unknown) => {
    console.error('bootstrap failed', err);
    root.render(<Root env={{ mode: 'browser', mocked: false }} />);
  });
