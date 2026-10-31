import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import '@fontsource/schibsted-grotesk/400.css';
import '@fontsource/schibsted-grotesk/500.css';
import '@fontsource/schibsted-grotesk/600.css';
import '@fontsource/schibsted-grotesk/700.css';
import '@fontsource/sometype-mono/400.css';
import '@fontsource/sometype-mono/500.css';
import './index.css';
import './ledger.css';
import './components/JudgeProof.css';
import './dossier.css';

createRoot(document.getElementById('root')!).render(<App />);
