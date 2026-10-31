import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import '@fontsource/sofia-sans-extra-condensed/800.css';
import '@fontsource/geist/400.css';
import '@fontsource/geist/500.css';
import '@fontsource/geist/600.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import './styles/press.css';
import './styles/overview.css';
import './styles/challenge.css';
import './styles/proof.css';
import './styles/screens.css';

createRoot(document.getElementById('root')!).render(<App />);
