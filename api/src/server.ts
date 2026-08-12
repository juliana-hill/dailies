import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'dailies-api' }));

app.post('/api/projects', (_req, res) => {
  res.status(501).json({ error: 'Project creation is scaffolded and not implemented yet.' });
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`Dailies API listening on ${port}`));
