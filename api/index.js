// Vercel serverless entry point. Vercel builds files under /api into functions;
// this re-exports the Express app so a single function handles every route.
// vercel.json rewrites all traffic here.
import app from '../server.js';

export default app;
