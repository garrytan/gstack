import { Routes, Route } from 'react-router-dom';
import Layout from '@/components/Layout';
import Dashboard from '@/pages/Dashboard';
import Skills from '@/pages/Skills';
import QAReports from '@/pages/QAReports';
import Evals from '@/pages/Evals';
import Browse from '@/pages/Browse';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="skills" element={<Skills />} />
        <Route path="qa" element={<QAReports />} />
        <Route path="evals" element={<Evals />} />
        <Route path="browse" element={<Browse />} />
      </Route>
    </Routes>
  );
}
